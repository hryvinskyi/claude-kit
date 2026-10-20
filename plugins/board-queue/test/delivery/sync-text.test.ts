import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkerReport } from '../../src/application/run-tick.ts';
import type { SyncView } from '../../src/application/queue-status.ts';
import { syncStatusLines, tickLines } from '../../src/delivery/human-text.ts';

const QUIET_TICK = {
  executed: 0,
  done: 0,
  blocked: 0,
  failed: 0,
  notApplied: 0,
  requeued: 0,
  unblocked: 0,
  recovered: 0,
  stale: 0,
};

const VIEW: SyncView = {
  server: 'https://dibs.example.com',
  project: 'widgets',
  owner: 'alice',
  mirror: { enabled: true, lastRun: null },
  importer: { enabled: false, lastRun: null },
  refused: null,
};

describe('what keeping in step looks like on a terminal', () => {
  it('says which directions are on and whose worker runs them', () => {
    assert.deepEqual(syncStatusLines(VIEW), [
      'in step with https://dibs.example.com (widgets): mirror on · importer off · only in alice\'s worker',
    ]);
  });

  it('says why this worker declined, and that the log lost events', () => {
    const lines = syncStatusLines({
      ...VIEW,
      refused: { at: '2026-03-02T09:00:00.000Z', reason: 'this worker runs as bob' },
      mirror: {
        enabled: true,
        lastRun: {
          at: '2026-03-02T09:00:00.000Z',
          events: 4,
          filed: 2,
          duplicates: 0,
          ignored: 1,
          refused: 0,
          unresolved: 2,
          cursor: 12,
          error: 'the event log could not be reached',
          cursorExpired: { at: '2026-03-01T09:00:00.000Z', prunedThrough: 8 },
          startedFromHead: { at: '2026-02-01T09:00:00.000Z', event: 4, because: 'it had never run' },
        },
      },
    });

    assert.ok(lines.includes('declined 2026-03-02T09:00:00.000Z — this worker runs as bob'));
    assert.ok(lines.some((line) => line.endsWith('— stopped: the event log could not be reached')));
    assert.ok(lines.some((line) => line.startsWith('mirror lost events: the log was pruned through 8')));
    assert.ok(lines.includes('mirror started from the head at event 4 (2026-02-01T09:00:00.000Z) because it had never run'));
    assert.ok(lines.some((line) => line.startsWith('mirror passed over 2 moves whose item could not be read')));
  });

  it('says why an import was not complete and what its read cost', () => {
    const lines = syncStatusLines({
      ...VIEW,
      importer: {
        enabled: true,
        lastRun: {
          at: '2026-03-02T09:00:00.000Z',
          items: 3,
          batches: 1,
          complete: false,
          open: 3,
          incompleteBecause: 'a page failed',
          requests: 2,
          notModified: 1,
          readCost: 3,
          refusedEdges: 0,
          stoppedBecause: null,
        },
      },
    });

    assert.ok(lines.includes('import 2026-03-02T09:00:00.000Z — 3 items in 1 batches, not complete: a page failed, '
      + '2 dependency requests (1 unchanged), read cost 3'));
  });

  it('adds a line per direction to what a tick reports', () => {
    const report: WorkerReport = {
      ...QUIET_TICK,
      sync: { mirror: { skipped: 'another tick holds the lock' }, import: { skipped: 'the last import was recent' } },
    };

    assert.deepEqual(tickLines(report).slice(1), [
      'mirror: skipped — another tick holds the lock',
      'import: skipped — the last import was recent',
    ]);
  });
});
