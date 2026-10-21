import type { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { ACTION_STATES, emptyActionCounts } from '../application/action-states.ts';
import type { ActionCounts, ActionFilter, ActionRepository, Clock, MetaWrite } from '../application/ports.ts';
import { Action } from '../domain/action.ts';
import type { ActionState } from '../domain/action.ts';
import type { BoardKey } from '../domain/board-directory.ts';
import type { CachedCatalog, CatalogField, CatalogOption, FieldCatalog } from '../domain/catalog.ts';
import { StaleAction } from '../domain/errors.ts';
import { IssueRef } from '../domain/issue-ref.ts';
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
const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;

const COLUMNS = 'id, kind, payload, repo, issue, state, attempts, not_before, origin, '
  + 'created_at, updated_at, last_error, result, blocked_reason, version, dedupe_key, ended_as';

/**
 * An action whose key another action already carries is not written: the filer
 * said this is one piece of work, and it is already in the queue.
 */
const INSERT_SQL = `INSERT INTO actions (${COLUMNS}) `
  + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING';

/**
 * Guarded by the version the aggregate was read at: when another writer has
 * touched the row in the meantime no column changes and the caller is told, so a
 * decision taken on stale facts never lands.
 */
const UPDATE_SQL = 'UPDATE actions SET kind = ?, payload = ?, repo = ?, issue = ?, state = ?, ended_as = ?, '
  + 'attempts = ?, not_before = ?, origin = ?, updated_at = ?, last_error = ?, result = ?, '
  + 'blocked_reason = ?, version = ? WHERE id = ? AND version = ?';

/**
 * The next action a worker may run, in one question.
 *
 * Actions on one issue run in the order they were filed — that is what orders a
 * comment before the close that follows it — so an action is passed over while an
 * older one on the same issue is still queued or running. Two actions filed in the
 * same millisecond are ordered by the order they were written, so neither can be
 * mistaken for the other's peer and both become claimable at once. An action that
 * names no issue is ordered against the other issue-less actions of its repository
 * only.
 */
const CLAIM_SQL = `SELECT ${COLUMNS} FROM actions AS a
WHERE a.state = 'queued'
  AND (a.not_before IS NULL OR a.not_before <= ?)
  AND NOT EXISTS (
    SELECT 1 FROM actions AS earlier
    WHERE earlier.id <> a.id
      AND earlier.repo IS a.repo
      AND earlier.issue IS a.issue
      AND earlier.state IN ('queued', 'running')
      AND (earlier.created_at < a.created_at
        OR (earlier.created_at = a.created_at AND earlier.rowid < a.rowid))
  )
ORDER BY a.created_at, a.rowid
LIMIT 1`;

/** The one waiting action a later request of the same sort may be folded into. */
const COALESCIBLE_SQL = `SELECT ${COLUMNS} FROM actions
WHERE kind = ? AND repo = ? AND issue = ? AND state = 'queued'
  AND (not_before IS NULL OR not_before <= ?)
ORDER BY created_at, rowid
LIMIT 1`;

/**
 * Folding a later request into a waiting one, as a single conditional statement.
 *
 * Three things must still hold for the merge to be the merge that was worked out.
 * The row must still be waiting, because a worker may have claimed it since it was
 * read and a whole-row write would put the values on an action already on its way
 * out. It must still be at the version the merge was computed from, or another
 * enqueuer merged into it in between and this write would drop their fields
 * without a word. And it must not have stepped into a wait, because a failure can
 * push a queued action into a backoff between the read and the write, and folding
 * a request into it would hide that request behind a delay nobody asked for.
 * No row changed means one of those stopped being true, and the caller looks again.
 */
const COALESCE_SQL = 'UPDATE actions SET payload = ?, updated_at = ?, version = version + 1 '
  + "WHERE id = ? AND state = 'queued' AND version = ? "
  + 'AND (not_before IS NULL OR not_before <= ?)';

export type SqliteActionRepositoryOptions = {
  /** Where the tick lock's timestamps come from. */
  clock?: Clock;
  /** Which processes are there, and when each started; this machine's own by default. */
  processes?: ProcessTable;
  /** How long a holder's lease may go unrenewed before the lock is taken from it. */
  lockStaleAfterMs?: number;
  /** How often a holder renews its lease while it holds the lock. */
  lockRenewEveryMs?: number;
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

    this.#db = openQueueDatabase(file);

    this.#insertStatement = this.#db.prepare(INSERT_SQL);
    this.#updateStatement = this.#db.prepare(UPDATE_SQL);
    this.#getStatement = this.#db.prepare(`SELECT ${COLUMNS} FROM actions WHERE id = ?`);
    this.#byDedupeKeyStatement = this.#db.prepare(`SELECT ${COLUMNS} FROM actions WHERE dedupe_key = ?`);
    this.#claimStatement = this.#db.prepare(CLAIM_SQL);
    this.#coalescibleStatement = this.#db.prepare(COALESCIBLE_SQL);
    this.#coalesceStatement = this.#db.prepare(COALESCE_SQL);
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

  async claimNextRunnable(now: Date): Promise<Action | null> {
    const action = this.#transact(() => {
      const row = this.#claimStatement.get(now.getTime());
      if (row === undefined) {
        return null;
      }
      const claimed = fromRow(row);
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
    return Promise.resolve(new QueuePause({ until, reason, consecutiveHits: hits }));
  }

  async setPause(pause: QueuePause | null): Promise<void> {
    if (pause === null) {
      this.#deleteStateStatement.run(PAUSE_KEY);
    } else {
      this.#writeState(PAUSE_KEY, JSON.stringify({
        until: pause.until.toISOString(),
        reason: pause.reason,
        consecutiveHits: pause.consecutiveHits,
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

  async withTickLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const taken = this.#takeTickLock();
    if (taken === null) {
      return null;
    }
    const holding = { value: taken.value };
    // The lease is renewed for as long as the work runs, so a holder that is
    // alive is never taken for one that has gone silent, however long it works.
    const renewal = setInterval(() => {
      holding.value = this.#renewTickLock(holding.value, taken.lease);
    }, this.#lockRenewEveryMs);
    renewal.unref();
    try {
      return await fn();
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

  /** The holding written again with a fresh time, while it is still ours; what is held afterwards. */
  #renewTickLock(value: string, lease: string): string {
    return this.#transact(() => {
      if (this.#readState(TICK_LOCK_KEY) !== value) {
        return value;
      }
      const renewed = this.#lockRecord(lease);
      this.#writeState(TICK_LOCK_KEY, renewed);
      return renewed;
    });
  }

  /**
   * Who holds the lock: the process, when it started and where its id counts,
   * the lease it holds it under, and when it last said it was still there.
   */
  #lockRecord(lease: string): string {
    this.#ownStart ??= this.#processes.startOf(process.pid);
    return JSON.stringify({
      pid: process.pid,
      started: this.#ownStart,
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
   * second.
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
    const started = asString(parsed['started']);
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
    dedupeKey: readOptionalText(row, 'dedupe_key'),
  });
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
