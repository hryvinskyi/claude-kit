import type { Action, ActionState, RowAtBlock } from '../domain/action.ts';
import type { BoardKey } from '../domain/board-directory.ts';
import type { FieldCatalog } from '../domain/catalog.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { Config } from '../domain/config.ts';
import { BoardQueueError, RefusedByRule, StaleAction, TransientFailure } from '../domain/errors.ts';
import type { ErrorCategory } from '../domain/errors.ts';
import type { ActionResult, ExecutionContext } from '../domain/kinds/action-kind.ts';
import type { KindRegistry } from '../domain/kinds/registry.ts';
import type { QueuePause } from '../domain/queue-pause.ts';
import type { RateBudget } from '../domain/rate-budget.ts';
import type { BoardRouter } from './board-router.ts';
import type { BudgetPolicy } from './budget-policy.ts';
import { catalogWarnings, unansweredOptions, wantedOptions } from './catalog-warnings.ts';
import { leasedLane, LOCK_LOST, TickLockLost } from './leased-gateways.ts';
import { LimiterWait } from './limiter-wait.ts';
import { planReplay, replayNote, rowReadingsOf } from './option-wait.ts';
import type { ReplayPlan } from './option-wait.ts';
import { writeLastBudget, writeLastTickAt, writeSecondaryHits } from './queue-meta.ts';
import type { ActionRepository, Clock, Logger, Sleeper, TickLease } from './ports.ts';

/** What one run of the worker did, in the words a log line and a status report use. */
export type TickReport = {
  /** Present when the tick did not run at all, and why. */
  skipped?: string;
  /** Present when queued work was left for a later pass on purpose, and why. */
  passedOver?: string;
  /** Why the loop stopped, when it stopped for something other than an empty queue. */
  stoppedBecause?: string;
  /**
   * Set when the tick found the lock taken by another pass and stopped: nothing
   * more in this tick is this pass's to do, the queue's notes and the report included.
   */
  lockLost?: true;
  /** Actions claimed and run, whatever became of them. */
  executed: number;
  done: number;
  blocked: number;
  failed: number;
  /** Conditional work whose condition did not hold; it ended skipped, without writing anything. */
  notApplied: number;
  /** Put back on the queue: a wait the action was not to blame for, or a failure worth another go. */
  requeued: number;
  /** Actions blocked by an earlier tick that the board can now answer for. */
  unblocked: number;
  /** Actions a previous run died holding, put back at the start of this one. */
  recovered: number;
  /** Actions another writer changed while they ran; this tick's verdict on them was dropped. */
  stale: number;
  pausedUntil?: string;
  /** The allowance as the last answer of the tick reported it. */
  budget?: string;
};

type Tally = {
  executed: number;
  done: number;
  blocked: number;
  failed: number;
  notApplied: number;
  requeued: number;
  unblocked: number;
  recovered: number;
  stale: number;
};

/**
 * Which tally an action joins is decided by the state it ended in, not by the
 * road it took there: a transient failure that used its last attempt is a failure,
 * the same one with attempts to spare is a requeue, and neither has to say so
 * twice.
 */
const TALLY_OF_STATE: Partial<Record<ActionState, keyof Tally>> = {
  done: 'done',
  blocked: 'blocked',
  failed: 'failed',
  skipped: 'notApplied',
  queued: 'requeued',
};

type SettleContext = {
  now: Date;
  policy: BudgetPolicy;
  maxAttempts: number;
  /** What the board lacked and how the row read, when the plan keeps that record. */
  wait: OptionWait;
};

/** Which wanted values the board lacked when an action blocked, and how its row read then. */
type OptionWait = {
  missing: readonly string[];
  row: RowAtBlock | null;
};

const NO_WAIT: OptionWait = { missing: [], row: null };

/** The release plan of a kind that runs its payload as it is. */
const NOTHING_NARROWED: ReplayPlan = { keys: [], guard: {}, leftOut: new Map() };

type FailurePlan = {
  /** What becomes of the action that met this failure. */
  settle(action: Action, error: BoardQueueError, ctx: SettleContext): void;
  /** Whether the failure is about the queue rather than the action, so the queue waits. */
  readonly pausesQueue: boolean;
  /** Whether anything else may run in this tick afterwards. */
  readonly stopsTick: boolean;
  /** Whether the action is to remember which wanted values the board lacked an option for. */
  readonly recordsMissingOptions: boolean;
};

/**
 * A refusal that was never about the work: the allowance, the burst limiter, a
 * credential nobody here can mend. The action goes back untouched — counting an
 * attempt against it would give up on work that was never wrong — and the queue
 * waits instead of asking the same question forty more times this minute.
 */
const QUEUE_LEVEL: FailurePlan = {
  settle: (action, _error, ctx) => {
    action.requeue(ctx.now);
  },
  pausesQueue: true,
  stopsTick: true,
  recordsMissingOptions: false,
};

/** A dead end: nothing this system can do again will change the answer. */
const NEEDS_A_PERSON: FailurePlan = {
  settle: (action, error, ctx) => {
    action.block(ctx.now, error);
  },
  pausesQueue: false,
  stopsTick: false,
  recordsMissingOptions: false,
};

/**
 * A dead end only until somebody adds an option to the board. The action keeps
 * which of its values the board lacked, because that is all the board learning
 * them answers for: the rest of the action was answerable all along.
 */
const AWAITS_AN_OPTION: FailurePlan = {
  settle: (action, error, ctx) => {
    action.block(ctx.now, error, ctx.wait.missing, ctx.wait.row);
  },
  pausesQueue: false,
  stopsTick: false,
  recordsMissingOptions: true,
};

/**
 * Conditional work whose condition no longer held: nothing was written, and
 * running it again would meet the same answer, so it ends here and asks nobody
 * for anything.
 */
const NO_LONGER_APPLIES: FailurePlan = {
  settle: (action, error, ctx) => {
    action.skip(ctx.now, error.describe());
  },
  pausesQueue: false,
  stopsTick: false,
  recordsMissingOptions: false,
};

/** A moment's fault: it waits out the policy's curve and comes back, a few times. */
const WORTH_ANOTHER_GO: FailurePlan = {
  settle: (action, error, ctx) => {
    action.failTransient(ctx.now, error.describe(), ctx.maxAttempts, ctx.policy.backoffSec(action.attempts));
  },
  pausesQueue: false,
  stopsTick: false,
  recordsMissingOptions: false,
};

/**
 * What each failure does to the action that met it, looked up by the failure's
 * own category. The gateways decide what a refusal was; this table decides what
 * it costs, and a failure nobody named here is treated as a moment's fault —
 * the safe reading, because it is the only one that neither gives up on work nor
 * hides it.
 */
const PLAN_BY_CATEGORY: ReadonlyMap<ErrorCategory, FailurePlan> = new Map<ErrorCategory, FailurePlan>([
  ['primary-rate-limited', QUEUE_LEVEL],
  ['secondary-rate-limited', QUEUE_LEVEL],
  ['credential-rejected', QUEUE_LEVEL],
  ['option-not-found', AWAITS_AN_OPTION],
  ['ambiguous-option', NEEDS_A_PERSON],
  ['issue-not-found', NEEDS_A_PERSON],
  ['refused-by-rule', NEEDS_A_PERSON],
  ['readback-mismatch', NEEDS_A_PERSON],
  ['invalid-issue-ref', NEEDS_A_PERSON],
  ['unknown-kind', NEEDS_A_PERSON],
  ['transient-failure', WORTH_ANOTHER_GO],
  ['precondition-unmet', NO_LONGER_APPLIES],
]);

/** The state of one action after the tick decided about it. */
type Step = {
  /** Null when another writer had changed the row and this tick's verdict was dropped. */
  state: ActionState | null;
  stopsTick: boolean;
  /** Set when the tick lock was found taken by another pass: nothing more is this pass's to do. */
  lockLost?: boolean;
  reason?: string;
  pausedUntil?: string;
};

export type DrainQueueDeps = {
  repository: ActionRepository;
  /** Hands each action the board, and the issues, of the repository it is about. */
  boards: BoardRouter;
  kinds: KindRegistry;
  policy: BudgetPolicy;
  clock: Clock;
  sleeper: Sleeper;
  logger: Logger;
  config: Config;
};

/**
 * One run of the single writer.
 *
 * Everything outward this system does happens here, one action at a time, behind
 * one lock: the board and the issues have one hourly allowance shared with every
 * person working on the same account, and the only way to keep a schedule inside
 * it is to spend it serially, to read what each answer says is left, and to stop
 * early rather than to find out by being refused.
 *
 * The tick is deliberately short-tempered. It stops on the first refusal that
 * belongs to the queue rather than to an action, it never starts work it cannot
 * see the allowance for, and it leaves a dead end alone until a person or the
 * board itself changes something.
 */
export class DrainQueue {
  readonly #repository: ActionRepository;
  readonly #boards: BoardRouter;
  readonly #kinds: KindRegistry;
  readonly #policy: BudgetPolicy;
  readonly #clock: Clock;
  readonly #sleeper: Sleeper;
  readonly #logger: Logger;
  readonly #config: Config;
  readonly #wait: LimiterWait;

  constructor(deps: DrainQueueDeps) {
    this.#repository = deps.repository;
    this.#boards = deps.boards;
    this.#kinds = deps.kinds;
    this.#policy = deps.policy;
    this.#clock = deps.clock;
    this.#sleeper = deps.sleeper;
    this.#logger = deps.logger;
    this.#config = deps.config;
    this.#wait = new LimiterWait({ repository: deps.repository, policy: deps.policy, logger: deps.logger });
  }

  /** One pass; an action `passOver` names stays queued this time, holding its place. */
  async run(passOver?: (action: Action) => boolean): Promise<TickReport> {
    const report = await this.#repository.withTickLock((lease) => this.#tick(lease, passOver));
    if (report === null) {
      return notRun('another tick holds the lock');
    }
    return report;
  }

  async #tick(lease: TickLease, passOver: ((action: Action) => boolean) | undefined): Promise<TickReport> {
    const recovered = await this.#putBackWhatAnEarlierRunLeftInHand();

    const waiting = await this.#waitingOut();
    if (waiting !== null) {
      return { ...emptyTally(), recovered, skipped: waiting };
    }

    const tally = emptyTally();
    tally.recovered = recovered;
    const probed = await this.#probe();
    if (probed.pause !== null) {
      return {
        ...tally,
        skipped: probed.pause.describe(),
        pausedUntil: probed.pause.until.toISOString(),
      };
    }

    const catalogsBefore = await this.#catalogMoments();
    let budget = probed.budget;
    let stoppedBecause: string | undefined;
    let pausedUntil: string | undefined;
    for (;;) {
      const mayStart = this.#policy.mayStart(budget, tally.executed);
      if (!mayStart.ok) {
        stoppedBecause = mayStart.reason;
        break;
      }
      if (!(await lease.stillHeld())) {
        return this.#stoppedForTheLock(tally);
      }
      const action = await this.#repository.claimNextRunnable(this.#clock.now(), passOver);
      if (action === null) {
        break;
      }
      if (tally.executed > 0) {
        // The gap belongs between two actions. Taking it before the work rather
        // than after it means a tick that has finished never sits waiting, and a
        // tick that found nothing to do never waits at all.
        await this.#sleeper.sleep(this.#config.worker.paceMs);
      }
      tally.executed += 1;
      const step = await this.#runOne(action, lease);
      budget = this.#boards.lastBudget() ?? budget;
      count(tally, step.state);
      if (step.lockLost === true) {
        return this.#stoppedForTheLock(tally);
      }
      if (step.state === 'done') {
        // An action that got through is the proof the burst limiter let go, and
        // the proof is only good at this moment: a refusal later in this same tick
        // starts its own doubling, and a count cleared after the loop would wipe
        // the hit that refusal just recorded.
        await writeSecondaryHits(this.#repository, 0);
      }
      if (step.stopsTick) {
        stoppedBecause = step.reason;
        pausedUntil = step.pausedUntil;
        break;
      }
    }

    tally.unblocked = (await this.#unblockWhatTheBoardsCanNowAnswer(catalogsBefore)).length;
    if (budget !== null) {
      // What the last answer of the tick said, not what the probe said before the
      // spending: a report that quotes the opening allowance understates the hour.
      await writeLastBudget(this.#repository, budget);
    }
    await writeLastTickAt(this.#repository, this.#clock.now());

    const report: TickReport = { ...tally };
    if (stoppedBecause !== undefined) {
      report.stoppedBecause = stoppedBecause;
    }
    if (pausedUntil !== undefined) {
      report.pausedUntil = pausedUntil;
    }
    if (budget !== null) {
      report.budget = budget.describe();
    }
    this.#logger.info('tick', { ...report });
    return report;
  }

  /**
   * The report of a pass that found the lock taken by another one. It writes
   * nothing more — not even the queue's own notes — because everything a tick
   * does after its work is the holder's to do, and the holder is the other pass.
   */
  #stoppedForTheLock(tally: Tally): TickReport {
    const report: TickReport = { ...tally, stoppedBecause: LOCK_LOST, lockLost: true };
    this.#logger.warn('the tick lock was taken by another pass; this one stopped', { ...report });
    return report;
  }

  /**
   * Puts back whatever an earlier run died holding.
   *
   * One process executes actions, and it holds the tick lock while it does, so an
   * action found running at the start of a run is not somebody else's work in
   * progress: it is a run that was killed, or a machine that went down, or a write
   * to the queue that failed after the work itself was decided. Nothing else would
   * ever free it. Cancel and retry both refuse a running action on principle, and
   * the claim passes over every later action on the same issue while an older one
   * is still running — so one such row wedges its issue for good, silently, and
   * the only sign is a count that never goes down.
   *
   * The attempt the claim charged is given back, because the work never had its
   * turn. Running it again is safe by design and not by luck: anything this system
   * posts carries a marker it looks for first, adding a row to the board hands back
   * the row that is already there, and a close reads the issue's state before it
   * changes anything.
   */
  async #putBackWhatAnEarlierRunLeftInHand(): Promise<number> {
    let recovered = 0;
    for (const action of await this.#repository.list({ states: ['running'] })) {
      action.requeue(this.#clock.now());
      try {
        await this.#repository.update(action);
      } catch (error) {
        if (!(error instanceof StaleAction)) {
          throw error;
        }
        continue;
      }
      recovered += 1;
      this.#logger.warn('an unfinished action from an earlier run was put back', {
        action: action.id,
        kind: action.kind,
        attempts: action.attempts,
      });
    }
    return recovered;
  }

  /**
   * Whether the queue is still serving a wait. A wait that has run out is cleared
   * here — but the count of burst refusals behind it is not, because that count is
   * what makes the next wait longer than this one.
   */
  async #waitingOut(): Promise<string | null> {
    const pause = await this.#repository.getPause();
    if (pause === null) {
      return null;
    }
    const now = this.#clock.now();
    if (pause.isActive(now)) {
      return pause.describe();
    }
    await this.#repository.setPause(null);
    this.#logger.info('the wait has run out', { reason: pause.reason, hits: pause.consecutiveHits });
    return null;
  }

  /**
   * What the allowance says before anything is spent. A probe that is refused by a
   * limiter settles the whole tick; a probe that fails for any other reason leaves
   * the allowance unknown, and an unknown allowance is not spent.
   */
  async #probe(): Promise<{ budget: RateBudget | null; pause: QueuePause | null }> {
    try {
      const budget = await this.#boards.probeBudget();
      await writeLastBudget(this.#repository, budget);
      return { budget, pause: null };
    } catch (error) {
      const pause = await this.#wait.after(error, this.#clock.now());
      if (pause === null) {
        this.#logger.warn('the allowance could not be read', { reason: describeUnknown(error) });
      }
      return { budget: null, pause };
    }
  }

  async #runOne(action: Action, lease: TickLease): Promise<Step> {
    let outcome: ActionResult | null = null;
    let failure: unknown = null;
    try {
      outcome = await this.#kinds.get(action.kind).execute(action.payload, this.#contextFor(action, lease));
    } catch (error) {
      failure = error;
    }

    const now = this.#clock.now();
    let step: Step = { state: null, stopsTick: false };
    if (failure instanceof TickLockLost) {
      // The pass that holds the lock now runs this action; it goes back for that
      // pass untouched, with the attempt the claim charged, as an action an
      // earlier run died holding does.
      action.requeue(now);
      step = { state: action.state, stopsTick: true, lockLost: true, reason: failure.message };
    } else if (outcome !== null) {
      action.succeed(now, summarise(outcome));
      this.#logger.info('action done', { action: action.id, kind: action.kind, summary: outcome.summary });
      step = { state: action.state, stopsTick: false };
    } else {
      let error = asBoardQueueError(failure);
      let plan = planFor(error);
      let wait = NO_WAIT;
      if (plan.recordsMissingOptions) {
        try {
          wait = await this.#whatTheBoardLacks(action);
        } catch (refusal) {
          if (!(refusal instanceof BoardQueueError)) {
            throw refusal;
          }
          // Reading the row was refused for the queue's sake — a limit, a
          // credential — so the action goes back as any work stopped by that
          // refusal does, and meets its missing option again after the wait.
          error = refusal;
          plan = planFor(refusal);
        }
      }
      plan.settle(action, error, {
        now,
        policy: this.#policy,
        maxAttempts: this.#config.worker.maxAttempts,
        wait,
      });
      const pause = plan.pausesQueue ? await this.#wait.after(error, now) : null;
      this.#logger.warn('action stopped', {
        action: action.id,
        kind: action.kind,
        state: action.state,
        attempts: action.attempts,
        reason: error.describe(),
      });
      step = { state: action.state, stopsTick: plan.stopsTick, reason: error.describe() };
      if (pause !== null) {
        step.pausedUntil = pause.until.toISOString();
      }
    }

    try {
      await this.#repository.update(action);
    } catch (error) {
      if (!(error instanceof StaleAction)) {
        throw error;
      }
      // Somebody filed, cancelled or retried this row while it ran, so the row is
      // no longer the one this verdict was reached about. It is left as they left
      // it and read again from scratch next time.
      this.#logger.warn('an action changed while it ran', { action: action.id, kind: action.kind });
      return { ...step, state: null };
    }
    return step;
  }

  /**
   * Which of the action's wanted values its board offers no option for, measured
   * against the catalog that just refused it — a miss is only final after a fresh
   * read, which leaves that read in the store — and, for a kind a release
   * narrows, how the row reads for every other value the action wants, so the
   * release can guard each of them by that reading. With no catalog to measure
   * against the answer is empty, and the action waits for a person like any other
   * block.
   *
   * The row costs finding it in the board's listing (a walk of the board, unless
   * one is still fresh) and one read of it by its id; nothing when the action
   * wants no other value or its kind does not narrow. A refusal that belongs to
   * the queue is thrown, so the tick stops spending; any other failure to read
   * leaves no reading, and the release then guards nothing it cannot.
   */
  async #whatTheBoardLacks(action: Action): Promise<OptionWait> {
    if (action.issueRef === null) {
      return NO_WAIT;
    }
    const board = this.#boards.directory.find(action.issueRef.repoFullName());
    const cached = board === null ? null : await this.#repository.getCatalog(board.key);
    if (cached === null) {
      return NO_WAIT;
    }
    const missing = unansweredOptions(action.payload, cached.catalog);
    if (missing.length === 0) {
      return NO_WAIT;
    }
    const others = wantedKeys(action.payload).filter((key) => !missing.includes(key));
    const narrows = this.#kinds.has(action.kind) && this.#kinds.get(action.kind).narrowsOnRelease;
    if (!narrows || others.length === 0) {
      return { missing, row: {} };
    }
    return { missing, row: await this.#readRow(action, action.issueRef, others, cached.catalog) };
  }

  /** The row's values for these payload keys, or null when the board did not answer for a reason of the moment. */
  async #readRow(
    action: Action,
    ref: IssueRef,
    keys: readonly string[],
    catalog: FieldCatalog,
  ): Promise<RowAtBlock | null> {
    try {
      const board = this.#boards.laneOf(ref).board;
      const listed = await board.findItem(ref);
      const row = listed === null ? null : await board.readItemById(listed.itemId);
      return rowReadingsOf(keys, catalog, row);
    } catch (error) {
      if (error instanceof BoardQueueError && planFor(error).pausesQueue) {
        throw error;
      }
      this.#logger.warn('the row could not be read', { action: action.id, reason: describeUnknown(error) });
      return null;
    }
  }

  /** When each board's catalog was last fetched, before this tick spends anything. */
  async #catalogMoments(): Promise<Map<BoardKey, number | null>> {
    const moments = new Map<BoardKey, number | null>();
    for (const { placement } of this.#boards.lanes()) {
      const cached = await this.#repository.getCatalog(placement.key);
      moments.set(placement.key, cached?.fetchedAt.getTime() ?? null);
    }
    return moments;
  }

  /**
   * Gives back the actions a person already answered for.
   *
   * An action blocked because its board had no such option is waiting on one
   * thing: somebody adding it. When a tick reads a fresh catalog of that board and
   * the option is there, the decision has been made — writing that value now is
   * not a second decision, it is the rest of the first one. The action's other
   * values were not written when it blocked, and the row may be moved on by a
   * person on the board or a writer this queue never hears from, before the
   * release or after it: each goes back guarded by what the row read at the
   * block, and the write leaves alone any field that reads otherwise when it is
   * about to happen. A value with no such reading, or one the board no longer
   * offers, is left out, and the note names each one and why. The action carries
   * that payload from then on, so a later retry runs it too. The release itself
   * reads nothing from the board.
   *
   * An action blocked without a record of which values were missing — blocked
   * before the queue kept one, or by a release that does not keep it — is left
   * for a person. Nothing else leaves the blocked state on its own. Each board's
   * options are its own, so an action is only ever measured against the catalog
   * of the board that carries its issue.
   */
  async #unblockWhatTheBoardsCanNowAnswer(fetchedBefore: ReadonlyMap<BoardKey, number | null>): Promise<string[]> {
    const fresh = new Map<BoardKey, FieldCatalog>();
    for (const [board, before] of fetchedBefore) {
      const cached = await this.#repository.getCatalog(board);
      if (cached !== null && cached.fetchedAt.getTime() !== before) {
        fresh.set(board, cached.catalog);
      }
    }
    if (fresh.size === 0) {
      return [];
    }
    return this.#requeueAgainst(fresh);
  }

  async #requeueAgainst(fresh: ReadonlyMap<BoardKey, FieldCatalog>): Promise<string[]> {
    const now = this.#clock.now();
    const freed: string[] = [];
    for (const action of await this.#repository.list({ states: ['blocked'] })) {
      const ref = action.issueRef;
      if (action.blockedReason !== 'option-not-found' || ref === null) {
        continue;
      }
      const board = this.#boards.directory.find(ref.repoFullName());
      const catalog = board === null ? undefined : fresh.get(board.key);
      if (catalog === undefined || action.missingOptions.length === 0 || !this.#kinds.has(action.kind)) {
        continue;
      }
      const unanswered = new Set(unansweredOptions(action.payload, catalog));
      if (action.missingOptions.some((key) => unanswered.has(key))) {
        continue;
      }
      const kind = this.#kinds.get(action.kind);
      try {
        const plan = kind.narrowsOnRelease
          ? planReplay({
            missing: action.missingOptions,
            wanted: wantedKeys(action.payload),
            unanswered,
            atBlock: action.rowAtBlock,
            earlier: action.writeGuard,
          })
          : NOTHING_NARROWED;
        const replay: unknown = kind.replayFor(action.payload, plan.keys);
        // The release is judged on what will run, not on what was filed: a value
        // the replay leaves out cannot keep it waiting.
        if (replay === null || replay === undefined || catalogWarnings(replay, catalog).length > 0) {
          continue;
        }
        action.resumeWith(now, replay, replayNote(action.payload, replay, plan), plan.guard);
      } catch (error) {
        const reason = error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
        this.#logger.warn('a blocked action could not be released', { action: action.id, kind: action.kind, reason });
        action.refuseRelease(now, reason);
      }
      try {
        await this.#repository.update(action);
      } catch (error) {
        if (!(error instanceof StaleAction)) {
          throw error;
        }
        continue;
      }
      if (action.state !== 'queued') {
        continue;
      }
      this.#logger.info('requeued: the board now offers the option it was waiting for', {
        action: action.id,
        kind: action.kind,
        note: action.result,
      });
      freed.push(action.id);
    }
    return freed;
  }

  /**
   * What the action runs with: the gateways of the board that carries its issue,
   * each write made only while this pass still holds the tick lock — a pass that
   * lost it would otherwise write what the pass holding it writes too.
   * An action that names no issue, or names a repository no board carries any
   * longer, has no board to run against, and is refused rather than sent to one.
   */
  #contextFor(action: Action, lease: TickLease): ExecutionContext {
    if (action.issueRef === null) {
      throw new RefusedByRule(`${action.kind} names no issue, so no board carries it`);
    }
    const lane = leasedLane(this.#boards.laneOf(action.issueRef), lease);
    return {
      board: lane.board,
      issues: lane.issues,
      clock: this.#clock,
      sleeper: this.#sleeper,
      paceMs: this.#config.worker.paceMs,
      refusedStatus: this.#config.refusedStatus,
      actionId: action.id,
      enqueuedAt: action.createdAt,
      writeGuard: action.writeGuard ?? {},
    };
  }
}

/** The report of a tick that did not run, and why. */
export function notRun(reason: string): TickReport {
  return { ...emptyTally(), skipped: reason };
}

/** What a failure costs, by its category; a failure nobody named is a moment's fault. */
function planFor(error: BoardQueueError): FailurePlan {
  return PLAN_BY_CATEGORY.get(error.category) ?? WORTH_ANOTHER_GO;
}

function emptyTally(): Tally {
  return {
    executed: 0,
    done: 0,
    blocked: 0,
    failed: 0,
    notApplied: 0,
    requeued: 0,
    unblocked: 0,
    recovered: 0,
    stale: 0,
  };
}

function count(tally: Tally, state: ActionState | null): void {
  if (state === null) {
    tally.stale += 1;
    return;
  }
  const bucket = TALLY_OF_STATE[state];
  if (bucket !== undefined) {
    tally[bucket] += 1;
  }
}

/** The payload keys of every board value the payload wants. */
function wantedKeys(payload: unknown): string[] {
  return wantedOptions(payload).map(([key]) => key);
}

/** The summary a person reads, and under it the values the board actually holds. */
function summarise(outcome: ActionResult): string {
  const readback = outcome.readback;
  if (readback === undefined || Object.keys(readback).length === 0) {
    return outcome.summary;
  }
  return `${outcome.summary}\n${JSON.stringify(readback)}`;
}

/**
 * Anything thrown that this system has no name for is read as a moment's fault:
 * a mistake in this code looks exactly like one, and treating it as a dead end
 * would quietly bury work that nothing was wrong with.
 */
function asBoardQueueError(failure: unknown): BoardQueueError {
  if (failure instanceof BoardQueueError) {
    return failure;
  }
  return new TransientFailure(`the action failed unexpectedly: ${describeUnknown(failure)}`);
}

/** A sentence for something thrown that is not one of this system's own failures. */
export function describeUnknown(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message;
  }
  return typeof failure === 'string' ? failure : 'the reason was not stated';
}
