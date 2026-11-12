import type { MirrorScope } from '../domain/sync-config.ts';
import type { BudgetPolicy } from './budget-policy.ts';
import { describeUnknown, notRun } from './drain-queue.ts';
import type { DrainQueue, TickReport } from './drain-queue.ts';
import type { FinishReport } from './finish-claims.ts';
import type { ForgeReport } from './forge-pass.ts';
import type { ImportReport } from './import-ready-work.ts';
import { LOCK_LOST, TickLockLost } from './leased-gateways.ts';
import { isMirrored, withdrawMirrored } from './mirror-claims.ts';
import { PassCeiling } from './pass-ceiling.ts';
import type { MirrorPass, MirrorReport } from './mirror-claims.ts';
import { writeMirrorPassOver } from './sync-meta.ts';
import type { OwnerRefusal, SyncOwner } from './sync-owner.ts';
import {
  giveBackLastAuditAttemptAt,
  readLastAudit,
  readLastAuditAttemptAt,
  readLastBudget,
  writeLastAuditAttemptAt,
} from './queue-meta.ts';
import type { ActionRepository, Clock, Logger, TickLease } from './ports.ts';
import type { TokenRefusalRecord } from './token-refusals.ts';

/**
 * Keeping the boards in step with a coordination server, when this deployment
 * does: the check that this is the one worker that may run the jobs kept for the
 * owner's, and the directions that are switched on.
 */
export type SyncJobs = {
  owner: SyncOwner;
  /**
   * Carries claims onto the boards as filed work; runs before the queue is drained,
   * and answers which mirrored actions may run in this pass. Each job is handed the
   * lease of the tick lock it runs under, confirms it before every write, and
   * throws `TickLockLost` once another pass has taken the lock.
   */
  mirror?: (lease: TickLease) => Promise<MirrorPass>;
  /**
   * Whose moves the mirror files: `all` runs it only in the owner's worker, `own`
   * in every worker, for the moves of the person it runs as. `all` unless named.
   */
  mirrorScope?: MirrorScope;
  /**
   * Ends this worker's own person's claims whose issues the board calls finished;
   * runs in every worker, after the mirror, and asks GitHub nothing.
   */
  finish?: (lease: TickLease) => Promise<FinishReport>;
  /** Reports the board's work to the server; runs after the queue and the report, when there is room. */
  importer?: (lease: TickLease) => Promise<ImportReport>;
  /** Keeps GitHub's pull requests, statuses, branches and runs in step with the server; runs last, when there is room. */
  forge?: (lease: TickLease) => Promise<ForgeReport>;
};

/** What the tick did about keeping in step, beside what it did to the queue. */
export type SyncTickReport = {
  /** Why this worker declined to keep in step, when it did. */
  refused?: string;
  /** Which kind of reason that was. */
  refusal?: OwnerRefusal;
  mirror?: MirrorReport | { skipped: string };
  finish?: FinishReport | { skipped: string };
  import?: ImportReport;
  forge?: ForgeReport | { skipped: string };
};

/**
 * A credential refused while the pass ran: GitHub's, which put the queue to
 * sleep and stops every pass until a working one is there, or the coordination
 * server's token, which every job that asks the server meets.
 */
export type RefusedCredential = {
  readonly by: 'github' | 'coordination';
  readonly reason: string;
};

export type WorkerReport = TickReport & {
  sync?: SyncTickReport;
  /** Present when a credential the pass depends on was refused; the pass then did not do its job. */
  refusedCredential?: RefusedCredential;
};

export type RunTickDeps = {
  drain: DrainQueue;
  repository: ActionRepository;
  policy: BudgetPolicy;
  clock: Clock;
  logger: Logger;
  /**
   * The report-only pass over the board, when this deployment has one wired. It
   * is handed in rather than reached for, so the worker runs with or without it
   * and neither has to know about the other.
   */
  audit?: (lease: TickLease) => Promise<void>;
  sync?: SyncJobs;
  /** What the coordination server's transports heard about the token, when this deployment talks to one. */
  tokenRefusals?: TokenRefusalRecord;
  /**
   * How long one pass may go on taking work; past it the pass starts no further
   * action and no further job, and ends. Unbounded when not named.
   */
  passCeilingSec?: number;
};

/**
 * What the scheduler actually calls: drain the queue, and once in a while, when
 * there is allowance nobody is waiting on, look at the whole board and write down
 * what does not add up.
 *
 * The order is not negotiable. The queue is work somebody asked for; the report
 * is work nobody is waiting for, and it reads the whole board and every open
 * issue to produce it. A tick that did not run — the lock was held, or the queue
 * is serving a wait — reports nothing either: whatever stopped the writing is a
 * reason not to start reading.
 *
 * The report runs under the same single lock the writing does, and for the same
 * reason. It spends the allowance the queue is pacing itself inside, so two of
 * them at once, or one alongside a tick in another process, is exactly the burst
 * every rule here exists to prevent.
 */
export class RunTick {
  readonly #drain: DrainQueue;
  readonly #repository: ActionRepository;
  readonly #policy: BudgetPolicy;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #audit: ((lease: TickLease) => Promise<void>) | null;
  readonly #sync: SyncJobs | null;
  readonly #tokenRefusals: TokenRefusalRecord | null;
  readonly #passCeilingMs: number;

  constructor(deps: RunTickDeps) {
    this.#drain = deps.drain;
    this.#repository = deps.repository;
    this.#policy = deps.policy;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#audit = deps.audit ?? null;
    this.#sync = deps.sync ?? null;
    this.#tokenRefusals = deps.tokenRefusals ?? null;
    this.#passCeilingMs = deps.passCeilingSec === undefined ? Number.POSITIVE_INFINITY : deps.passCeilingSec * 1000;
  }

  /**
   * The owner's check is asked only when a job that waits for it is on. A mirror of
   * this worker's own person's moves does not wait for it, and neither does ending
   * that person's finished claims.
   *
   * The mirror runs first, so the moves it files are drained in the same tick; the
   * import and the forge pass run last, because they read, and reading waits for
   * the work somebody asked for. Any one of them failing is recorded and the rest
   * of the tick goes on. Each runs under the single tick lock, so a pass that is
   * still running when the next tick starts is never joined by a second.
   *
   * One thing ends the tick where it stands: finding that another pass took the
   * lock from this one. Everything after — the drain, the report's stamp, the
   * reads and what they send — is then the other pass's to do, and doing it here
   * as well would write beside it, or put off what it is due to do.
   *
   * Whatever the pass did, its report says when a credential it depends on was
   * refused: a pass that met one, or that is waiting one out, has not done its
   * job, however quietly every part of it ended.
   *
   * The pass has a ceiling, counted from here. The job that ends finished claims,
   * which runs before the drain, starts only in its first half, so the queue
   * always has the second; the mirror runs first and is not held to it. Once the
   * ceiling is reached nothing more is started — the queue claims no action after its first,
   * and a job not yet begun is skipped, saying why — and the pass ends with what
   * it did, each job having released the lock as it finished. The drain itself
   * always runs, so filed work moves on every pass.
   */
  async run(): Promise<WorkerReport> {
    const report = await this.#pass(new PassCeiling(this.#clock.now(), this.#passCeilingMs));
    const refused = await this.#refusedCredential();
    return refused === null ? report : { ...report, refusedCredential: refused };
  }

  async #pass(ceiling: PassCeiling): Promise<WorkerReport> {
    const sync = this.#sync;
    const mirrorWaitsForOwner = sync?.mirror !== undefined && (sync.mirrorScope ?? 'all') === 'all';
    const ownerJobs = sync !== null && (mirrorWaitsForOwner || sync.importer !== undefined || sync.forge !== undefined);
    const allowed = sync !== null && ownerJobs ? await sync.owner.verdict() : null;
    if (sync !== null && !ownerJobs) {
      await sync.owner.notNeeded();
    }
    const syncReport: SyncTickReport = {};
    if (allowed !== null && !allowed.ok) {
      syncReport.refused = allowed.reason;
      syncReport.refusal = allowed.refusal;
    }
    const mayKeepInStep = sync !== null && allowed !== null && allowed.ok;
    let cleared: ReadonlySet<string> = new Set();
    if (sync?.mirror !== undefined && (mayKeepInStep || !mirrorWaitsForOwner)) {
      const mirror = await this.#locked('the claim mirror', sync.mirror);
      syncReport.mirror = 'skipped' in mirror.report ? mirror.report : mirror.report.report;
      cleared = 'skipped' in mirror.report ? cleared : mirror.report.cleared;
      if (mirror.lockLost) {
        return { ...notRun(LOCK_LOST), lockLost: true, sync: syncReport };
      }
    } else if (sync?.mirror !== undefined && allowed?.ok === false && allowed.refusal === 'not-the-owner') {
      await this.#retireMirrored(allowed.reason);
    }
    if (sync?.finish !== undefined && ceiling.halfGone(this.#clock.now())) {
      syncReport.finish = { skipped: ceiling.halfGoneReason() };
    } else if (sync?.finish !== undefined) {
      const finish = await this.#locked('ending finished claims', sync.finish);
      syncReport.finish = finish.report;
      if (finish.lockLost) {
        return { ...notRun(LOCK_LOST), lockLost: true, sync: syncReport };
      }
    }

    const passedOver = sync?.mirror === undefined ? null : await this.#mirroredWaiting(cleared, syncReport);
    const drained = await this.#drain.run(
      passedOver === null ? undefined : (action) => isMirrored(action) && !cleared.has(action.id),
      ceiling,
    );
    const report: TickReport = passedOver === null ? drained : { ...drained, passedOver };
    if (report.lockLost === true) {
      return sync === null ? report : { ...report, sync: syncReport };
    }
    if (await this.#maybeAudit(report, ceiling)) {
      return sync === null ? { ...report, lockLost: true } : { ...report, lockLost: true, sync: syncReport };
    }

    if (mayKeepInStep && sync.importer !== undefined) {
      if (ceiling.reached(this.#clock.now())) {
        syncReport.import = { skipped: ceiling.reason() };
      } else if (await this.#queueIsFree(report)) {
        const imported = await this.#locked('the import', sync.importer);
        syncReport.import = imported.report;
        if (imported.lockLost) {
          return { ...report, lockLost: true, sync: syncReport };
        }
      } else {
        syncReport.import = { skipped: 'the tick did not get to drain the queue, so nothing is read' };
      }
    }
    if (mayKeepInStep && sync.forge !== undefined) {
      if (ceiling.reached(this.#clock.now())) {
        syncReport.forge = { skipped: ceiling.reason() };
      } else if (await this.#queueIsFree(report)) {
        const forged = await this.#locked('the forge pass', sync.forge);
        syncReport.forge = forged.report;
        if (forged.lockLost) {
          return { ...report, lockLost: true, sync: syncReport };
        }
      } else {
        syncReport.forge = { skipped: 'the tick did not get to drain the queue, so nothing is read' };
      }
    }
    return sync === null ? report : { ...report, sync: syncReport };
  }

  /**
   * Runs one job under the single tick lock, handing it the lease. A job that
   * throws is logged and answered as skipped: keeping in step is never worth
   * losing the tick's own account of what it did to the queue. A job that found
   * the lock taken is answered as skipped for that reason, and said to have lost it.
   */
  async #locked<T>(
    name: string,
    job: (lease: TickLease) => Promise<T>,
  ): Promise<{ report: T | { skipped: string }; lockLost: boolean }> {
    type Outcome = { done: T } | { failed: string } | { lockLost: true };
    const outcome = await this.#repository.withTickLock(async (lease): Promise<Outcome> => {
      try {
        return { done: await job(lease) };
      } catch (error) {
        if (error instanceof TickLockLost) {
          this.#logger.warn(`${name} stopped: another pass took the tick lock`);
          return { lockLost: true };
        }
        const reason = describeUnknown(error);
        this.#logger.error(`${name} failed`, { reason });
        return { failed: reason };
      }
    });
    if (outcome === null) {
      return { report: { skipped: 'another tick holds the lock' }, lockLost: false };
    }
    if ('lockLost' in outcome) {
      return { report: { skipped: LOCK_LOST }, lockLost: true };
    }
    return {
      report: 'done' in outcome ? outcome.done : { skipped: `${name} failed: ${outcome.failed}` },
      lockLost: false,
    };
  }

  /**
   * The credential refused in this pass, if one was: GitHub's while the queue
   * waits one out — whether this pass met the refusal or an earlier one did — or
   * else the coordination server's token, when one of this pass's calls met it.
   */
  async #refusedCredential(): Promise<RefusedCredential | null> {
    const token = this.#tokenRefusals?.takeRefusal() ?? null;
    const pause = await this.#repository.getPause();
    if (pause !== null && pause.cause === 'credential' && pause.isActive(this.#clock.now())) {
      return { by: 'github', reason: pause.reason };
    }
    return token === null ? null : { by: 'coordination', reason: token };
  }

  /**
   * Why the mirrored actions still waiting that the mirror did not clear stay
   * queued this pass, or null when there are none; written down either way, so
   * that status says what this worker's last pass left. Each was filed while its
   * move stood, but another worker may have filed and run a later move of the same
   * item since; only the mirror can ask the server, and for these it did not get
   * to, so running them now could write the older move over the later one.
   */
  async #mirroredWaiting(cleared: ReadonlySet<string>, syncReport: SyncTickReport): Promise<string | null> {
    const left = (await this.#repository.list({ states: ['queued'] }))
      .filter((action) => isMirrored(action) && !cleared.has(action.id));
    if (left.length === 0) {
      await writeMirrorPassOver(this.#repository, null);
      return null;
    }
    const reason = `${String(left.length)} mirrored moves wait until the server can say they still stand: `
      + whyUncleared(syncReport);
    await writeMirrorPassOver(this.#repository, {
      at: this.#clock.now().toISOString(),
      reason,
      ids: left.map((action) => action.id),
    });
    return reason;
  }

  /** Withdraws the mirrored moves of a worker that no longer runs the mirror, under the tick lock. */
  async #retireMirrored(reason: string): Promise<void> {
    const withdrawn = await this.#repository.withTickLock((lease) => withdrawMirrored(
      { repository: this.#repository, clock: this.#clock, logger: this.#logger },
      lease,
      `this worker is no longer the mirror's owner, so the moves it filed are left to the worker that is: ${reason}`,
    ));
    if (withdrawn !== null && withdrawn > 0) {
      this.#logger.warn('the mirrored moves this worker filed were withdrawn: it no longer runs the mirror', {
        withdrawn,
      });
    }
  }

  /** Whether the queue ran and is not waiting out a refusal, which is when anything may read. */
  async #queueIsFree(report: TickReport): Promise<boolean> {
    if (report.skipped !== undefined || report.pausedUntil !== undefined) {
      return false;
    }
    const pause = await this.#repository.getPause();
    return pause === null || !pause.isActive(this.#clock.now());
  }

  /**
   * Writes the report when it is due and the pass is still inside its ceiling;
   * answers whether it found the lock taken by another pass.
   */
  async #maybeAudit(report: TickReport, ceiling: PassCeiling): Promise<boolean> {
    const audit = this.#audit;
    if (audit === null || ceiling.reached(this.#clock.now()) || !(await this.#worthReading(report))) {
      return false;
    }
    const before = await readLastAuditAttemptAt(this.#repository);
    const attemptedAt = this.#clock.now();
    // Stamped before the pass rather than after it, so that a pass which fails —
    // or which the machine interrupts — still holds the cadence. A report that
    // could not be written is a report worth waiting for, not one worth asking
    // for again in five minutes out of the allowance the queue is pacing itself
    // against.
    await writeLastAuditAttemptAt(this.#repository, attemptedAt);
    const read = await this.#repository.withTickLock(async (lease): Promise<'read' | 'lost'> => {
      try {
        await audit(lease);
      } catch (error) {
        if (error instanceof TickLockLost) {
          return 'lost';
        }
        // A report that could not be written is worth a loud line and nothing
        // more: it changes nothing, and losing the tick's own account of the work
        // it did would cost more than the report is worth.
        this.#logger.error('the board report could not be written', { reason: describeUnknown(error) });
      }
      return 'read';
    });
    if (read === null) {
      this.#logger.info('the board was not read: another tick holds the lock');
    }
    if (read !== 'lost') {
      return false;
    }
    // The pass that took the lock writes the report; this one's stamp would put it off.
    await giveBackLastAuditAttemptAt(this.#repository, attemptedAt, before);
    this.#logger.warn('the board report stopped: another pass took the tick lock');
    return true;
  }

  /**
   * Whether this is a moment to read the board at all.
   *
   * Three things say no before the cadence is even consulted. A tick that never
   * ran says nothing happened worth reporting on and, more to the point, says
   * whatever stopped it is still stopping things. A tick that ended by putting
   * the queue to sleep has just been told the allowance is gone — and the pass is
   * the most expensive thing here. And a wait somebody else set binds this too:
   * the report and the writing spend one allowance between them.
   */
  async #worthReading(report: TickReport): Promise<boolean> {
    if (!(await this.#queueIsFree(report))) {
      return false;
    }
    const lastAudit = await readLastAudit(this.#repository);
    const lastAttempt = await readLastAuditAttemptAt(this.#repository);
    const budget = await readLastBudget(this.#repository);
    return this.#policy.shouldAudit(later(lastAudit?.at ?? null, lastAttempt), this.#clock.now(), budget);
  }
}

/** The more recent of two moments, either of which may not have happened yet. */
function later(one: Date | null, other: Date | null): Date | null {
  if (one === null) {
    return other;
  }
  if (other === null) {
    return one;
  }
  return one.getTime() >= other.getTime() ? one : other;
}

/** Why the mirror left some of its waiting actions uncleared in this pass. */
function whyUncleared(syncReport: SyncTickReport): string {
  const mirror = syncReport.mirror;
  if (mirror === undefined) {
    return syncReport.refused === undefined ? 'the mirror did not run' : `the mirror did not run: ${syncReport.refused}`;
  }
  if ('skipped' in mirror) {
    return mirror.skipped;
  }
  return mirror.declined ?? mirror.error ?? 'they were filed before this worker kept a record of what each must find';
}
