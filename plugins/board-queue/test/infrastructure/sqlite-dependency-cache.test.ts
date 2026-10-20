import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { SqliteDependencyCache } from '../../src/infrastructure/sqlite-dependency-cache.ts';

const REF = IssueRef.of('acme/widgets', 41);

function fileIn(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-cache-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'queue.db');
}

describe('the kept dependency answers', () => {
  it('keeps an answer, its tag and its moments between processes', async (t) => {
    const file = fileIn(t);
    const writer = new SqliteDependencyCache(file);
    await writer.put('blocked_by', REF, {
      etag: '"b1"',
      issues: [{ ref: IssueRef.of('acme/api', 9), title: 'the api change', state: 'open' }],
      fetchedAt: new Date('2026-03-02T09:00:00Z'),
      issueUpdatedAt: new Date('2026-03-01T10:00:00Z'),
    });
    writer.close();

    const reader = new SqliteDependencyCache(file);
    t.after(() => {
      reader.close();
    });
    const kept = await reader.get('blocked_by', REF);

    assert.equal(kept?.etag, '"b1"');
    assert.deepEqual(kept?.issues.map((issue) => [issue.ref.toString(), issue.title, issue.state]), [
      ['acme/api#9', 'the api change', 'open'],
    ]);
    assert.equal(kept?.fetchedAt.toISOString(), '2026-03-02T09:00:00.000Z');
    assert.equal(kept?.issueUpdatedAt?.toISOString(), '2026-03-01T10:00:00.000Z');
    assert.equal(await reader.get('sub_issues', REF), null, 'each list is kept apart');
  });

  it('replaces an answer with the next one', async (t) => {
    const cache = new SqliteDependencyCache(fileIn(t));
    t.after(() => {
      cache.close();
    });
    const at = new Date('2026-03-02T09:00:00Z');
    await cache.put('sub_issues', REF, { etag: '"a"', issues: [], fetchedAt: at, issueUpdatedAt: null });
    await cache.put('sub_issues', REF, { etag: null, issues: [], fetchedAt: at, issueUpdatedAt: null });

    assert.equal((await cache.get('sub_issues', REF))?.etag, null);
  });

  it('reads an answer it cannot make sense of as no answer', async (t) => {
    const file = fileIn(t);
    const cache = new SqliteDependencyCache(file);
    t.after(() => {
      cache.close();
    });
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO import_fetches (key, etag, answer, fetched_at) VALUES (?, ?, ?, ?)')
      .run(`blocked_by:${REF.key()}`, null, '[{"ref":"not an issue"}]', 0);
    db.close();

    assert.equal(await cache.get('blocked_by', REF), null);
  });
});
