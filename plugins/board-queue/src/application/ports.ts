/**
 * What the queue needs from the outside world, stated by the side that needs it.
 *
 * Every interface here is a promise an adapter keeps; nothing in this file knows
 * about SQL, HTTP or a process. The comments are the contract — an implementation
 * that cannot keep one of them is a bug in the adapter, not a hint for callers.
 */
import type { Action, ActionState } from '../domain/action.ts';
import type { BoardKey } from '../domain/board-directory.ts';
import type { BoardSnapshot, CachedCatalog, FieldCatalog, ReadItemResult } from '../domain/catalog.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { QueuePause } from '../domain/queue-pause.ts';
import type { RateBudget } from '../domain/rate-budget.ts';

export type ActionFilter = {
  states?: readonly ActionState[];
  /** `owner/name`, matched case-insensitively. */
  repo?: string;
  issue?: number;
  kind?: string;
  limit?: number;
};

export type ActionCounts = Record<ActionState, number>;

/**
 * The queue itself. Two processes write it, so every method that changes a row
 * says how it behaves when somebody else got there first.
 */
export interface ActionRepository {
  insert(action: Action): Promise<void>;

  /**
   * Writes the aggregate guarded by the version it was read at
   * (`action.persistedVersion`) and stores `action.version`. When the guard finds
   * another version nothing is written and `StaleAction` is thrown: the row was
   * changed by somebody else and this copy's decisions were taken on stale facts.
   */
  update(action: Action): Promise<void>;

  get(id: string): Promise<Action | null>;

  /**
   * The oldest action of this kind on this issue that is still waiting to run
   * (queued, and past any waiting time), or null. The repository is matched
   * case-insensitively; a held or delayed action is never a candidate.
   */
  findCoalescible(kind: string, issueRef: IssueRef, now: Date): Promise<Action | null>;

  /**
   * Folds a merged payload into an action in one conditional statement, guarded by
   * the version the merge was computed from, so it can lose neither a race with a
   * worker claiming the row nor one with a second enqueuer merging into it. False
   * means the row stopped being the row the merge was about — claimed, changed by
   * somebody else, or stepped into a wait — and the caller must look again or file
   * a new action.
   */
  coalesceInto(id: string, mergedPayload: unknown, now: Date, expectedVersion: number): Promise<boolean>;

  /**
   * Takes the next action a worker may run and marks it running in the same
   * transaction, so two ticks cannot take the same one. Actions on one issue run
   * in the order they were filed: an action is not claimable while an older
   * action on the same issue is queued or running.
   */
  claimNextRunnable(now: Date): Promise<Action | null>;

  /** The matching actions, oldest first, so a listing reads in the order things were filed. */
  list(filter: ActionFilter): Promise<Action[]>;

  counts(): Promise<ActionCounts>;

  getPause(): Promise<QueuePause | null>;

  setPause(pause: QueuePause | null): Promise<void>;

  getMeta(key: string): Promise<string | null>;

  setMeta(key: string, value: string): Promise<void>;

  /** The catalog last fetched for this board, or null; each board's is kept apart from every other's. */
  getCatalog(board: BoardKey): Promise<CachedCatalog | null>;

  putCatalog(board: BoardKey, catalog: FieldCatalog, fetchedAt: Date): Promise<void>;

  /**
   * Runs the callback while holding the single tick lock, or answers null when
   * another tick holds it. A holder that is too old, or whose process is gone, is
   * not a holder: a crashed tick must not freeze the queue.
   */
  withTickLock<T>(fn: () => Promise<T>): Promise<T | null>;
}

/** Where one board's fetched catalog is kept between processes. */
export interface CatalogStore {
  get(): Promise<CachedCatalog | null>;
  put(catalog: FieldCatalog, fetchedAt: Date): Promise<void>;
}

/**
 * One board. Membership is written, never inferred from the issue's side: asking
 * an issue for its board items was measured to answer empty for issues that are
 * demonstrably on the board when the repository's owner and the board's owner
 * differ, which reads exactly like "not on the board".
 */
export interface BoardGateway {
  /** The board's fields and their options; cached, `force` refetches. */
  catalog(force?: boolean): Promise<FieldCatalog>;

  /** Every row in one paginated walk; cached for a short while, `force` refetches. */
  snapshot(force?: boolean): Promise<BoardSnapshot>;

  /** The row for this issue, matched on repository *and* number, or null. */
  findItem(ref: IssueRef): Promise<ReadItemResult | null>;

  /** The item id for this issue, adding it to the board if it is not there yet. */
  ensureItem(ref: IssueRef): Promise<string>;

  /** Reads one known row back; this is what a write is confirmed against. */
  readItemById(itemId: string): Promise<ReadItemResult>;

  setSingleSelect(itemId: string, fieldId: string, optionId: string): Promise<void>;

  /** Which of these issues are on the board, from one snapshot; keyed by `ref.key()`. */
  membership(refs: readonly IssueRef[]): Promise<Map<string, ReadItemResult | 'missing'>>;

  /** Asks the API what is left of the allowance, which every board on the account spends alike. */
  probeBudget(): Promise<RateBudget>;

  /** What the last response said, without spending anything. */
  lastBudget(): RateBudget | null;
}

export type IssueState = 'open' | 'closed';

export type IssueCloseReason = 'completed' | 'not_planned';

export type IssueSummary = {
  number: number;
  state: IssueState;
  title: string;
  url: string;
};

export type IssueCommentView = {
  id: number;
  body: string;
  url: string;
  createdAt: Date;
};

/** The issues themselves: comments, closes, and the cheap listings the audit reads. */
export interface IssueGateway {
  /** Posts a comment and answers its web address. */
  comment(ref: IssueRef, body: string): Promise<string>;

  close(ref: IssueRef, reason: IssueCloseReason): Promise<void>;

  get(ref: IssueRef): Promise<IssueSummary>;

  /** Comments written since the given moment; null means all of them. */
  listComments(ref: IssueRef, since: Date | null): Promise<IssueCommentView[]>;

  /** Open issues of `owner/name`, pull requests excluded. */
  listOpen(repo: string): Promise<IssueSummary[]>;

  /** Closed issues of `owner/name` touched since the given moment, pull requests excluded. */
  listClosedSince(repo: string, since: Date): Promise<IssueSummary[]>;

  lastBudget(): RateBudget | null;
}

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/**
 * Hands out the credential the gateways send. It is fetched lazily, so a process
 * that only reads the queue starts and answers without one, and `invalidate()`
 * drops a credential the API has rejected so the next call mints a fresh one.
 */
export interface TokenProvider {
  token(): Promise<string>;
  invalidate(): void;
}

export type LogFields = Record<string, unknown>;

/** Structured lines, with anything credential-shaped removed before it is written. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
