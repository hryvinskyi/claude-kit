import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Action } from '../../src/domain/action.ts';
import type { ActionState } from '../../src/domain/action.ts';
import { OptionNotFound } from '../../src/domain/errors.ts';
import { holdsItsIssue, stoppedIssues } from '../../src/domain/issue-order.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';

const now = new Date('2026-09-16T13:00:00.000Z');

/** An action brought to a state through the transitions the aggregate allows. */
function anAction(id: string, state: ActionState, issueRef: IssueRef | null): Action {
  const action = Action.enqueue({
    id,
    kind: 'issue.comment',
    payload: {},
    issueRef,
    origin: 'a test',
    now,
    hold: state === 'held',
  });
  if (state === 'queued' || state === 'held') {
    return action;
  }
  if (state === 'cancelled') {
    action.cancel(now);
    return action;
  }
  action.start(now);
  const endings: { [S in Exclude<ActionState, 'queued' | 'held' | 'cancelled'>]: () => void } = {
    running: () => undefined,
    done: () => action.succeed(now, 'posted'),
    failed: () => action.failTransient(now, 'the API answered 502', 1, 30),
    blocked: () => action.block(now, new OptionNotFound('Severity', 'urgent', ['S2'])),
    skipped: () => action.skip(now, 'the condition did not hold'),
  };
  endings[state]();
  return action;
}

const twelve = IssueRef.of('example-org/first-repo', 12);
const twelveShouted = IssueRef.of('EXAMPLE-ORG/First-Repo', 12);
const thirteen = IssueRef.of('example-org/first-repo', 13);

describe('the order actions on one issue keep', () => {
  it('holds an issue while an action is waiting, running, failed or blocked, and not once it is held or ended',
    () => {
      const holding: Record<ActionState, boolean> = {
        queued: true,
        running: true,
        failed: true,
        blocked: true,
        held: false,
        done: false,
        skipped: false,
        cancelled: false,
      };
      const states: readonly ActionState[] = ['queued', 'running', 'failed', 'blocked', 'held', 'done', 'skipped', 'cancelled'];
      for (const state of states) {
        assert.equal(holdsItsIssue(anAction('a', state, twelve).state), holding[state], state);
      }
    });

  it('finds the work stuck behind a stopped action, issue by issue', () => {
    const stopped = stoppedIssues([
      anAction('first-comment', 'failed', twelve),
      anAction('second-comment', 'blocked', twelve),
      anAction('close', 'queued', twelveShouted),
      anAction('move', 'held', twelve),
      anAction('done-on-thirteen', 'done', thirteen),
      anAction('blocked-on-thirteen', 'blocked', thirteen),
      anAction('after-on-thirteen', 'queued', thirteen),
    ]);

    assert.deepEqual(stopped.map((issue) => ({
      front: issue.front.id,
      waiting: issue.waiting.map((action) => action.id),
    })), [
      { front: 'first-comment', waiting: ['close', 'move'] },
      { front: 'blocked-on-thirteen', waiting: ['after-on-thirteen'] },
    ]);
  });

  it('leaves out an issue whose stopped action has nothing behind it, and work filed before it', () => {
    assert.deepEqual(stoppedIssues([
      anAction('before', 'queued', twelve),
      anAction('failed', 'failed', twelve),
      anAction('elsewhere', 'queued', thirteen),
    ]), []);
  });

  it('keeps actions that name no issue in one line of their own', () => {
    const stopped = stoppedIssues([
      anAction('failed', 'failed', null),
      anAction('on-an-issue', 'queued', twelve),
      anAction('after', 'queued', null),
    ]);

    assert.deepEqual(stopped.map((issue) => issue.waiting.map((action) => action.id)), [['after']]);
  });
});
