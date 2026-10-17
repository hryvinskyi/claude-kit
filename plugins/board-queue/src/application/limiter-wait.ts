import { BoardQueueError } from '../domain/errors.ts';
import type { QueuePause } from '../domain/queue-pause.ts';
import type { BudgetPolicy } from './budget-policy.ts';
import { readSecondaryHits, writeSecondaryHits } from './queue-meta.ts';
import type { ActionRepository, Logger } from './ports.ts';

export type LimiterWaitDeps = {
  repository: ActionRepository;
  policy: BudgetPolicy;
  logger: Logger;
};

/** The one failure whose wait doubles, so the one whose refusals are counted. */
function isBurstRefusal(error: BoardQueueError): boolean {
  return error.category === 'secondary-rate-limited';
}

/**
 * What every pass over the API does when a refusal was never about the work.
 *
 * The allowance and the burst limiter belong to the account, not to whatever was
 * being asked for when they said no: one answer of theirs ends the pass that met
 * it and every other pass until the wait is out. Writing the work and reading the
 * board are two different passes, and they share this because a wait one of them
 * earned must bind the other — a report that kept reading through an exhausted
 * hour would spend the allowance the queue is waiting for.
 */
export class LimiterWait {
  readonly #repository: ActionRepository;
  readonly #policy: BudgetPolicy;
  readonly #logger: Logger;

  constructor(deps: LimiterWaitDeps) {
    this.#repository = deps.repository;
    this.#policy = deps.policy;
    this.#logger = deps.logger;
  }

  /**
   * Puts the queue to sleep when this failure asks for it and answers what it
   * decided; nothing, when the failure is the caller's own business.
   *
   * The count of consecutive burst refusals is read from the queue's own notes
   * rather than from the wait in force: a pass clears an expired wait before it
   * runs, so a doubling that read the cleared wait would start from the base
   * every time and never double.
   */
  async after(error: unknown, now: Date): Promise<QueuePause | null> {
    if (!(error instanceof BoardQueueError)) {
      return null;
    }
    const hits = await readSecondaryHits(this.#repository);
    const pause = this.#policy.pauseFor(error, hits, now);
    if (pause === null) {
      return null;
    }
    if (isBurstRefusal(error)) {
      await writeSecondaryHits(this.#repository, hits + 1);
    }
    await this.#repository.setPause(pause);
    this.#logger.warn('the queue is waiting', { until: pause.until.toISOString(), reason: pause.reason });
    return pause;
  }
}
