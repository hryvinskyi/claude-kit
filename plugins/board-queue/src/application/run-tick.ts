import type { BudgetPolicy } from './budget-policy.ts';
import { describeUnknown } from './drain-queue.ts';
import type { DrainQueue, TickReport } from './drain-queue.ts';
import {
  readLastAudit,
  readLastAuditAttemptAt,
  readLastBudget,
  writeLastAuditAttemptAt,
} from './queue-meta.ts';
import type { ActionRepository, Clock, Logger } from './ports.ts';

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

  constructor(deps: RunTickDeps) {
    this.#drain = deps.drain;
    this.#repository = deps.repository;
    this.#policy = deps.policy;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#audit = deps.audit ?? null;
  }

  async run(): Promise<TickReport> {
    const report = await this.#drain.run();
    const audit = this.#audit;
    if (audit === null || !(await this.#worthReading(report))) {
      return report;
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
    return report;
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
    if (report.skipped !== undefined || report.pausedUntil !== undefined) {
      return false;
    }
    const pause = await this.#repository.getPause();
    if (pause !== null && pause.isActive(this.#clock.now())) {
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
