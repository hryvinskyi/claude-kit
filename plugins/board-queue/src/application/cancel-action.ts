import { requireAction } from './action-lookup.ts';
import { actionView } from './list-actions.ts';
import type { ActionView } from './list-actions.ts';
import type { ActionRepository, Clock } from './ports.ts';

/**
 * Taking an action off the queue for good.
 *
 * Work that is already running is not cancelled here: it is out at the API, and a
 * row that reads "cancelled" while the write lands would be a lie about the board.
 */
export class CancelAction {
  readonly #repository: ActionRepository;
  readonly #clock: Clock;

  constructor(repository: ActionRepository, clock: Clock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async execute(id: string): Promise<ActionView> {
    const action = await requireAction(this.#repository, id);
    action.cancel(this.#clock.now());
    await this.#repository.update(action);
    return actionView(action);
  }
}
