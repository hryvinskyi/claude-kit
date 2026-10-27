import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FinishClaims } from '../../src/application/finish-claims.ts';
import { finishSightingsKey, readFinishRun, readSightings } from '../../src/application/sync-meta.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import type { HeldClaim } from '../../src/domain/sync/finished-claims.ts';
import { FakeCoordination } from '../fakes/fake-coordination.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { SERVER, syncOf } from '../fixtures/sync.ts';

const SYNC = syncOf();
const SIGHTINGS = finishSightingsKey(SYNC.server, SYNC.project);
const TAKEN = '2026-03-02T08:00:00Z';
const AREAS = ['web:checkout', 'api:checkout'];

function heldClaim(item: number, boardStatus: string | null, overrides: Partial<HeldClaim> = {}): HeldClaim {
  return {
    item,
    ref: `gh:example-org/first-repo#${String(item)}`,
    claimedAt: TAKEN,
    boardStatus,
    closed: false,
    areas: AREAS,
    inReview: false,
    ...overrides,
  };
}

function harness() {
  const repository = new InMemoryActionRepository();
  const server = new FakeCoordination();
  const finish = new FinishClaims({
    claims: server,
    repository,
    sync: SYNC,
    finish: { enabled: true, handOn: ['Ready for QA'], complete: ['Done'] },
    clock: new FakeClock('2026-03-02T09:00:00.000Z'),
    logger: new RecordingLogger(),
  });
  return { repository, server, finish };
}

describe('letting claims go as the board moves their work on', () => {
  it('gives up the areas of a claim whose issue moved on to QA, keeping its item, and leaves the rest held', async () => {
    const { repository, server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress'))
      .heldBy('alice', heldClaim(42, 'In Progress'))
      .heldBy('bob', heldClaim(43, 'In Progress'));
    await finish.execute();

    server.heldBy('alice', heldClaim(41, 'Ready for QA')).heldBy('bob', heldClaim(43, 'Ready for QA'));
    const report = await finish.execute();

    assert.deepEqual(server.givenUp, [[41, AREAS]], 'bob\'s claim is left to bob\'s worker');
    assert.deepEqual(server.completed, [], 'the item stays held, so the work can be taken up again');
    assert.deepEqual(report.handedOn, ['gh:example-org/first-repo#41']);
    assert.equal(report.holder, 'alice');
    assert.equal(report.held, 2);
    assert.deepEqual((await readSightings(repository, SIGHTINGS)).get(41), { claimedAt: TAKEN, stage: 'handed-on' });
    assert.deepEqual(await readFinishRun(repository), report);
  });

  it('completes the claim once its issue is done or closed, after its areas were given up', async () => {
    const { repository, server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress')).heldBy('alice', heldClaim(42, 'In Progress'));
    await finish.execute();
    server.heldBy('alice', heldClaim(41, 'Ready for QA'));
    await finish.execute();

    server.heldBy('alice', heldClaim(41, 'Done', { areas: [] }))
      .heldBy('alice', heldClaim(42, 'In Progress', { closed: true }));
    const report = await finish.execute();

    assert.deepEqual(server.completed, [41, 42]);
    assert.deepEqual(report.completed, ['gh:example-org/first-repo#41', 'gh:example-org/first-repo#42']);
    assert.equal((await readSightings(repository, SIGHTINGS)).size, 0);
  });

  it('lets nothing go the first time it sees a claim, so work taken up again after QA keeps its areas', async () => {
    const { server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'Ready for QA'));

    await finish.execute();
    const again = await finish.execute();

    assert.deepEqual(server.givenUp, []);
    assert.deepEqual(again.handedOn, []);
  });

  it('counts a claim its holder let go of in the meantime, and forgets it', async () => {
    const { repository, server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress'));
    await finish.execute();
    server.heldBy('alice', heldClaim(41, 'Ready for QA')).goneOnCompletion.add(41);

    const report = await finish.execute();

    assert.deepEqual(report.handedOn, []);
    assert.equal(report.gone, 1);
    assert.equal((await readSightings(repository, SIGHTINGS)).size, 0);
  });

  it('makes a call the server could not answer again at the next run', async () => {
    const { server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress'));
    await finish.execute();
    server.heldBy('alice', heldClaim(41, 'Ready for QA')).fail('giveUpAreas', new TransientFailure('the server did not answer'));

    const failed = await finish.execute();
    const retried = await finish.execute();

    assert.match(failed.error ?? '', /did not answer/);
    assert.deepEqual(retried.handedOn, ['gh:example-org/first-repo#41']);
    assert.deepEqual(server.givenUp, [[41, AREAS]]);
  });

  it('lets nothing go on a token that speaks for an integration, and says so', async () => {
    const { server, finish } = harness();
    server.tokenHolder = null;

    const report = await finish.execute();

    assert.match(report.declined ?? '', /integration, not a person/);
    assert.deepEqual(server.calls, ['holder']);
  });

  it('records why a run stopped when the server could not list the claims', async () => {
    const { repository, server, finish } = harness();
    server.fail('held', new TransientFailure(`${SERVER} could not be reached`));

    const report = await finish.execute();

    assert.match(report.error ?? '', /could not be reached/);
    assert.equal((await readFinishRun(repository))?.error, report.error);
  });
});
