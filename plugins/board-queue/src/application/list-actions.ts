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

/**
 * The failed or blocked actions another one waits behind on the same issue: the
 * oldest, which is the one to clear first, and the ids of all of them, oldest
 * first, the oldest included.
 */
export type FrontView = {
  id: string;
  state: ActionState;
  inFront: string[];
};

/**
 * An action as a listing shows it: what it is, and, when it is waiting behind
 * failed or blocked actions on its issue, which ones. Such an action will not run
 * until every one of them is retried or cancelled, however long the queue is left
 * alone.
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
   * Which stopped actions each listed one waits behind. The issue's whole line is
   * read, not only the listed actions, because the actions in front need not match
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
      for (const { action, inFront } of stopped.waiting) {
        const [front] = inFront;
        if (front !== undefined) {
          fronts.set(action.id, { id: front.id, state: front.state, inFront: inFront.map((one) => one.id) });
        }
      }
    }
    return fronts;
  }
}
