import { couldReachStatus } from './field-request.ts';

/**
 * The board statuses that say somebody has started working on an issue, and the
 * rule that whoever moves an issue into one of them is the person it is assigned
 * to. A deployment that names no such status assigns nobody this way.
 */
export class StartOfWork {
  readonly #statuses: readonly string[];

  constructor(statuses: readonly string[]) {
    this.#statuses = statuses.filter((status) => status.trim() !== '');
  }

  /** Whether writing this wanted status text would start the work on an issue. */
  starts(wantedStatus: string): boolean {
    return couldReachStatus(wantedStatus, this.#statuses);
  }
}
