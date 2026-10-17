import type { Action, ActionState } from '../domain/action.ts';
import type { ActionFilter, ActionRepository } from './ports.ts';

/**
 * An action as everything outside this system reads it: plain values, moments
 * already written out, the payload as it was filed. The aggregate itself never
 * leaves the application — a printer that can call `cancel()` on what it is
 * printing is a mistake waiting for a careless line.
 */
export type ActionView = {
  id: string;
  kind: string;
  /** `owner/repo#number`, or nothing for work that names no issue. */
  ref: string | null;
  state: ActionState;
  attempts: number;
  notBefore: string | null;
  origin: string;
  createdAt: string;
  lastError: string | null;
  result: string | null;
  payload: unknown;
};

export function actionView(action: Action): ActionView {
  return {
    id: action.id,
    kind: action.kind,
    ref: action.issueRef === null ? null : action.issueRef.toString(),
    state: action.state,
    attempts: action.attempts,
    notBefore: action.notBefore === null ? null : action.notBefore.toISOString(),
    origin: action.origin,
    createdAt: action.createdAt.toISOString(),
    lastError: action.lastError,
    result: action.result,
    payload: action.payload,
  };
}

/** The queue, filtered, oldest first. */
export class ListActions {
  readonly #repository: ActionRepository;

  constructor(repository: ActionRepository) {
    this.#repository = repository;
  }

  async execute(filter: ActionFilter = {}): Promise<ActionView[]> {
    const actions = await this.#repository.list(filter);
    return actions.map(actionView);
  }
}
