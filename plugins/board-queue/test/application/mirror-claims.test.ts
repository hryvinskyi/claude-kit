import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OwnMoves } from '../../src/application/mirror-audience.ts';
import { MirrorClaims } from '../../src/application/mirror-claims.ts';
import { mirrorCursorKey, mirrorLoginKey, readMirrorRun } from '../../src/application/sync-meta.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import type { MirrorConfig } from '../../src/domain/sync-config.ts';
import { FakeCoordination, claim, forcedRelease } from '../fakes/fake-coordination.ts';
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
  /** Files only the moves of the person this login stands for; everybody's when absent. */
  ownLogin?: string | null | (() => Promise<string | null>);
  /** The configured owner's GitHub login, for a mirror of one's own moves. */
  owner?: string;
};

/** The GitHub login of the configured owner's worker, in the tests of a mirror of one's own moves. */
const OWNER_LOGIN = 'alice-gh';

function ownMoves(login: string | null | (() => Promise<string | null>), owner = OWNER_LOGIN): OwnMoves {
  return new OwnMoves({ login: typeof login === 'function' ? login : () => Promise.resolve(login) }, owner);
}

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
    ...(options.ownLogin === undefined ? {} : { audience: ownMoves(options.ownLogin, options.owner) }),
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
      { repo: 'example-org/first-repo', issue: 12, add: ['alice-gh', 'bob-gh'], remove: [] },
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

  it('still unassigns a member the project has since removed when their claim is taken over', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'bob'));
    await mirrorClaims.execute();
    feed.forget('bob');
    feed.log(claim(2, 'taken_over', 41, 'alice', 'bob'));

    await mirrorClaims.execute();

    const assignments = await repository.list({ kind: 'issue.assignees' });
    assert.deepEqual(assignments[1]?.payload, {
      repo: 'example-org/first-repo',
      issue: 12,
      add: ['alice-gh'],
      remove: ['bob-gh'],
    });
  });

  it('leaves the person who started the work assigned when their claim is released', async () => {
    const { repository, feed, mirrorClaims, following } = harness();
    await following();
    feed.log(claim(1, 'claimed', 41, 'bob'));
    await mirrorClaims.execute();
    feed.log(claim(2, 'released', 41, 'bob'));

    await mirrorClaims.execute();

    assert.deepEqual((await repository.list({})).map((action) => action.payload), [
      status(12, 'In Progress'),
      { repo: 'example-org/first-repo', issue: 12, add: ['bob-gh'], remove: [] },
      status(12, 'Todo'),
    ]);
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

describe('filing only the moves of the person this worker runs as', () => {
  it('files the moves whose last event that person caused, and asks nothing about the rest', async () => {
    const { repository, feed, mirrorClaims, following } = harness({ ownLogin: 'Bob-GH' });
    await following();
    feed.log(claim(3, 'claimed', 41, 'alice'), claim(4, 'claimed', 45, 'bob')).holds(41, 'alice').holds(45, 'bob');

    const report = await mirrorClaims.execute();

    const actions = await repository.list({});
    assert.deepEqual(actions.map((action) => [action.kind, action.payload]), [
      ['board.set-fields', status(13, 'In Progress')],
      ['issue.assignees', { repo: 'example-org/first-repo', issue: 13, add: ['bob-gh'], remove: [] }],
    ]);
    assert.equal(report.filedFor, 'bob');
    assert.equal(report.othersMoves, 1);
    assert.equal(report.cursor, 4, 'the cursor moves past the moves left to others');
    assert.deepEqual(feed.calls.filter((call) => call === 'itemRef').length, 1, 'alice\'s item is never looked up');
  });

  it('leaves a claim taken over in the same page to the taker\'s worker, which files the whole move', async () => {
    const events = [claim(3, 'claimed', 41, 'alice'), claim(5, 'taken_over', 41, 'bob', 'alice')];
    const alice = harness({ ownLogin: 'alice-gh' });
    const bob = harness({ ownLogin: 'bob-gh' });
    for (const worker of [alice, bob]) {
      await worker.following();
      worker.feed.log(...events).holds(41, 'bob');
    }

    await alice.mirrorClaims.execute();
    await bob.mirrorClaims.execute();

    assert.deepEqual(await alice.repository.list({}), []);
    assert.deepEqual((await bob.repository.list({})).map((action) => action.payload), [
      status(12, 'In Progress'),
      { repo: 'example-org/first-repo', issue: 12, add: ['bob-gh'], remove: ['alice-gh'] },
    ]);
  });

  it('files an admin\'s release in the admin\'s worker, and the operator\'s in the holder\'s', async () => {
    const admin = harness({ ownLogin: 'carol-gh' });
    const holder = harness({ ownLogin: 'alice-gh' });
    for (const worker of [admin, holder]) {
      worker.feed.forget('carol').member('carol', 'carol-gh');
      await worker.following();
      worker.feed.log(forcedRelease(3, 41, 'alice', 'carol'), forcedRelease(4, 45, 'alice', null));
    }

    await admin.mirrorClaims.execute();
    await holder.mirrorClaims.execute();

    assert.deepEqual((await admin.repository.list({ kind: 'board.set-fields' })).map((action) => action.payload), [
      status(12, 'Todo'),
    ]);
    assert.deepEqual((await holder.repository.list({ kind: 'board.set-fields' })).map((action) => action.payload), [
      status(13, 'Todo'),
    ]);
  });

  it('files only that person\'s live claims when it starts from the head', async () => {
    const { repository, feed, mirrorClaims } = harness({ ownLogin: 'bob-gh' });
    feed.log(claim(3, 'claimed', 41, 'alice'), claim(4, 'claimed', 45, 'bob')).holds(41, 'alice').holds(45, 'bob');

    const report = await mirrorClaims.execute();

    assert.deepEqual((await repository.list({ kind: 'board.set-fields' })).map((action) => action.payload), [
      status(13, 'In Progress'),
    ]);
    assert.equal(report.othersMoves, 1);
    assert.equal(report.startedFromHead?.event, 4);
  });

  it('files and reads nothing for a login no member names, keeps its cursor, and says so once', async () => {
    const { repository, feed, logger, mirrorClaims, following } = harness({ ownLogin: 'dave-gh' });
    await following();
    feed.log(claim(3, 'claimed', 41, 'alice'));

    const first = await mirrorClaims.execute();
    const second = await mirrorClaims.execute();

    assert.match(first.declined ?? '', /this worker runs as dave-gh, and no member of the project names that GitHub login/);
    assert.equal(second.declined, first.declined);
    assert.deepEqual(feed.calls, ['members', 'members'], 'only the members are read');
    assert.deepEqual(await repository.list({}), []);
    assert.equal(await repository.getMeta(CURSOR), '0');
    assert.equal(first.error, null);
    assert.equal(logger.lines.filter((line) => line.message === 'the claim mirror files nothing on this worker').length, 1);
    assert.equal((await readMirrorRun(repository))?.declined, first.declined);
  });

  it('files nothing when the login cannot be read, or two members name it', async () => {
    const unread = harness({ ownLogin: () => Promise.reject(new Error('gh is not installed')) });
    const nobody = harness({ ownLogin: null });
    const twice = harness({ ownLogin: 'alice-gh' });
    twice.feed.member('alicia', 'ALICE-gh');

    const [unreadRun, nobodyRun, twiceRun] = await Promise.all([
      unread.mirrorClaims.execute(),
      nobody.mirrorClaims.execute(),
      twice.mirrorClaims.execute(),
    ]);

    assert.match(unreadRun.declined ?? '', /could not be read: gh is not installed/);
    assert.match(nobodyRun.declined ?? '', /could not be read, so whose moves are this person's is not known/);
    assert.match(twiceRun.declined ?? '', /^alice, alicia all name alice-gh as their GitHub login/);
    assert.deepEqual(unread.feed.calls, []);
    assert.deepEqual(twice.feed.calls, ['members']);
  });

  it('records a server that cannot answer whose member this worker is as the run stopping', async () => {
    const { feed, mirrorClaims } = harness({ ownLogin: 'bob-gh' });
    feed.fail('members', new TransientFailure('the members could not be reached'));

    const report = await mirrorClaims.execute();

    assert.match(report.error ?? '', /the members could not be reached/);
    assert.equal(report.declined, null);
  });

  it('files nothing of an old page read late, once the server shows what somebody else did since', async () => {
    // Bob's laptop slept through the weekend: his claim and Carol's release of it are
    // both in the log, Carol's worker filed hers on Friday, and Bob's reads his page
    // only now — one event at a time, so his claim comes on a page of its own.
    const { repository, feed, mirrorWith, following } = harness({ ownLogin: 'bob-gh' });
    feed.member('carol', 'carol-gh');
    await following();
    feed.log(claim(3, 'claimed', 41, 'bob'), forcedRelease(4, 41, 'bob', 'carol'));

    const report = await mirrorWith(1).execute();

    assert.deepEqual(await repository.list({}), []);
    assert.equal(report.staleMoves, 1);
    assert.equal(report.othersMoves, 1);
    assert.equal(report.cursor, 4);
    assert.equal(feed.calls.filter((call) => call === 'liveClaims').length, 1, 'the live claims are read once a run');
  });

  it('files, in the owner\'s worker, the release of a member removed from the server\'s command line', async () => {
    const owner = harness({ ownLogin: 'alice-gh' });
    const bob = harness({ ownLogin: 'bob-gh' });
    for (const worker of [owner, bob]) {
      await worker.following();
      await worker.repository.setMeta(mirrorLoginKey(SYNC.server, SYNC.project, 'dave'), 'dave-gh');
      worker.feed.log(forcedRelease(6, 41, 'dave', null));
    }

    const filed = await owner.mirrorClaims.execute();
    const passed = await bob.mirrorClaims.execute();

    assert.deepEqual((await owner.repository.list({})).map((action) => action.payload), [
      status(12, 'Todo'),
    ]);
    assert.equal(filed.orphanMoves, 1);
    assert.deepEqual(await bob.repository.list({}), []);
    assert.equal(passed.othersMoves, 1);
  });

  it('files in the owner\'s worker the moves of a member who names no GitHub login, while they still stand', async () => {
    const { repository, feed, mirrorClaims, following } = harness({ ownLogin: 'alice-gh' });
    await following();
    feed.log(claim(3, 'claimed', 41, 'carol'), claim(4, 'claimed', 45, 'carol')).holds(41, 'carol');

    const report = await mirrorClaims.execute();

    assert.deepEqual((await repository.list({ kind: 'board.set-fields' })).map((action) => action.payload), [
      status(12, 'In Progress'),
    ]);
    assert.equal(report.orphanMoves, 1);
    assert.equal(report.staleMoves, 1);
  });

  it('warns at every run when the configured owner is no member, so nobody files those moves', async () => {
    const { logger, mirrorClaims, following } = harness({ ownLogin: 'bob-gh', owner: 'alcie-gh' });
    await following();

    const first = await mirrorClaims.execute();
    await mirrorClaims.execute();

    assert.match(first.ownerWarning ?? '', /no member of the project names alcie-gh, the configured owner/);
    assert.equal(logger.lines.filter((line) => line.message === 'the configured owner is no member of the project').length, 2);
  });

  it('logs a login that cannot be read at every run', async () => {
    const { logger, mirrorClaims } = harness({ ownLogin: null });

    await mirrorClaims.execute();
    await mirrorClaims.execute();

    assert.equal(logger.lines.filter((line) => line.message === 'the claim mirror files nothing on this worker').length, 2);
  });
});
