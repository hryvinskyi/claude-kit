import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ListActions } from '../../src/application/list-actions.ts';
import { fixture } from './queue-fixture.ts';

describe('reading the queue', () => {
  it('answers plain values a printer can use without touching an action', async () => {
    const { repository, file } = fixture();
    await file({
      id: 'one',
      state: 'blocked',
      issue: 12,
      origin: 'a session in the first repository',
      createdAt: new Date('2026-01-09T09:00:00.000Z'),
      payload: { repo: 'example-org/first-repo', issue: 12, fields: { severity: 'S2' } },
    });

    const views = await new ListActions(repository).execute({});

    assert.deepEqual(views, [{
      id: 'one',
      kind: 'board.set-fields',
      ref: 'example-org/first-repo#12',
      state: 'blocked',
      attempts: 1,
      notBefore: null,
      origin: 'a session in the first repository',
      createdAt: '2026-01-09T09:00:00.000Z',
      lastError: 'Severity has no option matching "urgent"; it accepts: S1 · blocking, S2 · broken',
      result: null,
      payload: { repo: 'example-org/first-repo', issue: 12, fields: { severity: 'S2' } },
    }]);
  });

  it('asks the queue for exactly what it was asked for', async () => {
    const { repository, file } = fixture();
    await file({ id: 'one', state: 'queued', issue: 1, createdAt: new Date('2026-01-08T09:00:00.000Z') });
    await file({ id: 'two', state: 'held', issue: 2, createdAt: new Date('2026-01-09T09:00:00.000Z') });
    await file({
      id: 'three',
      state: 'queued',
      kind: 'issue.comment',
      issue: 3,
      createdAt: new Date('2026-01-10T08:00:00.000Z'),
      payload: { repo: 'example-org/first-repo', issue: 3, body: 'a note' },
    });
    const list = new ListActions(repository);

    assert.deepEqual((await list.execute({})).map((view) => view.id), ['one', 'two', 'three']);
    assert.deepEqual((await list.execute({ states: ['held'] })).map((view) => view.id), ['two']);
    assert.deepEqual((await list.execute({ kind: 'issue.comment' })).map((view) => view.id), ['three']);
    assert.deepEqual((await list.execute({ issue: 1 })).map((view) => view.id), ['one']);
    assert.deepEqual((await list.execute({ limit: 2 })).map((view) => view.id), ['one', 'two']);
    assert.deepEqual(
      (await list.execute({ repo: 'EXAMPLE-ORG/FIRST-REPO', states: ['queued'] })).map((view) => view.id),
      ['one', 'three'],
    );
  });
});
