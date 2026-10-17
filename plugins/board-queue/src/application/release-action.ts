import { requireAction } from './action-lookup.ts';
import { actionView } from './list-actions.ts';
import type { ActionView } from './list-actions.ts';
import type { ActionRepository, Clock } from './ports.ts';

/**
 * The thing a held action was waiting for has happened.
 *
 * Only a held action can be released; asking this of anything else is a mistake
 * about what is in the queue, and it says so rather than quietly doing nothing.
 */
export class ReleaseAction {
  readonly #repository: ActionRepository;
  readonly #clock: Clock;

  constructor(repository: ActionRepository, clock: Clock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async execute(id: string): Promise<ActionView> {
    const action = await requireAction(this.#repository, id);
    action.release(this.#clock.now());
    await this.#repository.update(action);
    return actionView(action);
  }
}
