import type { WorkerConfig } from '../domain/config.ts';
import type { BoardQueueError, ErrorCategory } from '../domain/errors.ts';
import { PrimaryRateLimited, SecondaryRateLimited } from '../domain/errors.ts';
import { QueuePause } from '../domain/queue-pause.ts';
import type { RateBudget } from '../domain/rate-budget.ts';

/** Either the worker may start another action, or a sentence saying why it may not. */
export type StartDecision = { ok: true } | { ok: false; reason: string };

/** The first wait a failed attempt earns; every further one doubles it. */
const BACKOFF_FIRST_SEC = 30;
/** However often an action has failed, it never waits longer than this. */
const BACKOFF_CAP_SEC = 900;
/** A rejected credential is a person's problem; the queue looks again in a quarter of an hour. */
const CREDENTIAL_PAUSE_SEC = 15 * 60;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

type PauseContext = {
  now: Date;
  /** Burst refusals already counted before this one, so the first wait is the base. */
  hits: number;
  config: WorkerConfig;
};

type PauseRule = (error: BoardQueueError, ctx: PauseContext) => QueuePause | null;

/**
 * Ties a rule to the error shape its category already guarantees. The lookup below
 * is what decides which rule runs; the guard only tells the compiler what the
 * category means, and answers nothing for a failure that does not carry what the
 * rule needs rather than inventing a wait.
 */
function ruleFor<E extends BoardQueueError>(
  is: (error: BoardQueueError) => error is E,
  pause: (error: E, ctx: PauseContext) => QueuePause,
): PauseRule {
  return (error, ctx) => (is(error) ? pause(error, ctx) : null);
}

const isPrimary = (error: BoardQueueError): error is PrimaryRateLimited => error instanceof PrimaryRateLimited;
const isSecondary = (error: BoardQueueError): error is SecondaryRateLimited => error instanceof SecondaryRateLimited;

/**
 * Which failures stop the whole queue, and for how long, looked up by the
 * failure's own category. A failure that is not named here is about the action
 * that met it, not about the queue, so it stops nothing — and teaching the queue
 * about another kind of refusal is an entry here rather than a branch in the
 * worker.
 */
const PAUSE_RULES: ReadonlyMap<ErrorCategory, PauseRule> = new Map<ErrorCategory, PauseRule>([
  [
    'primary-rate-limited',
    ruleFor(isPrimary, (error) => QueuePause.forPrimary(error.resetAt)),
  ],
  [
    'secondary-rate-limited',
    ruleFor(isSecondary, (error, ctx) => QueuePause.forSecondaryAfterHits(
      ctx.now,
      error.retryAfterSec,
      ctx.hits,
      ctx.config.secondaryBaseSec,
      ctx.config.secondaryCapSec,
    )),
  ],
  [
    'credential-rejected',
    (error, ctx) => new QueuePause({
      until: new Date(ctx.now.getTime() + CREDENTIAL_PAUSE_SEC * 1000),
      reason: error.describe(),
      consecutiveHits: 0,
    }),
  ],
]);

/**
 * How much of the allowance the worker is willing to spend, and how long it waits
 * when something tells it to stop.
 *
 * Every method here answers a question and changes nothing: the decisions are
 * taken in one place, with names, so the worker reads as a sequence of choices
 * rather than as arithmetic, and so the numbers can be argued with in a test that
 * needs no queue at all.
 */
export class BudgetPolicy {
  readonly #config: WorkerConfig;

  constructor(config: WorkerConfig) {
    this.#config = config;
  }

  /**
   * Whether another action may start now.
   *
   * The floor exists because this system shares one hourly allowance with every
   * other session on the account: a worker that spends the last of it leaves the
   * people working alongside it unable to read a single issue. An allowance it
   * could not read at all counts as no room — a worker that cannot see what it is
   * spending does not spend.
   */
  mayStart(budget: RateBudget | null, executedThisTick: number): StartDecision {
    const cap = this.#config.perTickCap;
    if (executedThisTick >= cap) {
      return {
        ok: false,
        reason: `this tick has run ${String(executedThisTick)} actions, which is all one tick may run (${String(cap)})`,
      };
    }
    if (budget === null) {
      return {
        ok: false,
        reason: 'the allowance is unknown: the probe did not answer, and what cannot be seen is not spent',
      };
    }
    const floor = this.#config.graphqlFloor;
    if (budget.belowFloor(floor)) {
      return {
        ok: false,
        reason: `the ${budget.resource} allowance is ${String(budget.remaining)}, below the floor of `
          + `${String(floor)}; it comes back at ${budget.resetAt.toISOString()}`,
      };
    }
    return { ok: true };
  }

  /**
   * How long the queue waits after this failure, or nothing when the failure is
   * the action's own business.
   *
   * The count of burst refusals is handed in rather than read from the pause in
   * force: the worker clears an expired pause before it runs, so a doubling that
   * read the cleared pause would start from the base every time and never double.
   */
  pauseFor(error: BoardQueueError, consecutiveSecondaryHits: number, now: Date): QueuePause | null {
    const rule = PAUSE_RULES.get(error.category);
    if (rule === undefined) {
      return null;
    }
    return rule(error, { now, hits: consecutiveSecondaryHits, config: this.#config });
  }

  /**
   * How long an action waits after a failure that may well pass: half a minute,
   * doubling per attempt, never beyond a quarter of an hour. This is the only
   * place the curve exists; the aggregate is told the number and adds it.
   */
  backoffSec(attempts: number): number {
    const exponent = Math.max(0, Math.trunc(attempts) - 1);
    return Math.min(BACKOFF_FIRST_SEC * 2 ** exponent, BACKOFF_CAP_SEC);
  }

  /**
   * Whether the report-only pass has waited long enough and there is allowance to
   * spare for it. A report never competes with the work: it reads the whole board
   * and every open issue, which is worth doing only when nothing is queueing
   * behind it.
   */
  shouldAudit(lastAuditAt: Date | null, now: Date, budget: RateBudget | null): boolean {
    return readWhenDue(lastAuditAt, now, budget, {
      everyMs: this.#config.auditEveryHours * HOUR_MS,
      minRemaining: this.#config.auditMinRemaining,
    });
  }

  /**
   * Whether an import of the board's work has waited long enough and there is
   * allowance to spare for the read it starts. The same rule as the report's: the
   * queue's own writes keep priority, so a read that would eat into the reserve
   * waits for the next tick.
   */
  shouldImport(lastImportAt: Date | null, now: Date, budget: RateBudget | null, cadence: ImportCadence): boolean {
    return readWhenDue(lastImportAt, now, budget, {
      everyMs: cadence.everyMinutes * MINUTE_MS,
      minRemaining: cadence.minRemaining,
    });
  }
}

/** How often an import may read the board, and how much allowance it leaves alone. */
export type ImportCadence = {
  readonly everyMinutes: number;
  readonly minRemaining: number;
};

/**
 * Whether a read nobody is waiting for may start: the allowance is known and above
 * its reserve, and the gap since the last one has run out.
 */
function readWhenDue(
  last: Date | null,
  now: Date,
  budget: RateBudget | null,
  rule: { everyMs: number; minRemaining: number },
): boolean {
  if (budget === null || budget.remaining < rule.minRemaining) {
    return false;
  }
  if (last === null) {
    return true;
  }
  return now.getTime() - last.getTime() >= rule.everyMs;
}
