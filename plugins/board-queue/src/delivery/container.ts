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
import { MIRROR_AUDIENCES } from '../application/mirror-audience.ts';
import { MirrorClaims } from '../application/mirror-claims.ts';
import { FinishClaims } from '../application/finish-claims.ts';
import { ForgePass } from '../application/forge-pass.ts';
import type { Forge, ForgeCoordination, ForgeIdentity } from '../application/forge-ports.ts';
import { RunTick } from '../application/run-tick.ts';
import type { SyncJobs } from '../application/run-tick.ts';
import { SyncOwner } from '../application/sync-owner.ts';
import type { ClaimFeed, DependencyReader, LocalIdentity, OwnClaims, WorkImport } from '../application/sync-ports.ts';
import { ShowBoardItem } from '../application/show-board-item.ts';
import { BoardDirectory } from '../domain/board-directory.ts';
import type { BoardKey, BoardPlacement } from '../domain/board-directory.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { Config } from '../domain/config.ts';
import { RefusedByRule } from '../domain/errors.ts';
import { defaultKindRegistry } from '../domain/kinds/default-kinds.ts';
import type { KindRegistry } from '../domain/kinds/registry.ts';
import { StartOfWork } from '../domain/start-of-work.ts';
import type { SyncConfig } from '../domain/sync-config.ts';
import { syncIsOn } from '../domain/sync-config.ts';
import { DibsHttpClient } from '../infrastructure/dibs-http.ts';
import { dibsToken } from '../infrastructure/dibs-token.ts';
import { DibsForgeClient } from '../infrastructure/dibs-forge-http.ts';
import { GitHubRestForge } from '../infrastructure/github-rest-forge.ts';
import { SqliteForgeLedger } from '../infrastructure/sqlite-forge-ledger.ts';
import { GitHubRestDependencies } from '../infrastructure/github-rest-dependencies.ts';
import { SqliteDependencyCache } from '../infrastructure/sqlite-dependency-cache.ts';
import { FileAuditReport } from '../infrastructure/file-audit-report.ts';
import { FileLogger } from '../infrastructure/file-logger.ts';
import { GitHubGraphqlBoard } from '../infrastructure/github-graphql-board.ts';
import { BudgetLedger, GitHubHttp } from '../infrastructure/github-http.ts';
import type { FetchLike } from '../infrastructure/github-http.ts';
import { GitHubRestIssues } from '../infrastructure/github-rest-issues.ts';
import { auditPath, dbPath, logPath } from '../infrastructure/paths.ts';
import { SqliteActionRepository } from '../infrastructure/sqlite-action-repository.ts';
import { SystemClock, RealSleeper } from '../infrastructure/system-clock.ts';
import { AccountCredentials } from '../infrastructure/token-providers.ts';
import { localIdentity } from './local-identity.ts';

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
  /** Stands in for the coordination server, for every job that keeps in step with it but the forge jobs. */
  coordination?: ClaimFeed & WorkImport & OwnClaims;
  /** Stands in for the network under the coordination server's real clients, token and all. */
  dibsFetch?: FetchLike;
  /** Stands in for the REST lists of what blocks an issue. */
  dependencies?: DependencyReader;
  /** Stands in for the login this worker is judged by, whichever source the environment names. */
  identity?: LocalIdentity;
  /** Stands in for the network under the GitHub App's own calls: its credential and its login. */
  appFetch?: FetchLike;
  /** Stands in for GitHub's pull requests, branches, workflow runs and commit statuses. */
  forge?: Forge;
  /** Stands in for the coordination server, as the forge jobs reach it. */
  forgeCoordination?: ForgeCoordination;
  /** Stands in for whose credential each repository's forge calls go out under. */
  forgeIdentity?: ForgeIdentity;
};

export type BuildContainerOptions = {
  config: Config;
  /** Where the queue, the log and the reports live. */
  stateDir: string;
  /** Where the credential and the identity source are read from; the process's own by default. */
  env?: Record<string, string | undefined>;
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
  const env = options.env ?? process.env;
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
    env,
    boards: directory.boards().map((placement) => placement.board),
    logger,
    clock,
    ...(overrides.appFetch === undefined ? {} : { fetchImpl: overrides.appFetch }),
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
    env,
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
    dependencyHttp: memoised((ref: IssueRef) => directory.placementOf(ref), httpFor),
    forgeHttp: memoised((repo: string) => placementOfRepository(directory, repo), (placement) =>
      new GitHubHttp({
        tokens: overrides.tokens ?? credentials.appFor(placement.board) ?? credentials.for(placement.board),
        logger,
        ledger,
      })),
    forgeIdentity: overrides.forgeIdentity ?? {
      usesAppIdentity: (repo) => credentials.appFor(placementOfRepository(directory, repo).board) !== null,
    },
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
    enqueue: new EnqueueAction({
      repository,
      kinds,
      directory,
      clock,
      ...starterAssignment(sync, () => overrides.identity ?? localIdentity({
        env,
        board: firstBoard(directory),
        clock,
        fetchImpl: overrides.appFetch,
      })),
    }),
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
      ...(config.audit.enabled ? {
        audit: async () => {
          await audit.execute();
        },
      } : {}),
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
  env: Record<string, string | undefined>;
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
  /**
   * The REST transport the forge jobs reach a repository through: the App's own
   * credential for the account of the board that carries it, with no fallback,
   * where the deployment names an App; the board's usual chain otherwise.
   */
  forgeHttp: (repo: string) => GitHubHttp;
  /** Whose credential each repository's forge calls go out under. */
  forgeIdentity: ForgeIdentity;
};

/**
 * The jobs that keep in step, built only when the configuration switches one on:
 * nothing about the coordination server is opened, read or asked for otherwise.
 * The importer and the forge jobs run behind the check that this worker is the
 * owner's; the mirror does too, unless it files only this worker's own person's
 * moves, which it settles with the login this worker runs as. Ending finished
 * claims never waits for it: it ends only the claims of the member the token
 * speaks for.
 */
function buildSyncJobs(wiring: SyncWiring): SyncJobs {
  const { sync, env, repository, clock, logger, overrides } = wiring;
  const coordination = overrides.coordination ?? new DibsHttpClient({
    server: sync.server,
    token: dibsToken(sync, env),
    logger,
    ...(overrides.dibsFetch === undefined ? {} : { fetchImpl: overrides.dibsFetch }),
  });
  const identityDeps = { env, board: firstBoard(wiring.directory), clock, fetchImpl: overrides.appFetch };
  const jobs: SyncJobs = {
    owner: new SyncOwner({
      identity: overrides.identity ?? localIdentity(identityDeps),
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
      audience: MIRROR_AUDIENCES[mirror.scope](overrides.identity ?? localIdentity(identityDeps), sync.mirrorOwner),
    });
    jobs.mirror = () => claims.execute();
    jobs.mirrorScope = mirror.scope;
  }
  const finish = sync.finish;
  if (finish?.enabled === true) {
    const finishing = new FinishClaims({ claims: coordination, repository, sync, finish, clock, logger });
    jobs.finish = () => finishing.execute();
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
  if (sync.forge.enabled) {
    const ledger = new SqliteForgeLedger(dbPath(wiring.stateDir));
    wiring.closers.push(() => {
      ledger.close();
    });
    const pass = new ForgePass({
      forge: overrides.forge ?? new GitHubRestForge(wiring.forgeHttp),
      identity: wiring.forgeIdentity,
      coordination: overrides.forgeCoordination ?? new DibsForgeClient({
        server: sync.server,
        token: dibsToken(sync, env),
        logger,
        ...(overrides.dibsFetch === undefined ? {} : { fetchImpl: overrides.dibsFetch }),
      }),
      ledger,
      repository,
      wait: new LimiterWait({ repository, policy: wiring.policy, logger }),
      sync,
      settings: sync.forge,
      clock,
      sleeper: wiring.sleeper,
      logger,
    });
    jobs.forge = () => pass.execute();
  }
  return jobs;
}

/** The board that carries a repository; the configuration refuses a repository kept in step that none carries. */
function placementOfRepository(directory: BoardDirectory, repo: string): BoardPlacement {
  const placement = directory.find(repo);
  if (placement === null) {
    throw new RefusedByRule(`${repo} is carried by no configured board`);
  }
  return placement;
}

/**
 * Who a move that starts the work assigns, and which statuses start it: the
 * statuses a claim stands for when the mirror assigns people, and nothing for a
 * deployment whose mirror is off or assigns nobody. The identity is built only
 * when it can be asked.
 */
function starterAssignment(
  sync: SyncConfig | null,
  identity: () => LocalIdentity,
): { startOfWork?: StartOfWork; identity?: LocalIdentity } {
  const mirror = sync?.mirror;
  if (mirror?.enabled !== true || !mirror.assignees) {
    return {};
  }
  const { claimed, takenOver } = mirror.status;
  return { startOfWork: new StartOfWork([claimed, takenOver ?? claimed]), identity: identity() };
}

/** Any configured board; the configuration refuses one that names none. */
function firstBoard(directory: BoardDirectory): BoardPlacement {
  const [first] = directory.boards();
  if (first === undefined) {
    throw new RefusedByRule('the configuration names no board');
  }
  return first;
}

/** One transport per board, built the first time something of that board is asked about. */
function memoised<K>(
  placementOf: (key: K) => BoardPlacement,
  build: (placement: BoardPlacement) => GitHubHttp,
): (key: K) => GitHubHttp {
  const built = new Map<BoardKey, GitHubHttp>();
  return (key) => {
    const placement = placementOf(key);
    const held = built.get(placement.key) ?? build(placement);
    built.set(placement.key, held);
    return held;
  };
}
