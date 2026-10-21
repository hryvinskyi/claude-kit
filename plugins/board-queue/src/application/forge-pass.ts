import { RepositoryMap } from '../domain/forge/repository-map.ts';
import type { ForgeConfig, SyncConfig } from '../domain/sync-config.ts';
import { ForgeCalls, ForgePassStopped, ForgeRepositoryStopped } from './forge-calls.ts';
import { MeasureFootprints } from './forge-footprints.ts';
import { ReleaseRunHolds } from './forge-holds.ts';
import { ForgePassState } from './forge-pass-state.ts';
import type { CoordinationSnapshot, ForgeJob } from './forge-pass-state.ts';
import type { Forge, ForgeCoordination, ForgeIdentity, ForgeLedger } from './forge-ports.ts';
import { FollowPullRequests, PullEnds, PullReads, ReconcileReviews, ReportMergeability } from './forge-pulls.ts';
import { WriteStatuses } from './forge-statuses.ts';
import type { LimiterWait } from './limiter-wait.ts';
import type { ActionRepository, Clock, Logger, Sleeper } from './ports.ts';
import { writeForgeRun } from './sync-meta.ts';
import type { ForgeRepositoryRun, ForgeRun } from './sync-meta.ts';

/** What one pass did, or why it did not run. */
/** A pass that did not run, `declined` when this worker may not run it at all; or the pass that ran. */
export type ForgeReport = { skipped: string; declined?: true } | { run: ForgeRun };

/** How long a forgotten row has stood still: statuses written, and pull requests that ended and were reported. */
const KEPT_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** The most rows of each kind one pass forgets. */
const PRUNED_PER_PASS = 500;

export type ForgePassDeps = {
  forge: Forge;
  /** Whose credential each repository's calls go out under. */
  identity: ForgeIdentity;
  coordination: ForgeCoordination;
  ledger: ForgeLedger;
  /** Read for the wait in force and written with the pass's report; no action is ever filed in it. */
  repository: ActionRepository;
  wait: LimiterWait;
  sync: SyncConfig;
  settings: ForgeConfig;
  clock: Clock;
  sleeper: Sleeper;
  logger: Logger;
};

/**
 * GitHub and the coordination server kept in step about the work that leaves a
 * claim: pull requests merged or closed, whether each merges cleanly, the status
 * the server wants on its members' pull requests, what each claimed branch
 * changes, and the workflow runs slot holds wait for.
 *
 * One pass reads the server first — its repositories, members, claims in review,
 * claimed branches and holds — and nothing is sent when that read fails. Then
 * each repository kept in step is taken in turn through the jobs, in order: the
 * listing of pull requests, the claims in review, mergeability, statuses,
 * footprints, holds. Every request to GitHub is paced, one at a time, and asked
 * only while the pass is inside its time and the allowance above its reserve; a
 * limiter's refusal ends the pass and puts the queue to sleep, GitHub not
 * answering ends that repository's jobs, and the pass's report says why. Rows no
 * pass needs any more are forgotten at its end, a bounded number at a time.
 *
 * It starts only where the calls go out under an App's credential, unless the
 * configuration allows a person's.
 *
 * Every report to the server is safe to send twice, and what a pass keeps is
 * written only once the server answered, so a pass that dies sends again what it
 * had not kept rather than skipping it. It files nothing in the queue.
 */
export class ForgePass {
  readonly #coordination: ForgeCoordination;
  readonly #forge: Forge;
  readonly #identity: ForgeIdentity;
  readonly #ledger: ForgeLedger;
  readonly #repository: ActionRepository;
  readonly #wait: LimiterWait;
  readonly #settings: ForgeConfig;
  readonly #clock: Clock;
  readonly #sleeper: Sleeper;
  readonly #logger: Logger;
  readonly #repos: readonly string[];
  readonly #jobs: readonly ForgeJob[];

  constructor(deps: ForgePassDeps) {
    this.#coordination = deps.coordination;
    this.#forge = deps.forge;
    this.#identity = deps.identity;
    this.#ledger = deps.ledger;
    this.#repository = deps.repository;
    this.#wait = deps.wait;
    this.#settings = deps.settings;
    this.#clock = deps.clock;
    this.#sleeper = deps.sleeper;
    this.#logger = deps.logger;
    this.#repos = [...new Set(deps.sync.repos.map((repo) => repo.toLowerCase()))];
    const ends = new PullEnds(deps.forge, deps.coordination, deps.logger);
    const reads = new PullReads(deps.forge);
    const ledger = deps.ledger;
    const logger = deps.logger;
    this.#jobs = [
      new FollowPullRequests({ forge: deps.forge, ledger, ends, settings: deps.settings, logger }),
      new ReconcileReviews({ ledger, reads, ends, logger }),
      new ReportMergeability({ ledger, reads, ends, coordination: deps.coordination, logger }),
      new WriteStatuses({
        forge: deps.forge,
        coordination: deps.coordination,
        pulls: ledger,
        statuses: ledger,
        settings: deps.settings,
        clock: deps.clock,
        logger,
      }),
      new MeasureFootprints({ forge: deps.forge, coordination: deps.coordination, pulls: ledger, branches: ledger, logger }),
      new ReleaseRunHolds({ forge: deps.forge, coordination: deps.coordination, commits: ledger, logger }),
    ];
  }

  async execute(): Promise<ForgeReport> {
    const pause = await this.#repository.getPause();
    if (pause !== null && pause.isActive(this.#clock.now())) {
      return { skipped: `the queue is waiting out a refusal until ${pause.until.toISOString()}` };
    }
    const refused = this.#refusal();
    if (refused !== null) {
      this.#logger.error('the forge jobs declined to start', { reason: refused });
      await writeForgeRun(this.#repository, {
        at: this.#clock.now().toISOString(),
        requests: 0,
        notModified: 0,
        repos: [],
        stoppedBecause: null,
        refused,
        pruned: { statuses: 0, pulls: 0 },
      });
      return { skipped: refused, declined: true };
    }
    const calls = new ForgeCalls({
      allowance: this.#forge,
      wait: this.#wait,
      settings: this.#settings,
      clock: this.#clock,
      sleeper: this.#sleeper,
      logger: this.#logger,
    });
    const repos: ForgeRepositoryRun[] = [];
    try {
      const pass = new ForgePassState(calls, await this.#snapshot(calls));
      for (const repo of this.#repos) {
        const tally = await this.#tallyOf(repo, pass);
        repos.push(tally);
        await this.#runJobs(repo, pass, tally);
      }
    } catch (error) {
      if (!(error instanceof ForgePassStopped)) {
        throw error;
      }
    }
    const pruned = await this.#ledger.prune(new Date(this.#clock.now().getTime() - KEPT_FOR_MS), PRUNED_PER_PASS);
    const run: ForgeRun = {
      at: calls.startedAt.toISOString(),
      requests: calls.requests,
      notModified: calls.notModified,
      repos,
      stoppedBecause: calls.stoppedBecause,
      refused: null,
      pruned,
    };
    await writeForgeRun(this.#repository, run);
    this.#logger.info('the forge was kept in step', { ...run });
    return { run };
  }

  /**
   * Why the jobs must not start on this worker, or nothing when they may. They
   * write statuses every reader of a repository sees and spend the allowance of
   * whoever they run as, so a configuration copied onto a person's machine starts
   * nothing there unless it says so.
   */
  #refusal(): string | null {
    if (this.#settings.allowPersonalToken) {
      return null;
    }
    const personal = this.#repos.filter((repo) => !this.#identity.usesAppIdentity(repo));
    if (personal.length === 0) {
      return null;
    }
    return `the forge jobs run only under an App's credential, and ${personal.join(', ')} would be reached `
      + 'with a person\'s; name the App in this worker\'s environment, or set forge.allowPersonalToken';
  }

  /** The jobs of one repository, in order; GitHub not answering ends them, and the pass goes on. */
  async #runJobs(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    try {
      for (const job of this.#jobs) {
        pass.calls.enter();
        await job.run(repo, pass, tally);
      }
    } catch (error) {
      if (!(error instanceof ForgeRepositoryStopped)) {
        throw error;
      }
      tally.stoppedBecause = error.reason;
    }
  }

  async #snapshot(calls: ForgeCalls): Promise<CoordinationSnapshot> {
    const coordination = this.#coordination;
    const listed = await calls.coordination('its repositories', () => coordination.repositories(), true);
    const members = await calls.coordination('its members', () => coordination.members(), true);
    const reviewClaims = await calls.coordination('the claims in review', () => coordination.reviewClaims(), true);
    const claimBranches = await calls.coordination('the claimed branches', () => coordination.claimBranches(), true);
    const runHolds = await calls.coordination('the slot holds', () => coordination.runHolds(), true);
    return {
      repositories: RepositoryMap.of(listed, this.#repos),
      memberLogins: new Set(members.flatMap((member) => member.login === null ? [] : [member.login.toLowerCase()])),
      reviewClaims,
      claimBranches,
      runHolds,
    };
  }

  async #tallyOf(repo: string, pass: ForgePassState): Promise<ForgeRepositoryRun> {
    const mark = await this.#ledger.listing(repo);
    return {
      repo,
      cursor: mark === null ? null : mark.cursor.toISOString(),
      seeded: false,
      listed: 0,
      listedByServer: pass.snapshot.repositories.idOf(repo) !== null,
      merged: 0,
      closed: 0,
      mergesWithoutFiles: 0,
      refusedReports: 0,
      mergeability: 0,
      statuses: 0,
      statusesWithdrawn: 0,
      statusesDeferred: 0,
      footprints: 0,
      branchesGone: 0,
      holdsReleased: 0,
      failures: 0,
      listingError: null,
      stoppedBecause: null,
    };
  }
}
