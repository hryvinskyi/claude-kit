import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { Action } from '../../src/domain/action.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';

const FIRST = 'example-org/first-repo';
const BASE = new Date('2026-01-01T09:00:00.000Z');
const BACKUP = 'queue.db.before-layout2.bak';

/** The layout the first release wrote, exactly as it wrote it. */
const FIRST_LAYOUT = `
CREATE TABLE actions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, repo TEXT, issue INTEGER,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER, origin TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT, result TEXT,
  blocked_reason TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX actions_by_runnability ON actions (state, not_before);
CREATE INDEX actions_by_ref ON actions (repo, issue, created_at);
CREATE TABLE queue_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE board_catalog_cache (board TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL);
INSERT INTO queue_state (key, value) VALUES ('schema_version', '1');
INSERT INTO queue_state (key, value) VALUES ('meta:lastTickAt', '2026-01-01T08:55:00.000Z');
INSERT INTO actions (id, kind, payload, repo, issue, state, attempts, origin, created_at, updated_at, version)
VALUES ('old-1', 'board.set-fields', '{"repo":"example-org/first-repo","issue":12,"fields":{"severity":"S2"}}',
        'example-org/first-repo', 12, 'queued', 0, 'a session', 1767254400000, 1767254400000, 1);
`;

/**
 * A file a build wrote that recorded its layout under the generation's key: the
 * dedupe key, the generation set to 2, and a skipped action stored by its own name.
 */
const LAYOUT_AS_GENERATION = `
ALTER TABLE actions ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX actions_by_dedupe_key ON actions (dedupe_key);
UPDATE queue_state SET value = '2' WHERE key = 'schema_version';
INSERT INTO actions (id, kind, payload, repo, issue, state, attempts, origin, created_at, updated_at, version, result)
VALUES ('skipped-1', 'board.set-fields', '{"repo":"example-org/first-repo","issue":13,"fields":{"status":"Todo"}}',
        'example-org/first-repo', 13, 'skipped', 1, 'a mirror', 1767254400000, 1767254400000, 3, 'left as it is');
`;

function directory(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-schema-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fileIn(dir: string, ...scripts: readonly string[]): string {
  const file = path.join(dir, 'queue.db');
  const db = new DatabaseSync(file);
  for (const script of scripts) {
    db.exec(script);
  }
  db.close();
  return file;
}

function opened(t: TestContext, file: string): SqliteActionRepository {
  const repository = new SqliteActionRepository(file, { clock: new FakeClock('2026-03-02T09:00:00.000Z') });
  t.after(() => {
    repository.close();
  });
  return repository;
}

function keyed(id: string, dedupeKey: string | null, issue = 12): Action {
  return Action.enqueue({
    id,
    kind: 'board.set-fields',
    payload: { repo: FIRST, issue, fields: { severity: 'S2' } },
    issueRef: IssueRef.of(FIRST, issue),
    origin: 'a test',
    now: BASE,
    dedupeKey,
  });
}

function stateKey(file: string, key: string): string | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const value = db.prepare('SELECT value FROM queue_state WHERE key = ?').get(key)?.['value'];
    return typeof value === 'string' ? value : null;
  } finally {
    db.close();
  }
}

function backupsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.bak'));
}

describe('a queue file of the first layout', () => {
  it('is copied whole beside itself, readable by its owner alone, before anything in it changes', (t) => {
    const dir = directory(t);
    const file = fileIn(dir, FIRST_LAYOUT);

    opened(t, file);

    assert.deepEqual(backupsIn(dir), [BACKUP]);
    assert.equal(fs.statSync(path.join(dir, BACKUP)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.queue-backup-')), []);
    const copy = new DatabaseSync(path.join(dir, BACKUP), { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT COUNT(*) AS rows FROM actions').get()?.['rows'], 1);
      const columns = copy.prepare('SELECT name FROM pragma_table_info(?)').all('actions').map((row) => row['name']);
      assert.equal(columns.includes('dedupe_key'), false, 'the copy is the file as it was');
    } finally {
      copy.close();
    }
  });

  it('keeps the generation older readers check, and records its layout apart', (t) => {
    const file = fileIn(directory(t), FIRST_LAYOUT);

    opened(t, file);

    assert.equal(stateKey(file, 'schema_version'), '1');
    assert.equal(stateKey(file, 'layout_revision'), '2');
  });

  it('keeps every action and note it held, and reads them as before', async (t) => {
    const repository = opened(t, fileIn(directory(t), FIRST_LAYOUT));

    const old = await repository.get('old-1');
    assert.equal(old?.state, 'queued');
    assert.equal(old?.dedupeKey, null);
    assert.equal(await repository.getMeta('lastTickAt'), '2026-01-01T08:55:00.000Z');
  });

  it('takes a dedupe key afterwards, and refuses a second action under the same one', async (t) => {
    const repository = opened(t, fileIn(directory(t), FIRST_LAYOUT));

    assert.equal(await repository.insert(keyed('a', 'dibs:one')), true);
    assert.equal(await repository.insert(keyed('b', 'dibs:one', 13)), false);
    assert.equal(await repository.insert(keyed('c', null)), true);
    assert.equal(await repository.insert(keyed('d', null)), true);

    assert.equal((await repository.findByDedupeKey('dibs:one'))?.id, 'a');
    assert.deepEqual((await repository.list({})).map((action) => action.id), ['old-1', 'a', 'c', 'd']);
  });

  it('is copied once however often it is opened', (t) => {
    const dir = directory(t);
    const file = fileIn(dir, FIRST_LAYOUT);
    opened(t, file);
    opened(t, file);

    assert.deepEqual(backupsIn(dir), [BACKUP]);
  });

  it('keeps the first copy when a second opener finds the change already decided', (t) => {
    const dir = directory(t);
    const file = fileIn(dir, FIRST_LAYOUT);
    fs.writeFileSync(path.join(dir, BACKUP), 'the copy an earlier opener took', { mode: 0o600 });

    opened(t, file);

    assert.equal(fs.readFileSync(path.join(dir, BACKUP), 'utf8'), 'the copy an earlier opener took');
    assert.equal(stateKey(file, 'layout_revision'), '2');
  });
});

describe('a file whose layout was recorded under the generation\'s key', () => {
  it('is copied, given its key back, and its skipped actions stored as every reader reads them', async (t) => {
    const dir = directory(t);
    const file = fileIn(dir, FIRST_LAYOUT, LAYOUT_AS_GENERATION);

    const repository = opened(t, file);

    assert.deepEqual(backupsIn(dir), [BACKUP]);
    assert.equal(stateKey(file, 'schema_version'), '1');
    assert.equal(stateKey(file, 'layout_revision'), '2');
    assert.equal((await repository.get('skipped-1'))?.state, 'skipped');
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(
        { ...raw.prepare("SELECT state, ended_as FROM actions WHERE id = 'skipped-1'").get() },
        { state: 'cancelled', ended_as: 'skipped' },
      );
    } finally {
      raw.close();
    }
  });
});

describe('the skipped ending', () => {
  it('is listed, filtered and counted apart from a cancellation', async (t) => {
    const repository = opened(t, fileIn(directory(t), FIRST_LAYOUT));
    const skipped = keyed('skipped', null, 14);
    skipped.start(BASE);
    skipped.skip(BASE, 'Status reads "Ready for QA"');
    await repository.insert(skipped);
    const cancelled = keyed('cancelled', null, 15);
    cancelled.cancel(BASE);
    await repository.insert(cancelled);

    assert.deepEqual((await repository.list({ states: ['skipped'] })).map((action) => action.id), ['skipped']);
    assert.deepEqual((await repository.list({ states: ['cancelled'] })).map((action) => action.id), ['cancelled']);
    const counts = await repository.counts();
    assert.equal(counts.skipped, 1);
    assert.equal(counts.cancelled, 1);
  });
});

describe('a queue file that is up to date', () => {
  it('opens without waiting for a writer, because it writes nothing', (t) => {
    const dir = directory(t);
    const file = path.join(dir, 'queue.db');
    opened(t, file);
    const writer = new DatabaseSync(file);
    writer.exec('BEGIN IMMEDIATE');
    t.after(() => {
      writer.exec('ROLLBACK');
      writer.close();
    });

    const started = Date.now();
    opened(t, file);

    assert.ok(Date.now() - started < 1000, 'opening waited for the writer');
  });

  it('never records a lower layout than one a later release wrote', (t) => {
    const dir = directory(t);
    const file = path.join(dir, 'queue.db');
    opened(t, file);
    const later = new DatabaseSync(file);
    later.exec("UPDATE queue_state SET value = '5' WHERE key = 'layout_revision'");
    later.close();

    opened(t, file);

    assert.equal(stateKey(file, 'layout_revision'), '5');
  });
});

describe('a new queue file', () => {
  it('starts at the current layout with nothing to copy', (t) => {
    const dir = directory(t);
    const file = path.join(dir, 'queue.db');

    opened(t, file);

    assert.equal(stateKey(file, 'schema_version'), '1');
    assert.equal(stateKey(file, 'layout_revision'), '2');
    assert.deepEqual(backupsIn(dir), []);
  });
});

describe('a queue file of a newer generation', () => {
  it('is refused and left as it is', (t) => {
    const dir = directory(t);
    const file = fileIn(dir, FIRST_LAYOUT, "UPDATE queue_state SET value = '9' WHERE key = 'schema_version'");

    assert.throws(() => new SqliteActionRepository(file), /written by a newer version \(schema 9\)/);
    assert.equal(stateKey(file, 'schema_version'), '9');
    assert.deepEqual(backupsIn(dir), []);
  });
});

describe('writing a page of actions with its cursor', () => {
  it('writes the actions and the note together, and leaves out the ones already keyed', async (t) => {
    const repository = opened(t, path.join(directory(t), 'queue.db'));
    await repository.insert(keyed('first', 'dibs:1'));

    const written = await repository.insertAll(
      [keyed('again', 'dibs:1'), keyed('new', 'dibs:2', 13)],
      [{ key: 'mirror.cursor', value: '2' }],
    );

    assert.deepEqual(written, ['new']);
    assert.equal(await repository.getMeta('mirror.cursor'), '2');
    assert.equal((await repository.get('new'))?.persistedVersion, 1);
  });

  it('writes neither when one of them cannot be written', async (t) => {
    const repository = opened(t, path.join(directory(t), 'queue.db'));
    await repository.insert(keyed('taken', null));

    await assert.rejects(() => repository.insertAll(
      [keyed('fresh', 'dibs:3'), keyed('taken', 'dibs:4', 14)],
      [{ key: 'mirror.cursor', value: '4' }],
    ));

    assert.equal(await repository.get('fresh'), null);
    assert.equal(await repository.getMeta('mirror.cursor'), null);
  });
});
