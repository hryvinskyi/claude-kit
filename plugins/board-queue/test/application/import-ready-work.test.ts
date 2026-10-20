import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardRouter } from '../../src/application/board-router.ts';
import { BudgetPolicy } from '../../src/application/budget-policy.ts';
import { ImportReadyWork } from '../../src/application/import-ready-work.ts';
import type { ImportReport } from '../../src/application/import-ready-work.ts';
import { LimiterWait } from '../../src/application/limiter-wait.ts';
import { writeLastBudget } from '../../src/application/queue-meta.ts';
import type { ImportRun } from '../../src/application/sync-meta.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import type { IssueFacts } from '../../src/domain/catalog.ts';
import { IssueNotFound, SecondaryRateLimited, TransientFailure } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import type { ImporterConfig } from '../../src/domain/sync-config.ts';
import { FakeBoardGateway } from '../fakes/fake-board-gateway.ts';
import type { SeededItem } from '../fakes/fake-board-gateway.ts';
import { FakeCoordination } from '../fakes/fake-coordination.ts';
import { FakeDependencyReader, InMemoryDependencyCache } from '../fakes/fake-dependencies.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { boardCatalog } from '../fixtures/board.ts';
import { syncConfig, syncOf } from '../fixtures/sync.ts';
import { graphqlBudget } from './tick-fixture.ts';

const FIRST = 'example-org/first-repo';
const SECOND = 'Example-User/second-repo';
const SYNC = syncOf();

function facts(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return {
    title: 'an issue',
    state: 'open',
    createdAt: new Date('2026-03-01T09:00:00Z'),
    updatedAt: new Date('2026-03-01T10:00:00Z'),
    blockedByTotal: 0,
    subIssuesTotal: 0,
    ...overrides,
  };
}

function row(number: number, values: Record<string, string>, issue: Partial<IssueFacts> = {}, repo = FIRST): SeededItem {
  return {
    ref: IssueRef.of(repo, number),
    itemId: `item-${String(number)}`,
    values,
    issue: facts({ title: `issue ${String(number)}`, ...issue }),
  };
}

type Options = {
  items?: readonly SeededItem[];
  importer?: Partial<ImporterConfig>;
  remaining?: number;
};

function harness(options: Options = {}) {
  const clock = new FakeClock('2026-03-02T09:00:00.000Z');
  const sleeper = new FakeSleeper(clock);
  const repository = new InMemoryActionRepository();
  const board = new FakeBoardGateway({ catalog: boardCatalog(), items: options.items ?? [], clock });
  const boards = new BoardRouter(BoardDirectory.of(syncConfig.boards), () => ({
    board,
    issues: new FakeIssueGateway(),
  }));
  const dependencies = new FakeDependencyReader();
  const cache = new InMemoryDependencyCache();
  const target = new FakeCoordination();
  const logger = new RecordingLogger();
  const policy = new BudgetPolicy(syncConfig.worker);
  const importer = { ...SYNC.importer, ...options.importer };
  const useCase = new ImportReadyWork({
    boards,
    dependencies,
    cache,
    target,
    repository,
    wait: new LimiterWait({ repository, policy, logger }),
    policy,
    sync: SYNC,
    importer,
    clock,
    sleeper,
    logger,
  });
  const ready = async (): Promise<void> => {
    await writeLastBudget(repository, graphqlBudget(options.remaining ?? 4000));
  };
  return { clock, sleeper, repository, board, dependencies, cache, target, logger, useCase, ready };
}

function runOf(report: ImportReport): ImportRun {
  if ('skipped' in report) {
    throw new Error(`the import did not run: ${report.skipped}`);
  }
  return report.run;
}

describe('reporting the board\'s work', () => {
  it('sends every row of a repository kept in step, in the server\'s words, as one complete batch', async () => {
    const it_ = harness({
      items: [
        row(12, { Status: 'Todo', Module: 'Checkout', Severity: 'S1 · blocking' }),
        row(7, { Status: 'In Progress' }, {}, SECOND),
      ],
    });
    await it_.ready();

    const run = runOf(await it_.useCase.execute());

    assert.equal(it_.target.batches.length, 1);
    assert.deepEqual(it_.target.batches[0], {
      source: 'board',
      complete: true,
      items: [{
        ref: 'gh:example-org/first-repo#12',
        title: 'issue 12',
        closed: false,
        listing: { priority: 0, areasHint: ['checkout'], sourceStatus: 'Todo', blockedBy: [] },
      }],
    });
    assert.equal(run.complete, true);
    assert.equal(run.readCost, 1);
  });

  it('files nothing in the board queue and writes nothing to the board', async () => {
    const it_ = harness({ items: [row(12, { Status: 'Todo' }, { blockedByTotal: 1 })] });
    it_.dependencies.set('blocked_by', IssueRef.of(FIRST, 12), [
      { ref: IssueRef.of(FIRST, 13), title: 'issue 13', state: 'open' },
    ]);
    await it_.ready();

    await it_.useCase.execute();

    const counts = await it_.repository.counts();
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 0);
    assert.deepEqual(it_.board.calls, ['readWork']);
  });

  it('asks nothing of an issue whose summary says nothing blocks it', async () => {
    const it_ = harness({ items: [row(12, {}), row(13, {}, { blockedByTotal: 0, subIssuesTotal: 0 })] });
    await it_.ready();

    await it_.useCase.execute();

    assert.deepEqual(it_.dependencies.asked, []);
  });

  it('asks both lists of an issue when the board could not say what blocks it', async () => {
    const it_ = harness({ items: [row(12, {}, { blockedByTotal: null, subIssuesTotal: null })] });
    await it_.ready();

    await it_.useCase.execute();

    assert.deepEqual(it_.dependencies.asked.map((asked) => asked.list), ['blocked_by', 'sub_issues']);
  });

  it('sends a blocker in another repository under its own reference, as a blocker only', async () => {
    const it_ = harness({ items: [row(12, {}, { blockedByTotal: 1 })] });
    it_.dependencies.set('blocked_by', IssueRef.of(FIRST, 12), [
      { ref: IssueRef.of('acme/api', 9), title: 'the api change', state: 'open' },
    ]);
    await it_.ready();

    await it_.useCase.execute();

    const items = it_.target.batches[0]?.items ?? [];
    assert.deepEqual(items[0]?.listing?.blockedBy, ['gh:acme/api#9']);
    assert.deepEqual(items[1], { ref: 'gh:acme/api#9', title: 'the api change', closed: false, listing: null });
  });

  it('counts a parent as blocked by its open sub-issues only', async () => {
    const it_ = harness({ items: [row(12, {}, { subIssuesTotal: 2 })] });
    it_.dependencies.set('sub_issues', IssueRef.of(FIRST, 12), [
      { ref: IssueRef.of(FIRST, 20), title: 'open part', state: 'open' },
      { ref: IssueRef.of(FIRST, 21), title: 'done part', state: 'closed' },
    ]);
    await it_.ready();

    await it_.useCase.execute();

    assert.deepEqual(it_.target.batches[0]?.items[0]?.listing?.blockedBy, ['gh:example-org/first-repo#20']);
  });

  it('asks again with the tag it holds, and keeps the answer an "unchanged" stands for', async () => {
    const it_ = harness({ items: [row(12, {}, { blockedByTotal: 1 })] });
    it_.dependencies.set('blocked_by', IssueRef.of(FIRST, 12), [
      { ref: IssueRef.of(FIRST, 13), title: 'issue 13', state: 'open' },
    ]);
    await it_.ready();
    await it_.useCase.execute();
    it_.clock.advanceMinutes(16);

    const second = runOf(await it_.useCase.execute());

    assert.deepEqual(it_.dependencies.asked.map((asked) => asked.etag), [null, '"v1"']);
    assert.equal(second.notModified, 1);
    assert.deepEqual(it_.target.batches[1]?.items[0]?.listing?.blockedBy, ['gh:example-org/first-repo#13']);
  });

  it('asks a list that carried no tag again only once the issue changed', async () => {
    const it_ = harness({ items: [row(12, {}, { blockedByTotal: 1 })] });
    it_.dependencies.untagged.add(`blocked_by:${IssueRef.of(FIRST, 12).key()}`);
    it_.dependencies.set('blocked_by', IssueRef.of(FIRST, 12), []);
    await it_.ready();
    await it_.useCase.execute();
    it_.clock.advanceMinutes(16);

    await it_.useCase.execute();

    assert.equal(it_.dependencies.asked.length, 1, 'the issue did not change, so nothing was asked');
  });

  it('holds to the per-run cap and resumes with the oldest answers at the next run', async () => {
    const items = Array.from({ length: 5 }, (_, index) => row(100 + index, {}, { blockedByTotal: 1 }));
    const it_ = harness({ items, importer: { maxRequestsPerTick: 3 } });
    await it_.ready();

    const first = runOf(await it_.useCase.execute());
    it_.clock.advanceMinutes(16);
    await it_.useCase.execute();

    assert.equal(first.requests, 3);
    assert.deepEqual(it_.dependencies.asked.map((asked) => asked.ref), [
      'example-org/first-repo#100',
      'example-org/first-repo#101',
      'example-org/first-repo#102',
      'example-org/first-repo#103',
      'example-org/first-repo#104',
      'example-org/first-repo#100',
    ]);
  });

  it('paces its requests a second apart', async () => {
    const items = [row(1, {}, { blockedByTotal: 1 }), row(2, {}, { blockedByTotal: 1 })];
    const it_ = harness({ items });
    await it_.ready();

    await it_.useCase.execute();

    assert.deepEqual(it_.sleeper.slept, [1000]);
  });

  it('stops asking at a burst refusal, puts the queue to sleep, and still sends what it holds', async () => {
    const items = [row(1, {}, { blockedByTotal: 1 }), row(2, {}, { blockedByTotal: 1 })];
    const it_ = harness({ items });
    it_.dependencies.failNext(new SecondaryRateLimited(60));
    await it_.ready();

    const run = runOf(await it_.useCase.execute());

    assert.equal(it_.dependencies.asked.length, 1);
    assert.match(run.stoppedBecause ?? '', /burst limiter/);
    assert.notEqual(await it_.repository.getPause(), null);
    assert.equal(it_.target.batches.length, 1);
  });

  it('passes over an issue whose lists cannot be read and goes on with the rest', async () => {
    const items = [row(1, {}, { blockedByTotal: 1 }), row(2, {}, { blockedByTotal: 1 })];
    const it_ = harness({ items });
    it_.dependencies.failNext(new IssueNotFound('example-org/first-repo#1'));
    await it_.ready();

    await it_.useCase.execute();

    assert.equal(it_.dependencies.asked.length, 2);
    assert.equal(await it_.repository.getPause(), null);
  });

  it('sends no complete batch when a board could not be read', async () => {
    const it_ = harness({ items: [row(12, {})] });
    it_.board.fail('readWork', new TransientFailure('the board\'s work answered 502'));
    await it_.ready();

    const run = runOf(await it_.useCase.execute());

    assert.equal(run.complete, false);
    assert.ok(it_.target.batches.every((batch) => !batch.complete));
  });

  it('sends no complete batch when rows of the board could not be read', async () => {
    const it_ = harness({ items: [row(12, {})] });
    it_.board.unreadable = 1;
    await it_.ready();

    const run = runOf(await it_.useCase.execute());

    assert.equal(run.complete, false);
    assert.match(run.incompleteBecause ?? '', /could not be read/);
  });

  it('skips a draft or a pull request, which the board walk does not count as an issue', async () => {
    const it_ = harness({ items: [] });
    await it_.ready();

    await it_.useCase.execute();

    assert.deepEqual(it_.target.batches[0]?.items, []);
  });

  it('reads nothing while the allowance is below the import\'s reserve', async () => {
    const it_ = harness({ items: [row(12, {})], remaining: 900 });
    await it_.ready();

    const report = await it_.useCase.execute();

    assert.ok('skipped' in report && /reserve/.test(report.skipped));
    assert.deepEqual(it_.board.calls, []);
  });

  it('waits out its own cadence', async () => {
    const it_ = harness({ items: [row(12, {})] });
    await it_.ready();
    await it_.useCase.execute();
    it_.clock.advanceMinutes(10);

    const report = await it_.useCase.execute();

    assert.ok('skipped' in report && /15 minutes/.test(report.skipped));
    assert.equal(it_.target.batches.length, 1);
  });

  it('logs an edge the server would not record and goes on', async () => {
    const it_ = harness({ items: [row(12, {}, { blockedByTotal: 1 }), row(13, {})] });
    it_.dependencies.set('blocked_by', IssueRef.of(FIRST, 12), [
      { ref: IssueRef.of(FIRST, 13), title: 'issue 13', state: 'open' },
    ]);
    it_.target.refuseEdgesOf.set('gh:example-org/first-repo#12', {
      item: 'gh:example-org/first-repo#12',
      blockedBy: 'gh:example-org/first-repo#13',
      reason: 'dependency_cycle',
    });
    await it_.ready();

    const run = runOf(await it_.useCase.execute());

    assert.equal(run.refusedEdges, 1);
    assert.equal(run.complete, true);
    assert.ok(it_.logger.lines.some((line) => line.fields['reason'] === 'dependency_cycle'));
  });

  it('records a server that would not take a batch, and claims nothing was complete', async () => {
    const it_ = harness({ items: [row(12, {})] });
    it_.target.fail('putItems', new TransientFailure('the import was refused by the coordination server: 503'));
    await it_.ready();

    const run = runOf(await it_.useCase.execute());

    assert.equal(run.complete, false);
    assert.match(run.stoppedBecause ?? '', /could not be reported/);
  });

  it('closes nothing on the server when the board suddenly shows far fewer open items, and says why', async () => {
    const shrunk = harness({ items: [row(1, {})] });
    await shrunk.ready();
    await shrunk.repository.setMeta('import.lastCompleteOpen', '3');

    const run = runOf(await shrunk.useCase.execute());

    assert.equal(run.complete, false);
    assert.equal(run.open, 1);
    assert.match(run.incompleteBecause ?? '', /fell from 3 to 1/);
    assert.ok(shrunk.target.batches.every((batch) => !batch.complete));
  });

  it('remembers how many items were open at a complete import', async () => {
    const it_ = harness({ items: [row(1, {}), row(2, {})] });
    await it_.ready();

    await it_.useCase.execute();

    assert.equal(await it_.repository.getMeta('import.lastCompleteOpen'), '2');
  });
});
