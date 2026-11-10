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

/** An action waiting its turn, and every stopped action filed before it on its issue, oldest first. */
export type WaitingAction = {
  action: Action;
  inFront: readonly Action[];
};

/**
 * One issue whose actions stopped moving: every stopped action with work filed
 * after it, oldest first, and that work. The oldest is the front.
 */
export type StoppedIssue = {
  front: Action;
  stopped: readonly Action[];
  waiting: readonly WaitingAction[];
};

/**
 * The issues held up by failed or blocked actions, given actions in the order
 * they were filed.
 *
 * A queued or held action waits behind every stopped action filed before it on
 * its issue, because each of them holds the issue on its own: retrying the
 * nearer one runs nothing while an older one still stands in front of it. Every
 * one of them has to be retried or cancelled, the oldest first, before the work
 * behind them runs. The front of an issue is its oldest stopped action; a stopped
 * action filed after the last waiting one holds nothing up and is not counted.
 * An issue whose stopped actions have nothing behind them is not listed. Actions
 * that name no issue form one line of their own, as they do when the queue
 * orders them.
 */
export function stoppedIssues(actionsInFilingOrder: readonly Action[]): StoppedIssue[] {
  const lanes = new Map<string, { stopped: Action[]; waiting: WaitingAction[] }>();
  for (const action of actionsInFilingOrder) {
    const lane = laneOf(action);
    const issue = lanes.get(lane);
    if (STOPPED_STATES.includes(action.state)) {
      if (issue === undefined) {
        lanes.set(lane, { stopped: [action], waiting: [] });
      } else {
        issue.stopped.push(action);
      }
    } else if (WAITING_STATES.includes(action.state)) {
      issue?.waiting.push({ action, inFront: [...issue.stopped] });
    }
  }
  const stoppedIssues: StoppedIssue[] = [];
  for (const { waiting } of lanes.values()) {
    const last = waiting.at(-1);
    const front = last?.inFront[0];
    if (last !== undefined && front !== undefined) {
      stoppedIssues.push({ front, stopped: last.inFront, waiting });
    }
  }
  return stoppedIssues;
}

function laneOf(action: Action): string {
  return action.issueRef === null ? '' : action.issueRef.key();
}
