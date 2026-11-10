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
        waiting: [
          { id: 'c-2', kind: 'issue.close', state: 'queued' },
          { id: 'm-1', kind: 'board.set-fields', state: 'held' },
        ],
      }],
    });

    assert.ok(lines.includes('stopped example-org/first-repo#12 behind failed c-1 issue.comment — 2 waiting: '
      + 'c-2 issue.close, m-1 board.set-fields (held); retry or cancel c-1 to let them run'), lines.join('\n'));
  });

  it('says nothing about stopped issues when there are none', () => {
    assert.ok(!statusLines(QUIET).some((line) => line.startsWith('stopped')));
  });

  it('marks a listed action that waits behind a stopped one, and leaves the others as they were', () => {
    assert.equal(
      listedLine({ ...CLOSE, waitingBehind: { id: 'c-1', state: 'blocked' } }),
      'c-2 queued issue.close example-org/first-repo#12 — waits behind blocked c-1; retry or cancel c-1 to let it run',
    );
    assert.equal(listedLine(CLOSE), 'c-2 queued issue.close example-org/first-repo#12');
  });
});
