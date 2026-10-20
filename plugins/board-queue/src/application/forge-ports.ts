/**
 * What the forge jobs need from GitHub, from the coordination server and from the
 * queue's own file, stated by the side that needs it. Nothing here knows about
 * HTTP, SQL or a process; every repository is named `owner/name`.
 */
import type { CommitStatus } from '../domain/forge/commit-status.ts';
import type { ForgePull, PullEnd } from '../domain/forge/pull-requests.ts';
import type { CoordinatedRepository } from '../domain/forge/repository-map.ts';
import type { WorkflowRun } from '../domain/forge/workflow-runs.ts';
import type { WorkMember } from './sync-ports.ts';

/** Which pull requests a listing names: every one, or only those still open. */
export type PullListing = 'all' | 'open';

/** One page of a repository's pull requests, newest update first, or "unchanged" for a page asked conditionally. */
export type PullPage =
  | { readonly changed: false }
  | {
    readonly changed: true;
    /** The tag a later conditional request for the same page hands back. */
    readonly etag: string | null;
    readonly pulls: readonly ForgePull[];
    /** Whether another page follows. */
    readonly more: boolean;
    /** When GitHub says it answered, by its own clock; null when it did not say. */
    readonly servedAt: Date | null;
  };

/** One pull request read on its own, which is the only read that says whether it merges cleanly. */
export type PullRead =
  | { readonly changed: false }
  | {
    readonly changed: true;
    readonly etag: string | null;
    readonly pull: ForgePull;
    /** Whether it merges cleanly into its base; null while the forge is still working it out. */
    readonly mergeable: boolean | null;
  };

/** One page of the paths a pull request changed; a rename names both of its paths. */
export type PullFilesPage = {
  readonly paths: readonly string[];
  /** Whether another page follows. */
  readonly more: boolean;
};

/** The pull requests of a repository. Every call has a deadline; a limiter's refusal is thrown as the queue's own. */
export interface PullRequests {
  /** A page of the listing, sorted by the last update, newest first; page 1 may be asked conditionally. */
  pullPage(repo: string, listing: PullListing, page: number, etag: string | null): Promise<PullPage>;

  /** One pull request, asked conditionally with the tag of the answer the caller holds. */
  pull(repo: string, number: number, etag: string | null): Promise<PullRead>;

  /** A page of what a pull request changed, relative to the repository's root, from page 1. */
  pullFilesPage(repo: string, number: number, page: number): Promise<PullFilesPage>;
}

/** What a branch changes against its base, measured from where it left the base. */
export type BranchMeasure = {
  /** The merge base of the branch and its base: the commit the branch left the base at, not the base's tip. */
  readonly baseSha: string;
  /** When that commit was committed. */
  readonly baseAt: Date;
  readonly paths: readonly string[];
  /** True when the forge listed fewer paths than the branch changes. */
  readonly truncated: boolean;
};

export type BranchComparison =
  /** The answer the tag was taken from still holds. */
  | { readonly kind: 'unchanged' }
  /** The branch, or its base, is not there any more. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'measured'; readonly etag: string | null; readonly measure: BranchMeasure };

export type DefaultBranchRead =
  | { readonly changed: false }
  | { readonly changed: true; readonly etag: string | null; readonly name: string };

/** The branches of a repository. */
export interface Branches {
  /** The branch a repository's work is merged into when nothing else says so, asked conditionally. */
  defaultBranch(repo: string, etag: string | null): Promise<DefaultBranchRead>;

  /** What `branch` changes against `base`, asked conditionally. */
  compare(repo: string, base: string, branch: string, etag: string | null): Promise<BranchComparison>;
}

/** The commits of a repository. */
export interface Commits {
  /** The full id of the commit a (possibly short) id names, or nothing when the repository holds none. */
  resolveCommit(repo: string, sha: string): Promise<string | null>;
}

/** The workflow runs of a repository. */
export interface WorkflowRuns {
  /** The runs the forge made for one commit, of every workflow. */
  runsFor(repo: string, sha: string): Promise<WorkflowRun[]>;
}

/** The commit statuses of a repository. */
export interface CommitStatuses {
  /** Files a status on a commit; it replaces the one of the same context. */
  writeStatus(repo: string, sha: string, status: CommitStatus): Promise<void>;
}

/** What is left of the allowance a repository's calls spend, without spending any. */
export interface ForgeAllowance {
  /** The remaining REST requests the last answer reported, or null while none has. */
  remaining(repo: string): number | null;
}

/** GitHub, as the forge jobs reach it. */
export type Forge = PullRequests & Branches & Commits & WorkflowRuns & CommitStatuses & ForgeAllowance;

/**
 * Whose credential a repository's calls go out under. The forge jobs write commit
 * statuses everyone who reads the repository sees, and spend an allowance: they
 * run under an identity of their own, never a person's, unless a deployment says
 * otherwise.
 */
export interface ForgeIdentity {
  /** Whether the calls about this repository are made as an App rather than a person. */
  usesAppIdentity(repo: string): boolean;
}

/** A claim waiting in review, and the pull requests it waits for. */
export type ReviewClaim = {
  readonly item: number;
  readonly holder: string;
  /** As the server writes them: `owner/name#number`, in lower case. */
  readonly prs: readonly string[];
};

/** A live claim and the branch its work is on in each repository, keyed by the server's repository id. */
export type ClaimBranches = {
  readonly item: number;
  readonly holder: string;
  readonly branches: Readonly<Record<string, string>>;
};

/** The status the server wants on a repository's pull requests into one base, and whether it wants one at all. */
export type WantedStatus = {
  readonly enabled: boolean;
  readonly status: CommitStatus;
};

/** Where a claim stands after a report about one of its pull requests. */
export type ClaimAfterReport = 'in_review' | 'set_aside' | 'working' | 'completed';

/**
 * The server's answer to a merge or a close. An answer that matched nothing is a
 * success too: the report was about a pull request no claim recorded, or one the
 * server was told about already.
 */
export type PullReportAnswer =
  | { readonly matched: false }
  | { readonly matched: true; readonly item: number; readonly claim: ClaimAfterReport };

export type MergeReport = {
  /** `owner/name#number`. */
  readonly pr: string;
  readonly base: string;
  /**
   * The branch it was merged from, which the server tells apart from the branches
   * the merge moved the base under; null for a branch of a fork, which is no
   * branch of the repository's.
   */
  readonly head: string | null;
  readonly mergedAt: Date;
  /** What it changed; null when that could not be read, and the server then takes it from what it kept. */
  readonly files: readonly string[] | null;
};

/** What a claimed branch changes, as the server is told it. */
export type FootprintReport = {
  /** The server's id of the repository. */
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  readonly measure: BranchMeasure;
};

/**
 * Whether the server kept the footprint. One it did not keep — the claim ended, or
 * moved to another branch since the branches were read — is a success too.
 */
export type FootprintAnswer =
  | { readonly stored: true; readonly changed: boolean }
  | { readonly stored: false; readonly reason: string };

/** A slot held until a forge workflow's run for one commit finishes. */
export type RunHold = {
  /** The slot held. */
  readonly slot: string;
  readonly workflow: string;
  readonly sha: string;
};

/**
 * The coordination server, as the forge jobs read it and report to it. Every call
 * has a deadline, and an answer the server could not give is a `TransientFailure`;
 * every report is safe to send again.
 */
export interface ForgeCoordination {
  /** The project's repositories, with the remote each is cloned from. */
  repositories(): Promise<CoordinatedRepository[]>;

  members(): Promise<WorkMember[]>;

  /** The claims in review and the pull requests each waits for. */
  reviewClaims(): Promise<ReviewClaim[]>;

  /** Every live claim with the branch it is on in each repository. */
  claimBranches(): Promise<ClaimBranches[]>;

  /** Every hold that waits for a forge workflow run. */
  runHolds(): Promise<RunHold[]>;

  /**
   * The status for pull requests of `repo` (the server's id) into `base`, or null
   * when the server knows no such repository or branch.
   */
  wantedStatus(repo: string, base: string): Promise<WantedStatus | null>;

  reportMerged(report: MergeReport): Promise<PullReportAnswer>;

  reportClosed(pr: string): Promise<PullReportAnswer>;

  /** Whether a pull request merges cleanly into its base; answers whether the server recorded a change. */
  reportMergeable(pr: string, mergeable: boolean): Promise<boolean>;

  reportFootprint(item: number, footprint: FootprintReport): Promise<FootprintAnswer>;

  /** That the run a hold waits for finished; answers whether a hold ended. */
  reportRunFinished(hold: RunHold, conclusion: string): Promise<boolean>;
}

/** A pull request as the forge jobs keep it between passes. */
export type KeptPull = ForgePull & {
  /** The tag of the last time it was read on its own. */
  readonly etag: string | null;
  /** What the server was last told about whether it merges cleanly. */
  readonly mergeableSent: boolean | null;
  /** The end the server was told about — or refused to be told about, which is never sent again — or nothing. */
  readonly reported: PullEnd | null;
};

/** Where the listing of a repository stands: how far it read, and the tag of its first page. */
export type ListingMark = {
  readonly cursor: Date;
  readonly etag: string | null;
};

/** The pull requests of each repository, kept between passes. */
export interface PullLedger {
  listing(repo: string): Promise<ListingMark | null>;

  pull(repo: string, number: number): Promise<KeptPull | null>;

  /** The pull requests last known to be open, oldest number first. */
  openPulls(repo: string): Promise<KeptPull[]>;

  /** Keeps these pull requests and moves the listing's mark, in one transaction: all of it lands or none. */
  recordListing(repo: string, mark: ListingMark, pulls: readonly KeptPull[]): Promise<void>;

  recordPull(pull: KeptPull): Promise<void>;
}

/** The commit statuses written, so the same one is never written twice. */
export interface StatusLedger {
  lastStatus(repo: string, sha: string, context: string): Promise<CommitStatus | null>;

  /** Every status kept for one commit, whatever its context. */
  statusesOn(repo: string, sha: string): Promise<CommitStatus[]>;

  /** Keeps the status last written on a commit under its context. */
  recordStatus(repo: string, sha: string, status: CommitStatus, at: Date): Promise<void>;

  forgetStatus(repo: string, sha: string, context: string): Promise<void>;

  /** Counts one status written, in any repository, against the hour. */
  noteStatusWrite(at: Date): Promise<void>;

  /** How many statuses were written since this moment, in every repository. */
  statusWritesSince(since: Date): Promise<number>;
}

/** Which repository holds a commit a hold names, and the commit's full id. */
export type ResolvedCommit = {
  readonly repo: string;
  readonly sha: string;
};

/** The commits holds name, resolved once and kept. */
export interface CommitLedger {
  resolvedCommit(sha: string): Promise<ResolvedCommit | null>;

  recordResolvedCommit(sha: string, resolved: ResolvedCommit): Promise<void>;
}

/** How much a prune removed. */
export type Pruned = {
  readonly statuses: number;
  readonly pulls: number;
};

/** Forgetting what no pass needs any more, a bounded number of rows at a time. */
export interface LedgerPruning {
  /**
   * Forgets statuses written before `before` on commits that are no open pull
   * request's head, and pull requests that ended, were reported, and were last
   * updated before it; at most `limit` rows of each.
   */
  prune(before: Date, limit: number): Promise<Pruned>;
}

/** A branch's last measure, and the tag of the answer it came from. */
export type KeptMeasure = {
  readonly etag: string | null;
  readonly measure: BranchMeasure;
};

/** What each claimed branch was last measured to change, and each repository's default branch. */
export interface BranchLedger {
  defaultBranch(repo: string): Promise<{ readonly name: string; readonly etag: string | null } | null>;

  recordDefaultBranch(repo: string, name: string, etag: string | null): Promise<void>;

  measure(repo: string, base: string, branch: string): Promise<KeptMeasure | null>;

  recordMeasure(repo: string, base: string, branch: string, kept: KeptMeasure): Promise<void>;

  /** Forgets the measures of a repository's branches that are not among these. */
  forgetMeasuresExcept(repo: string, keep: readonly { readonly base: string; readonly branch: string }[]): Promise<void>;
}

/** Everything the forge jobs keep between passes, in the queue's own file. */
export type ForgeLedger = PullLedger & StatusLedger & BranchLedger & CommitLedger & LedgerPruning;
