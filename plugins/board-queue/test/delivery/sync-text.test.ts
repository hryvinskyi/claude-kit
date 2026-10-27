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
  ownerJobs: ['mirror'],
  mirror: { enabled: true, scope: 'all', lastRun: null },
  finish: { enabled: false, statuses: [], lastRun: null },
  importer: { enabled: false, lastRun: null },
  forge: { enabled: false, lastRun: null },
  refused: null,
};

const MIRROR_RUN = {
  at: '2026-03-02T09:00:00.000Z',
  events: 4,
  filed: 2,
  duplicates: 0,
  ignored: 0,
  refused: 0,
  unresolved: 0,
  cursor: 12,
  error: null,
  cursorExpired: null,
  startedFromHead: null,
  filedFor: null,
  othersMoves: 0,
  orphanMoves: 0,
  staleMoves: 0,
  declined: null,
  ownerWarning: null,
};

const FINISH_RUN = {
  at: '2026-03-02T09:00:00.000Z',
  holder: 'alice',
  held: 3,
  completed: ['gh:example-org/first-repo#41'],
  gone: 1,
  declined: null,
  error: null,
};

describe('ending finished claims on a terminal', () => {
  it('says at which statuses claims end, what the last run ended, and what one tick ended', () => {
    const lines = syncStatusLines({
      ...VIEW,
      finish: { enabled: true, statuses: ['Ready for QA', 'Done'], lastRun: FINISH_RUN },
    });

    assert.deepEqual(lines, [
      'in step with https://dibs.example.com (widgets): mirror on · finished claims ended at Ready for QA / Done '
        + '· importer off · forge off · only in alice\'s worker',
      'finished claims 2026-03-02T09:00:00.000Z — 3 held by alice, ended gh:example-org/first-repo#41, 1 no longer held',
    ]);
    const tick: WorkerReport = { ...QUIET_TICK, sync: { finish: FINISH_RUN } };
    assert.ok(tickLines(tick).includes('finished claims: 1 ended'));
  });

  it('says why a worker whose token speaks for an integration ends nothing', () => {
    const lines = syncStatusLines({
      ...VIEW,
      finish: {
        enabled: true,
        statuses: ['Done'],
        lastRun: { ...FINISH_RUN, holder: null, held: 0, completed: [], gone: 0, declined: 'the token speaks for an integration' },
      },
    });

    assert.equal(lines[1], 'finished claims 2026-03-02T09:00:00.000Z — ends nothing here: the token speaks for an integration');
  });
});

describe('what keeping in step looks like on a terminal', () => {
  it('says which directions are on and whose worker runs them', () => {
    assert.deepEqual(syncStatusLines(VIEW), [
      'in step with https://dibs.example.com (widgets): mirror on · importer off · forge off · only in alice\'s worker',
    ]);
  });

  it('says why this worker declined, and that the log lost events', () => {
    const lines = syncStatusLines({
      ...VIEW,
      refused: { at: '2026-03-02T09:00:00.000Z', reason: 'this worker runs as bob' },
      mirror: {
        enabled: true,
        scope: 'all',
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
          filedFor: null,
          othersMoves: 0,
          orphanMoves: 0,
          staleMoves: 0,
          declined: null,
          ownerWarning: null,
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

  it('says what the last forge pass did in each repository, and why it stopped', () => {
    const lines = syncStatusLines({
      ...VIEW,
      forge: {
        enabled: true,
        lastRun: {
          at: '2026-03-02T09:00:00.000Z',
          requests: 12,
          notModified: 9,
          stoppedBecause: 'the secondary rate limit asked for a wait',
          repos: [{
            repo: 'example-org/first-repo',
            cursor: '2026-03-02T08:58:00.000Z',
            seeded: false,
            listed: 3,
            listedByServer: false,
            merged: 1,
            closed: 0,
            mergesWithoutFiles: 1,
            refusedReports: 0,
            mergeability: 1,
            statuses: 2,
            statusesWithdrawn: 1,
            statusesDeferred: 1,
            footprints: 4,
            branchesGone: 1,
            holdsReleased: 0,
            failures: 1,
            listingError: null,
            stoppedBecause: 'GitHub did not answer 3 requests in a row',
          }],
          refused: null,
          pruned: { statuses: 2, pulls: 0 },
        },
      },
    });

    assert.ok(lines.includes('forge 2026-03-02T09:00:00.000Z — 12 requests (9 unchanged) · forgot 2 statuses and '
      + '0 pull requests — stopped: the secondary rate limit asked for a wait'));
    assert.ok(lines.includes('forge example-org/first-repo: 3 listed · cursor 2026-03-02T08:58:00.000Z · 1 merged '
      + '(1 without their files) · 0 closed · 1 mergeability · 2 statuses (1 taken back) (1 left for a later pass) · '
      + '4 footprints (1 branches gone) · 0 holds released · 1 failed, see the log · stopped: '
      + 'GitHub did not answer 3 requests in a row'));
    assert.ok(lines.includes('forge example-org/first-repo: the coordination server does not list it, so it gets no '
      + 'status and no footprint'));
  });

  it('says why the forge jobs declined to start', () => {
    const lines = syncStatusLines({
      ...VIEW,
      forge: {
        enabled: true,
        lastRun: {
          at: '2026-03-02T09:00:00.000Z',
          requests: 0,
          notModified: 0,
          repos: [],
          stoppedBecause: null,
          refused: 'the forge jobs run only under an App\'s credential',
          pruned: { statuses: 0, pulls: 0 },
        },
      },
    });

    assert.ok(lines.includes('forge 2026-03-02T09:00:00.000Z — declined: the forge jobs run only under an App\'s credential'));
  });

  it('adds a line per direction to what a tick reports', () => {
    const report: WorkerReport = {
      ...QUIET_TICK,
      sync: {
        mirror: { skipped: 'another tick holds the lock' },
        import: { skipped: 'the last import was recent' },
        forge: { skipped: 'the queue is waiting out a refusal' },
      },
    };

    assert.deepEqual(tickLines(report).slice(1), [
      'mirror: skipped — another tick holds the lock',
      'import: skipped — the last import was recent',
      'forge: skipped — the queue is waiting out a refusal',
    ]);
  });
  it('says a mirror files each person\'s own moves, and which jobs only the owner\'s worker runs', () => {
    const own: SyncView = {
      ...VIEW,
      ownerJobs: ['importer', 'forge'],
      mirror: { enabled: true, scope: 'own', lastRun: { ...MIRROR_RUN, filedFor: 'bob', othersMoves: 3, orphanMoves: 2, staleMoves: 1 } },
      importer: { enabled: true, lastRun: null },
      forge: { enabled: true, lastRun: null },
      refused: {
        at: '2026-03-02T09:00:00.000Z',
        reason: 'this worker runs as bob-gh, and only alice\'s worker runs the importer and the forge jobs',
        refusal: 'not-the-owner',
      },
    };

    assert.deepEqual(syncStatusLines(own), [
      'in step with https://dibs.example.com (widgets): mirror on, each person\'s own moves · importer on · forge on'
      + ' · importer and forge only in alice\'s worker',
      'not run here — this worker runs as bob-gh, and only alice\'s worker runs the importer and the forge jobs',
      'mirror 2026-03-02T09:00:00.000Z — 4 events read, 2 filed, 0 already filed, 3 left to other people\'s workers,'
      + ' 2 no person\'s worker files, filed here, 1 passed over because the server has moved on, bob\'s own, cursor 12',
    ]);
    assert.equal(
      syncStatusLines({ ...own, ownerJobs: [], importer: { enabled: false, lastRun: null }, forge: { enabled: false, lastRun: null } })[0],
      'in step with https://dibs.example.com (widgets): mirror on, each person\'s own moves · importer off · forge off',
    );
  });

  it('says loudly that the configured owner is no member', () => {
    const lines = syncStatusLines({
      ...VIEW,
      mirror: { enabled: true, scope: 'own', lastRun: { ...MIRROR_RUN, filedFor: 'bob', ownerWarning: 'no member names alcie-gh' } },
    });

    assert.ok(lines.includes('mirror: no member names alcie-gh'));
  });

  it('says why a mirror files nothing on this worker', () => {
    const lines = syncStatusLines({
      ...VIEW,
      mirror: {
        enabled: true,
        scope: 'own',
        lastRun: { ...MIRROR_RUN, declined: 'this worker runs as dave-gh, and no member of the project names that GitHub login' },
      },
    });

    assert.ok(lines.includes(
      'mirror 2026-03-02T09:00:00.000Z — files nothing here: this worker runs as dave-gh, and no member of the project names that GitHub login',
    ));
    assert.deepEqual(tickLines({ ...QUIET_TICK, sync: { mirror: { ...MIRROR_RUN, declined: 'no member' } } }).slice(1), [
      'mirror: files nothing here, see status',
    ]);
  });

  it('keeps a worker that is not the owner\'s out of every tick\'s output, and a fault in it', () => {
    const calm = tickLines({ ...QUIET_TICK, sync: { refused: 'this worker runs as bob', refusal: 'not-the-owner' } });
    const fault = tickLines({ ...QUIET_TICK, sync: { refused: 'the login could not be read', refusal: 'identity-unreadable' } });

    assert.deepEqual(calm.slice(1), []);
    assert.deepEqual(fault.slice(1), ['in step: declined — the login could not be read']);
  });
});
