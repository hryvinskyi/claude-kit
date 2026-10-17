import { StaleAction } from '../domain/errors.ts';
import { requireAction } from './action-lookup.ts';
import { actionView } from './list-actions.ts';
import type { ActionView } from './list-actions.ts';
import type { ActionRepository, Clock } from './ports.ts';

/**
 * Putting a dead end back on the queue.
 *
 * Nothing retries itself: an action is blocked because something outside this
 * system has to change — an option added to the board, a repository that came
 * back — and a machine that pressed the button again on its own would spend the
 * allowance proving the same point every five minutes. Retrying gives the action
 * its attempts back and keeps the error, which is the record of what was fixed.
 */
export class RetryAction {
  readonly #repository: ActionRepository;
  readonly #clock: Clock;

  constructor(repository: ActionRepository, clock: Clock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async execute(id: string): Promise<ActionView> {
    const action = await requireAction(this.#repository, id);
    action.retry(this.#clock.now());
    await this.#repository.update(action);
    return actionView(action);
  }

  /**
   * Every blocked action at once, answering the ids that went back on the queue.
   *
   * One that another writer changed while this was running is left where it is
   * and left out of the answer: it is no longer the action that was read, and the
   * list says exactly which ones moved.
   */
  async allBlocked(): Promise<string[]> {
    const now = this.#clock.now();
    const blocked = await this.#repository.list({ states: ['blocked'] });
    const retried: string[] = [];
    for (const action of blocked) {
      action.retry(now);
      try {
        await this.#repository.update(action);
      } catch (error) {
        if (error instanceof StaleAction) {
          continue;
        }
        throw error;
      }
      retried.push(action.id);
    }
    return retried;
  }
}
