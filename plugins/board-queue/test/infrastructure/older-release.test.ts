import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { Action } from '../../src/domain/action.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';

/**
 * The last release whose queue wrote the first layout. Going back to it — or to
 * any release before this one — must keep the queue running on a file this
 * version has opened and written to.
 */
const FIRST_LAYOUT_RELEASE = 'f1d33eadd22bc93bfc158b0c3aad9669bc614ba6';

const PLUGIN = path.join(import.meta.dirname, '..', '..');
const FIRST = 'example-org/first-repo';
const BASE = new Date('2026-01-01T09:00:00.000Z');

/**
 * What the older release is asked to do with a file, run in a process of its own
 * with its own code: optionally file an action, then list everything, read one
 * action, count, and report its status — the reads every tick, session brief and
 * listing makes.
 */
const OLDER_RELEASE_SCRIPT = `
import { SqliteActionRepository } from './src/infrastructure/sqlite-action-repository.ts';
import { QueueStatus } from './src/application/queue-status.ts';
import { Action } from './src/domain/action.ts';
import { IssueRef } from './src/domain/issue-ref.ts';

const [command, file, id] = process.argv.slice(2);
const repository = new SqliteActionRepository(file);
if (command === 'file') {
  await repository.insert(Action.enqueue({
    id,
    kind: 'board.set-fields',
    payload: { repo: '${FIRST}', issue: 12, fields: { severity: 'S2' } },
    issueRef: IssueRef.of('${FIRST}', 12),
    origin: 'the older release',
    now: new Date('2026-01-01T09:00:00.000Z'),
  }));
}
const listed = await repository.list({});
const one = await repository.get(id);
const counts = await repository.counts();
const status = await new QueueStatus(repository, { now: () => new Date() }).execute();
repository.close();
process.stdout.write(JSON.stringify({
  listed: listed.map((action) => ({ id: action.id, state: action.state })),
  one: one === null ? null : { id: one.id, state: one.state },
  counts,
  statusCounts: status.counts,
}));
`;

const OlderAnswer = z.object({
  listed: z.array(z.object({ id: z.string(), state: z.string() })),
  one: z.object({ id: z.string(), state: z.string() }).nullable(),
  counts: z.record(z.string(), z.number()),
  statusCounts: z.record(z.string(), z.number()),
});

type OlderRelease = {
  run(command: 'file' | 'read', file: string, id: string): z.infer<typeof OlderAnswer>;
};

/** The older release's queue code, taken from history into a directory of its own. */
function olderRelease(t: TestContext): OlderRelease {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-older-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args: string[]): string => execFileSync('git', ['-C', PLUGIN, ...args], { encoding: 'utf8' }).trim();
  const top = git('rev-parse', '--show-toplevel');
  const prefix = git('rev-parse', '--show-prefix');
  const archive = execFileSync(
    'git',
    ['-C', top, 'archive', '--format=tar', FIRST_LAYOUT_RELEASE, `${prefix}src`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync('tar', ['-x', '-C', root, '--strip-components', String(prefix.split('/').filter(Boolean).length)], {
    input: archive,
  });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const script = path.join(root, 'older.ts');
  fs.writeFileSync(script, OLDER_RELEASE_SCRIPT);
  return {
    run: (command, file, id) => {
      const ran = spawnSync(process.execPath, [script, command, file, id], { encoding: 'utf8', cwd: root });
      assert.equal(ran.status, 0, `the older release failed: ${ran.stderr}`);
      return OlderAnswer.parse(JSON.parse(ran.stdout));
    },
  };
}

describe('going back to the release before this layout', () => {
  it('keeps the queue running on a file this version opened, wrote and skipped work in', async (t) => {
    const older = olderRelease(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-roundtrip-'));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const file = path.join(dir, 'queue.db');

    older.run('file', file, 'from-the-older-release');

    const current = new SqliteActionRepository(file);
    const skipped = Action.enqueue({
      id: 'skipped-here',
      kind: 'board.set-fields',
      payload: { repo: FIRST, issue: 13, fields: { status: 'In Progress' }, onlyIfStatusIn: ['Todo', ''] },
      issueRef: IssueRef.of(FIRST, 13),
      origin: 'a mirror',
      now: BASE,
      dedupeKey: 'mirror:13',
    });
    skipped.start(BASE);
    skipped.skip(BASE, 'Status reads "Ready for QA"; the row was left as it is');
    await current.insert(skipped);
    current.close();

    const back = older.run('read', file, 'skipped-here');

    assert.deepEqual(back.listed, [
      { id: 'from-the-older-release', state: 'queued' },
      { id: 'skipped-here', state: 'cancelled' },
    ]);
    assert.deepEqual(back.one, { id: 'skipped-here', state: 'cancelled' });
    assert.equal(back.counts['cancelled'], 1);
    assert.equal(back.statusCounts['queued'], 1);

    older.run('file', file, 'filed-again-by-the-older-release');
    const reopened = new SqliteActionRepository(file);
    t.after(() => {
      reopened.close();
    });
    assert.equal((await reopened.get('skipped-here'))?.state, 'skipped');
    assert.equal((await reopened.get('filed-again-by-the-older-release'))?.state, 'queued');
    assert.equal((await reopened.counts()).skipped, 1);
  });
});
