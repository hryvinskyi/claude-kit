import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MirrorClaims } from '../../src/application/mirror-claims.ts';
import { mirrorCursorKey, readMirrorRun } from '../../src/application/sync-meta.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import type { MirrorConfig } from '../../src/domain/sync-config.ts';
import { FakeCoordination, claim } from '../fakes/fake-coordination.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { SERVER, syncConfig, syncOf } from '../fixtures/sync.ts';

const SYNC = syncOf();
const CURSOR = mirrorCursorKey(SYNC.server, SYNC.project);
const OWNED = ['In Progress', 'Todo', 'In Review', ''];

function mirrorOf(): MirrorConfig {
  const mirror = SYNC.mirror;
  if (mirror === undefined) {
    throw new Error('the fixture mirrors nothing');
  }
  return mirror;
}

type Options = {
  mirror?: MirrorConfig;
  pageSize?: number;
};

function harness(options: Options = {}) {
  const repository = new InMemoryActionRepository();
  const feed = new FakeCoordination()
    .item(41, 'gh:example-org/first-repo#12')
    .item(42, 'gh:example-user/second-repo#7')
    .item(43, 'gh:elsewhere/unlisted#1')
    .item(44, null)
    .item(45, 'gh:example-org/first-repo#13')
    .member('alice', 'alice-gh')
    .member('bob', 'bob-gh')
    .member('carol', null);
  const logger = new RecordingLogger();
  const mirrorWith = (pageSize: number | undefined): MirrorClaims => new MirrorClaims({
    feed,
    repository,
    kinds: defaultKindRegistry(syncConfig),
    directory: BoardDirectory.of(syncConfig.boards),
    sync: SYNC,
    mirror: options.mirror ?? mirrorOf(),
    clock: new FakeClock('2026-03-02T09:00:00.000Z'),
    logger,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  const mirrorClaims = mirrorWith(options.pageSize);
  /** A mirror that has run before and follows the log from its start. */
  const following = async (): Promise<void> => {
    await repository.setMeta(CURSOR, '0');
  };
  return { repository, feed, logger, mirrorClaims, mirrorWith, following };
}

function status(issue: number, value: string): unknown {
  return { repo: 'example-org/first-repo', issue, fields: { status: value }, onlyIfStatusIn: OWNED };
}

describe('following the claim log', () => {
  it('files a conditional status write and an assignment for a claim', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(3, 'claimed', 41, 'alice'));

    const report = await mirrorClaims.execute();

    const actions = await repository.list({});
    assert.deepEqual(actions.map((action) => [action.kind, action.payload]), [
      ['board.set-fields', status(12, 'In Progress')],
      ['issue.assignees', { repo: 'example-org/first-repo', issue: 12, add: ['alice-gh'], remove: [] }],
    ]);
    assert.deepEqual(actions.map((action) => action.dedupeKey), [
      `dibs:${SERVER}:widgets:3:status`,
      `dibs:${SERVER}:widgets:3:assignees`,
    ]);
    assert.equal(report.filed, 2);
    assert.equal(report.cursor, 3);
    assert.equal(await repository.getMeta(CURSOR), '3');
  });

  it('files nothing new when the same page is read again', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(3, 'claimed', 41, 'alice'));
    await mirrorClaims.execute();
    await following();

    const replay = await mirrorClaims.execute();

    assert.equal((await repository.list({})).length, 2);
    assert.equal(replay.filed, 0);
  });

  it('files no in-between state when the pages fall differently the second time', async () => {
    const { repository, feed, mirrorClaims, mirrorWith, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'alice'), claim(2, 'released', 41, 'alice'), claim(3, 'claimed', 41, 'bob'));
    await mirrorClaims.execute();
    await following();

    // The same log read again, two events a page: the first page ends on the
    // release, a state older than the one already filed.
    const replay = await mirrorWith(2).execute();

    const statuses = (await repository.list({ kind: 'board.set-fields' })).map((action) => action.payload);
    assert.deepEqual(statuses, [status(12, 'In Progress')], 'the release in the middle was not filed');
    assert.equal(replay.filed, 0);
  });

  it('reads on from the cursor, and only from it', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(3, 'claimed', 41, 'alice'));
    await mirrorClaims.execute();
    feed.log(claim(4, 'released', 41, 'alice'));

    await mirrorClaims.execute();

    assert.deepEqual(feed.pagesAskedFrom, [0, 3, 3, 4], 'each run asks once more and finds the cursor still');
    const keys = (await repository.list({ kind: 'board.set-fields' })).map((action) => action.dedupeKey);
    assert.deepEqual(keys, [`dibs:${SERVER}:widgets:3:status`, `dibs:${SERVER}:widgets:4:status`]);
  });

  it('collapses the events of one issue in a page to the state the last one left', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(
      claim(1, 'claimed', 41, 'alice'),
      claim(2, 'released', 41, 'alice'),
      claim(3, 'claimed', 41, 'bob'),
    );

    await mirrorClaims.execute();

    const actions = await repository.list({});
    assert.deepEqual(actions.map((action) => action.payload), [
      status(12, 'In Progress'),
      { repo: 'example-org/first-repo', issue: 12, add: ['bob-gh'], remove: ['alice-gh'] },
    ]);
  });

  it('moves on past pages that show nothing, as far as the server says it read', async () => {
    const { feed, mirrorClaims, following } = harness({ pageSize: 2 });
    await following();
    feed.log({ id: 1, kind: 'hidden' }, { id: 2, kind: 'hidden' }, { id: 3, kind: 'hidden' }, claim(4, 'claimed', 41, 'alice'));

    const report = await mirrorClaims.execute();

    assert.deepEqual(feed.pagesAskedFrom, [0, 2, 4]);
    assert.equal(report.cursor, 4);
    assert.equal(report.filed, 2);
  });

  it('saves the cursor even when a page shows nothing at all', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log({ id: 1, kind: 'hidden' }, { id: 2, kind: 'other' });

    const report = await mirrorClaims.execute();

    assert.equal(report.events, 1);
    assert.equal(report.filed, 0);
    assert.equal(await repository.getMeta(CURSOR), '2');
  });

  it('leaves alone an issue of a repository it does not keep in step, and an item that is no issue', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 42, 'alice'), claim(2, 'claimed', 43, 'alice'), claim(3, 'claimed', 44, 'alice'));

    const report = await mirrorClaims.execute();

    assert.equal((await repository.list({})).length, 0);
    assert.equal(report.ignored, 3);
    assert.equal(report.cursor, 3, 'what it passed over is behind the cursor all the same');
  });

  it('passes over an item whose reference cannot be read and files the rest of the page', async () => {
    const { feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 46, 'alice'), claim(2, 'claimed', 41, 'alice'));
    feed.fail('itemRef', new TransientFailure('the work item 46 answered 500'));

    const report = await mirrorClaims.execute();

    assert.equal(report.unresolved, 1);
    assert.equal(report.filed, 2);
    assert.equal(report.cursor, 2);
  });

  it('asks an item\'s reference once and keeps it', async () => {
    const { feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'alice'), claim(2, 'claimed', 45, 'bob'));
    await mirrorClaims.execute();
    feed.log(claim(3, 'released', 41, 'alice'));

    await mirrorClaims.execute();

    assert.equal(feed.calls.filter((call) => call === 'itemRef').length, 2);
  });

  it('assigns nobody for a member with no GitHub login, and says so', async () => {
    const { repository, feed, logger, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'carol'));

    await mirrorClaims.execute();

    assert.deepEqual((await repository.list({})).map((action) => action.kind), ['board.set-fields']);
    assert.ok(logger.lines.some((line) => /names no GitHub login/.test(line.message)));
  });

  it('still unassigns a member the project has since removed', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'bob'));
    await mirrorClaims.execute();
    feed.forget('bob');
    feed.log(claim(2, 'force_released', 41, 'bob'));

    await mirrorClaims.execute();

    const assignments = await repository.list({ kind: 'issue.assignees' });
    assert.deepEqual(assignments[1]?.payload, { repo: 'example-org/first-repo', issue: 12, add: [], remove: ['bob-gh'] });
  });

  it('files no assignment when the configuration says not to', async () => {
    const { repository, feed, mirrorClaims, following } = harness({ mirror: { ...mirrorOf(), assignees: false } });
    await following();
    feed.log(claim(1, 'claimed', 41, 'alice'));

    await mirrorClaims.execute();

    assert.deepEqual((await repository.list({})).map((action) => action.kind), ['board.set-fields']);
    assert.equal(feed.calls.includes('members'), false);
  });

  it('records a server it cannot reach, moves no cursor and files nothing', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'alice'));
    feed.fail('page', new TransientFailure('the event log could not be reached: no answer within the deadline'));

    const report = await mirrorClaims.execute();

    assert.match(report.error ?? '', /could not be reached/);
    assert.equal((await repository.list({})).length, 0);
    assert.equal(await repository.getMeta(CURSOR), '0');
    assert.match((await readMirrorRun(repository))?.error ?? '', /could not be reached/);
  });

  it('writes the cursor in the same transaction as the page\'s actions, so a failed write leaves neither', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'alice'));
    repository.failNextBatchWith = new Error('the disk is full');

    const report = await mirrorClaims.execute();

    assert.match(report.error ?? '', /disk is full/);
    assert.equal((await repository.list({})).length, 0);
    assert.equal(await repository.getMeta(CURSOR), '0');
    const again = await mirrorClaims.execute();
    assert.equal(again.filed, 2, 'the next run files the page it could not file before');
  });

  it('reads on page after page while the cursor moves', async () => {
    const { feed, mirrorClaims, following } = harness();
    await following();
    feed.log(...Array.from({ length: 500 }, (_, index) => ({ id: index + 1, kind: 'other' as const })));
    feed.log(claim(501, 'claimed', 41, 'alice'));

    const report = await mirrorClaims.execute();

    assert.deepEqual(feed.pagesAskedFrom, [0, 500, 501]);
    assert.equal(report.events, 501);
    assert.equal(report.filed, 2);
  });

  it('refuses a cursor note that is not a cursor, reads nothing, and says so', async () => {
    const { repository, feed, mirrorClaims } = harness();
    await repository.setMeta(CURSOR, 'forty-two');
    feed.log(claim(1, 'claimed', 41, 'alice'));

    const report = await mirrorClaims.execute();

    assert.match(report.error ?? '', /reads "forty-two", which is not a position in the log/);
    assert.deepEqual(feed.calls, []);
    assert.equal(await repository.getMeta(CURSOR), 'forty-two');
  });
});

describe('starting from the head of the log', () => {
  it('replays nothing on its first run and files the state each live claim stands for now', async () => {
    const { repository, feed, mirrorClaims } = harness();
    feed.log(claim(1, 'claimed', 41, 'alice'), claim(2, 'released', 41, 'alice'), claim(3, 'claimed', 45, 'bob'));
    feed.holds(45, 'bob', true);

    const report = await mirrorClaims.execute();

    const actions = await repository.list({});
    assert.deepEqual(actions.map((action) => [action.dedupeKey, action.payload]), [
      [`dibs:${SERVER}:widgets:head3:45:status`, status(13, 'In Review')],
      [`dibs:${SERVER}:widgets:head3:45:assignees`, { repo: 'example-org/first-repo', issue: 13, add: ['bob-gh'], remove: [] }],
    ]);
    assert.equal(report.cursor, 3);
    assert.deepEqual(report.startedFromHead, { at: '2026-03-02T09:00:00.000Z', event: 3, because: 'it had never run' });
    assert.equal(await repository.getMeta(CURSOR), '3');
  });

  it('files only the claimed status for a claim in review when no review status is configured', async () => {
    const { repository, feed, mirrorClaims } = harness({
      mirror: { ...mirrorOf(), status: { claimed: 'In Progress', released: 'Todo' } },
    });
    feed.holds(41, 'alice', true);

    await mirrorClaims.execute();

    const [first] = await repository.list({ kind: 'board.set-fields' });
    assert.deepEqual(first?.payload, {
      repo: 'example-org/first-repo',
      issue: 12,
      fields: { status: 'In Progress' },
      onlyIfStatusIn: ['In Progress', 'Todo', ''],
    });
  });

  it('follows the log from the head after that, and files nothing about events before it', async () => {
    const { repository, feed, mirrorClaims } = harness();
    feed.log(claim(1, 'claimed', 41, 'alice'));
    feed.holds(41, 'alice');
    await mirrorClaims.execute();
    feed.log(claim(2, 'released', 41, 'alice'));

    await mirrorClaims.execute();

    const statuses = (await repository.list({ kind: 'board.set-fields' })).map((action) => action.payload);
    assert.deepEqual(statuses, [status(12, 'In Progress'), status(12, 'Todo')]);
  });

  it('files the live claims in place of the events the log no longer keeps, and clears the loss', async () => {
    const { repository, feed, mirrorClaims } = harness();
    await repository.setMeta(CURSOR, '2');
    feed.log(claim(10, 'claimed', 41, 'alice'), claim(11, 'released', 41, 'alice'));
    feed.prunedThrough = 5;
    feed.holds(45, 'bob');

    const report = await mirrorClaims.execute();

    assert.equal(report.cursorExpired, null);
    assert.equal(report.startedFromHead?.event, 11);
    assert.match(report.startedFromHead?.because ?? '', /no longer kept the events after 2; it was pruned through 5/);
    const statuses = (await repository.list({ kind: 'board.set-fields' })).map((action) => action.payload);
    assert.deepEqual(statuses, [status(13, 'In Progress')], 'the pruned and the later events of #12 were not replayed');
  });

  it('keeps saying events were lost until the live claims could be filed', async () => {
    const { repository, feed, mirrorClaims } = harness();
    await repository.setMeta(CURSOR, '2');
    feed.log(claim(10, 'claimed', 41, 'alice'));
    feed.prunedThrough = 5;
    feed.fail('liveClaims', new TransientFailure('the live claims could not be reached'));

    const report = await mirrorClaims.execute();

    assert.deepEqual(report.cursorExpired, { at: '2026-03-02T09:00:00.000Z', prunedThrough: 5 });
    assert.equal(await repository.getMeta(CURSOR), '2');
    assert.match(report.error ?? '', /could not be reached/);
  });
});
