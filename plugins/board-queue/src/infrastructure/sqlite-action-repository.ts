import type { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { ACTION_STATES, emptyActionCounts } from '../application/action-states.ts';
import type {
  ActionCounts,
  ActionFilter,
  ActionRepository,
  Clock,
  MetaWrite,
  TickLease,
} from '../application/ports.ts';
import { z } from 'zod';
import { Action } from '../domain/action.ts';
import type { ActionProps, ActionState } from '../domain/action.ts';
import type { BoardKey } from '../domain/board-directory.ts';
import type { CachedCatalog, CatalogField, CatalogOption, FieldCatalog } from '../domain/catalog.ts';
import { StaleAction } from '../domain/errors.ts';
import { IssueRef } from '../domain/issue-ref.ts';
import { IssueOrder, ISSUE_HOLDING_STATES, STILL_TO_RUN_STATES } from '../domain/issue-order.ts';
import { QueuePause } from '../domain/queue-pause.ts';
import { randomUUID } from 'node:crypto';
import { LocalProcessTable, UNKNOWN_START } from './process-table.ts';
import type { ProcessTable } from './process-table.ts';
import { openQueueDatabase } from './queue-database.ts';
import { redactSecrets } from './redaction.ts';

const PAUSE_KEY = 'pause';
const TICK_LOCK_KEY = 'tick_lock';
/** Meta lives beside the queue's own rows, so it is kept in its own namespace. */
const META_PREFIX = 'meta:';

/**
 * A holder renews its lease this often while it holds the lock, and one whose
 * lease has gone unrenewed this long is treated as gone, wherever it runs.
 */
const LOCK_RENEW_EVERY_MS = 60 * 1000;

/** Where a lock holder writes when its process started, as `ProcessTable.startOf` words it. */
const START_MARK_KEY = 'startMark';
const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;

const COLUMNS = 'id, kind, payload, repo, issue, state, attempts, not_before, origin, '
  + 'created_at, updated_at, last_error, result, blocked_reason, version, dedupe_key, ended_as, option_wait, '
  + 'write_guard';

/**
 * An action whose key another action already carries is not written: the filer
 * said this is one piece of work, and it is already in the queue.
 */
const INSERT_SQL = `INSERT INTO actions (${COLUMNS}) `
  + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING';

/**
 * Guarded by the version the aggregate was read at: when another writer has
 * touched the row in the meantime no column changes and the caller is told, so a
 * decision taken on stale facts never lands.
 */
const UPDATE_SQL = 'UPDATE actions SET kind = ?, payload = ?, repo = ?, issue = ?, state = ?, ended_as = ?, '
  + 'attempts = ?, not_before = ?, origin = ?, updated_at = ?, last_error = ?, result = ?, '
  + 'blocked_reason = ?, option_wait = ?, write_guard = ?, version = ? WHERE id = ? AND version = ?';

/**
 * The actions a worker may run next, oldest first.
 *
 * Actions on one issue run in the order they were filed — that is what orders a
 * comment before the close that follows it — so an action is passed over while an
 * older one on the same issue is in a state that holds the issue: queued, running,
 * or stopped as failed or blocked until a person retries or cancels it. An older
 * action its filer deferred to a date still to come — queued, never run — is left
 * out of this question: whether it holds back a later one depends on what each
 * writes, which `IssueOrder` decides over the rows `deferredBeforeSql` reads. Two
 * actions filed in the same millisecond are ordered by the order they were
 * written, so neither can be mistaken for the other's peer and both become
 * claimable at once. Actions that name no issue are ordered against each other
 * only.
 *
 * Built when a repository opens rather than when the module loads, because the
 * holding states are spelled through the stored-state table further down.
 */
const claimCandidatesSql = (): string => `SELECT ${COLUMNS}, a.rowid AS seq FROM actions AS a
WHERE a.state = 'queued'
  AND (a.not_before IS NULL OR a.not_before <= :now)
  AND NOT EXISTS (
    SELECT 1 FROM actions AS earlier
    WHERE earlier.id <> a.id
      AND earlier.repo IS a.repo
      AND earlier.issue IS a.issue
      AND ${storedIn('earlier', ISSUE_HOLDING_STATES)}
      AND (earlier.created_at < a.created_at
        OR (earlier.created_at = a.created_at AND earlier.rowid < a.rowid))
      AND NOT (${deferredAt('earlier')})
  )
ORDER BY a.created_at, a.rowid`;

/** The deferred actions filed before one action on its issue, which `IssueOrder` weighs against it. */
const deferredBeforeSql = (): string => `SELECT ${COLUMNS} FROM actions AS earlier
WHERE earlier.repo IS :repo
  AND earlier.issue IS :issue
  AND ${deferredAt('earlier')}
  AND (earlier.created_at < :createdAt OR (earlier.created_at = :createdAt AND earlier.rowid < :seq))`;

/** That the row is deferred by its filer at `:now`, as `isDeferred` reads an action. */
const deferredAt = (alias: string): string => `${storedIn(alias, ['queued'])}
        AND ${alias}.attempts = 0
        AND ${alias}.not_before IS NOT NULL
        AND ${alias}.not_before > :now`;

/**
 * That no action which may still write to the issue — held ones included — was
 * filed after the row the alias names. A request folded into that row runs at its
 * place in the line, so one filed after it would otherwise land its older values
 * over the request's.
 */
const nothingFiledAfter = (alias: string): string => `NOT EXISTS (
    SELECT 1 FROM actions AS later
    WHERE later.id <> ${alias}.id
      AND later.repo IS ${alias}.repo
      AND later.issue IS ${alias}.issue
      AND ${storedIn('later', STILL_TO_RUN_STATES)}
      AND (later.created_at > ${alias}.created_at
        OR (later.created_at = ${alias}.created_at AND later.rowid > ${alias}.rowid))
  )`;

/**
 * The one waiting action a later request of the same sort may be folded into: the
 * last action on the issue that may still write to it, when that one is of this
 * sort and is waiting to run.
 */
const coalescibleSql = (): string => `SELECT ${COLUMNS} FROM actions AS a
WHERE a.kind = ? AND a.repo = ? AND a.issue = ? AND a.state = 'queued'
  AND (a.not_before IS NULL OR a.not_before <= ?)
  AND ${nothingFiledAfter('a')}
ORDER BY a.created_at DESC, a.rowid DESC
LIMIT 1`;

/**
 * Folding a later request into a waiting one, as a single conditional statement.
 *
 * Four things must still hold for the merge to be the merge that was worked out.
 * The row must still be waiting, because a worker may have claimed it since it was
 * read and a whole-row write would put the values on an action already on its way
 * out. It must still be at the version the merge was computed from, or another
 * enqueuer merged into it in between and this write would drop their fields
 * without a word. It must not have stepped into a wait, because a failure can
 * push a queued action into a backoff between the read and the write, and folding
 * a request into it would hide that request behind a delay nobody asked for. And
 * it must still be the last action on its issue that may still write to it,
 * because another filer may have added one behind it since — held or not — which
 * would then run after the request's values.
 * No row changed means one of those stopped being true, and the caller looks again.
 */
const coalesceSql = (): string => 'UPDATE actions SET payload = ?, updated_at = ?, version = version + 1 '
  + "WHERE id = ? AND state = 'queued' AND version = ? "
  + `AND (not_before IS NULL OR not_before <= ?) AND ${nothingFiledAfter('actions')}`;

export type SqliteActionRepositoryOptions = {
  /** Where the tick lock's timestamps come from. */
  clock?: Clock;
  /** Which processes are there, and when each started; this machine's own by default. */
  processes?: ProcessTable;
  /** How long a holder's lease may go unrenewed before the lock is taken from it. */
  lockStaleAfterMs?: number;
  /** How often a holder renews its lease while it holds the lock. */
  lockRenewEveryMs?: number;
  /**
   * The order of an issue's actions. Without one, every kind is unknown to it, so
   * a deferred action holds back everything filed after it on its issue.
   */
  issueOrder?: IssueOrder;
};

/**
 * The queue, on a local database file.
 *
 * Everything that decides a race — claiming, coalescing, taking the tick lock —
 * happens inside one immediate transaction, because the worker and every editor
 * session hold this same file open at once. Rows never leave this file as rows:
 * they become aggregates on the way out and columns on the way in.
 */
export class SqliteActionRepository implements ActionRepository {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #processes: ProcessTable;
  readonly #lockStaleAfterMs: number;
  readonly #lockRenewEveryMs: number;
  #ownStart: string | null = null;

  readonly #insertStatement: StatementSync;
  readonly #updateStatement: StatementSync;
  readonly #getStatement: StatementSync;
  readonly #byDedupeKeyStatement: StatementSync;
  readonly #claimStatement: StatementSync;
  readonly #deferredBeforeStatement: StatementSync;
  readonly #order: IssueOrder;
  readonly #coalescibleStatement: StatementSync;
  readonly #coalesceStatement: StatementSync;
  readonly #countsStatement: StatementSync;
  readonly #readStateStatement: StatementSync;
  readonly #writeStateStatement: StatementSync;
  readonly #deleteStateStatement: StatementSync;
  readonly #releaseLockStatement: StatementSync;
  readonly #readCatalogStatement: StatementSync;
  readonly #writeCatalogStatement: StatementSync;

  constructor(file: string, options: SqliteActionRepositoryOptions = {}) {
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#processes = options.processes ?? new LocalProcessTable();
    this.#lockStaleAfterMs = options.lockStaleAfterMs ?? LOCK_STALE_AFTER_MS;
    this.#lockRenewEveryMs = options.lockRenewEveryMs ?? LOCK_RENEW_EVERY_MS;
    this.#order = options.issueOrder ?? new IssueOrder([]);

    this.#db = openQueueDatabase(file);

    this.#insertStatement = this.#db.prepare(INSERT_SQL);
    this.#updateStatement = this.#db.prepare(UPDATE_SQL);
    this.#getStatement = this.#db.prepare(`SELECT ${COLUMNS} FROM actions WHERE id = ?`);
    this.#byDedupeKeyStatement = this.#db.prepare(`SELECT ${COLUMNS} FROM actions WHERE dedupe_key = ?`);
    this.#claimStatement = this.#db.prepare(claimCandidatesSql());
    this.#deferredBeforeStatement = this.#db.prepare(deferredBeforeSql());
    this.#coalescibleStatement = this.#db.prepare(coalescibleSql());
    this.#coalesceStatement = this.#db.prepare(coalesceSql());
    this.#countsStatement = this.#db.prepare(
      'SELECT state, ended_as, COUNT(*) AS total FROM actions GROUP BY state, ended_as',
    );
    this.#readStateStatement = this.#db.prepare('SELECT value FROM queue_state WHERE key = ?');
    this.#writeStateStatement = this.#db.prepare(
      'INSERT INTO queue_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.#deleteStateStatement = this.#db.prepare('DELETE FROM queue_state WHERE key = ?');
    this.#releaseLockStatement = this.#db.prepare('DELETE FROM queue_state WHERE key = ? AND value = ?');
    this.#readCatalogStatement = this.#db.prepare('SELECT fetched_at, json FROM board_catalog_cache WHERE board = ?');
    this.#writeCatalogStatement = this.#db.prepare(
      'INSERT INTO board_catalog_cache (board, fetched_at, json) VALUES (?, ?, ?) '
      + 'ON CONFLICT(board) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json',
    );
  }

  close(): void {
    this.#db.close();
  }

  async insert(action: Action): Promise<boolean> {
    const inserted = this.#write(action);
    if (inserted) {
      action.markPersisted();
    }
    return Promise.resolve(inserted);
  }

  async insertAll(actions: readonly Action[], meta: readonly MetaWrite[]): Promise<string[]> {
    const inserted = this.#transact(() => {
      const written: Action[] = [];
      for (const action of actions) {
        if (this.#write(action)) {
          written.push(action);
        }
      }
      for (const entry of meta) {
        this.#writeState(META_PREFIX + entry.key, entry.value);
      }
      return written;
    });
    for (const action of inserted) {
      action.markPersisted();
    }
    return Promise.resolve(inserted.map((action) => action.id));
  }

  async findByDedupeKey(key: string): Promise<Action | null> {
    const row = this.#byDedupeKeyStatement.get(key);
    return Promise.resolve(row === undefined ? null : fromRow(row));
  }

  async update(action: Action): Promise<void> {
    if (this.#writeGuarded(action) === 0) {
      throw new StaleAction(action.id, action.persistedVersion);
    }
    action.markPersisted();
    return Promise.resolve();
  }

  async get(id: string): Promise<Action | null> {
    const row = this.#getStatement.get(id);
    return Promise.resolve(row === undefined ? null : fromRow(row));
  }

  async findCoalescible(kind: string, issueRef: IssueRef, now: Date): Promise<Action | null> {
    const row = this.#coalescibleStatement.get(
      kind,
      issueRef.repoFullName().toLowerCase(),
      issueRef.number,
      now.getTime(),
    );
    return Promise.resolve(row === undefined ? null : fromRow(row));
  }

  async coalesceInto(
    id: string,
    mergedPayload: unknown,
    now: Date,
    expectedVersion: number,
  ): Promise<boolean> {
    const changed = this.#transact(() => changeCount(this.#coalesceStatement.run(
      encodePayload(mergedPayload),
      now.getTime(),
      id,
      expectedVersion,
      now.getTime(),
    )));
    return Promise.resolve(changed > 0);
  }

  async claimNextRunnable(now: Date, passOver?: (action: Action) => boolean): Promise<Action | null> {
    const action = this.#transact(() => {
      const claimed = this.#nextRunnable(now, passOver ?? (() => false));
      if (claimed === null) {
        return null;
      }
      claimed.start(now);
      if (this.#writeGuarded(claimed) === 0) {
        throw new StaleAction(claimed.id, claimed.persistedVersion);
      }
      return claimed;
    });
    if (action !== null) {
      action.markPersisted();
    }
    return Promise.resolve(action);
  }

  /** The oldest action no older one on its issue holds back, deferred ones included, and not passed over. */
  #nextRunnable(now: Date, passOver: (action: Action) => boolean): Action | null {
    for (const row of this.#claimStatement.all({ now: now.getTime() })) {
      const candidate = fromRow(row);
      if (passOver(candidate)) {
        continue;
      }
      const deferred = this.#deferredBeforeStatement.all({
        now: now.getTime(),
        repo: readOptionalText(row, 'repo'),
        issue: readOptionalInteger(row, 'issue'),
        createdAt: readInteger(row, 'created_at'),
        seq: readInteger(row, 'seq'),
      }).map(fromRow);
      if (!deferred.some((earlier) => this.#order.holdsBack(earlier, candidate, now))) {
        return candidate;
      }
    }
    return null;
  }

  async list(filter: ActionFilter): Promise<Action[]> {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    // An empty list of states is no preference, the same as naming none at all.
    if (filter.states !== undefined && filter.states.length > 0) {
      conditions.push(`(${filter.states.map(() => '(state = ? AND ended_as IS ?)').join(' OR ')})`);
      for (const state of filter.states) {
        params.push(STORED_AS[state].state, STORED_AS[state].endedAs);
      }
    }
    if (filter.repo !== undefined) {
      conditions.push('repo = ?');
      params.push(filter.repo.trim().toLowerCase());
    }
    if (filter.issue !== undefined) {
      conditions.push('issue = ?');
      params.push(filter.issue);
    }
    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const limit = filter.limit === undefined ? '' : ' LIMIT ?';
    if (filter.limit !== undefined) {
      params.push(filter.limit);
    }
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM actions${where} ORDER BY created_at, rowid${limit}`)
      .all(...params);
    return Promise.resolve(rows.map(fromRow));
  }

  async counts(): Promise<ActionCounts> {
    const counts = emptyActionCounts();
    for (const row of this.#countsStatement.all()) {
      const state = stateOf(readText(row, 'state'), readOptionalText(row, 'ended_as'));
      if (state !== null) {
        counts[state] += readInteger(row, 'total');
      }
    }
    return Promise.resolve(counts);
  }

  async getPause(): Promise<QueuePause | null> {
    const raw = this.#readState(PAUSE_KEY);
    if (raw === null) {
      return Promise.resolve(null);
    }
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) {
      return Promise.resolve(null);
    }
    const until = asDate(parsed['until']);
    const reason = asString(parsed['reason']);
    const hits = asNumber(parsed['consecutiveHits']);
    if (until === null || reason === null || hits === null) {
      return Promise.resolve(null);
    }
    // A note that names no cause reads as a limiter's wait.
    const cause = parsed['cause'] === 'credential' ? 'credential' : 'limit';
    return Promise.resolve(new QueuePause({ until, reason, consecutiveHits: hits, cause }));
  }

  async setPause(pause: QueuePause | null): Promise<void> {
    if (pause === null) {
      this.#deleteStateStatement.run(PAUSE_KEY);
    } else {
      this.#writeState(PAUSE_KEY, JSON.stringify({
        until: pause.until.toISOString(),
        reason: pause.reason,
        consecutiveHits: pause.consecutiveHits,
        cause: pause.cause,
      }));
    }
    return Promise.resolve();
  }

  async getMeta(key: string): Promise<string | null> {
    return Promise.resolve(this.#readState(META_PREFIX + key));
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#writeState(META_PREFIX + key, value);
    return Promise.resolve();
  }

  async deleteMeta(key: string): Promise<void> {
    this.#deleteStateStatement.run(META_PREFIX + key);
    return Promise.resolve();
  }

  async getCatalog(board: BoardKey): Promise<CachedCatalog | null> {
    const row = this.#readCatalogStatement.get(board);
    if (row === undefined) {
      return Promise.resolve(null);
    }
    const catalog = asFieldCatalog(parseJson(readText(row, 'json')));
    if (catalog === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ fetchedAt: new Date(readInteger(row, 'fetched_at')), catalog });
  }

  async putCatalog(board: BoardKey, catalog: FieldCatalog, fetchedAt: Date): Promise<void> {
    this.#writeCatalogStatement.run(board, fetchedAt.getTime(), JSON.stringify(catalog));
    return Promise.resolve();
  }

  async withTickLock<T>(fn: (lease: TickLease) => Promise<T>): Promise<T | null> {
    const taken = this.#takeTickLock();
    if (taken === null) {
      return null;
    }
    const holding = { value: taken.value, lost: false };
    const stillHeld = (): boolean => {
      if (holding.lost) {
        return false;
      }
      const renewed = this.#renewTickLock(holding.value, taken.lease);
      if (renewed === null) {
        holding.lost = true;
        return false;
      }
      holding.value = renewed;
      return true;
    };
    // The lease is renewed for as long as the work runs, so a holder that is
    // alive is never taken for one that has gone silent, however long it works.
    const renewal = setInterval(stillHeld, this.#lockRenewEveryMs);
    renewal.unref();
    try {
      return await fn({ stillHeld: () => Promise.resolve(stillHeld()) });
    } finally {
      clearInterval(renewal);
      // Only our own holding is released: a tick that took the lock from us
      // because we looked dead keeps it.
      this.#releaseLockStatement.run(TICK_LOCK_KEY, holding.value);
    }
  }

  #takeTickLock(): { value: string; lease: string } | null {
    return this.#transact(() => {
      const current = this.#readState(TICK_LOCK_KEY);
      if (current !== null && this.#lockIsHeld(current)) {
        return null;
      }
      const lease = randomUUID();
      const value = this.#lockRecord(lease);
      this.#writeState(TICK_LOCK_KEY, value);
      return { value, lease };
    });
  }

  /**
   * The holding written again with a fresh time, while it is still ours; what is
   * held afterwards, or null once another pass has written its own over it.
   */
  #renewTickLock(value: string, lease: string): string | null {
    return this.#transact(() => {
      if (this.#readState(TICK_LOCK_KEY) !== value) {
        return null;
      }
      const renewed = this.#lockRecord(lease);
      this.#writeState(TICK_LOCK_KEY, renewed);
      return renewed;
    });
  }

  /**
   * Who holds the lock: the process, when it started and where its id counts,
   * the lease it holds it under, and when it last said it was still there.
   *
   * The start is written under a key of its own, in the spelling every reader
   * of this version reads alike whatever its language or time zone. The key
   * releases before it read, `started`, held the start as the reading process's
   * own locale spelled it; such a release compares that key with its own reading
   * and takes the lock from a holder whose spelling differs from its own. With
   * the key left out it does what it does for a holder that never said when it
   * started: it waits for the holder's process to end or its lease to lapse.
   */
  #lockRecord(lease: string): string {
    this.#ownStart ??= this.#processes.startOf(process.pid);
    return JSON.stringify({
      pid: process.pid,
      [START_MARK_KEY]: this.#ownStart,
      where: this.#processes.here(),
      lease,
      at: this.#clock.now().toISOString(),
    });
  }

  /**
   * A holder counts while its lease is fresh and it is still the process that
   * took the lock. Where its id counts in the same place as ours, that is
   * checked: a process that is gone, or an id now carried by a process that
   * started at another time — a restarted container hands out the same ids
   * again — is no holder. A holder counted somewhere else cannot be looked up
   * from here, so its lease alone decides. A tick that was killed mid-run must
   * not keep the queue frozen, and one that is alive must not lose the lock to a
   * second. A holder written by a release before this one says when it started
   * only in its own locale's words, which cannot be compared with a reading
   * here, so it is taken as a holder whose start is unknown.
   */
  #lockIsHeld(raw: string): boolean {
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) {
      return false;
    }
    const pid = asNumber(parsed['pid']);
    const at = asDate(parsed['at']);
    if (pid === null || at === null) {
      return false;
    }
    if (this.#clock.now().getTime() - at.getTime() >= this.#lockStaleAfterMs) {
      return false;
    }
    const where = asString(parsed['where']);
    if (where !== null && where !== this.#processes.here()) {
      return true;
    }
    const seen = this.#processes.startOf(pid);
    if (seen === null) {
      return false;
    }
    const started = asString(parsed[START_MARK_KEY]);
    return started === null || started === UNKNOWN_START || seen === UNKNOWN_START || seen === started;
  }

  /** Writes a new row and answers whether it was written, rather than found under its key. */
  #write(action: Action): boolean {
    const row = toRow(action);
    return changeCount(this.#insertStatement.run(
      row.id,
      row.kind,
      row.payload,
      row.repo,
      row.issue,
      row.state,
      row.attempts,
      row.not_before,
      row.origin,
      row.created_at,
      row.updated_at,
      row.last_error,
      row.result,
      row.blocked_reason,
      row.version,
      row.dedupe_key,
      row.ended_as,
      row.option_wait,
      row.write_guard,
    )) > 0;
  }

  #writeGuarded(action: Action): number {
    const row = toRow(action);
    return changeCount(this.#updateStatement.run(
      row.kind,
      row.payload,
      row.repo,
      row.issue,
      row.state,
      row.ended_as,
      row.attempts,
      row.not_before,
      row.origin,
      row.updated_at,
      row.last_error,
      row.result,
      row.blocked_reason,
      row.option_wait,
      row.write_guard,
      row.version,
      row.id,
      action.persistedVersion,
    ));
  }

  #readState(key: string): string | null {
    const row = this.#readStateStatement.get(key);
    return row === undefined ? null : readText(row, 'value');
  }

  #writeState(key: string, value: string): void {
    this.#writeStateStatement.run(key, value);
  }

  /** Everything that must not lose a race runs inside one write transaction. */
  #transact<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const outcome = fn();
      this.#db.exec('COMMIT');
      return outcome;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** A state as a row holds it: a state every reader of the file knows, and how it ended where that says less. */
type StoredState = {
  readonly state: string;
  readonly endedAs: string | null;
};

/**
 * How each state is stored. Every state an older reader of this file knows is
 * stored as itself; a skipped action is stored as cancelled — an ending every
 * reader knows, which nothing retries — and marked, so an older reader lists it
 * as finished and this one reads it back as skipped.
 */
const STORED_AS: { readonly [S in ActionState]: StoredState } = {
  queued: { state: 'queued', endedAs: null },
  held: { state: 'held', endedAs: null },
  running: { state: 'running', endedAs: null },
  done: { state: 'done', endedAs: null },
  failed: { state: 'failed', endedAs: null },
  blocked: { state: 'blocked', endedAs: null },
  skipped: { state: 'cancelled', endedAs: 'skipped' },
  cancelled: { state: 'cancelled', endedAs: null },
};

/**
 * A condition that a row of the given alias is in one of these states, spelled
 * as they are stored. The states are this program's own constants, never input,
 * so they are written into the statement as literals.
 */
function storedIn(alias: string, states: readonly ActionState[]): string {
  const each = states.map((state) => {
    const stored = STORED_AS[state];
    const endedAs = stored.endedAs === null ? 'IS NULL' : `= '${stored.endedAs}'`;
    return `(${alias}.state = '${stored.state}' AND ${alias}.ended_as ${endedAs})`;
  });
  return `(${each.join(' OR ')})`;
}

/** The state a stored row stands for, or null when it stands for none this version knows. */
function stateOf(state: string, endedAs: string | null): ActionState | null {
  for (const candidate of ACTION_STATES) {
    const stored = STORED_AS[candidate];
    if (stored.state === state && stored.endedAs === endedAs) {
      return candidate;
    }
  }
  return null;
}

type ActionRow = {
  id: string;
  kind: string;
  payload: string;
  repo: string | null;
  issue: number | null;
  state: string;
  attempts: number;
  not_before: number | null;
  origin: string;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  result: string | null;
  blocked_reason: string | null;
  version: number;
  dedupe_key: string | null;
  ended_as: string | null;
  option_wait: string | null;
  write_guard: string | null;
};

/**
 * The aggregate as columns.
 *
 * The repository is stored folded to lower case because that is what every match
 * compares; the spelling a person reads stays in the payload, which is the text
 * the caller filed.
 */
function toRow(action: Action): ActionRow {
  const props = action.props();
  const stored = STORED_AS[props.state];
  return {
    id: props.id,
    kind: props.kind,
    payload: encodePayload(props.payload),
    repo: props.issueRef === null ? null : props.issueRef.repoFullName().toLowerCase(),
    issue: props.issueRef === null ? null : props.issueRef.number,
    state: stored.state,
    ended_as: stored.endedAs,
    attempts: props.attempts,
    not_before: props.notBefore === null ? null : props.notBefore.getTime(),
    origin: props.origin,
    created_at: props.createdAt.getTime(),
    updated_at: props.updatedAt.getTime(),
    // The two columns that quote what came back from outside: an error the API
    // wrote, and the summary of what a kind did. Either can carry a credential
    // that was echoed into a message, and this row is read by every listing.
    last_error: props.lastError === null ? null : redactSecrets(props.lastError),
    result: props.result === null ? null : redactSecrets(props.result),
    blocked_reason: props.blockedReason,
    option_wait: encodeOptionWait(props),
    write_guard: encodeWriteGuard(props),
    version: props.version,
    dedupe_key: props.dedupeKey,
  };
}

function fromRow(row: Record<string, SQLOutputValue>): Action {
  const payload = parseJson(readText(row, 'payload'));
  const repo = readOptionalText(row, 'repo');
  const issue = readOptionalInteger(row, 'issue');
  const storedState = readText(row, 'state');
  const state = stateOf(storedState, readOptionalText(row, 'ended_as'));
  if (state === null) {
    throw new Error(`the queue holds an action in the unknown state "${storedState}"`);
  }
  return new Action({
    id: readText(row, 'id'),
    kind: readText(row, 'kind'),
    payload,
    issueRef: repo === null || issue === null ? null : IssueRef.of(displayRepo(payload, repo), issue),
    state,
    attempts: readInteger(row, 'attempts'),
    notBefore: readOptionalMoment(row, 'not_before'),
    origin: readText(row, 'origin'),
    createdAt: new Date(readInteger(row, 'created_at')),
    updatedAt: new Date(readInteger(row, 'updated_at')),
    lastError: readOptionalText(row, 'last_error'),
    result: readOptionalText(row, 'result'),
    version: readInteger(row, 'version'),
    blockedReason: readOptionalText(row, 'blocked_reason'),
    ...optionWaitOf(readOptionalText(row, 'option_wait'), readInteger(row, 'version')),
    writeGuard: writeGuardOf(readOptionalText(row, 'write_guard'), readInteger(row, 'version')),
    dedupeKey: readOptionalText(row, 'dedupe_key'),
  });
}

/**
 * What an action blocked for a missing option waits for, as it is stored: the
 * record and the row version it was written at.
 *
 * Releases that came before this record share the file and never touch the
 * column, but every write they make moves the version on. A record whose version
 * is not the row's was therefore left behind by such a write — a retry, a block
 * for another value — and describes a block that is over; it reads as no record,
 * and the action waits for a person, as it did before the record existed.
 */
const StoredReading = z.object({ name: z.string(), optionId: z.string().nullable() });

const StoredOptionWait = z.object({
  at: z.number().int(),
  missing: z.array(z.string()).min(1),
  row: z.record(z.string(), StoredReading).nullable(),
});

type OptionWaitProps = Pick<ActionProps, 'missingOptions' | 'rowAtBlock'>;

const NO_OPTION_WAIT: OptionWaitProps = { missingOptions: [], rowAtBlock: null };

function encodeOptionWait(props: ActionProps): string | null {
  if (props.missingOptions.length === 0) {
    return null;
  }
  return JSON.stringify({
    at: props.version,
    missing: [...props.missingOptions],
    row: props.rowAtBlock,
  } satisfies z.infer<typeof StoredOptionWait>);
}

/** The stored record, or none when it is absent, unreadable, or older than the row it sits in. */
function optionWaitOf(stored: string | null, version: number): OptionWaitProps {
  if (stored === null) {
    return NO_OPTION_WAIT;
  }
  const parsed = StoredOptionWait.safeParse(parseJson(stored));
  if (!parsed.success || parsed.data.at !== version) {
    return NO_OPTION_WAIT;
  }
  return { missingOptions: parsed.data.missing, rowAtBlock: parsed.data.row };
}

/**
 * The guard a release set, as it is stored: the readings and the row version they
 * were written at. Releases before the guard existed never touch the column, so
 * an action they run writes unguarded, as they always did; any write they make
 * moves the version on — a merge folded into the action included — and a guard
 * whose version is not the row's reads as none, because the values it guarded may
 * no longer be the ones the action carries.
 */
const StoredWriteGuard = z.object({
  at: z.number().int(),
  guard: z.record(z.string(), StoredReading),
});

function encodeWriteGuard(props: ActionProps): string | null {
  if (props.writeGuard === null) {
    return null;
  }
  const stored = { at: props.version, guard: { ...props.writeGuard } } satisfies z.infer<typeof StoredWriteGuard>;
  return JSON.stringify(stored);
}

function writeGuardOf(stored: string | null, version: number): ActionProps['writeGuard'] {
  if (stored === null) {
    return null;
  }
  const parsed = StoredWriteGuard.safeParse(parseJson(stored));
  return parsed.success && parsed.data.at === version ? parsed.data.guard : null;
}

/** The spelling the caller filed, when the payload still carries the same repository. */
function displayRepo(payload: unknown, stored: string): string {
  if (isRecord(payload)) {
    const spelled = asString(payload['repo']);
    if (spelled !== null && spelled.toLowerCase() === stored) {
      return spelled;
    }
  }
  return stored;
}

function encodePayload(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

/** SQLite counts rows as a number here and as a bigint when asked to; both are rows. */
function changeCount(result: { changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

function readText(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`the column "${column}" does not hold text`);
  }
  return value;
}

function readOptionalText(row: Record<string, SQLOutputValue>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  return readText(row, column);
}

function readInteger(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value !== 'number') {
    throw new Error(`the column "${column}" does not hold a number`);
  }
  return value;
}

function readOptionalInteger(row: Record<string, SQLOutputValue>, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  return readInteger(row, column);
}

function readOptionalMoment(row: Record<string, SQLOutputValue>, column: string): Date | null {
  const value = readOptionalInteger(row, column);
  return value === null ? null : new Date(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === null) {
    return null;
  }
  const moment = new Date(text);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/**
 * The cached catalog, read the way anything that came from outside this run is
 * read: checked rather than trusted. A cache this cannot make sense of is no
 * cache, and the worker fetches a fresh one.
 */
function asFieldCatalog(value: unknown): FieldCatalog | null {
  if (!isRecord(value)) {
    return null;
  }
  const projectId = asString(value['projectId']);
  const rawFields = value['fields'];
  if (projectId === null || !Array.isArray(rawFields)) {
    return null;
  }
  const fields: CatalogField[] = [];
  for (const rawField of rawFields) {
    const field = asCatalogField(rawField);
    if (field === null) {
      return null;
    }
    fields.push(field);
  }
  return { projectId, fields };
}

function asCatalogField(value: unknown): CatalogField | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value['id']);
  const name = asString(value['name']);
  const dataType = asString(value['dataType']);
  const rawOptions = value['options'];
  if (id === null || name === null || dataType === null || !Array.isArray(rawOptions)) {
    return null;
  }
  const options: CatalogOption[] = [];
  for (const rawOption of rawOptions) {
    if (!isRecord(rawOption)) {
      return null;
    }
    const optionId = asString(rawOption['id']);
    const optionName = asString(rawOption['name']);
    if (optionId === null || optionName === null) {
      return null;
    }
    options.push({ id: optionId, name: optionName });
  }
  return { id, name, dataType, options };
}
