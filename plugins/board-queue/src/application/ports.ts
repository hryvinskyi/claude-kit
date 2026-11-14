/**
 * What the queue needs from the outside world, stated by the side that needs it.
 *
 * Every interface here is a promise an adapter keeps; nothing in this file knows
 * about SQL, HTTP or a process. The comments are the contract — an implementation
 * that cannot keep one of them is a bug in the adapter, not a hint for callers.
 */
import type { Action, ActionState } from '../domain/action.ts';
import type { BoardKey } from '../domain/board-directory.ts';
import type { CachedCatalog, FieldCatalog } from '../domain/catalog.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { QueuePause } from '../domain/queue-pause.ts';

export type {
  BoardGateway,
  Clock,
  IssueCloseReason,
  IssueCommentView,
  IssueGateway,
  IssueReading,
  IssueState,
  IssueSummary,
  Sleeper,
} from '../domain/ports.ts';

export type ActionFilter = {
  states?: readonly ActionState[];
  /** `owner/name`, matched case-insensitively. */
  repo?: string;
  issue?: number;
  kind?: string;
  limit?: number;
};

export type ActionCounts = Record<ActionState, number>;

/** One value of the queue's own notes, written together with the actions it belongs to. */
export type MetaWrite = {
  readonly key: string;
  readonly value: string;
};

/**
 * The queue itself. Two processes write it, so every method that changes a row
 * says how it behaves when somebody else got there first.
 */
export interface ActionRepository {
  /**
   * Writes a new action. An action whose dedupe key another action already
   * carries is not written, and the answer is false; one without a key is always
   * written.
   */
  insert(action: Action): Promise<boolean>;

  /**
   * Writes every action whose dedupe key is new, and the notes, in one
   * transaction: either all of it lands or none of it does. Answers the ids of the
   * actions that were written, in the order they were given.
   */
  insertAll(actions: readonly Action[], meta: readonly MetaWrite[]): Promise<string[]>;

  /** The action carrying this dedupe key, or null. */
  findByDedupeKey(key: string): Promise<Action | null>;

  /**
   * Writes the aggregate guarded by the version it was read at
   * (`action.persistedVersion`) and stores `action.version`. When the guard finds
   * another version nothing is written and `StaleAction` is thrown: the row was
   * changed by somebody else and this copy's decisions were taken on stale facts.
   */
  update(action: Action): Promise<void>;

  get(id: string): Promise<Action | null>;

  /**
   * The action a later request of this kind on this issue may be folded into, or
   * null: the last action filed on the issue that may still write to it (queued,
   * held, running, failed or blocked), when that one is of this kind and still
   * waiting to run (queued, and past any waiting time). An action with another one
   * filed after it that may still write is never a candidate, whatever that one's
   * kind, because the request would then run before it: a request never folds
   * past a held action either. The repository is matched case-insensitively; a
   * held or delayed action is never a candidate.
   */
  findCoalescible(kind: string, issueRef: IssueRef, now: Date): Promise<Action | null>;

  /**
   * Folds a merged payload into an action in one conditional statement, guarded by
   * the version the merge was computed from, so it can lose neither a race with a
   * worker claiming the row nor one with a second enqueuer merging into it. False
   * means the row stopped being the row the merge was about — claimed, changed by
   * somebody else, stepped into a wait, or no longer the last action on its issue
   * that may still write to it — and the caller must look again or file a new
   * action.
   */
  coalesceInto(id: string, mergedPayload: unknown, now: Date, expectedVersion: number): Promise<boolean>;

  /**
   * Takes the next action a worker may run and marks it running in the same
   * transaction, so two ticks cannot take the same one. Actions on one issue run
   * in the order they were filed: an action is not claimable while an older
   * action on the same issue is queued, running, failed or blocked. A failed or
   * blocked action keeps holding its issue until it is retried (and so queued
   * again) or cancelled; a held action holds nothing until it is released.
   * An action `passOver` names is not taken this time: it stays queued, and
   * goes on holding its issue for whatever was filed after it.
   */
  claimNextRunnable(now: Date, passOver?: (action: Action) => boolean): Promise<Action | null>;

  /** The matching actions, oldest first, so a listing reads in the order things were filed. */
  list(filter: ActionFilter): Promise<Action[]>;

  counts(): Promise<ActionCounts>;

  getPause(): Promise<QueuePause | null>;

  setPause(pause: QueuePause | null): Promise<void>;

  getMeta(key: string): Promise<string | null>;

  setMeta(key: string, value: string): Promise<void>;

  /** Forgets one of the queue's notes; a note that is not there is left as it is. */
  deleteMeta(key: string): Promise<void>;

  /** The catalog last fetched for this board, or null; each board's is kept apart from every other's. */
  getCatalog(board: BoardKey): Promise<CachedCatalog | null>;

  putCatalog(board: BoardKey, catalog: FieldCatalog, fetchedAt: Date): Promise<void>;

  /**
   * Runs the callback while holding the single tick lock, or answers null when
   * another tick holds it. A holder that is too old, or whose process is gone, is
   * not a holder: a crashed tick must not freeze the queue. The lease is renewed
   * for as long as the callback runs, and the callback is handed it, so it can ask
   * before each outward write whether the lock is still its own.
   */
  withTickLock<T>(fn: (lease: TickLease) => Promise<T>): Promise<T | null>;
}

/**
 * The tick lock as the pass holding it sees it.
 *
 * Another pass may take the lock from this one — it waited out a lease this one
 * could not renew, a suspended machine say — and this pass is not told. Whatever
 * it writes outward after that, the other pass may write too.
 */
export interface TickLease {
  /**
   * Whether the lock is still this pass's, renewing the lease when it is. Once it
   * answers false it answers false from then on: a pass that lost the lock never
   * gets it back by asking.
   */
  stillHeld(): Promise<boolean>;
}

/** Where one board's fetched catalog is kept between processes. */
export interface CatalogStore {
  get(): Promise<CachedCatalog | null>;
  put(catalog: FieldCatalog, fetchedAt: Date): Promise<void>;
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
