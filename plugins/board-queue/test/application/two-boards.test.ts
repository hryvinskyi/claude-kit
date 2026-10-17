import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditBoard } from '../../src/application/audit-board.ts';
import type { AuditReport } from '../../src/application/audit-board.ts';
import { BoardRouter } from '../../src/application/board-router.ts';
import { BudgetPolicy } from '../../src/application/budget-policy.ts';
import { RepositoryCatalogStore } from '../../src/application/catalog-store.ts';
import { DrainQueue } from '../../src/application/drain-queue.ts';
import { Action } from '../../src/domain/action.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import type { BoardKey } from '../../src/domain/board-directory.ts';
import type { FieldCatalog } from '../../src/domain/catalog.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';
import { FakeBoardGateway, catalogField, catalogOf, seedItem } from '../fakes/fake-board-gateway.ts';
import type { SeededItem } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import type { SeededIssue } from '../fakes/fake-issue-gateway.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { lanesByBoard } from '../fakes/lanes.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { boardCatalog } from '../fixtures/board.ts';
import { ORG_BOARD, THIRD, USER_BOARD, twoBoardConfig, twoBoardDirectory } from '../fixtures/config.ts';

const FIRST = 'example-org/first-repo';

/** The second board's own vocabulary: one option the first board does not offer, under ids of its own. */
function personCatalog(): FieldCatalog {
  return {
    ...catalogOf(
      catalogField('Status', ['Todo', 'In Progress', 'Done']),
      catalogField('Module', ['onboarding']),
    ),
    projectId: 'project-user',
  };
}

type BoardSide = {
  board: FakeBoardGateway;
  issues: FakeIssueGateway;
};

type TwoBoards = {
  repository: InMemoryActionRepository;
  clock: FakeClock;
  organisation: BoardSide;
  person: BoardSide;
  router: BoardRouter;
  drain: DrainQueue;
  audit: AuditBoard;
  reports: AuditReport[];
  file: (id: string, kind: string, payload: unknown) => Promise<void>;
};

function twoBoards(seed: {
  organisation?: { items?: SeededItem[]; issues?: SeededIssue[] };
  person?: { items?: SeededItem[]; issues?: SeededIssue[]; catalog?: FieldCatalog };
} = {}, directory: BoardDirectory = twoBoardDirectory): TwoBoards {
  const repository = new InMemoryActionRepository();
  const clock = new FakeClock('2026-01-10T09:00:00.000Z');
  const budget = new RateBudget({
    resource: 'graphql',
    remaining: 4000,
    limit: 5000,
    used: 1000,
    resetAt: new Date('2026-01-10T10:00:00.000Z'),
  });
  const side = (key: BoardKey, catalog: FieldCatalog, items: SeededItem[], issues: SeededIssue[]): BoardSide => ({
    board: new FakeBoardGateway({
      catalog,
      items,
      clock,
      store: new RepositoryCatalogStore(repository, key),
      catalogTtlSec: twoBoardConfig.worker.catalogTtlSec,
      budget,
    }),
    issues: new FakeIssueGateway(issues),
  });
  const organisation = side(ORG_BOARD, boardCatalog(), seed.organisation?.items ?? [], seed.organisation?.issues ?? []);
  const person = side(
    USER_BOARD,
    seed.person?.catalog ?? personCatalog(),
    seed.person?.items ?? [],
    seed.person?.issues ?? [],
  );
  const router = new BoardRouter(directory, lanesByBoard(new Map([[ORG_BOARD, organisation], [USER_BOARD, person]])));
  const kinds = defaultKindRegistry(twoBoardConfig);
  const policy = new BudgetPolicy(twoBoardConfig.worker);
  const logger = new RecordingLogger();
  const reports: AuditReport[] = [];
  return {
    repository,
    clock,
    organisation,
    person,
    router,
    drain: new DrainQueue({
      repository,
      boards: router,
      kinds,
      policy,
      clock,
      sleeper: new FakeSleeper(clock),
      logger,
      config: twoBoardConfig,
    }),
    audit: new AuditBoard({
      config: twoBoardConfig,
      repository,
      boards: router,
      policy,
      clock,
      logger,
      reports: { save: async (report) => { reports.push(report); } },
    }),
    reports,
    file: async (id, kindName, payload) => {
      const kind = kinds.get(kindName);
      await repository.insert(Action.enqueue({
        id,
        kind: kind.name,
        payload,
        issueRef: kind.issueRefOf(payload),
        origin: 'a session',
        now: clock.now(),
      }));
    },
  };
}

describe('a queue that writes to two boards', () => {
  it('writes each issue on the board that carries its repository, in that board\'s own vocabulary', async () => {
    const world = twoBoards({
      organisation: { items: [seedItem(IssueRef.of(FIRST, 12), 'org-item', {})] },
      person: { items: [seedItem(IssueRef.of(THIRD, 12), 'user-item', {})] },
    });
    await world.file('org', 'board.set-fields', { repo: FIRST, issue: 12, fields: { module: 'Checkout' } });
    await world.file('user', 'board.set-fields', { repo: THIRD, issue: 12, fields: { module: 'onboarding' } });

    const report = await world.drain.run();

    assert.equal(report.done, 2);
    assert.deepEqual(world.organisation.board.ensured, [`${FIRST}#12`]);
    assert.deepEqual(world.person.board.ensured, [`${THIRD}#12`]);
    assert.deepEqual(world.organisation.board.valuesOf(IssueRef.of(FIRST, 12)), { Module: 'Checkout' });
    assert.deepEqual(world.person.board.valuesOf(IssueRef.of(THIRD, 12)), { Module: 'onboarding' });
    assert.equal(world.person.board.written[0]?.optionId, 'option-module-onboarding');
  });

  it('posts a comment through the issues of the board that carries the repository', async () => {
    const world = twoBoards({ person: { issues: [{ ref: IssueRef.of(THIRD, 5) }] } });
    await world.file('note', 'issue.comment', { repo: THIRD, issue: 5, body: 'seen on staging' });

    await world.drain.run();

    assert.equal(world.person.issues.posted.length, 1);
    assert.equal(world.person.issues.posted[0]?.ref, `${THIRD}#5`);
    assert.deepEqual(world.organisation.issues.calls, []);
  });

  it('keeps each board\'s catalog under that board, so one board\'s options never answer for the other', async () => {
    const world = twoBoards({ person: { items: [seedItem(IssueRef.of(THIRD, 12), 'user-item', {})] } });
    await world.file('user', 'board.set-fields', { repo: THIRD, issue: 12, fields: { module: 'onboarding' } });

    await world.drain.run();

    assert.equal(world.organisation.board.catalogFetches, 0);
    assert.equal((await world.repository.getCatalog(USER_BOARD))?.catalog.projectId, 'project-user');
    assert.equal(await world.repository.getCatalog(ORG_BOARD), null);
  });

  it('gives a blocked action back only when the board that carries it offers the option', async () => {
    const world = twoBoards({
      organisation: { items: [seedItem(IssueRef.of(FIRST, 12), 'org-item', {})] },
      person: { items: [seedItem(IssueRef.of(THIRD, 12), 'user-item', {})] },
    });
    // Each board lacks the option the other offers.
    await world.file('org', 'board.set-fields', { repo: FIRST, issue: 12, fields: { module: 'onboarding' } });
    await world.file('user', 'board.set-fields', { repo: THIRD, issue: 12, fields: { module: 'Checkout' } });
    await world.drain.run();
    assert.equal((await world.repository.get('org'))?.state, 'blocked');
    assert.equal((await world.repository.get('user'))?.state, 'blocked');

    world.person.board.addOption('Module', { id: 'option-module-checkout', name: 'Checkout' });
    world.clock.advance(twoBoardConfig.worker.catalogTtlSec * 1000 + 1000);
    await world.file('fresh', 'board.set-fields', { repo: THIRD, issue: 13, fields: { status: 'Todo' } });
    const report = await world.drain.run();

    assert.equal(report.unblocked, 1);
    assert.equal((await world.repository.get('user'))?.state, 'queued');
    assert.equal((await world.repository.get('org'))?.state, 'blocked', 'the other board never offered it');
  });

  it('blocks work on a repository no board carries any longer, naming the ones that are', async () => {
    const [organisationBoard, personBoard] = twoBoardConfig.boards;
    assert.ok(organisationBoard !== undefined && personBoard !== undefined);
    const shrunk = BoardDirectory.of([{ ...organisationBoard, repos: ['Example-User/second-repo'] }, personBoard]);
    const world = twoBoards({ organisation: { items: [seedItem(IssueRef.of(FIRST, 12), 'org-item', {})] } }, shrunk);
    await world.file('orphan', 'board.set-fields', { repo: FIRST, issue: 12, fields: { status: 'Todo' } });

    await world.drain.run();

    const orphan = await world.repository.get('orphan');
    assert.equal(orphan?.state, 'blocked');
    assert.match(orphan?.lastError ?? '', /example-org\/first-repo is not a configured repository/);
    assert.deepEqual(world.organisation.board.calls.filter((call) => call !== 'probeBudget'), []);
  });

  it('reads every board for the repositories it carries and reports them all', async () => {
    const world = twoBoards({
      organisation: { issues: [{ ref: IssueRef.of(FIRST, 1), title: 'on the first board, unfiled' }] },
      person: {
        issues: [{ ref: IssueRef.of(THIRD, 2), title: 'on the second board' }],
        items: [seedItem(IssueRef.of(THIRD, 2), 'user-item', { Status: 'Todo' })],
      },
    });

    const report = await world.audit.execute();

    assert.deepEqual(Object.keys(report.repos), [...twoBoardDirectory.repos()]);
    assert.deepEqual(report.repos[FIRST]?.notOnBoard.map((issue) => issue.number), [1]);
    assert.deepEqual(report.repos[THIRD]?.notOnBoard, []);
    assert.deepEqual(report.repos[THIRD]?.emptyFields.map((issue) => issue.number), [2]);
    assert.ok(world.person.issues.calls.includes('listOpen'));
    assert.equal(world.person.board.snapshotFetches > 0, true);
    assert.equal(report.repos[THIRD]?.open, 1);
  });
});
