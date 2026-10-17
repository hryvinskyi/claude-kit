import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReleaseAction } from '../../src/application/release-action.ts';
import { IllegalTransition, RefusedByRule } from '../../src/domain/errors.ts';
import { fixture } from './queue-fixture.ts';

describe('releasing a held action', () => {
  it('puts it back on the queue', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'held-one', state: 'held' });

    const view = await new ReleaseAction(repository, clock).execute('held-one');

    assert.equal(view.state, 'queued');
    assert.equal(view.ref, 'example-org/first-repo#12');
    assert.equal((await repository.get('held-one'))?.state, 'queued');
  });

  it('refuses an action that was not being held', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'queued-one', state: 'queued' });

    await assert.rejects(
      () => new ReleaseAction(repository, clock).execute('queued-one'),
      (error: unknown) => error instanceof IllegalTransition && error.describe().includes('be released'),
    );
  });

  it('says so when nothing carries that id', async () => {
    const { repository, clock } = fixture();

    await assert.rejects(
      () => new ReleaseAction(repository, clock).execute('not-an-id'),
      (error: unknown) => error instanceof RefusedByRule && error.message.includes('not-an-id'),
    );
  });
});
