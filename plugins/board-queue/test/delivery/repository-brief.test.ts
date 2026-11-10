import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ListedActionView } from '../../src/application/list-actions.ts';
import { briefLines, briefOf } from '../../src/delivery/repository-brief.ts';

const NOW = new Date('2026-09-16T13:00:00.000Z');
const REPO = 'example-org/first-repo';

function aView(overrides: Partial<ListedActionView> & Pick<ListedActionView, 'id' | 'state'>): ListedActionView {
  return {
    kind: 'issue.comment',
    ref: `${REPO}#12`,
    attempts: 0,
    notBefore: null,
    origin: 'a session',
    createdAt: '2026-09-16T12:00:00.000Z',
    lastError: null,
    result: null,
    payload: {},
    waitingBehind: null,
    ...overrides,
  };
}

describe('the session-start lines when work waits behind a stopped action', () => {
  it('keeps what can never run out of the queued count', () => {
    const brief = briefOf(REPO, [
      aView({ id: 'comment', state: 'failed', lastError: 'the API answered 502' }),
      aView({ id: 'close', state: 'queued', kind: 'issue.close', waitingBehind: { id: 'comment', state: 'failed', inFront: ['comment'] } }),
      aView({ id: 'elsewhere', state: 'queued', ref: `${REPO}#13` }),
    ], NOW);

    assert.equal(brief.queued, 1);
    assert.equal(brief.behindStopped, 1);
    assert.equal(brief.failed, 1);
  });

  it('names one stopped issue with the stopped action, its state, and how to move on', () => {
    const lines = briefLines(briefOf(REPO, [
      aView({ id: 'fields', state: 'blocked', kind: 'board.set-fields', lastError: 'no such option' }),
      aView({ id: 'close', state: 'queued', kind: 'issue.close', waitingBehind: { id: 'fields', state: 'blocked', inFront: ['fields'] } }),
      aView({ id: 'note', state: 'held', waitingBehind: { id: 'fields', state: 'blocked', inFront: ['fields'] } }),
    ], NOW));

    assert.deepEqual(lines, [
      '[BOARD QUEUE] queued 0 · held 1 (oldest 0.0d) · blocked 1 · failed 0 · behind a stop 1',
      '[BOARD QUEUE] blocked example-org/first-repo#12 — no such option',
      '[BOARD QUEUE] stopped example-org/first-repo#12 behind blocked fields — 2 waiting; retry or cancel fields to let them run',
    ]);
  });

  it('names every stopped action in front, the oldest first, when an issue has two stops', () => {
    const lines = briefLines(briefOf(REPO, [
      aView({ id: 'move', state: 'failed', kind: 'board.set-fields', lastError: 'the API answered 502' }),
      aView({ id: 'evidence', state: 'failed', lastError: 'the API answered 502' }),
      aView({
        id: 'close',
        state: 'queued',
        kind: 'issue.close',
        waitingBehind: { id: 'move', state: 'failed', inFront: ['move', 'evidence'] },
      }),
    ], NOW));

    assert.deepEqual(lines, [
      '[BOARD QUEUE] queued 0 · held 0 · blocked 0 · failed 2 · behind a stop 1',
      '[BOARD QUEUE] stopped example-org/first-repo#12 behind failed move — 1 waiting; 2 stopped actions stand in '
      + 'front: retry or cancel move first, then evidence, to let them run',
    ]);
  });

  it('does not count a delayed action as delayed when it is stuck behind a stop', () => {
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const brief = briefOf(REPO, [
      aView({ id: 'comment', state: 'failed' }),
      aView({
        id: 'close',
        state: 'queued',
        notBefore: later,
        waitingBehind: { id: 'comment', state: 'failed', inFront: ['comment'] },
      }),
    ], NOW);

    assert.equal(brief.delayed, 0);
    assert.equal(brief.behindStopped, 1);
  });

  it('leaves the line as it was when nothing waits behind a stop', () => {
    const lines = briefLines(briefOf(REPO, [aView({ id: 'a', state: 'queued' })], NOW));

    assert.deepEqual(lines, ['[BOARD QUEUE] queued 1 · held 0 · blocked 0 · failed 0']);
  });
});
