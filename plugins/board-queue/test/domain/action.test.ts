import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Action } from '../../src/domain/action.ts';
import type { ActionState } from '../../src/domain/action.ts';
import { IllegalTransition, OptionNotFound } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';

const now = new Date('2026-09-16T13:00:00.000Z');
const later = new Date('2026-09-16T13:05:00.000Z');
const ref = IssueRef.of('example-org/first-repo', 12);

function queued(): Action {
  return Action.enqueue({
    id: 'a-1',
    kind: 'board.set-fields',
    payload: { repo: 'example-org/first-repo', issue: 12, fields: { status: 'In Progress' } },
    issueRef: ref,
    origin: 'a test',
    now,
  });
}

function running(): Action {
  const action = queued();
  action.start(now);
  return action;
}

function inState(state: ActionState): Action {
  const action = queued();
  const reach: Record<ActionState, () => void> = {
    queued: () => undefined,
    held: () => {
      throw new Error('a held action is created held');
    },
    running: () => action.start(now),
    done: () => {
      action.start(now);
      action.succeed(now, 'done');
    },
    failed: () => {
      action.start(now);
      action.failTransient(now, 'boom', 1, 30);
    },
    blocked: () => {
      action.start(now);
      action.block(now, new OptionNotFound('Module', 'Checkout', ['Cart']));
    },
    skipped: () => {
      action.start(now);
      action.skip(now, 'Status is "Ready for QA", which this request does not move');
    },
    cancelled: () => action.cancel(now),
  };
  reach[state]();
  return action;
}

describe('Action', () => {
  it('starts queued, or held when the work waits on something else', () => {
    const action = queued();
    assert.equal(action.state, 'queued');
    assert.equal(action.attempts, 0);
    assert.equal(action.version, 1);
    assert.equal(action.persistedVersion, 1);
    assert.equal(action.notBefore, null);
    assert.equal(action.lastError, null);
    assert.equal(action.result, null);
    assert.equal(action.blockedReason, null);
    assert.equal(action.issueRef?.toString(), 'example-org/first-repo#12');

    const held = Action.enqueue({ ...queued().props(), origin: 'a test', now, hold: true });
    assert.equal(held.state, 'held');
  });

  it('keeps a waiting time it was filed with', () => {
    const action = Action.enqueue({ ...queued().props(), origin: 'a test', now, notBefore: later });
    assert.equal(action.notBefore?.getTime(), later.getTime());
    assert.ok(!action.isRunnable(now));
    assert.ok(action.isRunnable(later));
  });

  it('is runnable, and mergeable, only while it is queued and past its waiting time', () => {
    const action = queued();
    assert.ok(action.isRunnable(now));
    assert.ok(action.isCoalescible(now));
    action.start(now);
    assert.ok(!action.isRunnable(now));
    assert.ok(!action.isCoalescible(now));
  });

  it('counts the attempt when a worker takes it', () => {
    const action = queued();
    action.start(later);
    assert.equal(action.state, 'running');
    assert.equal(action.attempts, 1);
    assert.equal(action.updatedAt.getTime(), later.getTime());
  });

  it('keeps the notes a partial success left when it finishes', () => {
    const action = running();
    action.note(now, 'the comment landed');
    action.succeed(later, 'fields applied');
    assert.equal(action.state, 'done');
    assert.equal(action.result, 'the comment landed\nfields applied');
  });

  it('waits exactly as long as it was told after a failure that may pass', () => {
    const action = running();
    action.failTransient(now, 'a 502 from the API', 5, 240);
    assert.equal(action.state, 'queued');
    assert.equal(action.attempts, 1);
    assert.equal(action.lastError, 'a 502 from the API');
    assert.equal(action.notBefore?.getTime(), now.getTime() + 240_000);
  });

  it('gives up once it has used its attempts', () => {
    const action = queued();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      action.start(now);
      action.failTransient(now, `attempt ${String(attempt)} failed`, 3, 30);
    }
    assert.equal(action.state, 'failed');
    assert.equal(action.attempts, 3);
    assert.equal(action.notBefore, null);
  });

  it('records why it is blocked as a category as well as a sentence', () => {
    const action = running();
    action.block(now, new OptionNotFound('Module', 'Checkout', ['Cart', 'Catalog']));
    assert.equal(action.state, 'blocked');
    assert.equal(action.blockedReason, 'option-not-found');
    assert.ok(action.lastError?.includes('Cart, Catalog'));
  });

  it('comes back from blocked and from failed with its attempts restored', () => {
    for (const state of ['blocked', 'failed'] as const) {
      const action = inState(state);
      const errorBefore = action.lastError;
      action.retry(later);
      assert.equal(action.state, 'queued');
      assert.equal(action.attempts, 0);
      assert.equal(action.notBefore, null);
      assert.equal(action.blockedReason, null);
      assert.equal(action.lastError, errorBefore);
    }
  });

  it('is released from held, requeued without counting the attempt, and cancellable', () => {
    const held = Action.enqueue({ ...queued().props(), origin: 'a test', now, hold: true });
    held.release(later);
    assert.equal(held.state, 'queued');

    const stopped = running();
    assert.equal(stopped.attempts, 1);
    stopped.requeue(later);
    assert.equal(stopped.state, 'queued');
    assert.equal(stopped.attempts, 0);

    for (const state of ['queued', 'blocked', 'failed'] as const) {
      const action = inState(state);
      action.cancel(later);
      assert.equal(action.state, 'cancelled');
    }
  });

  it('refuses every transition its state does not allow', () => {
    assert.throws(() => inState('done').start(now), IllegalTransition);
    assert.throws(() => inState('queued').succeed(now, 'x'), IllegalTransition);
    assert.throws(() => inState('queued').failTransient(now, 'x', 5, 30), IllegalTransition);
    assert.throws(() => inState('queued').block(now, new OptionNotFound('Module', 'x', [])), IllegalTransition);
    assert.throws(() => inState('queued').release(now), IllegalTransition);
    assert.throws(() => inState('queued').retry(now), IllegalTransition);
    assert.throws(() => inState('running').cancel(now), IllegalTransition);
    assert.throws(() => inState('queued').requeue(now), IllegalTransition);
    assert.throws(() => inState('queued').note(now, 'x'), IllegalTransition);
    assert.throws(
      () => inState('done').retry(now),
      (error: unknown) => error instanceof IllegalTransition
        && error.from === 'done'
        && error.describe().includes('a-1'),
    );
  });

  it('raises its version on every change, and the guard only once a store wrote it', () => {
    const action = queued();
    assert.equal(action.version, 1);
    action.start(now);
    assert.equal(action.version, 2);
    action.note(now, 'halfway');
    assert.equal(action.version, 3);
    assert.equal(action.persistedVersion, 1);
    action.markPersisted();
    assert.equal(action.persistedVersion, 3);
    action.succeed(now, 'finished');
    assert.equal(action.version, 4);
    assert.equal(action.persistedVersion, 3);
  });

  it('hands out its state as plain properties, and takes them back', () => {
    const action = running();
    const props = action.props();
    const copy = new Action(props);
    assert.deepEqual(copy.props(), props);
    assert.equal(copy.state, 'running');
    assert.equal(copy.persistedVersion, props.version);
  });
});
