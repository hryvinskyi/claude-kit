import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RetryAction } from '../../src/application/retry-action.ts';
import { IllegalTransition, RefusedByRule } from '../../src/domain/errors.ts';
import { fixture } from './queue-fixture.ts';

describe('retrying an action that stopped', () => {
  it('puts a blocked action back with its attempts returned and its error kept', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'blocked-one', state: 'blocked' });

    const view = await new RetryAction(repository, clock).execute('blocked-one');

    assert.equal(view.state, 'queued');
    assert.equal(view.attempts, 0);
    assert.match(view.lastError ?? '', /has no option matching "urgent"/);
    const stored = await repository.get('blocked-one');
    assert.equal(stored?.blockedReason, null);
  });

  it('puts a failed action back too', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'failed-one', state: 'failed' });

    assert.equal((await new RetryAction(repository, clock).execute('failed-one')).state, 'queued');
  });

  it('refuses an action that is already waiting to run', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'queued-one', state: 'queued' });

    await assert.rejects(
      () => new RetryAction(repository, clock).execute('queued-one'),
      IllegalTransition,
    );
  });

  it('answers which blocked actions it moved, and leaves the rest where they are', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'blocked-one', state: 'blocked', issue: 1, createdAt: new Date('2026-01-08T09:00:00.000Z') });
    await file({ id: 'blocked-two', state: 'blocked', issue: 2, createdAt: new Date('2026-01-09T09:00:00.000Z') });
    await file({ id: 'failed-one', state: 'failed', issue: 3 });
    await file({ id: 'queued-one', state: 'queued', issue: 4 });

    const moved = await new RetryAction(repository, clock).allBlocked();

    assert.deepEqual(moved, ['blocked-one', 'blocked-two']);
    assert.equal((await repository.counts()).blocked, 0);
    assert.equal((await repository.counts()).failed, 1);
    assert.equal((await repository.counts()).queued, 3);
  });

  it('says so when nothing carries that id', async () => {
    const { repository, clock } = fixture();

    await assert.rejects(() => new RetryAction(repository, clock).execute('not-an-id'), RefusedByRule);
  });
});
