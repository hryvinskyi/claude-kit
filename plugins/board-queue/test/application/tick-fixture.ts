import { BoardRouter } from '../../src/application/board-router.ts';
import { BudgetPolicy } from '../../src/application/budget-policy.ts';
import { RepositoryCatalogStore } from '../../src/application/catalog-store.ts';
import { DrainQueue } from '../../src/application/drain-queue.ts';
import { Action } from '../../src/domain/action.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import type { FieldCatalog } from '../../src/domain/catalog.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config, WorkerConfig } from '../../src/domain/config.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';
import { FakeBoardGateway } from '../fakes/fake-board-gateway.ts';
import type { SeededItem } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import type { SeededIssue } from '../fakes/fake-issue-gateway.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { boardCatalog } from '../fixtures/board.ts';
import { TEST_BOARD, testConfig } from '../fixtures/config.ts';

export const FIRST = 'example-org/first-repo';
export const SECOND = 'Example-User/second-repo';
export const START = '2026-01-10T09:00:00.000Z';
export const RESET = new Date('2026-01-10T09:40:00.000Z');

export function graphqlBudget(remaining: number): RateBudget {
  return new RateBudget({
    resource: 'graphql',
    remaining,
    limit: 5000,
    used: 5000 - remaining,
    resetAt: RESET,
  });
}

export type FiledAction = {
  id: string;
  kind?: string;
  payload: unknown;
  origin?: string;
  createdAt?: Date;
  hold?: boolean;
};

export type TickOptions = {
  worker?: Partial<WorkerConfig>;
  catalog?: FieldCatalog;
  items?: readonly SeededItem[];
  issues?: readonly SeededIssue[];
  budget?: RateBudget;
};

export type TickFixture = {
  config: Config;
  repository: InMemoryActionRepository;
  board: FakeBoardGateway;
  issues: FakeIssueGateway;
  /** The one configured board, reached through the fakes above. */
  boards: BoardRouter;
  clock: FakeClock;
  sleeper: FakeSleeper;
  logger: RecordingLogger;
  policy: BudgetPolicy;
  drain: DrainQueue;
  file: (input: FiledAction) => Promise<Action>;
  /** The action as the queue holds it now, never the copy the test filed. */
  stored: (id: string) => Promise<Action>;
};

/** A worker with a queue, a board and a set of issues, none of them on a network. */
export function tickFixture(options: TickOptions = {}): TickFixture {
  const config: Config = options.worker === undefined
    ? testConfig
    : ConfigSchema.parse({ ...testConfig, worker: { ...testConfig.worker, ...options.worker } });
  const repository = new InMemoryActionRepository();
  const clock = new FakeClock(START);
  const sleeper = new FakeSleeper(clock);
  const logger = new RecordingLogger();
  const board = new FakeBoardGateway({
    catalog: options.catalog ?? boardCatalog(),
    items: options.items ?? [],
    clock,
    store: new RepositoryCatalogStore(repository, TEST_BOARD),
    catalogTtlSec: config.worker.catalogTtlSec,
    budget: options.budget ?? graphqlBudget(4000),
  });
  const issues = new FakeIssueGateway(options.issues ?? []);
  const boards = new BoardRouter(BoardDirectory.of(config.boards), () => ({ board, issues }));
  const policy = new BudgetPolicy(config.worker);
  const kinds = defaultKindRegistry(config);
  const drain = new DrainQueue({
    repository,
    boards,
    kinds,
    policy,
    clock,
    sleeper,
    logger,
    config,
  });

  return {
    config,
    repository,
    board,
    issues,
    boards,
    clock,
    sleeper,
    logger,
    policy,
    drain,
    file: async (input: FiledAction): Promise<Action> => {
      const kind = kinds.get(input.kind ?? 'board.set-fields');
      const action = Action.enqueue({
        id: input.id,
        kind: kind.name,
        payload: input.payload,
        issueRef: kind.issueRefOf(input.payload),
        origin: input.origin ?? 'a session',
        now: input.createdAt ?? clock.now(),
        hold: input.hold,
      });
      await repository.insert(action);
      return action;
    },
    stored: async (id: string): Promise<Action> => {
      const action = await repository.get(id);
      if (action === null) {
        throw new Error(`the queue holds no action with the id "${id}"`);
      }
      return action;
    },
  };
}

/** The payload a set-fields action carries, spelled the short way callers spell it. */
export function setFields(issue: number, fields: Record<string, string>, repo = FIRST): unknown {
  return { repo, issue, fields };
}
