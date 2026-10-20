import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { BudgetPolicy } from '../../src/application/budget-policy.ts';
import { ForgePass } from '../../src/application/forge-pass.ts';
import type { KeptPull, ListingMark, WantedStatus } from '../../src/application/forge-ports.ts';
import { LimiterWait } from '../../src/application/limiter-wait.ts';
import { readForgeRun } from '../../src/application/sync-meta.ts';
import type { ForgeRepositoryRun, ForgeRun } from '../../src/application/sync-meta.ts';
import { WorkerConfigSchema } from '../../src/domain/config.ts';
import { NoAnswer, SecondaryRateLimited, TransientFailure } from '../../src/domain/errors.ts';
import type { ForgeConfig, SyncConfig } from '../../src/domain/sync-config.ts';
import { SyncConfigSchema } from '../../src/domain/sync-config.ts';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';
import { SqliteForgeLedger } from '../../src/infrastructure/sqlite-forge-ledger.ts';
import { FakeForge, pullRequest } from '../fakes/fake-forge.ts';
import { FakeForgeCoordination } from '../fakes/fake-forge-coordination.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { SERVER } from '../fixtures/sync.ts';

const FIRST = 'example-org/first-repo';
const SECOND = 'example-org/second-repo';
const THIRD = 'example-org/third-repo';
const START = '2026-03-02T09:00:00.000Z';
const BRANCH = 'alice/7-refunds';

const QUIET: WantedStatus = {
  enabled: true,
  status: { state: 'success', description: 'Nothing freezes main.', context: 'dibs' },
};

const FROZEN: WantedStatus = {
  enabled: true,
  status: { state: 'failure', description: 'A freezing action is in progress until 14:40 UTC.', context: 'dibs' },
};

function at(time: string): Date {
  return new Date(`2026-03-02T${time}.000Z`);
}

function measure(paths: readonly string[], sha = '4f2a91c0') {
  return { baseSha: sha, baseAt: new Date('2026-03-01T08:12:00.000Z'), paths, truncated: false };
}

/** The queue's own ledger, which can be told to lose the next listing it keeps, as a process that dies before its commit would. */
class DyingLedger extends SqliteForgeLedger {
  dieOnNextListing = false;

  override async recordListing(repo: string, mark: ListingMark, pulls: readonly KeptPull[]): Promise<void> {
    if (this.dieOnNextListing) {
      this.dieOnNextListing = false;
      throw new Error('the process died before its commit');
    }
    return super.recordListing(repo, mark, pulls);
  }
}

type Harness = {
  forge: FakeForge;
  dibs: FakeForgeCoordination;
  ledger: DyingLedger;
  repository: SqliteActionRepository;
  clock: FakeClock;
  sleeper: FakeSleeper;
  logger: RecordingLogger;
  /** Runs one pass, five minutes after the last. */
  pass(): Promise<ForgeRun>;
  /** Runs one pass and answers why it was skipped. */
  skipped(): Promise<string>;
  tallyOf(run: ForgeRun, repo: string): ForgeRepositoryRun;
};

type Options = {
  repos?: readonly string[];
  forge?: Partial<ForgeConfig>;
  /** Whether the calls go out as an App; they do unless a test says otherwise. */
  asApp?: boolean;
};

function syncFor(options: Options): SyncConfig {
  return SyncConfigSchema.parse({
    server: SERVER,
    project: 'widgets',
    tokenEnv: 'DIBS_TEST_TOKEN',
    mirrorOwner: 'alice',
    repos: options.repos ?? [FIRST],
    forge: { enabled: true, ...options.forge },
  });
}

function harness(t: TestContext, options: Options = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'board-queue-forge-'));
  const file = join(dir, 'queue.db');
  const clock = new FakeClock(START);
  const sleeper = new FakeSleeper(clock);
  const logger = new RecordingLogger();
  const repository = new SqliteActionRepository(file, { clock });
  const ledger = new DyingLedger(file);
  t.after(() => {
    ledger.close();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const forge = new FakeForge();
  const dibs = new FakeForgeCoordination()
    .repository('web', FIRST)
    .repository('api', SECOND)
    .repository('tools', THIRD)
    .member('alice', 'Alice-GH')
    .member('board', null);
  const sync = syncFor(options);
  const pass = new ForgePass({
    forge,
    coordination: dibs,
    identity: { usesAppIdentity: () => options.asApp ?? true },
    ledger,
    repository,
    wait: new LimiterWait({ repository, policy: new BudgetPolicy(WorkerConfigSchema.parse({})), logger }),
    sync,
    settings: sync.forge,
    clock,
    sleeper,
    logger,
  });
  let passes = 0;
  const execute = async () => {
    if (passes > 0) {
      clock.advanceMinutes(5);
    }
    passes += 1;
    return pass.execute();
  };
  return {
    forge,
    dibs,
    ledger,
    repository,
    clock,
    sleeper,
    logger,
    pass: async () => {
      const report = await execute();
      if ('skipped' in report) {
        throw new Error(`the pass was skipped: ${report.skipped}`);
      }
      return report.run;
    },
    skipped: async () => {
      const report = await execute();
      if (!('skipped' in report)) {
        throw new Error('the pass ran');
      }
      return report.skipped;
    },
    tallyOf: (run, repo) => {
      const tally = run.repos.find((one) => one.repo === repo);
      assert.ok(tally !== undefined, `the pass reports ${repo}`);
      return tally;
    },
  };
}

describe('following the pull requests of a repository', () => {
  it('starts from now with what is open, and reports nothing that ended before', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 1));
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('08:30:00'), updatedAt: at('08:30:00') }));

    const run = await h.pass();

    const tally = h.tallyOf(run, FIRST);
    assert.equal(tally.seeded, true);
    assert.equal(tally.listed, 1);
    assert.equal(tally.cursor, START);
    assert.deepEqual(h.dibs.merged, []);
    assert.deepEqual(h.forge.asked.filter((asked) => asked.call === 'pullPage').map((asked) => asked.detail), ['open 1']);
    assert.deepEqual((await h.ledger.openPulls(FIRST)).map((pull) => pull.number), [1]);
  });

  it('reports a merge once, with its head, base and files, however many passes see it again', async (t) => {
    const h = harness(t);
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`]);
    h.forge.put(pullRequest(FIRST, 1));
    await h.pass();
    h.forge.put(
      pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('09:02:00'), updatedAt: at('09:02:00'), headRef: BRANCH }),
      null,
      ['src/billing/refund.ts'],
    );

    const second = await h.pass();
    const third = await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('09:02:00'), updatedAt: at('09:11:00'), headRef: BRANCH }));
    h.forge.put(pullRequest(FIRST, 3, { updatedAt: at('09:12:00') }));
    const fourth = await h.pass();

    assert.equal(h.dibs.merged.length, 1);
    assert.deepEqual(h.dibs.merged[0], {
      pr: `${FIRST}#2`,
      base: 'main',
      head: BRANCH,
      mergedAt: at('09:02:00'),
      files: ['src/billing/refund.ts'],
      answer: { matched: true, item: 7, claim: 'completed' },
    });
    assert.equal(h.tallyOf(second, FIRST).cursor, at('09:02:00').toISOString());
    assert.equal(h.tallyOf(third, FIRST).listed, 0, 'an unchanged first page reads nothing');
    assert.ok(third.notModified >= 1);
    assert.equal(h.tallyOf(fourth, FIRST).listed, 2);
    assert.equal(h.tallyOf(fourth, FIRST).merged, 0);
    assert.equal(h.tallyOf(fourth, FIRST).cursor, at('09:12:00').toISOString());
  });

  it('reads back past its cursor by the overlap, and no further', async (t) => {
    const h = harness(t);
    h.forge.pageSize = 2;
    await h.pass();
    h.forge.put(pullRequest(FIRST, 10, { state: 'closed', mergedAt: at('09:03:00'), updatedAt: at('09:03:00') }));
    // Landed while the last pass was reading, with GitHub's clock a little behind: inside the overlap.
    h.forge.put(pullRequest(FIRST, 11, { state: 'closed', updatedAt: at('08:55:00') }));
    // Older than the cursor less the overlap: the last listing's business, not this one's.
    h.forge.put(pullRequest(FIRST, 12, { state: 'closed', updatedAt: at('08:40:00') }));
    h.forge.put(pullRequest(FIRST, 13, { state: 'closed', updatedAt: at('08:30:00') }));
    h.forge.put(pullRequest(FIRST, 14, { state: 'closed', updatedAt: at('08:20:00') }));

    const run = await h.pass();

    assert.deepEqual(h.dibs.merged.map((merge) => merge.pr), [`${FIRST}#10`]);
    assert.deepEqual(h.dibs.closed.map((close) => close.pr), [`${FIRST}#11`]);
    assert.deepEqual(
      h.forge.asked.filter((asked) => asked.call === 'pullPage').map((asked) => asked.detail),
      ['open 1', 'all 1', 'all 2'],
    );
    assert.equal(h.tallyOf(run, FIRST).cursor, at('09:03:00').toISOString());
  });

  it('sends its reports again after dying between them and its commit, and the server matches nothing twice', async (t) => {
    const h = harness(t);
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`]);
    await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('09:02:00'), updatedAt: at('09:02:00') }));
    h.ledger.dieOnNextListing = true;

    const died = await h.pass();
    const again = await h.pass();

    assert.deepEqual(h.dibs.merged.map((merge) => merge.answer), [
      { matched: true, item: 7, claim: 'completed' },
      { matched: false },
    ]);
    assert.match(h.tallyOf(died, FIRST).listingError ?? '', /died before its commit/);
    assert.equal(h.tallyOf(died, FIRST).cursor, START, 'the cursor did not move');
    assert.equal(h.tallyOf(again, FIRST).cursor, at('09:02:00').toISOString());
    assert.equal((await h.ledger.listing(FIRST))?.cursor.toISOString(), at('09:02:00').toISOString());
    assert.equal((await h.ledger.pull(FIRST, 2))?.reported, 'merged');
  });

  it('keeps one cursor per repository', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND, THIRD] });
    await h.pass();
    h.forge.put(pullRequest(SECOND, 4, { state: 'closed', mergedAt: at('09:03:00'), updatedAt: at('09:03:00') }));

    const run = await h.pass();

    assert.equal(h.tallyOf(run, FIRST).cursor, START);
    assert.equal(h.tallyOf(run, SECOND).cursor, at('09:03:00').toISOString());
    assert.equal(h.tallyOf(run, THIRD).cursor, START);
    assert.equal((await h.ledger.listing(SECOND))?.cursor.toISOString(), at('09:03:00').toISOString());
    assert.equal((await h.ledger.listing(FIRST))?.cursor.toISOString(), START);
    assert.deepEqual(h.dibs.merged.map((merge) => merge.pr), [`${SECOND}#4`]);
  });
});

describe('a window larger than one pass, and pull requests that do not cooperate', () => {
  it('reports a merge whose files cannot be read without them, and goes on to the next', async (t) => {
    const h = harness(t);
    await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('09:01:00'), updatedAt: at('09:01:00') }), null, ['a.ts']);
    h.forge.put(pullRequest(FIRST, 3, { state: 'closed', mergedAt: at('09:02:00'), updatedAt: at('09:02:00') }), null, ['b.ts']);
    h.forge.filesFail.add(`${FIRST}#2`);

    const run = await h.pass();
    await h.pass();
    h.forge.put(pullRequest(FIRST, 4, { updatedAt: at('09:12:00') }));
    await h.pass();

    assert.deepEqual(h.dibs.merged.map((merge) => [merge.pr, merge.files]), [
      [`${FIRST}#2`, null],
      [`${FIRST}#3`, ['b.ts']],
    ]);
    assert.equal(h.tallyOf(run, FIRST).mergesWithoutFiles, 1);
    assert.equal(h.tallyOf(run, FIRST).cursor, at('09:02:00').toISOString());
  });

  it('works through a backlog over several passes, the cursor at the last pull request finished, nothing sent twice', async (t) => {
    const h = harness(t, { forge: { maxPassMinutes: 4, paceMs: 60_000 } });
    await h.pass();
    for (let number = 10; number < 17; number += 1) {
      h.forge.put(pullRequest(FIRST, number, {
        state: 'closed',
        mergedAt: at(`09:0${String(number - 10)}:30`),
        updatedAt: at(`09:0${String(number - 10)}:30`),
      }), null, [`f${String(number)}.ts`]);
    }

    const first = await h.pass();
    const passes = [first];
    for (let more = 0; more < 4 && h.dibs.merged.length < 7; more += 1) {
      passes.push(await h.pass());
    }

    assert.match(first.stoppedBecause ?? '', /as long as one pass may/);
    assert.ok(h.tallyOf(first, FIRST).merged > 0 && h.tallyOf(first, FIRST).merged < 7, 'the first pass did part of it');
    assert.deepEqual(h.dibs.merged.map((merge) => merge.pr), [10, 11, 12, 13, 14, 15, 16].map((n) => `${FIRST}#${String(n)}`));
    assert.ok(passes.length > 2, 'it took more than two passes');
    assert.equal((await h.ledger.listing(FIRST))?.cursor.toISOString(), at('09:06:30').toISOString());
  });

  it('reads a pull request\'s files a page at a time, each page paced like any request', async (t) => {
    const h = harness(t);
    await h.pass();
    h.forge.pageSize = 2;
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('09:01:00'), updatedAt: at('09:01:00') }), null,
      ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    const slept = h.sleeper.slept.length;
    const asked = h.forge.asked.length;

    await h.pass();

    assert.deepEqual(h.forge.asked.slice(asked).filter((one) => one.call === 'pullFiles').map((one) => one.detail), ['2 1', '2 2', '2 3']);
    assert.deepEqual(h.dibs.merged[0]?.files, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    assert.equal(h.sleeper.slept.length - slept, h.forge.asked.length - asked - 1, 'every request after the first was paced');
  });

  it('reports a pull request that showed up on two pages once', async (t) => {
    const h = harness(t);
    await h.pass();
    h.forge.pageSize = 2;
    h.forge.put(pullRequest(FIRST, 5, { updatedAt: at('09:04:00') }));
    h.forge.put(pullRequest(FIRST, 6, { state: 'closed', mergedAt: at('09:03:00'), updatedAt: at('09:03:00') }));
    h.forge.put(pullRequest(FIRST, 7, { updatedAt: at('08:55:00') }));
    h.forge.onPageAsked = (page) => {
      if (page === 2) {
        // Updated while the first page was being handled: everything shifts down one place.
        h.forge.put(pullRequest(FIRST, 8, { updatedAt: at('09:04:30') }));
      }
    };

    await h.pass();

    assert.deepEqual(h.forge.asked.filter((one) => one.call === 'pullPage').map((one) => one.detail).slice(1), ['all 1', 'all 2']);
    assert.deepEqual(h.dibs.merged.map((merge) => merge.pr), [`${FIRST}#6`]);
  });

  it('names no head for a merge from a fork, and never measures a claimed branch against a fork\'s pull request', async (t) => {
    const h = harness(t);
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.put(pullRequest(FIRST, 3, { headRef: BRANCH, headRepo: 'someone/first-repo', baseRef: 'release' }));
    h.forge.branch(FIRST, 'main', BRANCH, measure(['a.ts']));
    await h.pass();
    h.forge.put(pullRequest(FIRST, 4, {
      state: 'closed',
      mergedAt: at('09:02:00'),
      updatedAt: at('09:02:00'),
      headRef: 'main',
      headRepo: 'someone/first-repo',
    }));

    await h.pass();

    assert.deepEqual(h.dibs.footprints.map((one) => one.footprint.base), ['main', 'main']);
    assert.equal(h.dibs.merged[0]?.head, null);
  });

  it('starts its first cursor where GitHub says it answered, not where this machine\'s clock stands', async (t) => {
    const h = harness(t);
    h.forge.servedAt = at('08:58:00');

    const run = await h.pass();

    assert.equal(h.tallyOf(run, FIRST).cursor, at('08:58:00').toISOString());
  });
});

describe('the claims in review', () => {
  it('reports a pull request a claim waits for that was merged before any listing saw it', async (t) => {
    const h = harness(t);
    h.forge.put(
      pullRequest(FIRST, 4, { state: 'closed', mergedAt: new Date('2026-02-01T10:00:00Z'), updatedAt: new Date('2026-02-01T10:00:00Z') }),
      null,
      ['README.md'],
    );
    h.dibs.inReview(9, 'alice', [`${FIRST}#4`]);

    await h.pass();
    await h.pass();

    assert.deepEqual(h.dibs.merged.map((merge) => ({ pr: merge.pr, files: merge.files, matched: merge.answer.matched })), [
      { pr: `${FIRST}#4`, files: ['README.md'], matched: true },
    ]);
  });

  it('reports a close, and leaves a claim the server only set aside to be measured on', async (t) => {
    const h = harness(t);
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`], 'set_aside');
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.branch(FIRST, 'main', BRANCH, measure(['src/a.ts']));
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', updatedAt: at('08:00:00') }));

    await h.pass();

    assert.deepEqual(h.dibs.closed.map((close) => close.answer), [{ matched: true, item: 7, claim: 'set_aside' }]);
    assert.deepEqual(h.dibs.footprints.map((footprint) => footprint.item), [7]);
  });

  it('measures nothing of a claim a merge completed in the same pass', async (t) => {
    const h = harness(t);
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`], 'completed');
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.branch(FIRST, 'main', BRANCH, measure(['src/a.ts']));
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('08:00:00'), updatedAt: at('08:00:00') }));

    await h.pass();

    assert.equal(h.dibs.merged.length, 1);
    assert.deepEqual(h.dibs.footprints, []);
  });

  it('asks again after a pull request kept as closed, which may have been reopened since', async (t) => {
    const h = harness(t);
    h.forge.pageSize = 1;
    await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', updatedAt: at('09:02:00') }));
    await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'open', updatedAt: at('09:20:00') }));
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`]);
    h.forge.fail('pullPage', new TransientFailure('the listing answered 403'));

    const run = await h.pass();

    assert.match(h.tallyOf(run, FIRST).listingError ?? '', /403/);
    assert.deepEqual(h.dibs.closed.map((close) => close.pr), [`${FIRST}#2`], 'reported once, before it was reopened');
    assert.equal((await h.ledger.pull(FIRST, 2))?.state, 'open');
  });

  it('goes on with the rest when one pull request cannot be read', async (t) => {
    const h = harness(t);
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`]);
    h.dibs.inReview(8, 'alice', [`${FIRST}#3`]);
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('08:00:00'), updatedAt: at('08:00:00') }));
    h.forge.put(pullRequest(FIRST, 3, { state: 'closed', mergedAt: at('08:10:00'), updatedAt: at('08:10:00') }));
    h.forge.fail('pull', new TransientFailure('the pull request answered 502'));

    const run = await h.pass();

    assert.equal(run.stoppedBecause, null);
    assert.equal(h.tallyOf(run, FIRST).failures, 1);
    assert.deepEqual(h.dibs.merged.map((merge) => merge.pr), [`${FIRST}#3`]);
  });
});

describe('whether a pull request merges cleanly', () => {
  it('is told about a member\'s pull request when it changes, and never about a stranger\'s', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 5), false);
    h.forge.put(pullRequest(FIRST, 6, { author: 'stranger' }), false);

    await h.pass();
    await h.pass();
    h.forge.setMergeable(FIRST, 5, true);
    await h.pass();

    assert.deepEqual(h.dibs.mergeability, [
      { pr: `${FIRST}#5`, mergeable: false },
      { pr: `${FIRST}#5`, mergeable: true },
    ]);
    assert.deepEqual(
      [...new Set(h.forge.asked.filter((asked) => asked.call === 'pull').map((asked) => asked.detail))],
      ['5'],
    );
  });

  it('says nothing while the forge is still working it out', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 5), null);

    await h.pass();

    assert.deepEqual(h.dibs.mergeability, []);
  });
});

describe('the status on a member\'s pull request', () => {
  it('is written once for a state that does not change over ten passes, and again when it does', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 5));
    h.dibs.wants('web', 'main', QUIET);

    for (let pass = 0; pass < 10; pass += 1) {
      await h.pass();
    }
    assert.equal(h.forge.statuses.length, 1);
    h.dibs.wants('web', 'main', FROZEN);
    await h.pass();
    await h.pass();

    assert.deepEqual(h.forge.statuses.map((written) => written.status.state), ['success', 'failure']);
    assert.equal(h.forge.statuses[1]?.sha, pullRequest(FIRST, 5).headSha);
    assert.equal(h.forge.statuses[1]?.status.description, 'A freezing action is in progress until 14:40 UTC.');
  });

  it('is never written on a stranger\'s pull request, nor where the repository wants none or is not listed', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND, 'example-org/unlisted'] });
    h.forge.put(pullRequest(FIRST, 5, { author: 'stranger' }));
    h.forge.put(pullRequest(SECOND, 6));
    h.forge.put(pullRequest('example-org/unlisted', 7));
    h.dibs.wants('web', 'main', QUIET);
    h.dibs.wants('api', 'main', { ...QUIET, enabled: false });

    await h.pass();

    assert.deepEqual(h.forge.statuses, []);
  });

  it('takes back a failing status once the repository no longer wants one, and then forgets it', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 5));
    h.dibs.wants('web', 'main', FROZEN);
    await h.pass();
    h.dibs.wants('web', 'main', { ...FROZEN, enabled: false });

    await h.pass();
    await h.pass();

    assert.deepEqual(h.forge.statuses.map((written) => [written.status.state, written.status.description]), [
      ['failure', 'A freezing action is in progress until 14:40 UTC.'],
      ['success', 'no longer checked by dibs'],
    ]);
    assert.deepEqual(await h.ledger.statusesOn(FIRST, pullRequest(FIRST, 5).headSha), []);
  });

  it('takes back a failing status under a context the server no longer files under, and one on a former member\'s pull request', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 5));
    h.forge.put(pullRequest(FIRST, 6, { author: 'bob-gh' }));
    h.dibs.member('bob', 'bob-gh');
    h.dibs.wants('web', 'main', FROZEN);
    await h.pass();
    h.dibs.wants('web', 'main', { ...QUIET, status: { ...QUIET.status, context: 'freeze' } });
    h.dibs.forgetMember('bob');

    const run = await h.pass();

    assert.equal(h.tallyOf(run, FIRST).statusesWithdrawn, 2);
    assert.deepEqual(h.forge.statuses.slice(2).map((written) => [written.sha.slice(0, 4), written.status.context, written.status.state]).sort(), [
      ['0005', 'dibs', 'success'],
      ['0005', 'freeze', 'success'],
      ['0006', 'dibs', 'success'],
    ]);
  });

  it('writes no more statuses in an hour than the hour allows, and the rest once it has passed', async (t) => {
    const h = harness(t, { forge: { maxStatusWritesPerHour: 2 } });
    for (const number of [5, 6, 7]) {
      h.forge.put(pullRequest(FIRST, number));
    }
    h.dibs.wants('web', 'main', QUIET);

    await h.pass();
    const held = await h.pass();
    h.clock.advanceMinutes(60);
    await h.pass();

    assert.equal(h.tallyOf(held, FIRST).statusesDeferred, 1);
    assert.equal(h.forge.statuses.length, 3);
  });

  it('leaves what is over the per-pass number to the next pass', async (t) => {
    const h = harness(t, { forge: { maxStatusWritesPerPass: 2 } });
    for (const number of [5, 6, 7]) {
      h.forge.put(pullRequest(FIRST, number));
    }
    h.dibs.wants('web', 'main', QUIET);

    const first = await h.pass();
    await h.pass();

    assert.equal(h.tallyOf(first, FIRST).statuses, 2);
    assert.equal(h.tallyOf(first, FIRST).statusesDeferred, 1);
    assert.deepEqual(h.forge.statuses.map((written) => written.sha).sort(), [5, 6, 7].map((n) => pullRequest(FIRST, n).headSha).sort());
  });
});

describe('the footprint of a claimed branch', () => {
  it('is measured against the base of its pull request, and told again from the kept measure when unchanged', async (t) => {
    const h = harness(t);
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.put(pullRequest(FIRST, 2, { headRef: BRANCH, baseRef: 'release' }));
    h.forge.branch(FIRST, 'release', BRANCH, measure(['src/billing/refund.ts']));

    await h.pass();
    const second = await h.pass();

    assert.deepEqual(h.dibs.footprints, [
      { item: 7, footprint: { repo: 'web', branch: BRANCH, base: 'release', measure: measure(['src/billing/refund.ts']) } },
      { item: 7, footprint: { repo: 'web', branch: BRANCH, base: 'release', measure: measure(['src/billing/refund.ts']) } },
    ]);
    const compares = h.forge.asked.filter((asked) => asked.call === 'compare');
    assert.equal(compares[0]?.etag, null);
    assert.notEqual(compares[1]?.etag, null);
    assert.ok(second.notModified >= 2, 'the compare and the first page were unchanged');
  });

  it('is measured against the default branch while the branch has no pull request', async (t) => {
    const h = harness(t);
    h.dibs.claim(7, 'alice', { web: BRANCH, api: 'alice/7-client' });
    h.forge.defaultBranchOf(FIRST, 'trunk');
    h.forge.branch(FIRST, 'trunk', BRANCH, measure(['a.ts'], 'beefcafe'));

    await h.pass();
    await h.pass();

    assert.deepEqual(h.dibs.footprints.map((one) => one.footprint.base), ['trunk', 'trunk']);
    assert.equal(h.forge.count('defaultBranch'), 2);
    assert.equal(h.forge.asked.filter((asked) => asked.call === 'defaultBranch')[1]?.etag !== null, true);
  });

  it('tells nothing about a branch that was deleted', async (t) => {
    const h = harness(t);
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.branch(FIRST, 'main', BRANCH, measure(['a.ts']));
    await h.pass();
    h.forge.deleteBranch(FIRST, 'main', BRANCH);

    const run = await h.pass();

    assert.equal(h.dibs.footprints.length, 1);
    assert.equal(h.tallyOf(run, FIRST).branchesGone, 1);
    assert.equal(await h.ledger.measure(FIRST, 'main', BRANCH), null);
  });

  it('sends nothing for a branch whose comparison names no files', async (t) => {
    const h = harness(t);
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.fail('compare', new TransientFailure('what alice/7-refunds changes answered without the files it changes'));

    const run = await h.pass();

    assert.deepEqual(h.dibs.footprints, []);
    assert.equal(h.tallyOf(run, FIRST).failures, 1);
  });

  it('takes a footprint the server did not keep as an answer', async (t) => {
    const h = harness(t);
    h.dibs.claim(7, 'alice', { web: BRANCH });
    h.forge.branch(FIRST, 'main', BRANCH, measure(['a.ts']));
    h.dibs.footprintAnswer = { stored: false, reason: 'other_branch' };

    const run = await h.pass();

    assert.equal(run.stoppedBecause, null);
    assert.equal(h.tallyOf(run, FIRST).footprints, 1);
    assert.equal(h.tallyOf(run, FIRST).failures, 0);
  });
});

describe('a slot held until a workflow run finishes', () => {
  const SHA = 'abc1234def';

  function run(id: number, path: string, status: string, conclusion: string | null, created: string) {
    return { id, path, name: null, status, conclusion, createdAt: at(created), headSha: SHA };
  }

  it('is released on the completed run of its own workflow only, and once', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND] });
    h.dibs.hold({ slot: 'deploy', workflow: 'deploy.yml', sha: SHA });
    h.forge.setRuns(SECOND, [
      run(1, '.github/workflows/ci.yml', 'completed', 'success', '09:00:00'),
      run(2, '.github/workflows/deploy.yml', 'in_progress', null, '09:00:00'),
    ]);

    await h.pass();
    assert.deepEqual(h.dibs.runsFinished, []);
    h.forge.setRuns(SECOND, [
      run(1, '.github/workflows/ci.yml', 'completed', 'success', '09:00:00'),
      run(2, '.github/workflows/deploy.yml', 'completed', 'failure', '09:00:00'),
    ]);
    const released = await h.pass();
    await h.pass();

    assert.deepEqual(h.dibs.runsFinished, [
      { hold: { slot: 'deploy', workflow: 'deploy.yml', sha: SHA }, conclusion: 'failure' },
    ]);
    assert.equal(h.tallyOf(released, SECOND).holdsReleased, 1);
  });
});

describe('a hold that names a short commit', () => {
  const FULL = `abc1234${'d'.repeat(33)}`;

  it('is resolved once, in the repository that holds the commit, and its runs are asked there only', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND] });
    h.dibs.hold({ slot: 'deploy', workflow: 'deploy.yml', sha: 'abc1234' });
    h.forge.setRuns(SECOND, [{
      id: 1, path: '.github/workflows/deploy.yml', name: 'Deploy', status: 'in_progress', conclusion: null,
      createdAt: at('09:00:00'), headSha: FULL,
    }]);

    await h.pass();
    await h.pass();

    const asked = (call: string) => h.forge.asked.filter((one) => one.call === call).map((one) => `${one.repo} ${one.detail}`);
    assert.deepEqual(asked('resolveCommit'), [`${FIRST} abc1234`, `${SECOND} abc1234`]);
    assert.deepEqual(asked('runsFor'), [`${SECOND} ${FULL}`, `${SECOND} ${FULL}`]);
    assert.deepEqual(await h.ledger.resolvedCommit('abc1234'), { repo: SECOND, sha: FULL });
  });

  it('is released under the commit as the hold names it', async (t) => {
    const h = harness(t);
    h.dibs.hold({ slot: 'deploy', workflow: 'deploy.yml', sha: 'abc1234' });
    h.forge.setRuns(FIRST, [{
      id: 1, path: '.github/workflows/deploy.yml', name: 'Deploy', status: 'completed', conclusion: 'success',
      createdAt: at('09:00:00'), headSha: FULL,
    }]);

    await h.pass();

    assert.deepEqual(h.dibs.runsFinished, [{ hold: { slot: 'deploy', workflow: 'deploy.yml', sha: 'abc1234' }, conclusion: 'success' }]);
  });
});

describe('what no pass needs any more', () => {
  it('is forgotten once it stood still for thirty days, and what is still open is kept', async (t) => {
    const h = harness(t);
    h.forge.put(pullRequest(FIRST, 5));
    h.forge.put(pullRequest(FIRST, 6));
    h.dibs.wants('web', 'main', QUIET);
    await h.pass();
    h.forge.put(pullRequest(FIRST, 5, { state: 'closed', updatedAt: at('09:02:00') }));
    await h.pass();
    h.clock.advanceDays(31);

    const run = await h.pass();

    assert.deepEqual(run.pruned, { statuses: 1, pulls: 1 });
    assert.equal(await h.ledger.pull(FIRST, 5), null);
    assert.notEqual(await h.ledger.pull(FIRST, 6), null);
    assert.equal((await h.ledger.statusesOn(FIRST, pullRequest(FIRST, 6).headSha)).length, 1, 'a status on an open head stays');
    assert.equal(h.forge.statuses.length, 2, 'nothing was written again');
  });
});

describe('a worker that is not where the forge jobs belong', () => {
  it('declines to start where the calls would go out under a person\'s credential, and says why', async (t) => {
    const h = harness(t, { asApp: false });

    const reason = await h.skipped();

    assert.match(reason, /only under an App's credential/);
    assert.deepEqual(h.dibs.calls, []);
    assert.deepEqual(h.forge.asked, []);
    assert.match((await readForgeRun(h.repository))?.refused ?? '', /forge\.allowPersonalToken/);
  });

  it('starts there when the configuration allows a person\'s credential', async (t) => {
    const h = harness(t, { asApp: false, forge: { allowPersonalToken: true } });

    const run = await h.pass();

    assert.equal(run.refused, null);
  });
});

describe('the limits of a pass', () => {
  it('stops at a burst refusal, puts the queue to sleep and says why, and the next pass waits', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND] });
    h.dibs.inReview(7, 'alice', [`${FIRST}#2`]);
    h.forge.fail('pullPage', new SecondaryRateLimited(900));

    const run = await h.pass();
    const skipped = await h.skipped();

    assert.match(run.stoppedBecause ?? '', /secondary|burst|limit/i);
    assert.equal(h.forge.asked.length, 1);
    assert.deepEqual(h.dibs.merged, []);
    assert.equal(await h.ledger.listing(FIRST), null);
    assert.notEqual(await h.repository.getPause(), null);
    assert.match(skipped, /waiting out a refusal/);
    assert.equal((await readForgeRun(h.repository))?.stoppedBecause, run.stoppedBecause);
  });

  it('asks GitHub one request at a time, a second apart', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND, THIRD] });

    const run = await h.pass();

    assert.equal(run.requests, 3);
    assert.deepEqual(h.sleeper.slept, [1000, 1000]);
  });

  it('asks nothing below the allowance\'s reserve', async (t) => {
    const h = harness(t);
    h.forge.remainingNow = 100;

    const run = await h.pass();

    assert.match(run.stoppedBecause ?? '', /below the reserve of 500/);
    assert.deepEqual(h.forge.asked, []);
  });

  it('stops asking once it has run as long as a pass may', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND, THIRD], forge: { maxPassMinutes: 1, paceMs: 60_000 } });

    const run = await h.pass();

    assert.match(run.stoppedBecause ?? '', /as long as one pass may/);
    assert.equal(run.requests, 1, 'the second request would have gone out a minute in');
  });

  it('ends a repository\'s jobs when GitHub does not answer three requests of one job in a row, and goes on', async (t) => {
    const h = harness(t, { repos: [FIRST, SECOND] });
    for (const number of [5, 6, 7]) {
      h.forge.put(pullRequest(FIRST, number));
    }
    h.forge.put(pullRequest(SECOND, 8));
    h.dibs.claim(9, 'alice', { web: BRANCH });
    h.forge.branch(FIRST, 'main', BRANCH, measure(['a.ts']));
    await h.pass();
    for (let failure = 0; failure < 3; failure += 1) {
      h.forge.fail('pull', new NoAnswer('the pull request could not be reached'));
    }

    const run = await h.pass();

    assert.equal(run.stoppedBecause, null, 'the pass went on');
    assert.match(h.tallyOf(run, FIRST).stoppedBecause ?? '', /did not answer 3 requests in a row/);
    assert.equal(h.dibs.footprints.length, 1, 'the footprint job of the first repository did not run this pass');
    assert.equal(h.tallyOf(run, SECOND).stoppedBecause, null);
    assert.ok(h.forge.asked.some((asked) => asked.call === 'pull' && asked.repo === SECOND), 'the second repository was read');
  });

  it('goes on past requests GitHub refused, which say nothing about the next one', async (t) => {
    const h = harness(t);
    for (const number of [5, 6, 7, 8]) {
      h.forge.put(pullRequest(FIRST, number), false);
    }
    await h.pass();
    for (const refusal of ['403: Resource not accessible by integration', '404', '422']) {
      h.forge.fail('pull', new TransientFailure(`the pull request answered ${refusal}`));
    }

    const run = await h.pass();

    assert.equal(h.tallyOf(run, FIRST).stoppedBecause, null);
    assert.equal(h.tallyOf(run, FIRST).failures, 3);
    assert.equal(h.forge.count('pull'), 8, 'the fourth pull request was read after three refusals');
  });
});

describe('a coordination server that does not answer', () => {
  it('is asked first, and nothing is asked of GitHub or sent when it cannot be read', async (t) => {
    const h = harness(t);
    h.dibs.fail('reviewClaims', new TransientFailure('the claims in review could not be reached'));

    const run = await h.pass();

    assert.match(run.stoppedBecause ?? '', /did not answer the claims in review/);
    assert.deepEqual(h.forge.asked, []);
    assert.deepEqual(run.repos, []);
  });

  it('keeps the cursor where it was when a report is not answered, and the next pass sends it', async (t) => {
    const h = harness(t);
    await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', mergedAt: at('09:02:00'), updatedAt: at('09:02:00') }));
    h.dibs.fail('reportMerged', new NoAnswer('the merge could not be reached'));

    const failed = await h.pass();
    const again = await h.pass();

    assert.match(failed.stoppedBecause ?? '', /did not answer the merge/);
    assert.equal(h.tallyOf(failed, FIRST).cursor, START);
    assert.equal((await h.ledger.listing(FIRST))?.cursor.toISOString(), at('09:02:00').toISOString());
    assert.equal(h.tallyOf(again, FIRST).merged, 1);
    assert.equal(h.dibs.merged.length, 1);
  });

  it('records a report the server refused, sends it no more, and moves on', async (t) => {
    const h = harness(t);
    await h.pass();
    h.forge.put(pullRequest(FIRST, 2, { state: 'closed', updatedAt: at('09:01:00') }));
    h.forge.put(pullRequest(FIRST, 3, { state: 'closed', updatedAt: at('09:02:00') }));
    h.dibs.fail('reportClosed', new TransientFailure('the close was refused by the coordination server: 422 (invalid_request)'));

    const run = await h.pass();
    await h.pass();

    assert.equal(run.stoppedBecause, null);
    assert.equal(h.tallyOf(run, FIRST).refusedReports, 1);
    assert.equal(h.tallyOf(run, FIRST).cursor, at('09:02:00').toISOString());
    assert.deepEqual(h.dibs.closed.map((close) => close.pr), [`${FIRST}#3`]);
  });
});
