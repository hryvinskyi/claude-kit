import { AuditBoard } from '../application/audit-board.ts';
import type { AuditReportSink } from '../application/audit-board.ts';
import { BoardRouter } from '../application/board-router.ts';
import type { LaneFactory } from '../application/board-router.ts';
import { BudgetPolicy } from '../application/budget-policy.ts';
import { CancelAction } from '../application/cancel-action.ts';
import { RepositoryCatalogStore } from '../application/catalog-store.ts';
import { DrainQueue } from '../application/drain-queue.ts';
import { EnqueueAction } from '../application/enqueue-action.ts';
import { ListActions } from '../application/list-actions.ts';
import type { ActionRepository, Clock, Logger, Sleeper, TokenProvider } from '../application/ports.ts';
import { QueueStatus } from '../application/queue-status.ts';
import { ReleaseAction } from '../application/release-action.ts';
import { RetryAction } from '../application/retry-action.ts';
import { ImportReadyWork } from '../application/import-ready-work.ts';
import { LimiterWait } from '../application/limiter-wait.ts';
import { MirrorClaims } from '../application/mirror-claims.ts';
import { RunTick } from '../application/run-tick.ts';
import type { SyncJobs } from '../application/run-tick.ts';
import { SyncOwner } from '../application/sync-owner.ts';
import type { ClaimFeed, DependencyReader, LocalIdentity, WorkImport } from '../application/sync-ports.ts';
import { ShowBoardItem } from '../application/show-board-item.ts';
import { BoardDirectory } from '../domain/board-directory.ts';
import type { BoardKey, BoardPlacement } from '../domain/board-directory.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { Config } from '../domain/config.ts';
import { defaultKindRegistry } from '../domain/kinds/default-kinds.ts';
import type { KindRegistry } from '../domain/kinds/registry.ts';
import type { SyncConfig } from '../domain/sync-config.ts';
import { syncIsOn } from '../domain/sync-config.ts';
import { DibsHttpClient, tokenFromEnvironment } from '../infrastructure/dibs-http.ts';
import { GhCliIdentity } from '../infrastructure/gh-cli-identity.ts';
import { GitHubRestDependencies } from '../infrastructure/github-rest-dependencies.ts';
import { SqliteDependencyCache } from '../infrastructure/sqlite-dependency-cache.ts';
import { FileAuditReport } from '../infrastructure/file-audit-report.ts';
import { FileLogger } from '../infrastructure/file-logger.ts';
import { GitHubGraphqlBoard } from '../infrastructure/github-graphql-board.ts';
import { BudgetLedger, GitHubHttp } from '../infrastructure/github-http.ts';
import { GitHubRestIssues } from '../infrastructure/github-rest-issues.ts';
import { auditPath, dbPath, logPath } from '../infrastructure/paths.ts';
import { SqliteActionRepository } from '../infrastructure/sqlite-action-repository.ts';
import { SystemClock, RealSleeper } from '../infrastructure/system-clock.ts';
import { AccountCredentials } from '../infrastructure/token-providers.ts';

/**
 * What a test puts in place of the things that reach outside the machine. The
 * queue itself is never among them: every command is meant to be proved against
 * the database it really runs on.
 */
export type ContainerOverrides = {
  /** Builds each configured board's gateways in place of the ones that reach the network. */
  lanes?: LaneFactory;
  clock?: Clock;
  sleeper?: Sleeper;
  /** Stands in for every board's credential chain, so a test can watch when one is asked for. */
  tokens?: TokenProvider;
  /** Somewhere other than the state directory to leave the board report. */
  reports?: AuditReportSink;
  /** Stands in for the coordination server, for both directions of keeping in step. */
  coordination?: ClaimFeed & WorkImport;
  /** Stands in for the REST lists of what blocks an issue. */
  dependencies?: DependencyReader;
  /** Stands in for the login this machine's GitHub command line tool is signed in as. */
  identity?: LocalIdentity;
};

export type BuildContainerOptions = {
  config: Config;
  /** Where the queue, the log and the reports live. */
  stateDir: string;
  overrides?: ContainerOverrides;
};

/**
 * Everything assembled, offered as the ports and use cases the entry points use.
 * The repository is offered as the port, with the file handle closed through
 * `close()`, so nothing outside this module has to know which database is behind
 * it.
 */
export type Container = {
  config: Config;
  stateDir: string;
  repository: ActionRepository;
  kinds: KindRegistry;
  /** Which board carries which repository. */
  directory: BoardDirectory;
  /** Every board with the gateways that reach it. */
  boards: BoardRouter;
  clock: Clock;
  sleeper: Sleeper;
  logger: Logger;
  policy: BudgetPolicy;
  enqueue: EnqueueAction;
  release: ReleaseAction;
  cancel: CancelAction;
  retry: RetryAction;
  status: QueueStatus;
  list: ListActions;
  show: ShowBoardItem;
  audit: AuditBoard;
  drain: DrainQueue;
  tick: RunTick;
  close(): void;
};

/**
 * The one place this system decides which implementation is which.
 *
 * Two things matter here beyond the wiring. The credential is never asked for
 * while this runs: a session that only lists the queue, or files an action, must
 * start and answer on a machine where no credential can be minted at all, so the
 * chain is built and the first call that actually reaches the API is what mints
 * one. And the gateways are replaceable, because a test that proves what a tool
 * answers has no business holding a network open.
 */
export function buildContainer(options: BuildContainerOptions): Container {
  const { config, stateDir } = options;
  const overrides = options.overrides ?? {};

  const clock = overrides.clock ?? new SystemClock();
  const sleeper = overrides.sleeper ?? new RealSleeper();
  const logger = new FileLogger(logPath(stateDir), clock);
  const repository = new SqliteActionRepository(dbPath(stateDir), { clock });
  const directory = BoardDirectory.of(config.boards);

  // Built, not used: nothing below asks for a credential until a gateway makes a
  // call. Each board is reached with the credential of the account that owns it,
  // and the App's own credential is preferred where the deployment names one,
  // because the board writes then cost the App's allowance instead of the
  // allowance the person is working inside.
  const credentials = new AccountCredentials({
    env: process.env,
    boards: directory.boards().map((placement) => placement.board),
    logger,
    clock,
  });
  // One account's allowance, whichever board's call reported it last.
  const ledger = new BudgetLedger();
  const httpFor = (placement: BoardPlacement): GitHubHttp =>
    new GitHubHttp({ tokens: overrides.tokens ?? credentials.for(placement.board), logger, ledger });
  const networkLanes: LaneFactory = (placement) => {
    const http = httpFor(placement);
    return {
      board: new GitHubGraphqlBoard({
        http,
        board: placement.board,
        clock,
        catalogStore: new RepositoryCatalogStore(repository, placement.key),
        catalogTtlSec: config.worker.catalogTtlSec,
      }),
      issues: new GitHubRestIssues(http),
    };
  };
  const boards = new BoardRouter(directory, overrides.lanes ?? networkLanes);

  const kinds = defaultKindRegistry(config);
  const policy = new BudgetPolicy(config.worker);
  const drain = new DrainQueue({ repository, boards, kinds, policy, clock, sleeper, logger, config });
  const audit = new AuditBoard({
    config,
    repository,
    boards,
    policy,
    clock,
    logger,
    reports: overrides.reports ?? new FileAuditReport(auditPath(stateDir)),
  });

  const sync = config.dibs ?? null;
  const closers: (() => void)[] = [];
  const syncJobs = sync === null || !syncIsOn(sync) ? undefined : buildSyncJobs({
    sync,
    repository,
    kinds,
    directory,
    boards,
    policy,
    clock,
    sleeper,
    logger,
    overrides,
    stateDir,
    closers,
    dependencyHttp: memoised((ref) => directory.placementOf(ref), httpFor),
  });

  return {
    config,
    stateDir,
    repository,
    kinds,
    directory,
    boards,
    clock,
    sleeper,
    logger,
    policy,
    enqueue: new EnqueueAction({ repository, kinds, directory, clock }),
    release: new ReleaseAction(repository, clock),
    cancel: new CancelAction(repository, clock),
    retry: new RetryAction(repository, clock),
    status: new QueueStatus(repository, clock, sync),
    list: new ListActions(repository),
    show: new ShowBoardItem({ boards, repository, clock }),
    audit,
    drain,
    // The worker is handed the pass as something to call, not as something it
    // knows: draining the queue and reading the board are separate jobs that
    // happen to run on one schedule.
    tick: new RunTick({
      drain,
      repository,
      policy,
      clock,
      logger,
      audit: async () => {
        await audit.execute();
      },
      ...(syncJobs === undefined ? {} : { sync: syncJobs }),
    }),
    close: () => {
      for (const close of closers) {
        close();
      }
      repository.close();
    },
  };
}

type SyncWiring = {
  sync: SyncConfig;
  repository: ActionRepository;
  kinds: KindRegistry;
  directory: BoardDirectory;
  boards: BoardRouter;
  policy: BudgetPolicy;
  clock: Clock;
  sleeper: Sleeper;
  logger: Logger;
  overrides: ContainerOverrides;
  stateDir: string;
  /** Where every handle opened here is registered to be closed with the container. */
  closers: (() => void)[];
  /** The REST transport an issue's dependency lists are read through: that of the board that carries it. */
  dependencyHttp: (ref: IssueRef) => GitHubHttp;
};

/**
 * The two directions of keeping in step, built only when the configuration
 * switches one on: nothing about the coordination server is opened, read or asked
 * for otherwise. Both run behind the check that this worker is the one that may.
 */
function buildSyncJobs(wiring: SyncWiring): SyncJobs {
  const { sync, repository, clock, logger, overrides } = wiring;
  const coordination = overrides.coordination ?? new DibsHttpClient({
    server: sync.server,
    token: tokenFromEnvironment(process.env, sync.tokenEnv),
    logger,
  });
  const jobs: SyncJobs = {
    owner: new SyncOwner({
      identity: overrides.identity ?? new GhCliIdentity(),
      sync,
      repository,
      clock,
      logger,
    }),
  };
  const mirror = sync.mirror;
  if (mirror?.enabled === true) {
    const claims = new MirrorClaims({
      feed: coordination,
      repository,
      kinds: wiring.kinds,
      directory: wiring.directory,
      sync,
      mirror,
      clock,
      logger,
    });
    jobs.mirror = () => claims.execute();
  }
  if (sync.importer.enabled) {
    const cache = new SqliteDependencyCache(dbPath(wiring.stateDir));
    wiring.closers.push(() => {
      cache.close();
    });
    const importer = new ImportReadyWork({
      boards: wiring.boards,
      dependencies: overrides.dependencies ?? new GitHubRestDependencies(wiring.dependencyHttp),
      cache,
      target: coordination,
      repository,
      wait: new LimiterWait({ repository, policy: wiring.policy, logger }),
      policy: wiring.policy,
      sync,
      importer: sync.importer,
      clock,
      sleeper: wiring.sleeper,
      logger,
    });
    jobs.importer = () => importer.execute();
  }
  return jobs;
}

/** One transport per board, built the first time an issue of that board is asked about. */
function memoised(
  placementOf: (ref: IssueRef) => BoardPlacement,
  build: (placement: BoardPlacement) => GitHubHttp,
): (ref: IssueRef) => GitHubHttp {
  const built = new Map<BoardKey, GitHubHttp>();
  return (ref) => {
    const placement = placementOf(ref);
    const held = built.get(placement.key) ?? build(placement);
    built.set(placement.key, held);
    return held;
  };
}
