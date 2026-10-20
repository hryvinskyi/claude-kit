import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { KeptPull } from '../../src/application/forge-ports.ts';
import { SqliteForgeLedger } from '../../src/infrastructure/sqlite-forge-ledger.ts';
import { pullRequest } from '../fakes/fake-forge.ts';

const REPO = 'example-org/first-repo';

function opened(t: TestContext): { ledger: SqliteForgeLedger; file: string; reopen: () => SqliteForgeLedger } {
  const dir = mkdtempSync(join(tmpdir(), 'board-queue-forge-ledger-'));
  const file = join(dir, 'queue.db');
  const open: SqliteForgeLedger[] = [];
  const reopen = () => {
    const ledger = new SqliteForgeLedger(file);
    open.push(ledger);
    return ledger;
  };
  const ledger = reopen();
  t.after(() => {
    for (const one of open) {
      one.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { ledger, file, reopen };
}

function kept(number: number, overrides: Partial<KeptPull> = {}): KeptPull {
  return { ...pullRequest(REPO, number), etag: null, mergeableSent: null, reported: null, ...overrides };
}

describe('what the forge jobs keep between passes', () => {
  it('keeps pull requests and the listing mark, read back by another process in any case', async (t) => {
    const { ledger, reopen } = opened(t);
    const merged = kept(2, { state: 'closed', mergedAt: new Date('2026-03-02T09:02:00Z'), reported: 'merged', etag: '"x"' });

    await ledger.recordListing('Example-Org/First-Repo', { cursor: new Date('2026-03-02T09:02:00Z'), etag: '"p1"' }, [
      kept(1, { mergeableSent: false }),
      merged,
    ]);

    const other = reopen();
    assert.deepEqual(await other.listing(REPO), { cursor: new Date('2026-03-02T09:02:00Z'), etag: '"p1"' });
    assert.deepEqual(await other.pull(REPO, 2), merged);
    assert.deepEqual((await other.openPulls(REPO)).map((pull) => [pull.number, pull.mergeableSent]), [[1, false]]);
  });

  it('keeps neither the pull requests nor the mark when one of them cannot be written', async (t) => {
    const { ledger } = opened(t);

    await assert.rejects(() => ledger.recordListing(REPO, { cursor: new Date('2026-03-02T09:00:00Z'), etag: null }, [
      kept(1),
      kept(2, { updatedAt: new Date(Number.NaN) }),
    ]));

    assert.equal(await ledger.listing(REPO), null);
    assert.equal(await ledger.pull(REPO, 1), null);
  });

  it('reads a row this version cannot read as no row', async (t) => {
    const { ledger, file } = opened(t);
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO forge_pulls (repo, number, open, reported, updated_at, head_sha, record) VALUES (?, ?, 1, 0, 0, ?, ?)')
      .run(REPO, 3, 'a'.repeat(40), '{"number":"three"}');
    raw.close();

    assert.equal(await ledger.pull(REPO, 3), null);
    assert.deepEqual(await ledger.openPulls(REPO), []);
  });

  it('keeps the last status written per commit and context', async (t) => {
    const { ledger } = opened(t);
    const sha = 'a'.repeat(40);

    await ledger.recordStatus(REPO, sha, { state: 'success', description: 'Nothing freezes main.', context: 'dibs' }, new Date());
    await ledger.recordStatus(REPO, sha, { state: 'failure', description: 'Frozen.', context: 'dibs' }, new Date());

    assert.deepEqual(await ledger.lastStatus(REPO, sha, 'dibs'), { state: 'failure', description: 'Frozen.', context: 'dibs' });
    assert.equal(await ledger.lastStatus(REPO, sha, 'other'), null);
  });

  it('keeps each branch\'s measure and forgets those no longer claimed', async (t) => {
    const { ledger } = opened(t);
    const measure = { baseSha: '4f2a91c0', baseAt: new Date('2026-03-01T08:12:00Z'), paths: ['a.ts'], truncated: true };
    await ledger.recordMeasure(REPO, 'main', 'alice/7', { etag: '"c1"', measure });
    await ledger.recordMeasure(REPO, 'main', 'bob/8', { etag: null, measure });
    await ledger.recordDefaultBranch(REPO, 'trunk', '"r1"');

    await ledger.forgetMeasuresExcept(REPO, [{ base: 'main', branch: 'alice/7' }]);

    assert.deepEqual(await ledger.measure(REPO, 'main', 'alice/7'), { etag: '"c1"', measure });
    assert.equal(await ledger.measure(REPO, 'main', 'bob/8'), null);
    assert.deepEqual(await ledger.defaultBranch(REPO), { name: 'trunk', etag: '"r1"' });
    assert.equal(await ledger.listing(REPO), null, 'a default branch is no listing mark');
  });
});
