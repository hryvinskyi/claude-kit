import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OwnMoves } from '../../src/application/mirror-audience.ts';
import { TickLockLost } from '../../src/application/leased-gateways.ts';
import { MirrorClaims } from '../../src/application/mirror-claims.ts';
import { readLastAuditAttemptAt, writeLastAudit, writeLastAuditAttemptAt } from '../../src/application/queue-meta.ts';
import { QueueStatus } from '../../src/application/queue-status.ts';
import { RunTick } from '../../src/application/run-tick.ts';
import { statusLines } from '../../src/delivery/human-text.ts';
import type { SyncJobs } from '../../src/application/run-tick.ts';
import { mirrorCursorKey, readSyncRefusal } from '../../src/application/sync-meta.ts';
import { SyncOwner } from '../../src/application/sync-owner.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { LocalIdentity } from '../../src/application/sync-ports.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import type { SyncConfig } from '../../src/domain/sync-config.ts';
import { catalogField, catalogOf, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeCoordination, claim } from '../fakes/fake-coordination.ts';
import { syncConfig, syncOf } from '../fixtures/sync.ts';
import { FIRST, setFields, tickFixture } from './tick-fixture.ts';
import type { TickFixture } from './tick-fixture.ts';

const SYNC = syncOf();
const TWELVE = IssueRef.of(FIRST, 12);
const THIRTEEN = IssueRef.of(FIRST, 13);

/** A board whose statuses include one the mirror never writes. */
function qaCatalog() {
  return catalogOf(
    catalogField('Status', ['Todo', 'In Progress', 'In Review', 'Ready for QA', 'Done']),
    catalogField('Severity', ['S1 · blocking', 'S2 · broken · no workaround']),
  );
}

function identity(login: string | null): LocalIdentity {
  return { login: () => Promise.resolve(login) };
}

function worker(fixture: TickFixture, feed: FakeCoordination, login: string | null): RunTick {
  const mirror = SYNC.mirror;
  if (mirror === undefined) {
    throw new Error('the fixture mirrors nothing');
  }
  const claims = new MirrorClaims({
    feed,
    repository: fixture.repository,
    kinds: defaultKindRegistry(syncConfig),
    directory: BoardDirectory.of(syncConfig.boards),
    sync: SYNC,
    mirror,
    clock: fixture.clock,
    logger: fixture.logger,
  });
  const sync: SyncJobs = {
    owner: new SyncOwner({
      identity: identity(login),
      sync: SYNC,
      repository: fixture.repository,
      clock: fixture.clock,
      logger: fixture.logger,
    }),
    mirror: (lease) => claims.pass(lease),
  };
  return new RunTick({
    drain: fixture.drain,
    repository: fixture.repository,
    policy: fixture.policy,
    clock: fixture.clock,
    logger: fixture.logger,
    sync,
  });
}

/** The fixture's configuration with a mirror of each worker's own person's moves. */
function ownScopeSync(overrides: Record<string, unknown> = {}) {
  return syncOf(ConfigSchema.parse({
    ...syncConfig,
    dibs: { ...SYNC, mirror: { ...SYNC.mirror, scope: 'own' }, ...overrides },
  }));
}

function mirrorFor(fixture: TickFixture, feed: FakeCoordination, sync: SyncConfig, audience: OwnMoves): MirrorClaims {
  const mirror = sync.mirror;
  if (mirror === undefined) {
    throw new Error('the configuration mirrors nothing');
  }
  return new MirrorClaims({
    feed,
    repository: fixture.repository,
    kinds: defaultKindRegistry(syncConfig),
    directory: BoardDirectory.of(syncConfig.boards),
    sync,
    mirror,
    clock: fixture.clock,
    logger: fixture.logger,
    audience,
  });
}

/** The mirror as the worker runs it in a pass. */
function mirrorJob(claims: MirrorClaims): NonNullable<SyncJobs['mirror']> {
  return (lease) => claims.pass(lease);
}

function feedWithAClaim(): FakeCoordination {
  return new FakeCoordination()
    .item(41, 'gh:example-org/first-repo#12')
    .member('alice', 'alice-gh')
    .log(claim(3, 'claimed', 41, 'alice'))
    .holds(41, 'alice');
}

describe('a tick that keeps the board in step', () => {
  it('drains what the mirror filed in the same tick', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' })],
      issues: [{ ref: TWELVE }],
    });

    const report = await worker(fixture, feedWithAClaim(), 'alice').run();

    assert.equal(report.done, 2);
    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'In Progress' });
    assert.deepEqual(fixture.issues.assigneesOf(TWELVE), ['alice-gh']);
  });

  it('never pulls a row back out of a status it does not own, and does not try again', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Ready for QA' })],
      issues: [{ ref: TWELVE }],
    });
    const tick = worker(fixture, feedWithAClaim(), 'alice');

    const report = await tick.run();
    const again = await tick.run();

    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'Ready for QA' });
    assert.equal(fixture.board.written.length, 0);
    assert.equal(report.notApplied, 1);
    const [status] = await fixture.repository.list({ kind: 'board.set-fields' });
    assert.equal(status?.state, 'skipped');
    assert.match(status?.result ?? '', /"Ready for QA"/);
    assert.equal(again.executed, 0, 'a skipped move is an ending, not a failure to retry');
  });

  it('declines on a worker that is not the owner, says why, and drains its own queue', async () => {
    const fixture = tickFixture({ items: [seedItem(TWELVE, 'item-12', {})], issues: [{ ref: TWELVE }] });
    await fixture.file({ id: 'mine', payload: setFields(12, { severity: 'S2' }) });
    const feed = feedWithAClaim();

    const report = await worker(fixture, feed, 'bob').run();

    assert.deepEqual(feed.calls, [], 'nothing was asked of the server');
    assert.equal(report.sync?.refused, 'this worker runs as bob, and only alice\'s worker runs the claim mirror and the importer');
    assert.equal(report.sync?.refusal, 'not-the-owner');
    assert.equal(report.sync?.mirror, undefined);
    assert.equal(report.done, 1);
    assert.match((await readSyncRefusal(fixture.repository))?.reason ?? '', /only alice's worker runs the claim mirror/);
  });

  it('declines when the login cannot be read at all', async () => {
    const fixture = tickFixture();
    const feed = feedWithAClaim();

    const report = await worker(fixture, feed, null).run();

    assert.match(report.sync?.refused ?? '', /could not be read/);
    assert.deepEqual(feed.calls, []);
  });

  it('forgets an earlier refusal once the owner\'s worker runs', async () => {
    const fixture = tickFixture();
    await worker(fixture, feedWithAClaim(), 'bob').run();

    await worker(fixture, new FakeCoordination(), 'Alice').run();

    assert.equal(await readSyncRefusal(fixture.repository), null);
  });

  it('drains the rest of the queue when the server cannot be reached, and reports it', async () => {
    const fixture = tickFixture({ items: [seedItem(TWELVE, 'item-12', {})], issues: [{ ref: TWELVE }] });
    await fixture.file({ id: 'mine', payload: setFields(12, { severity: 'S2' }) });
    const feed = feedWithAClaim().fail('page', new TransientFailure('the event log could not be reached'));

    const report = await worker(fixture, feed, 'alice').run();

    assert.equal(report.done, 1);
    const mirrored = report.sync?.mirror;
    assert.ok(mirrored !== undefined && !('skipped' in mirrored));
    assert.match(mirrored.error ?? '', /could not be reached/);
  });

  it('holds mirrored moves back from the drain in a pass whose owner check could not run, and says why in status', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' }), seedItem(THIRTEEN, 'item-13', {})],
      issues: [{ ref: TWELVE }, { ref: THIRTEEN }],
    });
    await fixture.file({ id: 'mirrored', payload: setFields(12, { status: 'In Progress' }), origin: 'the claim mirror' });
    await fixture.file({ id: 'mine', payload: setFields(13, { severity: 'S2' }) });
    await fixture.file({ id: 'close', kind: 'issue.close', payload: { repo: FIRST, issue: 12, reason: 'completed' } });

    const report = await worker(fixture, feedWithAClaim(), null).run();
    const status = await new QueueStatus(fixture.repository, fixture.clock, SYNC).execute();

    assert.equal(report.done, 1, 'the rest of the queue is drained');
    assert.equal((await fixture.repository.get('mirrored'))?.state, 'queued');
    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'Todo' });
    assert.match(report.passedOver ?? '', /mirrored moves wait/);
    const waiting = status.sync?.mirror.waiting;
    assert.equal(waiting?.count, 1);
    assert.match(waiting?.reason ?? '', /mirror did not run/);
    assert.deepEqual(waiting?.held.map((one) => [one.id, one.waiting.map((behind) => behind.id)]), [['mirrored', ['close']]],
      'the close held behind the mirrored move is named');
    assert.ok(statusLines(status).some((line) => line.startsWith('mirror: 1 mirrored moves left queued')));
  });

  it('withdraws its mirrored moves once this worker is no longer the mirror\'s owner, and lets the issue move on', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' })],
      issues: [{ ref: TWELVE }],
    });
    await fixture.file({ id: 'mirrored', payload: setFields(12, { status: 'In Progress' }), origin: 'the claim mirror' });
    await fixture.file({ id: 'close', kind: 'issue.close', payload: { repo: FIRST, issue: 12, reason: 'completed' } });

    const report = await worker(fixture, feedWithAClaim(), 'bob').run();

    const mirrored = await fixture.repository.get('mirrored');
    assert.equal(mirrored?.state, 'skipped');
    assert.match(mirrored?.result ?? '', /no longer the mirror's owner/);
    assert.equal((await fixture.repository.get('close'))?.state, 'done');
    assert.equal(report.passedOver, undefined);
  });

  it('holds back a mirrored move whose filing it has no record of, where moves can be overtaken', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' })],
      issues: [{ ref: TWELVE }],
    });
    const feed = new FakeCoordination().member('alice', 'alice-gh').member('bob', 'bob-gh');
    await fixture.repository.setMeta(mirrorCursorKey(SYNC.server, SYNC.project), '0');
    await fixture.file({
      id: 'unrecorded',
      payload: setFields(12, { status: 'In Progress' }),
      origin: 'the claim mirror',
      dedupeKey: `dibs:${SYNC.server}:${SYNC.project}:9:status`,
    });
    const sync = ownScopeSync({ importer: { enabled: false } });
    const bob = identity('bob-gh');
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: bob, sync, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        mirror: mirrorJob(mirrorFor(fixture, feed, sync, new OwnMoves(bob, SYNC.mirrorOwner))),
        mirrorScope: 'own',
      },
    });

    const report = await tick.run();

    assert.equal((await fixture.repository.get('unrecorded'))?.state, 'queued');
    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'Todo' });
    assert.match(report.passedOver ?? '', /1 mirrored moves wait/);
  });

  it('runs a mirrored move it has no record of where one worker files every move in order', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' })],
      issues: [{ ref: TWELVE }],
    });
    await fixture.repository.setMeta(mirrorCursorKey(SYNC.server, SYNC.project), '0');
    await fixture.file({
      id: 'unrecorded',
      payload: setFields(12, { status: 'In Progress' }),
      origin: 'the claim mirror',
      dedupeKey: `dibs:${SYNC.server}:${SYNC.project}:9:status`,
    });

    const report = await worker(fixture, new FakeCoordination(), 'alice').run();

    assert.equal((await fixture.repository.get('unrecorded'))?.state, 'done');
    assert.equal(report.passedOver, undefined);
  });

  it('says nothing of mirrored moves waiting when none wait, whatever the last stored run says', async () => {
    const fixture = tickFixture();
    await worker(fixture, new FakeCoordination(), 'alice').run();
    // A run as an older release stored it, naming nothing about the moves it checked.
    await fixture.repository.setMeta('mirror.lastRun', JSON.stringify({
      at: '2026-03-02T09:00:00.000Z', events: 0, filed: 0, duplicates: 0, ignored: 0, refused: 0, unresolved: 0,
      cursor: 0, error: null, cursorExpired: null, startedFromHead: null,
    }));

    const status = await new QueueStatus(fixture.repository, fixture.clock, SYNC).execute();

    assert.equal(status.sync?.mirror.waiting, null);
    assert.ok(!statusLines(status).some((line) => /left queued|stay queued/.test(line)));
  });

  it('holds mirrored moves back from the drain when the server could not say whether they still stand', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' })],
      issues: [{ ref: TWELVE }],
    });
    const feed = new FakeCoordination()
      .item(41, 'gh:example-org/first-repo#12')
      .member('alice', 'alice-gh')
      .member('bob', 'bob-gh')
      .log(claim(3, 'claimed', 41, 'bob'))
      .holds(41, 'bob');
    await fixture.repository.setMeta(mirrorCursorKey(SYNC.server, SYNC.project), '0');
    const sync = ownScopeSync({ importer: { enabled: false } });
    const bob = identity('bob-gh');
    const mirror = mirrorFor(fixture, feed, sync, new OwnMoves(bob, SYNC.mirrorOwner));
    await fixture.repository.withTickLock((lease) => mirror.execute(lease));
    assert.equal((await fixture.repository.list({ states: ['queued'] })).length, 2, 'filed while the queue waited');
    feed.fail('liveClaims', new TransientFailure('the live claims could not be reached'));
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: bob, sync, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        mirror: (lease) => mirror.pass(lease),
        mirrorScope: 'own',
      },
    });

    const report = await tick.run();

    assert.equal(report.executed, 0);
    assert.equal((await fixture.repository.list({ states: ['queued'] })).length, 2);
    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'Todo' });
    assert.match(report.passedOver ?? '', /mirrored moves wait/);

    const checked = await tick.run();

    assert.equal(checked.done, 2, 'once the server answers, the moves that still stand run');
    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'In Progress' });
  });

  it('runs the forge pass after the queue is drained, under the lock, and not while another tick holds it', async () => {
    const fixture = tickFixture({ items: [seedItem(TWELVE, 'item-12', {})], issues: [{ ref: TWELVE }] });
    await fixture.file({ id: 'mine', payload: setFields(12, { severity: 'S2' }) });
    const order: string[] = [];
    const forge = async () => {
      order.push(`forge after ${String((await fixture.repository.counts()).done)} done`);
      return { skipped: 'nothing to do' };
    };
    const sync: SyncJobs = {
      owner: new SyncOwner({ identity: identity('alice'), sync: SYNC, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
      forge,
    };
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync,
    });

    const report = await tick.run();
    fixture.repository.pretendAnotherTickHolds = true;
    const locked = await tick.run();

    assert.deepEqual(order, ['forge after 1 done']);
    assert.deepEqual(report.sync?.forge, { skipped: 'nothing to do' });
    assert.deepEqual(locked.sync?.forge, { skipped: 'the tick did not get to drain the queue, so nothing is read' });
  });

  it('stops the whole tick once the drain found the lock taken: no report stamped, nothing read or sent after', async () => {
    const fixture = tickFixture({ items: [seedItem(TWELVE, 'item-12', {})], issues: [{ ref: TWELVE }] });
    await fixture.file({ id: 'mine', payload: setFields(12, { severity: 'S2' }) });
    await writeLastAudit(fixture.repository, {
      at: new Date(fixture.clock.now().getTime() - 7 * 60 * 60 * 1000),
      notOnBoard: 0,
      emptyFields: 0,
      closedNotDone: 0,
    });
    fixture.board.onCall = (call): void => {
      if (call === 'catalog') {
        fixture.repository.takeTheLockAway();
      }
    };
    const ran: string[] = [];
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      audit: () => {
        ran.push('audit');
        return Promise.resolve();
      },
      sync: {
        owner: new SyncOwner({ identity: identity('alice'), sync: SYNC, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        importer: () => {
          ran.push('import');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
        forge: () => {
          ran.push('forge');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
      },
    });

    const report = await tick.run();

    assert.deepEqual(ran, []);
    assert.match(report.stoppedBecause ?? '', /lock/);
    assert.equal(await readLastAuditAttemptAt(fixture.repository), null, 'the holder\'s due report is not put off');
  });

  it('runs nothing more once a job before the drain found the lock taken', async () => {
    const fixture = tickFixture({ items: [seedItem(TWELVE, 'item-12', {})], issues: [{ ref: TWELVE }] });
    await fixture.file({ id: 'mine', payload: setFields(12, { severity: 'S2' }) });
    const ran: string[] = [];
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: identity('alice'), sync: SYNC, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        mirror: async (lease) => {
          ran.push('mirror');
          fixture.repository.takeTheLockAway();
          if (!(await lease.stillHeld())) {
            throw new TickLockLost();
          }
          return Promise.reject(new Error('the lease said the lock was still held'));
        },
        finish: () => {
          ran.push('finish');
          return Promise.reject(new Error('finish ran'));
        },
        forge: () => {
          ran.push('forge');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
      },
    });

    const report = await tick.run();

    assert.deepEqual(ran, ['mirror']);
    assert.equal(report.executed, 0);
    assert.match(report.skipped ?? '', /lock/);
    assert.equal((await fixture.stored('mine')).state, 'queued');
  });

  it('runs nothing more once ending finished claims found the lock taken', async () => {
    const fixture = tickFixture({ items: [seedItem(TWELVE, 'item-12', {})], issues: [{ ref: TWELVE }] });
    await fixture.file({ id: 'mine', payload: setFields(12, { severity: 'S2' }) });
    const ran: string[] = [];
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: identity('alice'), sync: SYNC, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        finish: () => {
          ran.push('finish');
          return Promise.reject(new TickLockLost());
        },
        importer: () => {
          ran.push('import');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
        forge: () => {
          ran.push('forge');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
      },
    });

    const report = await tick.run();

    assert.deepEqual(ran, ['finish']);
    assert.equal(report.executed, 0);
    assert.equal((await fixture.stored('mine')).state, 'queued', 'the queue is the holder\'s to drain');
  });

  it('runs nothing more once the import found the lock taken', async () => {
    const fixture = tickFixture();
    const ran: string[] = [];
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: identity('alice'), sync: SYNC, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        importer: () => {
          ran.push('import');
          return Promise.reject(new TickLockLost());
        },
        forge: () => {
          ran.push('forge');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
      },
    });

    const report = await tick.run();

    assert.deepEqual(ran, ['import']);
    assert.equal(report.lockLost, true);
  });

  it('runs nothing more once the board report found the lock taken, and gives its stamp back', async () => {
    const fixture = tickFixture();
    const lastAttempt = new Date(fixture.clock.now().getTime() - 8 * 60 * 60 * 1000);
    await writeLastAudit(fixture.repository, { at: lastAttempt, notOnBoard: 0, emptyFields: 0, closedNotDone: 0 });
    await writeLastAuditAttemptAt(fixture.repository, lastAttempt);
    const ran: string[] = [];
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      audit: async (lease) => {
        ran.push('audit');
        fixture.repository.takeTheLockAway();
        if (!(await lease.stillHeld())) {
          throw new TickLockLost();
        }
      },
      sync: {
        owner: new SyncOwner({ identity: identity('alice'), sync: SYNC, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        importer: () => {
          ran.push('import');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
        forge: () => {
          ran.push('forge');
          return Promise.resolve({ skipped: 'nothing to do' });
        },
      },
    });

    const report = await tick.run();

    assert.deepEqual(ran, ['audit']);
    assert.equal(report.lockLost, true);
    assert.equal(
      (await readLastAuditAttemptAt(fixture.repository))?.getTime(),
      lastAttempt.getTime(),
      'the holder\'s report is not put off by a pass that never wrote one',
    );
  });

  it('does not run the mirror while another tick holds the lock', async () => {
    const fixture = tickFixture();
    fixture.repository.pretendAnotherTickHolds = true;
    const feed = feedWithAClaim();

    const report = await worker(fixture, feed, 'alice').run();

    assert.deepEqual(report.sync?.mirror, { skipped: 'another tick holds the lock' });
    assert.deepEqual(feed.calls, []);
  });
  it('mirrors its own person\'s moves on a worker that is not the owner, and leaves the owner\'s jobs quietly', async () => {
    const fixture = tickFixture({
      catalog: qaCatalog(),
      items: [seedItem(TWELVE, 'item-12', { Status: 'Todo' })],
      issues: [{ ref: TWELVE }],
    });
    const feed = new FakeCoordination()
      .item(41, 'gh:example-org/first-repo#12')
      .member('alice', 'alice-gh')
      .member('bob', 'bob-gh')
      .log(claim(3, 'claimed', 41, 'bob'))
      .holds(41, 'bob');
    await fixture.repository.setMeta(mirrorCursorKey(SYNC.server, SYNC.project), '0');
    const sync = ownScopeSync();
    const bob = identity('bob-gh');
    const importer = async () => Promise.reject(new Error('the importer must not run on this worker'));
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: bob, sync, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        mirror: (lease) => mirrorFor(fixture, feed, sync, new OwnMoves(bob, SYNC.mirrorOwner)).pass(lease),
        mirrorScope: 'own',
        importer,
      },
    });

    const report = await tick.run();
    await tick.run();

    assert.deepEqual(fixture.board.valuesOf(TWELVE), { Status: 'In Progress' });
    assert.deepEqual(fixture.issues.assigneesOf(TWELVE), ['bob-gh']);
    assert.equal(report.sync?.refusal, 'not-the-owner');
    assert.equal(report.sync?.refused, 'this worker runs as bob-gh, and only alice\'s worker runs the importer');
    assert.equal(report.sync?.import, undefined);
    assert.deepEqual(fixture.logger.lines.filter((line) => line.level === 'error'), []);
    assert.equal(
      fixture.logger.lines.filter((line) => line.message === 'the jobs kept for the owner\'s worker do not run on this one').length,
      1,
      'said once, not at every tick',
    );
    assert.equal((await readSyncRefusal(fixture.repository))?.refusal, 'not-the-owner');
  });

  it('never asks whether it is the owner\'s when only its own person\'s moves are mirrored, and forgets an old refusal', async () => {
    const fixture = tickFixture();
    await worker(fixture, feedWithAClaim(), 'bob').run();
    const sync = ownScopeSync({ importer: { enabled: false } });
    let asked = 0;
    const counted = { login: () => { asked += 1; return Promise.resolve('alice-gh'); } };
    const owner = { login: () => Promise.reject(new Error('the owner check must not be asked')) };
    const tick = new RunTick({
      drain: fixture.drain,
      repository: fixture.repository,
      policy: fixture.policy,
      clock: fixture.clock,
      logger: fixture.logger,
      sync: {
        owner: new SyncOwner({ identity: owner, sync, repository: fixture.repository, clock: fixture.clock, logger: fixture.logger }),
        mirror: (lease) => mirrorFor(fixture, feedWithAClaim(), sync, new OwnMoves(counted, SYNC.mirrorOwner)).pass(lease),
        mirrorScope: 'own',
      },
    });

    const report = await tick.run();

    assert.equal(report.sync?.refused, undefined);
    assert.equal(asked, 1);
    assert.equal(await readSyncRefusal(fixture.repository), null);
    const mirrored = report.sync?.mirror;
    assert.ok(mirrored !== undefined && !('skipped' in mirrored));
    assert.equal(mirrored.filedFor, 'alice');
  });
});
