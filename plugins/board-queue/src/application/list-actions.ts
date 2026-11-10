import type { Action, ActionState } from '../domain/action.ts';
import { stoppedIssues } from '../domain/issue-order.ts';
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

/** The failed or blocked action another one waits behind on the same issue. */
export type FrontView = {
  id: string;
  state: ActionState;
};

/**
 * An action as a listing shows it: what it is, and, when it is waiting behind a
 * failed or blocked action on its issue, which one. Such an action will not run
 * until that one is retried or cancelled, however long the queue is left alone.
 */
export type ListedActionView = ActionView & {
  waitingBehind: FrontView | null;
};

/** The queue, filtered, oldest first. */
export class ListActions {
  readonly #repository: ActionRepository;

  constructor(repository: ActionRepository) {
    this.#repository = repository;
  }

  async execute(filter: ActionFilter = {}): Promise<ListedActionView[]> {
    const actions = await this.#repository.list(filter);
    const fronts = await this.#frontsOf(actions, filter);
    return actions.map((action) => ({ ...actionView(action), waitingBehind: fronts.get(action.id) ?? null }));
  }

  /**
   * Which stopped action each listed one waits behind. The issue's whole line is
   * read, not only the listed actions, because the action in front need not match
   * the filter: a listing of queued work still has to say what holds it.
   */
  async #frontsOf(listed: readonly Action[], filter: ActionFilter): Promise<Map<string, FrontView>> {
    const fronts = new Map<string, FrontView>();
    if (!listed.some((action) => action.state === 'queued' || action.state === 'held')) {
      return fronts;
    }
    const open = await this.#repository.list({
      states: ['blocked', 'failed', 'held', 'queued'],
      repo: filter.repo,
      issue: filter.issue,
    });
    for (const stopped of stoppedIssues(open)) {
      for (const waiting of stopped.waiting) {
        fronts.set(waiting.id, { id: stopped.front.id, state: stopped.front.state });
      }
    }
    return fronts;
  }
}
