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

function heldClaim(item: number, boardStatus: string | null, overrides: Partial<HeldClaim> = {}): HeldClaim {
  return { item, ref: `gh:example-org/first-repo#${String(item)}`, claimedAt: TAKEN, boardStatus, inReview: false, ...overrides };
}

function harness() {
  const repository = new InMemoryActionRepository();
  const server = new FakeCoordination();
  const logger = new RecordingLogger();
  const finish = new FinishClaims({
    claims: server,
    repository,
    sync: SYNC,
    finish: { enabled: true, statuses: ['Ready for QA', 'Done'] },
    clock: new FakeClock('2026-03-02T09:00:00.000Z'),
    logger,
  });
  return { repository, server, logger, finish };
}

describe('ending the claims whose work the board calls finished', () => {
  it('completes the claim of an issue moved on to QA since the last run, and leaves the rest held', async () => {
    const { repository, server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress'))
      .heldBy('alice', heldClaim(42, 'In Progress'))
      .heldBy('bob', heldClaim(43, 'In Progress'));
    await finish.execute();

    server.heldBy('alice', heldClaim(41, 'Ready for QA')).heldBy('bob', heldClaim(43, 'Ready for QA'));
    const report = await finish.execute();

    assert.deepEqual(server.completed, [41], 'bob\'s claim is left to bob\'s worker');
    assert.deepEqual(report.completed, ['gh:example-org/first-repo#41']);
    assert.equal(report.holder, 'alice');
    assert.equal(report.held, 2);
    assert.deepEqual([...(await readSightings(repository, SIGHTINGS)).keys()], [42]);
    assert.deepEqual(await readFinishRun(repository), report);
  });

  it('ends nothing the first time it sees a claim, so work taken up again after QA stays held', async () => {
    const { server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'Ready for QA'));

    await finish.execute();
    const again = await finish.execute();

    assert.deepEqual(server.completed, []);
    assert.deepEqual(again.completed, []);
  });

  it('counts a finished claim its holder let go of in the meantime, and forgets it', async () => {
    const { repository, server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress'));
    await finish.execute();
    server.heldBy('alice', heldClaim(41, 'Done')).goneOnCompletion.add(41);

    const report = await finish.execute();

    assert.deepEqual(report.completed, []);
    assert.equal(report.gone, 1);
    assert.equal((await readSightings(repository, SIGHTINGS)).size, 0);
  });

  it('tries a completion the server could not answer again at the next run', async () => {
    const { server, finish } = harness();
    server.heldBy('alice', heldClaim(41, 'In Progress'));
    await finish.execute();
    server.heldBy('alice', heldClaim(41, 'Ready for QA')).fail('complete', new TransientFailure('the server did not answer'));

    const failed = await finish.execute();
    const retried = await finish.execute();

    assert.match(failed.error ?? '', /did not answer/);
    assert.deepEqual(retried.completed, ['gh:example-org/first-repo#41']);
    assert.deepEqual(server.completed, [41]);
  });

  it('ends nothing on a token that speaks for an integration, and says so', async () => {
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
