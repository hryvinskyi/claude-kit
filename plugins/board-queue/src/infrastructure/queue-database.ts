import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The oldest generation of readers that can read the file, kept under the key
 * every reader has always checked: a reader refuses a file that names a higher
 * one. A change of layout that older readers still read correctly leaves it alone,
 * so going back to an older release never stops the queue.
 */
export const READER_GENERATION = 1;

/** The layout this version writes; it only ever grows, and older readers never look at it. */
export const LAYOUT_REVISION = 3;

const READER_GENERATION_KEY = 'schema_version';
const LAYOUT_REVISION_KEY = 'layout_revision';

/**
 * Everything every layout has, written so that running it again over an existing
 * file changes nothing. A column or an index a later layout added is not here: an
 * older file does not have it, and creating the index over a column it lacks
 * would fail before the step that adds the column could run.
 */
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  repo TEXT,
  issue INTEGER,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  result TEXT,
  blocked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS actions_by_runnability ON actions (state, not_before);
CREATE INDEX IF NOT EXISTS actions_by_ref ON actions (repo, issue, created_at);
CREATE TABLE IF NOT EXISTS queue_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_catalog_cache (
  board TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_fetches (
  key TEXT PRIMARY KEY,
  etag TEXT,
  answer TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  issue_updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS forge_repos (
  repo TEXT PRIMARY KEY,
  cursor_at INTEGER,
  listing_etag TEXT,
  default_branch TEXT,
  default_branch_etag TEXT
);
CREATE TABLE IF NOT EXISTS forge_pulls (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  open INTEGER NOT NULL,
  reported INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS forge_pulls_open ON forge_pulls (repo, open, number);
CREATE INDEX IF NOT EXISTS forge_pulls_ended ON forge_pulls (open, reported, updated_at);
CREATE INDEX IF NOT EXISTS forge_pulls_heads ON forge_pulls (repo, head_sha, open);
CREATE TABLE IF NOT EXISTS forge_statuses (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT NOT NULL,
  description TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  PRIMARY KEY (repo, sha, context)
);
CREATE INDEX IF NOT EXISTS forge_statuses_written ON forge_statuses (written_at);
CREATE TABLE IF NOT EXISTS forge_status_writes (
  written_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS forge_status_writes_at ON forge_status_writes (written_at);
CREATE TABLE IF NOT EXISTS forge_commits (
  sha TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  full_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forge_measures (
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  branch TEXT NOT NULL,
  etag TEXT,
  measure TEXT NOT NULL,
  PRIMARY KEY (repo, base, branch)
);
`;

/** One change of layout, and the revision a file has once it is applied. */
type Step = {
  readonly to: number;
  apply(db: DatabaseSync): void;
};

/**
 * Every change of layout since the first, oldest first. Each one keeps the file
 * readable by the first generation of readers: it adds what those readers never
 * select, and stores nothing in a column they do select that they cannot read.
 *
 * A layout that only adds tables needs no step: the tables are in the base schema,
 * which runs over every file whose layout is behind, and no older reader ever
 * names them.
 */
const STEPS: readonly Step[] = [
  {
    to: 2,
    apply: (db) => {
      // A key that makes an action the one copy of a piece of work. It is nullable,
      // and SQLite counts every null as distinct, so the actions filed before it
      // existed — and every action filed without one — never collide.
      if (!hasColumn(db, 'actions', 'dedupe_key')) {
        db.exec('ALTER TABLE actions ADD COLUMN dedupe_key TEXT');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS actions_by_dedupe_key ON actions (dedupe_key)');
      // How a finished action ended, where its stored state alone says less than
      // the aggregate knows: a skipped action is stored as cancelled, an ending
      // every reader knows, and marked here.
      if (!hasColumn(db, 'actions', 'ended_as')) {
        db.exec('ALTER TABLE actions ADD COLUMN ended_as TEXT');
      }
      db.exec("UPDATE actions SET state = 'cancelled', ended_as = 'skipped' WHERE state = 'skipped'");
    },
  },
];

/** What the file says about itself, read without taking a lock. */
type Found = {
  /** The reader generation the file names, or null when it names none. */
  readonly generation: number | null;
  /** The layout revision it names, or null when it names none. */
  readonly revision: number | null;
  readonly hasActions: boolean;
};

/**
 * The queue's file, opened, brought to the layout this version writes, and kept
 * to its owner.
 *
 * Opening a file that is already up to date writes nothing and takes no lock.
 * Several processes hold this file open at once — the worker and every session —
 * so a change of layout is decided again inside one immediate transaction. Before
 * it, a file that holds actions is copied whole beside itself, once per layout
 * revision, through a directory only the owner can read, so the copy is never
 * readable by anybody else and two processes opening it at the same moment leave
 * one copy, taken before either of them changed anything.
 */
export function openQueueDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  narrowTo(file);
  // Several processes read and write this file; the log lets them do so at once,
  // and the timeout makes a writer wait for the current one instead of failing.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    const found = readFound(db);
    refuseNewer(found);
    if (isDue(found)) {
      if (found.hasActions) {
        backUpOnce(db, file);
      }
      migrate(db);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  // The log and the shared-memory file appear the moment the log is switched on
  // above, and they hold the same rows the database does.
  narrowTo(`${file}-wal`);
  narrowTo(`${file}-shm`);
  return db;
}

function migrate(db: DatabaseSync): void {
  transact(db, () => {
    const found = readFound(db);
    refuseNewer(found);
    if (!isDue(found)) {
      return;
    }
    db.exec(BASE_SCHEMA);
    const from = revisionOf(found);
    for (const step of STEPS) {
      if (from < step.to) {
        step.apply(db);
      }
    }
    // Never lower: a later layout another process wrote stays recorded.
    writeState(db, LAYOUT_REVISION_KEY, String(Math.max(from, LAYOUT_REVISION)));
    writeState(db, READER_GENERATION_KEY, String(READER_GENERATION));
  });
}

/**
 * A file this version cannot read. One exception is not refused: a file that
 * names the second generation and no revision was written by a build that
 * recorded its layout under the generation's key; its layout is this one's
 * second revision, and opening it gives the key back to the readers.
 */
function refuseNewer(found: Found): void {
  if (found.generation !== null && found.generation > READER_GENERATION && !wroteLayoutAsGeneration(found)) {
    throw new Error(
      `this queue file was written by a newer version (schema ${String(found.generation)}); `
      + `this one reads ${String(READER_GENERATION)}`,
    );
  }
}

function isDue(found: Found): boolean {
  return found.generation !== READER_GENERATION || revisionOf(found) < LAYOUT_REVISION;
}

/**
 * The layout a file is in: what it names, or the first for a file that names none.
 * A file whose layout was recorded under the generation's key is counted as the
 * first too, so every step runs over it; each step looks before it changes
 * anything, so what such a file already has is left as it is.
 */
function revisionOf(found: Found): number {
  return found.revision ?? 1;
}

function wroteLayoutAsGeneration(found: Found): boolean {
  return found.generation === 2 && found.revision === null;
}

/**
 * A whole copy of the file, taken before its layout changes. It is written into a
 * directory of its own, which only the owner can enter, and linked into place only
 * when no copy for this revision exists yet; a second process that took one in the
 * same moment, or after the first one changed the file, finds the name taken and
 * throws its own away.
 */
function backUpOnce(db: DatabaseSync, file: string): void {
  const copy = `${file}.before-layout${String(LAYOUT_REVISION)}.bak`;
  if (existsSync(copy)) {
    return;
  }
  const scratch = mkdtempSync(path.join(path.dirname(file), '.queue-backup-'));
  try {
    const taken = path.join(scratch, 'copy.db');
    db.prepare('VACUUM INTO ?').run(taken);
    chmodSync(taken, 0o600);
    try {
      linkSync(taken, copy);
    } catch (error) {
      if (!isAlreadyThere(error)) {
        throw error;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function readFound(db: DatabaseSync): Found {
  const hasState = hasTable(db, 'queue_state');
  return {
    generation: hasState ? storedNumber(db, READER_GENERATION_KEY) : null,
    revision: hasState ? storedNumber(db, LAYOUT_REVISION_KEY) : null,
    hasActions: hasTable(db, 'actions'),
  };
}

function storedNumber(db: DatabaseSync, key: string): number | null {
  const value = db.prepare('SELECT value FROM queue_state WHERE key = ?').get(key)?.['value'];
  if (typeof value !== 'string') {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`this queue file names a ${key} this version does not know (${value})`);
  }
  return number;
}

function writeState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO queue_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    !== undefined;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare('SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== undefined;
}

function transact(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Keeps a queue file to its owner. Best effort: a file that is not there yet, or
 * one somebody else owns, is not this process's to change, and refusing to open
 * the queue over its permissions would stop the work without protecting anything.
 */
export function narrowTo(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Left as it is; the directory around it is the owner's alone.
  }
}
