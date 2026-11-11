import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { Action } from '../../src/domain/action.ts';
import { OptionNotFound } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';
import { SqliteForgeLedger } from '../../src/infrastructure/sqlite-forge-ledger.ts';

/**
 * The last release whose queue wrote the first layout. Going back to it — or to
 * any release before this one — must keep the queue running on a file this
 * version has opened and written to.
 */
const FIRST_LAYOUT_RELEASE = 'f1d33eadd22bc93bfc158b0c3aad9669bc614ba6';

/** The last release whose queue wrote the second layout, before the forge's tables. */
const SECOND_LAYOUT_RELEASE = 'd2a0ebc78abff71fc13fa0d2ba0c01b793e51d1a';

/** The last release whose queue wrote the third layout, before it kept which values a board lacked. */
const THIRD_LAYOUT_RELEASE = 'f5ce87aad77bdd27b8a805889f3b65bab2bc85c2';

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
import { OptionNotFound } from './src/domain/errors.ts';

const [command, file, id] = process.argv.slice(2);
const repository = new SqliteActionRepository(file);
if (command === 'reblock') {
  // A person retries a blocked action, and the worker blocks it again for another value.
  const now = new Date('2026-01-01T10:00:00.000Z');
  const blocked = await repository.get(id);
  blocked.retry(now);
  await repository.update(blocked);
  const claimed = await repository.claimNextRunnable(now);
  claimed.block(now, new OptionNotFound('Defect type', 'Chore', ['Bug', 'Regression']));
  await repository.update(claimed);
}
let folded = null;
if (command === 'fold-and-run') {
  // A session of this release files a request on the issue, and this release's
  // worker runs the queue against a board that answers like the real one.
  const { EnqueueAction } = await import('./src/application/enqueue-action.ts');
  const { DrainQueue } = await import('./src/application/drain-queue.ts');
  const { BoardRouter } = await import('./src/application/board-router.ts');
  const { BudgetPolicy } = await import('./src/application/budget-policy.ts');
  const { BoardDirectory } = await import('./src/domain/board-directory.ts');
  const { ConfigSchema } = await import('./src/domain/config.ts');
  const { defaultKindRegistry } = await import('./src/domain/kinds/default-kinds.ts');
  const { RateBudget } = await import('./src/domain/rate-budget.ts');
  const config = ConfigSchema.parse({
    boards: [{ owner: 'example-org', number: 7, ownerType: 'organization', repos: ['${FIRST}'] }],
    fields: ['Status', 'Severity', 'Module', 'Environment', 'Defect type'],
    refusedStatus: ['Done'],
    worker: { paceMs: 0 },
  });
  const offered = { Status: ['Todo', 'In Progress', 'In Review'], Severity: ['S2', 'S4'], Module: ['Checkout'] };
  const catalog = {
    projectId: 'project-1',
    fields: Object.entries(offered).map(([name, names]) => ({
      id: 'field-' + name, name, dataType: 'SINGLE_SELECT',
      options: names.map((option) => ({ id: 'option-' + name + '-' + option, name: option })),
    })),
  };
  const values = { Status: 'In Progress' };
  const ref = IssueRef.of('${FIRST}', 12);
  const budget = new RateBudget({ resource: 'graphql', remaining: 4000, limit: 5000, used: 1000, resetAt: new Date(Date.now() + 3600000) });
  const board = {
    probeBudget: async () => budget,
    lastBudget: () => budget,
    catalog: async () => catalog,
    ensureItem: async () => 'item-7',
    findItem: async () => ({ itemId: 'item-7', ref, values: { ...values } }),
    readItemById: async () => ({ itemId: 'item-7', ref, values: { ...values } }),
    setSingleSelect: async (_item, fieldId, optionId) => {
      const field = catalog.fields.find((one) => one.id === fieldId);
      values[field.name] = field.options.find((one) => one.id === optionId).name;
    },
  };
  const clock = { now: () => new Date() };
  const directory = BoardDirectory.of(config.boards);
  const kinds = defaultKindRegistry(config);
  const outcome = await new EnqueueAction({ repository, kinds, directory, clock }).execute({
    kind: 'board.set-fields',
    payload: { repo: '${FIRST}', issue: 12, fields: { module: 'Checkout' } },
    origin: 'a session of the older release',
  });
  const report = await new DrainQueue({
    repository,
    boards: new BoardRouter(directory, () => ({ board, issues: {} })),
    kinds,
    policy: new BudgetPolicy(config.worker),
    clock,
    sleeper: { sleep: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    config,
  }).run();
  folded = { coalescedInto: outcome.coalescedInto ?? null, done: report.done, values };
}
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
let lock = null;
if (command === 'lock') {
  // A pass of this release, started by hand while another may be running.
  lock = await repository.withTickLock(async () => 'taken');
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
  folded,
  lock,
}));
`;

const OlderAnswer = z.object({
  listed: z.array(z.object({ id: z.string(), state: z.string() })),
  one: z.object({ id: z.string(), state: z.string() }).nullable(),
  counts: z.record(z.string(), z.number()),
  statusCounts: z.record(z.string(), z.number()),
  folded: z.object({
    coalescedInto: z.string().nullable(),
    done: z.number(),
    values: z.record(z.string(), z.string()),
  }).nullable(),
  lock: z.string().nullable(),
});

type OlderRelease = {
  run(
    command: 'file' | 'read' | 'reblock' | 'fold-and-run' | 'lock',
    file: string,
    id: string,
    environment?: Readonly<Record<string, string>>,
  ): z.infer<typeof OlderAnswer>;
};

/** An older release's queue code, taken from history into a directory of its own. */
function olderRelease(t: TestContext, release: string): OlderRelease {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-older-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args: string[]): string => execFileSync('git', ['-C', PLUGIN, ...args], { encoding: 'utf8' }).trim();
  const top = git('rev-parse', '--show-toplevel');
  const prefix = git('rev-parse', '--show-prefix');
  const archive = execFileSync(
    'git',
    ['-C', top, 'archive', '--format=tar', release, `${prefix}src`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync('tar', ['-x', '-C', root, '--strip-components', String(prefix.split('/').filter(Boolean).length)], {
    input: archive,
  });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // A later release reads its notes with the same libraries this one installs.
  fs.symlinkSync(path.join(PLUGIN, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const script = path.join(root, 'older.ts');
  fs.writeFileSync(script, OLDER_RELEASE_SCRIPT);
  return {
    run: (command, file, id, environment = {}) => {
      const ran = spawnSync(process.execPath, [script, command, file, id], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, ...environment },
      });
      assert.equal(ran.status, 0, `the older release failed: ${ran.stderr}`);
      return OlderAnswer.parse(JSON.parse(ran.stdout));
    },
  };
}

describe('going back to the release before this layout', () => {
  it('keeps the queue running on a file this version opened, wrote and skipped work in', async (t) => {
    const older = olderRelease(t, FIRST_LAYOUT_RELEASE);
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

describe('going back to the release before the forge\'s tables', () => {
  it('keeps the queue running on a file this version opened and kept forge state in, and the state survives', async (t) => {
    const older = olderRelease(t, SECOND_LAYOUT_RELEASE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-roundtrip-'));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const file = path.join(dir, 'queue.db');

    older.run('file', file, 'from-the-older-release');
    const ledger = new SqliteForgeLedger(file);
    await ledger.recordListing(FIRST, { cursor: BASE, etag: '"p1"' }, [{
      repo: FIRST,
      number: 2,
      state: 'closed',
      mergedAt: BASE,
      updatedAt: BASE,
      author: 'alice-gh',
      headRef: 'alice/2-work',
      headRepo: FIRST,
      headSha: 'a'.repeat(40),
      baseRef: 'main',
      etag: null,
      mergeableSent: null,
      reported: 'merged',
    }]);
    ledger.close();

    const back = older.run('file', file, 'filed-after-the-forge-tables');

    assert.deepEqual(back.listed, [
      { id: 'from-the-older-release', state: 'queued' },
      { id: 'filed-after-the-forge-tables', state: 'queued' },
    ]);
    assert.equal(back.statusCounts['queued'], 2);
    const reopened = new SqliteForgeLedger(file);
    t.after(() => {
      reopened.close();
    });
    assert.equal((await reopened.listing(FIRST))?.etag, '"p1"');
    assert.equal((await reopened.pull(FIRST, 2))?.reported, 'merged');
  });
});

describe('going back to the release before the queue kept which values a board lacked', () => {
  it('reads a record that release left behind as no record, once it has retried and blocked the action again',
    async (t) => {
      const older = olderRelease(t, THIRD_LAYOUT_RELEASE);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-roundtrip-'));
      t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const file = path.join(dir, 'queue.db');

      const current = new SqliteActionRepository(file);
      const action = Action.enqueue({
        id: 'waits-for-an-option',
        kind: 'board.set-fields',
        payload: { repo: FIRST, issue: 12, fields: { severity: 'S4', type: 'Chore' } },
        issueRef: IssueRef.of(FIRST, 12),
        origin: 'a session',
        now: BASE,
      });
      await current.insert(action);
      action.start(BASE);
      action.block(BASE, new OptionNotFound('Severity', 'S4', ['S1']), ['severity'], { type: { name: '', optionId: null } });
      await current.update(action);
      assert.deepEqual((await current.get('waits-for-an-option'))?.missingOptions, ['severity']);
      current.close();

      const back = older.run('reblock', file, 'waits-for-an-option');
      assert.deepEqual(back.one, { id: 'waits-for-an-option', state: 'blocked' });

      const reopened = new SqliteActionRepository(file);
      t.after(() => {
        reopened.close();
      });
      const reblocked = await reopened.get('waits-for-an-option');
      assert.equal(reblocked?.state, 'blocked');
      assert.equal(reblocked.blockedReason, 'option-not-found');
      assert.match(reblocked.lastError ?? '', /Chore/);
      assert.deepEqual(reblocked.missingOptions, [], 'the record describes a block that is over');
      assert.equal(reblocked.rowAtBlock, null);
    });
});

describe('going back to the release before the board guarded what it released', () => {
  it('folds a request into a guarded action and runs it, unguarded, as that release always did', async (t) => {
    const older = olderRelease(t, THIRD_LAYOUT_RELEASE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-roundtrip-'));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const file = path.join(dir, 'queue.db');

    const current = new SqliteActionRepository(file);
    const action = Action.enqueue({
      id: 'released-by-the-board',
      kind: 'board.set-fields',
      payload: { repo: FIRST, issue: 12, fields: { status: 'In Review', severity: 'S4' } },
      issueRef: IssueRef.of(FIRST, 12),
      origin: 'a session',
      now: BASE,
    });
    await current.insert(action);
    action.start(BASE);
    action.block(BASE, new OptionNotFound('Severity', 'S4', ['S2']), ['severity'], {
      status: { name: 'Todo', optionId: 'option-Status-Todo' },
    });
    action.resumeWith(BASE, action.payload, 'the board now offers what this waited for', {
      status: { name: 'Todo', optionId: 'option-Status-Todo' },
    });
    await current.update(action);
    current.close();

    const back = older.run('fold-and-run', file, 'released-by-the-board');

    assert.deepEqual(back.folded, {
      coalescedInto: 'released-by-the-board',
      done: 1,
      values: { Status: 'In Review', Severity: 'S4', Module: 'Checkout' },
    });
    assert.deepEqual(back.one, { id: 'released-by-the-board', state: 'done' });
    const reopened = new SqliteActionRepository(file);
    t.after(() => {
      reopened.close();
    });
    const ran = await reopened.get('released-by-the-board');
    assert.equal(ran?.state, 'done');
    assert.equal(ran.writeGuard, null);
  });
});

describe('an older release run beside this one', () => {
  it('never takes the lock from a live pass of this version, whatever language and time zone it runs in',
    async (t) => {
      const older = olderRelease(t, THIRD_LAYOUT_RELEASE);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-roundtrip-'));
      t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const file = path.join(dir, 'queue.db');
      const current = new SqliteActionRepository(file);
      t.after(() => {
        current.close();
      });

      const tried = await current.withTickLock(() => Promise.resolve([
        older.run('lock', file, 'none', { LANG: 'uk_UA.UTF-8', LC_ALL: 'uk_UA.UTF-8', TZ: 'Asia/Tokyo' }),
        older.run('lock', file, 'none', { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }),
      ]));

      assert.deepEqual(tried?.map((answer) => answer.lock), [null, null]);
      assert.equal(older.run('lock', file, 'none').lock, 'taken', 'once this version let go, the older release takes it');
    });
});
