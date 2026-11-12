import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyActionCounts } from '../../src/application/action-states.ts';
import type { ListedActionView } from '../../src/application/list-actions.ts';
import type { QueueStatusView } from '../../src/application/queue-status.ts';
import { listedLine, statusLines } from '../../src/delivery/human-text.ts';

const QUIET: QueueStatusView = {
  counts: emptyActionCounts(),
  pause: null,
  lastTickAt: null,
  lastBudget: null,
  lastAudit: null,
  blocked: [],
  failed: [],
  held: [],
  delayed: [],
  waitingOnDeferred: [],
  stopped: [],
  sync: null,
};

const CLOSE: ListedActionView = {
  id: 'c-2',
  kind: 'issue.close',
  ref: 'example-org/first-repo#12',
  state: 'queued',
  attempts: 0,
  notBefore: null,
  origin: 'a session',
  createdAt: '2026-01-10T09:00:00.000Z',
  lastError: null,
  result: null,
  payload: {},
  waitingBehind: null,
};

describe('a stopped issue, as a terminal shows it', () => {
  it('says which issue is stuck, behind what, what waits, and what lets it move', () => {
    const lines = statusLines({
      ...QUIET,
      stopped: [{
        ref: 'example-org/first-repo#12',
        front: { id: 'c-1', kind: 'issue.comment', state: 'failed', lastError: 'the API answered 502' },
        stopped: [{ id: 'c-1', kind: 'issue.comment', state: 'failed' }],
        waiting: [
          { id: 'c-2', kind: 'issue.close', state: 'queued' },
          { id: 'm-1', kind: 'board.set-fields', state: 'held' },
        ],
      }],
    });

    assert.ok(lines.includes('stopped example-org/first-repo#12 behind failed c-1 issue.comment — 2 waiting: '
      + 'c-2 issue.close, m-1 board.set-fields (held); retry or cancel c-1 to let them run'), lines.join('\n'));
  });

  it('names every stopped action in front, the oldest first, when two stand there', () => {
    const lines = statusLines({
      ...QUIET,
      stopped: [{
        ref: 'example-org/first-repo#12',
        front: { id: 'm-1', kind: 'board.set-fields', state: 'failed', lastError: 'the API answered 502' },
        stopped: [
          { id: 'm-1', kind: 'board.set-fields', state: 'failed' },
          { id: 'c-1', kind: 'issue.comment', state: 'failed' },
        ],
        waiting: [{ id: 'c-2', kind: 'issue.close', state: 'queued' }],
      }],
    });

    assert.ok(lines.includes('stopped example-org/first-repo#12 behind failed m-1 board.set-fields — 1 waiting: '
      + 'c-2 issue.close; 2 stopped actions stand in front: retry or cancel m-1 first, then c-1, to let them run'),
    lines.join('\n'));
  });

  it('says nothing about stopped issues when there are none', () => {
    assert.ok(!statusLines(QUIET).some((line) => line.startsWith('stopped')));
  });

  it('marks a listed action that waits behind a stopped one, and leaves the others as they were', () => {
    assert.equal(
      listedLine({ ...CLOSE, waitingBehind: { id: 'c-1', state: 'blocked', inFront: ['c-1'] } }),
      'c-2 queued issue.close example-org/first-repo#12 — waits behind blocked c-1; retry or cancel c-1 to let it run',
    );
    assert.equal(
      listedLine({ ...CLOSE, waitingBehind: { id: 'm-1', state: 'failed', inFront: ['m-1', 'c-1'] } }),
      'c-2 queued issue.close example-org/first-repo#12 — waits behind failed m-1; 2 stopped actions stand in '
      + 'front: retry or cancel m-1 first, then c-1, to let it run',
    );
    assert.equal(listedLine(CLOSE), 'c-2 queued issue.close example-org/first-repo#12');
  });
});

describe('an action that got past an error, as a listing shows it', () => {
  const OPTION_ERROR = 'Severity has no option matching "S4"; it accepts: S1 · blocking';
  const RELEASED = {
    ...CLOSE,
    id: 'm-1',
    kind: 'board.set-fields',
    lastError: OPTION_ERROR,
    result: 'the board now offers what this waited for, so it runs again with severity "S4"\n'
      + 'example-org/first-repo#12: Severity → S4 · trivial',
  };

  it('shows what a finished action did, not the error it got past', () => {
    assert.equal(
      listedLine({ ...RELEASED, state: 'done' }),
      'm-1 done board.set-fields example-org/first-repo#12 — the board now offers what this waited for, so it '
      + 'runs again with severity "S4"',
    );
    assert.equal(
      listedLine({ ...RELEASED, state: 'skipped', result: 'Status reads "In Review"; the row was left as it is' }),
      'm-1 skipped board.set-fields example-org/first-repo#12 — Status reads "In Review"; the row was left as it is',
    );
  });

  it('shows the error that stopped an action still waiting on it, and a finished one\'s error when it kept no result',
    () => {
      assert.equal(
        listedLine({ ...RELEASED, state: 'blocked', result: null }),
        `m-1 blocked board.set-fields example-org/first-repo#12 — ${OPTION_ERROR}`,
      );
      assert.equal(listedLine({ ...RELEASED, state: 'queued' }), `m-1 queued board.set-fields example-org/first-repo#12 — ${OPTION_ERROR}`);
      assert.equal(
        listedLine({ ...RELEASED, state: 'done', result: null }),
        `m-1 done board.set-fields example-org/first-repo#12 — ${OPTION_ERROR}`,
      );
    });
});
