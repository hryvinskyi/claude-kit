import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CancelAction } from '../../src/application/cancel-action.ts';
import { IllegalTransition, RefusedByRule } from '../../src/domain/errors.ts';
import { fixture } from './queue-fixture.ts';

describe('cancelling an action', () => {
  it('takes a waiting, held, blocked or failed action off the queue', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'queued-one', state: 'queued', issue: 1 });
    await file({ id: 'held-one', state: 'held', issue: 2 });
    await file({ id: 'blocked-one', state: 'blocked', issue: 3 });
    await file({ id: 'failed-one', state: 'failed', issue: 4 });
    const cancel = new CancelAction(repository, clock);

    for (const id of ['queued-one', 'held-one', 'blocked-one', 'failed-one']) {
      assert.equal((await cancel.execute(id)).state, 'cancelled');
    }

    assert.equal((await repository.counts()).cancelled, 4);
  });

  it('leaves work that is already out at the API alone', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'running-one', state: 'running' });

    await assert.rejects(
      () => new CancelAction(repository, clock).execute('running-one'),
      IllegalTransition,
    );
    assert.equal((await repository.get('running-one'))?.state, 'running');
  });

  it('says so when nothing carries that id', async () => {
    const { repository, clock } = fixture();

    await assert.rejects(
      () => new CancelAction(repository, clock).execute('not-an-id'),
      RefusedByRule,
    );
  });
});
