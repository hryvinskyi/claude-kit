import type { Action, ActionState } from './action.ts';

/**
 * The states in which an action keeps every action filed after it on the same
 * issue from running.
 *
 * Queued and running are the plain cases: it has not happened yet. Failed and
 * blocked are the ones that matter: the action stopped and waits for a person,
 * and the work filed after it — the close that follows its evidence comment —
 * must wait with it, or the issue ends up in a state nobody filed. Such an issue
 * moves again when the action in front is retried (back to queued) or cancelled.
 *
 * Held is deliberately absent. A held action waits on something outside the
 * queue, often a deploy days away, and it was filed knowing that; it starts to
 * hold its issue once it is released and becomes queued. Done, skipped and
 * cancelled have ended and hold nothing.
 */
export const ISSUE_HOLDING_STATES = ['queued', 'running', 'failed', 'blocked'] as const satisfies readonly ActionState[];

/** The states that hold an issue until a person retries or cancels the action. */
const STOPPED_STATES: readonly ActionState[] = ['failed', 'blocked'];

/** The states an action waiting behind a stopped one can be in. */
const WAITING_STATES: readonly ActionState[] = ['queued', 'held'];

const HOLDING: readonly ActionState[] = ISSUE_HOLDING_STATES;

export function holdsItsIssue(state: ActionState): boolean {
  return HOLDING.includes(state);
}

/**
 * One issue whose actions stopped moving: the stopped action in front, and the
 * actions filed after it that will not run until it is retried or cancelled.
 */
export type StoppedIssue = {
  front: Action;
  waiting: readonly Action[];
};

/**
 * The issues held up by a failed or blocked action, given actions in the order
 * they were filed.
 *
 * The front of an issue is its oldest stopped action; every queued or held action
 * filed after it is waiting behind it. An issue whose stopped action has nothing
 * behind it is not listed: nothing is held up there. Actions that name no issue
 * form one line of their own, as they do when the queue orders them.
 */
export function stoppedIssues(actionsInFilingOrder: readonly Action[]): StoppedIssue[] {
  const fronts = new Map<string, { front: Action; waiting: Action[] }>();
  for (const action of actionsInFilingOrder) {
    const lane = laneOf(action);
    const stopped = fronts.get(lane);
    if (stopped === undefined) {
      if (STOPPED_STATES.includes(action.state)) {
        fronts.set(lane, { front: action, waiting: [] });
      }
    } else if (WAITING_STATES.includes(action.state)) {
      stopped.waiting.push(action);
    }
  }
  return [...fronts.values()].filter((stopped) => stopped.waiting.length > 0);
}

function laneOf(action: Action): string {
  return action.issueRef === null ? '' : action.issueRef.key();
}
