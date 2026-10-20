import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MirrorClaims } from '../../src/application/mirror-claims.ts';
import { RunTick } from '../../src/application/run-tick.ts';
import type { SyncJobs } from '../../src/application/run-tick.ts';
import { readSyncRefusal } from '../../src/application/sync-meta.ts';
import { SyncOwner } from '../../src/application/sync-owner.ts';
import type { LocalIdentity } from '../../src/application/sync-ports.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import { catalogField, catalogOf, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeCoordination, claim } from '../fakes/fake-coordination.ts';
import { syncConfig, syncOf } from '../fixtures/sync.ts';
import { FIRST, setFields, tickFixture } from './tick-fixture.ts';
import type { TickFixture } from './tick-fixture.ts';

const SYNC = syncOf();
const TWELVE = IssueRef.of(FIRST, 12);

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
    mirror: () => claims.execute(),
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
    assert.match(report.sync?.refused ?? '', /runs as bob, and only alice's worker/);
    assert.equal(report.sync?.mirror, undefined);
    assert.equal(report.done, 1);
    assert.match((await readSyncRefusal(fixture.repository))?.reason ?? '', /only alice's worker/);
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

  it('does not run the mirror while another tick holds the lock', async () => {
    const fixture = tickFixture();
    fixture.repository.pretendAnotherTickHolds = true;
    const feed = feedWithAClaim();

    const report = await worker(fixture, feed, 'alice').run();

    assert.deepEqual(report.sync?.mirror, { skipped: 'another tick holds the lock' });
    assert.deepEqual(feed.calls, []);
  });
});
