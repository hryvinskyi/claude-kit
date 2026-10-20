import type { BudgetPolicy } from './budget-policy.ts';
import { describeUnknown } from './drain-queue.ts';
import type { DrainQueue, TickReport } from './drain-queue.ts';
import type { ForgeReport } from './forge-pass.ts';
import type { ImportReport } from './import-ready-work.ts';
import type { MirrorReport } from './mirror-claims.ts';
import type { SyncOwner } from './sync-owner.ts';
import {
  readLastAudit,
  readLastAuditAttemptAt,
  readLastBudget,
  writeLastAuditAttemptAt,
} from './queue-meta.ts';
import type { ActionRepository, Clock, Logger } from './ports.ts';

/**
 * Keeping the boards in step with a coordination server, when this deployment
 * does: the check that this is the one worker that may, and the directions that
 * are switched on.
 */
export type SyncJobs = {
  owner: SyncOwner;
  /** Carries claims onto the boards as filed work; runs before the queue is drained. */
  mirror?: () => Promise<MirrorReport>;
  /** Reports the board's work to the server; runs after the queue and the report, when there is room. */
  importer?: () => Promise<ImportReport>;
  /** Keeps GitHub's pull requests, statuses, branches and runs in step with the server; runs last, when there is room. */
  forge?: () => Promise<ForgeReport>;
};

/** What the tick did about keeping in step, beside what it did to the queue. */
export type SyncTickReport = {
  /** Why this worker declined to keep in step, when it did. */
  refused?: string;
  mirror?: MirrorReport | { skipped: string };
  import?: ImportReport;
  forge?: ForgeReport | { skipped: string };
};

export type WorkerReport = TickReport & { sync?: SyncTickReport };

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
  audit?: () => Promise<void>;
  sync?: SyncJobs;
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
  readonly #audit: (() => Promise<void>) | null;
  readonly #sync: SyncJobs | null;

  constructor(deps: RunTickDeps) {
    this.#drain = deps.drain;
    this.#repository = deps.repository;
    this.#policy = deps.policy;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#audit = deps.audit ?? null;
    this.#sync = deps.sync ?? null;
  }

  /**
   * The mirror runs first, so the moves it files are drained in the same tick; the
   * import and the forge pass run last, because they read, and reading waits for
   * the work somebody asked for. Any one of them failing is recorded and the rest
   * of the tick goes on. Each runs under the single tick lock, so a pass that is
   * still running when the next tick starts is never joined by a second.
   */
  async run(): Promise<WorkerReport> {
    const sync = this.#sync;
    const allowed = sync === null ? null : await sync.owner.verdict();
    const syncReport: SyncTickReport = {};
    if (allowed !== null && !allowed.ok) {
      syncReport.refused = allowed.reason;
    }
    const mayKeepInStep = sync !== null && allowed !== null && allowed.ok;
    if (mayKeepInStep && sync.mirror !== undefined) {
      syncReport.mirror = await this.#locked('the claim mirror', sync.mirror);
    }

    const report = await this.#drain.run();
    await this.#maybeAudit(report);

    if (mayKeepInStep && sync.importer !== undefined) {
      syncReport.import = await this.#queueIsFree(report)
        ? await this.#locked('the import', sync.importer)
        : { skipped: 'the tick did not get to drain the queue, so nothing is read' };
    }
    if (mayKeepInStep && sync.forge !== undefined) {
      syncReport.forge = await this.#queueIsFree(report)
        ? await this.#locked('the forge pass', sync.forge)
        : { skipped: 'the tick did not get to drain the queue, so nothing is read' };
    }
    return sync === null ? report : { ...report, sync: syncReport };
  }

  /**
   * Runs one job under the single tick lock. A job that throws is logged and
   * answered as skipped: keeping in step is never worth losing the tick's own
   * account of what it did to the queue.
   */
  async #locked<T>(name: string, job: () => Promise<T>): Promise<T | { skipped: string }> {
    const outcome = await this.#repository.withTickLock(async (): Promise<{ done: T } | { failed: string }> => {
      try {
        return { done: await job() };
      } catch (error) {
        const reason = describeUnknown(error);
        this.#logger.error(`${name} failed`, { reason });
        return { failed: reason };
      }
    });
    if (outcome === null) {
      return { skipped: 'another tick holds the lock' };
    }
    return 'done' in outcome ? outcome.done : { skipped: `${name} failed: ${outcome.failed}` };
  }

  /** Whether the queue ran and is not waiting out a refusal, which is when anything may read. */
  async #queueIsFree(report: TickReport): Promise<boolean> {
    if (report.skipped !== undefined || report.pausedUntil !== undefined) {
      return false;
    }
    const pause = await this.#repository.getPause();
    return pause === null || !pause.isActive(this.#clock.now());
  }

  async #maybeAudit(report: TickReport): Promise<void> {
    const audit = this.#audit;
    if (audit === null || !(await this.#worthReading(report))) {
      return;
    }
    // Stamped before the pass rather than after it, so that a pass which fails —
    // or which the machine interrupts — still holds the cadence. A report that
    // could not be written is a report worth waiting for, not one worth asking
    // for again in five minutes out of the allowance the queue is pacing itself
    // against.
    await writeLastAuditAttemptAt(this.#repository, this.#clock.now());
    const read = await this.#repository.withTickLock(async () => {
      try {
        await audit();
      } catch (error) {
        // A report that could not be written is worth a loud line and nothing
        // more: it changes nothing, and losing the tick's own account of the work
        // it did would cost more than the report is worth.
        this.#logger.error('the board report could not be written', { reason: describeUnknown(error) });
      }
      return true;
    });
    if (read === null) {
      this.#logger.info('the board was not read: another tick holds the lock');
    }
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
