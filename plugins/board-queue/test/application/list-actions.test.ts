import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ListActions } from '../../src/application/list-actions.ts';
import type { ListedActionView } from '../../src/application/list-actions.ts';
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
      waitingBehind: null,
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

  it('names the failed or blocked action each waiting one is stuck behind, whatever the filter', async () => {
    const { repository, file } = fixture();
    const at = (hour: number): Date => new Date(Date.UTC(2026, 0, 9, hour));
    await file({ id: 'comment', state: 'failed', kind: 'issue.comment', issue: 12, createdAt: at(1) });
    await file({ id: 'close', state: 'queued', kind: 'issue.close', issue: 12, createdAt: at(2) });
    await file({ id: 'move', state: 'held', issue: 12, createdAt: at(3) });
    await file({ id: 'fields', state: 'blocked', issue: 13, createdAt: at(4) });
    await file({ id: 'after-fields', state: 'queued', issue: 13, createdAt: at(5) });
    await file({ id: 'before-fields', state: 'queued', issue: 14, createdAt: at(0) });
    const list = new ListActions(repository);

    const behind = (views: readonly ListedActionView[]) => Object.fromEntries(views.map((view) => [
      view.id,
      view.waitingBehind === null ? null : { id: view.waitingBehind.id, state: view.waitingBehind.state },
    ]));

    assert.deepEqual(behind(await list.execute({})), {
      'before-fields': null,
      comment: null,
      close: { id: 'comment', state: 'failed' },
      move: { id: 'comment', state: 'failed' },
      fields: null,
      'after-fields': { id: 'fields', state: 'blocked' },
    });
    assert.deepEqual(
      behind(await list.execute({ states: ['queued'], issue: 12 })),
      { close: { id: 'comment', state: 'failed' } },
      'the action in front is found though the filter leaves it out',
    );
  });

  it('names the oldest stopped action in front of a waiting one, and every stopped one there', async () => {
    const { repository, file } = fixture();
    const at = (hour: number): Date => new Date(Date.UTC(2026, 0, 9, hour));
    await file({ id: 'move', state: 'failed', issue: 12, createdAt: at(1) });
    await file({ id: 'comment', state: 'failed', kind: 'issue.comment', issue: 12, createdAt: at(2) });
    await file({ id: 'close', state: 'queued', kind: 'issue.close', issue: 12, createdAt: at(3) });

    const views = await new ListActions(repository).execute({ states: ['queued'] });

    assert.deepEqual(views.map((view) => view.waitingBehind), [
      { id: 'move', state: 'failed', inFront: ['move', 'comment'] },
    ]);
  });

  it('names nothing once the action in front is retried', async () => {
    const { repository, clock, file } = fixture();
    const failed = await file({ id: 'comment', state: 'failed', kind: 'issue.comment', createdAt: new Date(0) });
    await file({ id: 'close', state: 'queued', kind: 'issue.close', createdAt: new Date(1000) });
    const stored = await repository.get(failed.id);
    assert.ok(stored !== null);
    stored.retry(clock.now());
    await repository.update(stored);

    const views = await new ListActions(repository).execute({});

    assert.deepEqual(views.map((view) => view.waitingBehind), [null, null]);
  });
});
