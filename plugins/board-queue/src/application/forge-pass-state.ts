import type { RepositoryMap } from '../domain/forge/repository-map.ts';
import type { ForgeCalls } from './forge-calls.ts';
import type { ClaimBranches, KeptPull, ResolvedCommit, ReviewClaim, RunHold } from './forge-ports.ts';
import type { ForgeRepositoryRun } from './sync-meta.ts';

/** What the coordination server said at the start of a pass; every job of the pass works from it. */
export type CoordinationSnapshot = {
  readonly repositories: RepositoryMap;
  /** The GitHub logins of the project's members, in lower case. */
  readonly memberLogins: ReadonlySet<string>;
  readonly reviewClaims: readonly ReviewClaim[];
  readonly claimBranches: readonly ClaimBranches[];
  readonly runHolds: readonly RunHold[];
};

/** A pull request read on its own during this pass, and whether it merges cleanly. */
export type FreshPull = {
  readonly pull: KeptPull;
  readonly mergeable: boolean | null;
};

/**
 * What one pass has done so far, shared by its jobs so that none of them asks or
 * tells twice what another already did in the same pass.
 */
export class ForgePassState {
  readonly calls: ForgeCalls;
  readonly snapshot: CoordinationSnapshot;
  /** Pull requests whose end the server was told about in this pass. */
  readonly reported = new Set<string>();
  /** Pull requests read on their own in this pass. */
  readonly fresh = new Map<string, FreshPull>();
  /** Items whose claim a report of this pass ended. */
  readonly endedItems = new Set<number>();
  /** Holds whose run was reported finished in this pass. */
  readonly releasedHolds = new Set<string>();
  /** Each repository's default branch, once read in this pass. */
  readonly defaultBranches = new Map<string, string>();
  /** Pull requests whose state this pass's own listing read, so nothing has to ask after them again. */
  readonly confirmed = new Map<string, KeptPull>();
  /** Commits a hold names, as resolved in this pass. */
  readonly commits = new Map<string, ResolvedCommit>();
  /** Commits asked about in a repository that holds none of them, keyed `repo` and sha. */
  readonly commitsAbsent = new Set<string>();
  /** Commit statuses written in this pass, across every repository. */
  statusWrites = 0;

  constructor(calls: ForgeCalls, snapshot: CoordinationSnapshot) {
    this.calls = calls;
    this.snapshot = snapshot;
  }
}

/**
 * One job of a pass, run for each repository in turn. A job records what it did
 * on the repository's tally; a failure about one thing is its own to weigh, and
 * only the calls' own stops end the repository's jobs or the pass.
 */
export interface ForgeJob {
  /** What the job does, as a log line names it. */
  readonly name: string;
  run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void>;
}
