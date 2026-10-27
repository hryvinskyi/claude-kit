/**
 * What keeping the boards in step with a coordination server needs from the
 * outside world, stated by the side that needs it. Nothing here knows about HTTP,
 * a file or a process.
 */
import type { IssueRef } from '../domain/issue-ref.ts';
import type { ClaimEvent } from '../domain/sync/claim-moves.ts';
import type { HeldClaim } from '../domain/sync/finished-claims.ts';
import type { Blocker } from '../domain/sync/ready-work.ts';

/**
 * One page of the server's event log, with only the claim events kept.
 *
 * The server leaves out of a page the events this reader may not see, while its
 * cursor still moves past them, so a page can hold nothing and still not be the
 * end of the log. Only `next` says how far the page read.
 */
export type ClaimFeedPage = {
  readonly claims: readonly ClaimEvent[];
  /** How many events the page showed, claim events or not. */
  readonly shown: number;
  /**
   * The cursor to ask from next: the last event the page read, shown or not, or
   * the cursor asked with when it read nothing; null while the log is empty.
   */
  readonly next: number | null;
};

/** A live claim on the server: who holds which item, and whether its work waits on a review. */
export type LiveClaim = {
  readonly item: number;
  readonly holder: string;
  readonly inReview: boolean;
};

/** A member of the server's project, and the GitHub login it names, if any. */
export type WorkMember = {
  readonly handle: string;
  readonly login: string | null;
};

/**
 * The coordination server's log of claims, as the mirror reads it. Every call has
 * a deadline; an answer the server could not give is a `TransientFailure`, and a
 * cursor behind what the log still keeps is a `CursorExpired` naming where to go
 * on from.
 */
export interface ClaimFeed {
  /** The events after `after`, oldest first, at most `limit` of them. */
  page(after: number, limit: number): Promise<ClaimFeedPage>;

  /** Every member of the project. */
  members(): Promise<WorkMember[]>;

  /** The outside reference of a work item (`scheme:value`), or null for an item that has none or is gone. */
  itemRef(id: number): Promise<string | null>;

  /** Every live claim of the project, as it stands now. */
  liveClaims(): Promise<LiveClaim[]>;
}

/**
 * The claims of the member the token speaks for, as the job that ends finished
 * claims reads and ends them. Every call has a deadline; an answer the server
 * could not give is a `TransientFailure`.
 */
export interface OwnClaims {
  /** The member the token speaks for, or null when it speaks for an integration rather than a person. */
  holder(): Promise<string | null>;

  /** Every claim that member holds, live or stale, with the board status the server last heard for its issue. */
  held(holder: string): Promise<HeldClaim[]>;

  /** Completes the member's claim on the item: true when it ended, false when the member no longer held it. */
  complete(item: number): Promise<boolean>;
}

/** What an imported item says beyond its title and whether it is closed: the facts of a listed item. */
export type ImportedListing = {
  readonly priority: number;
  readonly areasHint: readonly string[];
  readonly sourceStatus: string | null;
  /** The outside references of what blocks it; this list replaces the imported edges the server holds. */
  readonly blockedBy: readonly string[];
};

/** One item of an import batch. */
export type ImportedItem = {
  /** Its outside reference, `gh:owner/repo#number`. */
  readonly ref: string;
  readonly title: string;
  readonly closed: boolean;
  /**
   * Null for an item carried only because a listed item waits for it: it belongs
   * to no source, so a complete batch never closes it, and its own facts and
   * edges are left as the server holds them.
   */
  readonly listing: ImportedListing | null;
};

export type ImportBatch = {
  readonly source: string;
  /** True only when the batch names every open item of its source; the server closes the rest. */
  readonly complete: boolean;
  readonly items: readonly ImportedItem[];
};

/** An edge the server would not record, and why. */
export type RefusedEdge = {
  readonly item: string;
  readonly blockedBy: string;
  readonly reason: string;
};

/** An area hint the server left out, and why. */
export type DroppedHint = {
  readonly ref: string;
  readonly area: string;
  readonly reason: string;
};

export type ImportAnswer = {
  /** How many items each outcome befell, keyed by the server's word for it. */
  readonly outcomes: Readonly<Record<string, number>>;
  /** How many items a complete batch closed. */
  readonly closed: number;
  readonly refusedEdges: readonly RefusedEdge[];
  readonly droppedHints: readonly DroppedHint[];
};

/** Where the board's work is reported to. */
export interface WorkImport {
  putItems(batch: ImportBatch): Promise<ImportAnswer>;
}

/** The two lists GitHub keeps of what an issue waits for. */
export type DependencyList = 'blocked_by' | 'sub_issues';

/** An issue named in a dependency answer, with what the answer says about it. */
export type LinkedIssue = Blocker;

export type DependencyAnswer =
  | { readonly changed: true; readonly etag: string | null; readonly issues: readonly LinkedIssue[] }
  /** The answer the tag was taken from still holds; nothing was sent back. */
  | { readonly changed: false; readonly etag: string };

/**
 * What blocks an issue, read conditionally: handed the tag of the answer the
 * caller holds, it answers "unchanged" when that answer still holds. A refusal
 * from a limiter is thrown as the queue's own rate-limit failures.
 */
export interface DependencyReader {
  read(list: DependencyList, ref: IssueRef, etag: string | null): Promise<DependencyAnswer>;
}

/** The last answer one dependency list gave, kept between imports. */
export type DependencyFetch = {
  readonly etag: string | null;
  readonly issues: readonly LinkedIssue[];
  readonly fetchedAt: Date;
  /** When the issue said it last changed, as the board read it at the time of the fetch. */
  readonly issueUpdatedAt: Date | null;
};

/** Where the dependency answers are kept between imports. */
export interface DependencyCache {
  get(list: DependencyList, ref: IssueRef): Promise<DependencyFetch | null>;
  put(list: DependencyList, ref: IssueRef, fetch: DependencyFetch): Promise<void>;
}

/** Who this worker runs as, as the machine it runs on says. */
export interface LocalIdentity {
  /** The login, or null when none can be read. */
  login(): Promise<string | null>;
}
