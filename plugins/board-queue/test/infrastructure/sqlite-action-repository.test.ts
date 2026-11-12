import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';
import type { SqliteActionRepositoryOptions } from '../../src/infrastructure/sqlite-action-repository.ts';
import { Action } from '../../src/domain/action.ts';
import type { FieldCatalog } from '../../src/domain/catalog.ts';
import { OptionNotFound, StaleAction } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { QueuePause } from '../../src/domain/queue-pause.ts';
import { ORG_BOARD, TEST_BOARD, USER_BOARD } from '../fixtures/config.ts';
import { LocalProcessTable } from '../../src/infrastructure/process-table.ts';
import type { ProcessTable } from '../../src/infrastructure/process-table.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import { testConfig } from '../fixtures/config.ts';

const FIRST = 'Example-Org/First-Repo';
const SECOND = 'Example-User/Second-Repo';

const BASE = new Date('2026-01-01T09:00:00.000Z');

/** The order of an issue's actions with the kinds the worker runs. */
const ISSUE_ORDER = defaultKindRegistry(testConfig).issueOrder();

function at(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60 * 1000);
}

/**
 * A real database in a directory of its own, on the same engine the worker runs
 * on: every rule this adapter carries lives in SQL, and a fake would only prove
 * that the test agrees with itself.
 */
function databaseIn(t: TestContext): (options?: SqliteActionRepositoryOptions) => SqliteActionRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-test-'));
  const opened: SqliteActionRepository[] = [];
  t.after(() => {
    for (const repository of opened) {
      repository.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return (options?: SqliteActionRepositoryOptions) => {
    const repository = new SqliteActionRepository(path.join(dir, 'queue.db'), options);
    opened.push(repository);
    return repository;
  };
}

type ActionOptions = {
  id: string;
  kind?: string;
  ref?: string | null;
  issue?: number;
  payload?: unknown;
  createdAt?: Date;
  origin?: string;
  hold?: boolean;
  notBefore?: Date | null;
};

function anAction(options: ActionOptions): Action {
  const repo = options.ref === undefined ? FIRST : options.ref;
  const issue = options.issue ?? 12;
  return Action.enqueue({
    id: options.id,
    kind: options.kind ?? 'board.set-fields',
    payload: options.payload ?? { repo, issue, fields: { severity: 'S2' } },
    issueRef: repo === null ? null : IssueRef.of(repo, issue),
    origin: options.origin ?? 'a test',
    now: options.createdAt ?? BASE,
    hold: options.hold,
    notBefore: options.notBefore ?? null,
  });
}

/**
 * Takes the oldest action on the queue and stops it the way a run does: failed
 * once it has used its attempts, or blocked on something a person has to fix.
 */
async function stopFirst(repository: SqliteActionRepository, stop: 'failed' | 'blocked', now: Date): Promise<void> {
  const first = await repository.claimNextRunnable(now);
  assert.ok(first !== null, 'something should be runnable');
  if (stop === 'failed') {
    first.failTransient(now, 'the API answered 502', 1, 30);
  } else {
    first.block(now, new OptionNotFound('Severity', 'urgent', ['S2 · broken']));
  }
  await repository.update(first);
  assert.equal((await stored(repository, first.id)).state, stop);
}

async function stored(repository: SqliteActionRepository, id: string): Promise<Action> {
  const action = await repository.get(id);
  assert.ok(action !== null, `the queue should hold ${id}`);
  return action;
}

describe('the queue on disk', () => {
  it('keeps a payload, its moments and its version through a round trip', async (t) => {
    const repository = databaseIn(t)();
    const filed = anAction({
      id: 'one',
      payload: { repo: FIRST, issue: 12, fields: { severity: 'S2', status: 'In review' } },
      createdAt: at(0),
      notBefore: at(30),
      origin: 'a session in the first repository',
    });
    await repository.insert(filed);

    const read = await stored(repository, 'one');
    assert.deepEqual(read.payload, { repo: FIRST, issue: 12, fields: { severity: 'S2', status: 'In review' } });
    assert.equal(read.state, 'queued');
    assert.equal(read.attempts, 0);
    assert.equal(read.origin, 'a session in the first repository');
    assert.equal(read.createdAt.getTime(), at(0).getTime());
    assert.equal(read.notBefore?.getTime(), at(30).getTime());
    assert.equal(read.version, 1);
    assert.equal(read.lastError, null);
    assert.equal(read.result, null);
    // The column matches in lower case; the caller's spelling comes back to a reader.
    assert.equal(read.issueRef?.toString(), `${FIRST}#12`);
  });

  it('remembers why an action is blocked, as a category and as a sentence', async (t) => {
    const repository = databaseIn(t)();
    const filed = anAction({ id: 'one', createdAt: at(0) });
    await repository.insert(filed);
    filed.start(at(1));
    filed.block(at(1), new OptionNotFound('Severity', 'urgent', ['S1 · blocking', 'S2 · broken']));
    await repository.update(filed);

    const read = await stored(repository, 'one');
    assert.equal(read.state, 'blocked');
    assert.equal(read.blockedReason, 'option-not-found');
    assert.match(read.lastError ?? '', /has no option matching "urgent"/);
  });

  it('remembers which wanted values the board lacked, and stores the narrower payload a release resumes with',
    async (t) => {
      const repository = databaseIn(t)();
      const filed = anAction({
        id: 'one',
        payload: { repo: FIRST, issue: 12, fields: { status: 'In Progress', severity: 'S4' } },
        createdAt: at(0),
      });
      await repository.insert(filed);
      filed.start(at(1));
      const todo = { name: 'Todo', optionId: 'option-todo' };
      filed.block(at(1), new OptionNotFound('Severity', 'S4', ['S1 · blocking']), ['severity'], { status: todo });
      await repository.update(filed);

      const blocked = await stored(repository, 'one');
      assert.deepEqual(blocked.missingOptions, ['severity']);
      assert.deepEqual(blocked.rowAtBlock, { status: { name: 'Todo', optionId: 'option-todo' } });

      const narrowed = { repo: FIRST, issue: 12, fields: { status: 'In Progress', severity: 'S4' } };
      blocked.resumeWith(at(2), narrowed, 'status only if unchanged', { status: todo });
      await repository.update(blocked);

      const resumed = await stored(repository, 'one');
      assert.equal(resumed.state, 'queued');
      assert.deepEqual(resumed.missingOptions, []);
      assert.equal(resumed.rowAtBlock, null);
      assert.deepEqual(resumed.payload, narrowed, 'the guard is kept beside the payload, never in it');
      assert.deepEqual(resumed.writeGuard, { status: todo });
      assert.match(resumed.result ?? '', /status only if unchanged/);

      resumed.start(at(3));
      await repository.update(resumed);
      assert.deepEqual((await stored(repository, 'one')).writeGuard, { status: todo }, 'a claim keeps the guard');
    });

  it('reads a guard that a merge by another writer has outlived as no guard', async (t) => {
    const repository = databaseIn(t)();
    const filed = anAction({
      id: 'one',
      payload: { repo: FIRST, issue: 12, fields: { status: 'In Progress', severity: 'S4' } },
      createdAt: at(0),
    });
    await repository.insert(filed);
    filed.start(at(1));
    filed.block(at(1), new OptionNotFound('Severity', 'S4', ['S1 · blocking']), ['severity'], {});
    filed.resumeWith(at(2), filed.payload, 'note', { status: { name: 'Todo', optionId: 'option-todo' } });
    await repository.update(filed);

    // What a release that knows nothing of the guard does when it folds a request in.
    const merged = { repo: FIRST, issue: 12, fields: { status: 'In Progress', severity: 'S4', module: 'Checkout' } };
    assert.equal(await repository.coalesceInto('one', merged, at(3), filed.version), true);

    const after = await stored(repository, 'one');
    assert.deepEqual(after.payload, merged);
    assert.equal(after.writeGuard, null);
  });

  it('refuses a write taken on facts another writer has already changed', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));

    const mine = await stored(repository, 'one');
    const theirs = await stored(repository, 'one');
    mine.start(at(1));
    await repository.update(mine);

    theirs.start(at(2));
    await assert.rejects(() => repository.update(theirs), StaleAction);

    const read = await stored(repository, 'one');
    assert.equal(read.state, 'running');
    assert.equal(read.attempts, 1);
    assert.equal(read.version, 2);
    assert.equal(read.updatedAt.getTime(), at(1).getTime());
  });

  it('offers the newest waiting action of that sort on that issue, never an older one', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'older', createdAt: at(0) }));
    await repository.insert(anAction({ id: 'newer', createdAt: at(5) }));

    const found = await repository.findCoalescible('board.set-fields', IssueRef.of(FIRST, 12), at(10));
    assert.equal(found?.id, 'newer', 'a request folded into the older one would run before the newer one');
  });

  it('offers nothing when any action that may still write to the issue was filed after the waiting one', async (t) => {
    for (const after of ['queued', 'held', 'running', 'failed', 'blocked'] as const) {
      const repository = databaseIn(t)();
      await repository.insert(anAction({ id: 'waiting', createdAt: at(0) }));
      await repository.insert(anAction({
        id: 'after',
        kind: 'issue.comment',
        payload: { repo: FIRST, issue: 12, body: 'a note' },
        createdAt: at(1),
        hold: after === 'held',
      }));
      if (after === 'running' || after === 'failed' || after === 'blocked') {
        // An action released after the one behind it ran can stand in front of a queued one.
        const behind = await stored(repository, 'after');
        behind.start(at(2));
        if (after === 'failed') {
          behind.failTransient(at(2), 'the API answered 502', 1, 30);
        } else if (after === 'blocked') {
          behind.block(at(2), new OptionNotFound('Severity', 'urgent', ['S2 · broken']));
        }
        await repository.update(behind);
      }

      assert.equal(
        await repository.findCoalescible('board.set-fields', IssueRef.of(FIRST, 12), at(10)),
        null,
        `an action ${after} after it keeps a later request from being folded in front of it`,
      );
      assert.equal(
        await repository.coalesceInto('waiting', { repo: FIRST, issue: 12, fields: { severity: 'S1' } }, at(10), 1),
        false,
        `the fold itself refuses a row with an action ${after} after it`,
      );
    }
  });

  it('offers the waiting action again once what was filed after it has ended', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'waiting', createdAt: at(0) }));
    await repository.insert(anAction({
      id: 'after',
      kind: 'issue.comment',
      payload: { repo: FIRST, issue: 12, body: 'a note' },
      createdAt: at(1),
    }));
    const cancelled = await stored(repository, 'after');
    cancelled.cancel(at(2));
    await repository.update(cancelled);

    assert.equal((await repository.findCoalescible('board.set-fields', IssueRef.of(FIRST, 12), at(10)))?.id, 'waiting');
  });

  it('matches the repository however it is spelled', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));

    const found = await repository.findCoalescible(
      'board.set-fields',
      IssueRef.of(FIRST.toUpperCase(), 12),
      at(10),
    );
    assert.equal(found?.id, 'one');
  });

  it('passes over an action that is held, delayed, of another sort or on another issue', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'held', createdAt: at(0), hold: true }));
    await repository.insert(anAction({ id: 'delayed', createdAt: at(1), notBefore: at(90) }));
    await repository.insert(anAction({ id: 'other-kind', kind: 'board.verify', createdAt: at(2) }));
    await repository.insert(anAction({ id: 'other-issue', issue: 13, createdAt: at(3) }));

    assert.equal(await repository.findCoalescible('board.set-fields', IssueRef.of(FIRST, 12), at(10)), null);
    assert.equal(
      (await repository.findCoalescible('board.verify', IssueRef.of(FIRST, 12), at(10)))?.id,
      'other-kind',
      'the sort of work is part of the match, and this one is still waiting',
    );
  });

  it('offers nothing a worker has already taken', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));
    await repository.claimNextRunnable(at(1));

    assert.equal(await repository.findCoalescible('board.set-fields', IssueRef.of(FIRST, 12), at(10)), null);
  });

  it('lets later work on the issue run past a deferred action, and holds back only the kinds that wait for it', async (t) => {
    const repository = databaseIn(t)({ issueOrder: ISSUE_ORDER });
    await repository.insert(anAction({ id: 'deferred', kind: 'issue.comment', createdAt: at(0), notBefore: at(90) }));
    await repository.insert(anAction({ id: 'fields', createdAt: at(1) }));
    await repository.insert(anAction({ id: 'close', kind: 'issue.close', createdAt: at(2) }));

    const fields = await repository.claimNextRunnable(at(10));
    assert.equal(fields?.id, 'fields', 'a field write does not wait a fortnight for a comment put off');
    assert.ok(fields !== null);
    fields.succeed(at(11), 'written');
    await repository.update(fields);
    assert.equal(await repository.claimNextRunnable(at(12)), null, 'the close waits for the comment filed before it');

    const deferred = await repository.claimNextRunnable(at(90));
    assert.equal(deferred?.id, 'deferred');
    assert.ok(deferred !== null);
    deferred.succeed(at(91), 'posted');
    await repository.update(deferred);
    assert.equal((await repository.claimNextRunnable(at(92)))?.id, 'close');
  });

  it('holds back a later write of the same field or assignee behind a deferred one, so the older value never lands last', async (t) => {
    const repository = databaseIn(t)({ issueOrder: ISSUE_ORDER });
    const fields = (fieldValues: Record<string, string>) => ({ repo: FIRST, issue: 12, fields: fieldValues });
    const people = (add: string[], remove: string[]) => ({ repo: FIRST, issue: 12, add, remove });
    await repository.insert(anAction({ id: 'ready-for-qa', createdAt: at(0), notBefore: at(90),
      payload: fields({ status: 'Ready for QA' }) }));
    await repository.insert(anAction({ id: 'assign-later', kind: 'issue.assignees', createdAt: at(0), notBefore: at(90),
      payload: people(['Alice'], []) }));
    await repository.insert(anAction({ id: 'severity', createdAt: at(1), payload: fields({ severity: 'S2' }) }));
    await repository.insert(anAction({ id: 'bob', kind: 'issue.assignees', createdAt: at(2), payload: people(['bob'], []) }));
    await repository.insert(anAction({ id: 'correction', createdAt: at(3), payload: fields({ status: 'In Progress' }) }));
    await repository.insert(anAction({ id: 'unassign', kind: 'issue.assignees', createdAt: at(4),
      payload: people([], ['alice']) }));

    const ran: string[] = [];
    for (let claimed = await repository.claimNextRunnable(at(10)); claimed !== null;
      claimed = await repository.claimNextRunnable(at(10))) {
      ran.push(claimed.id);
      claimed.succeed(at(10), 'written');
      await repository.update(claimed);
    }

    assert.deepEqual(ran, ['severity', 'bob'], 'only the writes the deferred ones do not touch run now');
    assert.equal((await repository.claimNextRunnable(at(90)))?.id, 'ready-for-qa', 'come due, the deferred write runs first');
  });

  it('holds the issue behind a deferred action once its date has come, and behind one waiting out a failure', async (t) => {
    const repository = databaseIn(t)({ issueOrder: ISSUE_ORDER });
    await repository.insert(anAction({ id: 'deferred', createdAt: at(0), notBefore: at(5) }));
    await repository.insert(anAction({ id: 'first', issue: 41, createdAt: at(0) }));
    await repository.insert(anAction({ id: 'behind-due', kind: 'issue.comment', createdAt: at(1) }));
    await repository.insert(anAction({ id: 'behind-failure', kind: 'issue.comment', issue: 41, createdAt: at(1) }));
    const failing = await repository.claimNextRunnable(at(2));
    assert.equal(failing?.id, 'first');
    assert.ok(failing !== null);
    failing.failTransient(at(2), 'the API answered 502', 3, 600);
    await repository.update(failing);

    assert.equal((await repository.claimNextRunnable(at(6)))?.id, 'deferred', 'come due, it runs in its place');
    assert.equal(await repository.claimNextRunnable(at(6)), null, 'nothing overtakes it, nor an action waiting out a failure');
  });

  it('folds a later request into one that is still waiting', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));

    const folded = await repository.coalesceInto(
      'one',
      { repo: FIRST, issue: 12, fields: { severity: 'S1', module: 'Checkout' } },
      at(4),
      1,
    );

    assert.equal(folded, true);
    const read = await stored(repository, 'one');
    assert.deepEqual(read.payload, { repo: FIRST, issue: 12, fields: { severity: 'S1', module: 'Checkout' } });
    assert.equal(read.version, 2);
    assert.equal(read.updatedAt.getTime(), at(4).getTime());
  });

  it('changes nothing once a worker has claimed the action it would have folded into', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));
    await repository.claimNextRunnable(at(1));

    const folded = await repository.coalesceInto(
      'one',
      { repo: FIRST, issue: 12, fields: { severity: 'S1' } },
      at(4),
      1,
    );

    assert.equal(folded, false);
    const read = await stored(repository, 'one');
    assert.deepEqual(read.payload, { repo: FIRST, issue: 12, fields: { severity: 'S2' } });
    assert.equal(read.state, 'running');
  });

  it('changes nothing once somebody else has folded into the same action', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));
    // Another enqueuer read the row at version 1 and got its merge in first.
    await repository.coalesceInto('one', { repo: FIRST, issue: 12, fields: { module: 'Checkout' } }, at(3), 1);

    const folded = await repository.coalesceInto(
      'one',
      { repo: FIRST, issue: 12, fields: { severity: 'S1' } },
      at(4),
      1,
    );

    assert.equal(folded, false, 'a merge worked out from a version that is gone would drop the other caller');
    const read = await stored(repository, 'one');
    assert.deepEqual(read.payload, { repo: FIRST, issue: 12, fields: { module: 'Checkout' } });
  });

  it('changes nothing once the action it would have folded into has stepped into a wait', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));
    const waiting = await stored(repository, 'one');
    waiting.start(at(1));
    waiting.failTransient(at(2), 'the API was unreachable', 5, 600);
    await repository.update(waiting);

    const folded = await repository.coalesceInto(
      'one',
      { repo: FIRST, issue: 12, fields: { severity: 'S1' } },
      at(3),
      waiting.version,
    );

    assert.equal(folded, false, 'folding into a row in backoff would hide the request behind a delay');
    assert.deepEqual(
      (await stored(repository, 'one')).payload,
      { repo: FIRST, issue: 12, fields: { severity: 'S2' } },
    );
  });

  it('keeps an action a dead run left in hand, and lets the next run give it back', async (t) => {
    const open = databaseIn(t);
    const file = open();
    await file.insert(anAction({ id: 'in-hand', createdAt: at(0) }));
    await file.insert(anAction({ id: 'behind-it', kind: 'issue.comment', createdAt: at(1) }));
    assert.equal((await file.claimNextRunnable(at(2)))?.id, 'in-hand');

    // The run that held it is gone; everything it knew is on disk and nowhere else,
    // which is all a run that comes after it ever has to go on.
    const next = open();
    const abandoned = await next.list({ states: ['running'] });
    assert.deepEqual(abandoned.map((action) => action.id), ['in-hand']);
    assert.equal(
      await next.claimNextRunnable(at(3)),
      null,
      'nothing on that issue may run while the abandoned action sits there',
    );

    const first = abandoned[0];
    assert.ok(first !== undefined);
    first.requeue(at(3));
    await next.update(first);

    const again = await next.claimNextRunnable(at(4));
    assert.equal(again?.id, 'in-hand');
    assert.equal(again?.attempts, 1, 'the attempt the dead run charged is given back before it is charged again');
  });

  it('keeps the queue file to its owner', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-mode-'));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const file = path.join(dir, 'queue.db');
    const repository = new SqliteActionRepository(file);
    t.after(() => {
      repository.close();
    });
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('never writes a credential into the columns a listing reads', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));
    const action = await stored(repository, 'one');
    action.start(at(1));
    action.failTransient(at(2), 'the call was refused: Bearer ghs_cccccccccccccccccccccccccccccccccccc', 5, 60);
    await repository.update(action);

    const read = await stored(repository, 'one');
    assert.equal(read.lastError?.includes('ghs_'), false);
    assert.match(read.lastError ?? '', /\[redacted\]/);
  });

  it('hands out nothing until an action may run', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0), notBefore: at(60) }));

    assert.equal(await repository.claimNextRunnable(at(30)), null);
    assert.equal((await repository.claimNextRunnable(at(60)))?.id, 'one');
  });

  it('marks what it hands out as running, once', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0) }));

    const claimed = await repository.claimNextRunnable(at(1));
    assert.equal(claimed?.id, 'one');
    assert.equal(claimed?.state, 'running');
    assert.equal(claimed?.attempts, 1);

    const read = await stored(repository, 'one');
    assert.equal(read.state, 'running');
    assert.equal(read.version, 2);
    assert.equal(await repository.claimNextRunnable(at(2)), null);
  });

  it('keeps two actions on one issue in the order they were filed', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'comment', kind: 'issue.comment', createdAt: at(0) }));
    await repository.insert(anAction({ id: 'close', kind: 'issue.close', createdAt: at(1) }));
    await repository.insert(anAction({ id: 'elsewhere', issue: 99, createdAt: at(2) }));

    const first = await repository.claimNextRunnable(at(5));
    assert.equal(first?.id, 'comment');
    const second = await repository.claimNextRunnable(at(5));
    assert.equal(second?.id, 'elsewhere', 'another issue is not held up by this one');
    assert.equal(await repository.claimNextRunnable(at(5)), null);

    first?.succeed(at(6), 'posted');
    assert.ok(first !== null);
    await repository.update(first);

    assert.equal((await repository.claimNextRunnable(at(7)))?.id, 'close');
  });

  it('keeps an issue held behind a failed action, whenever it is asked', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'comment', kind: 'issue.comment', createdAt: at(0) }));
    await repository.insert(anAction({ id: 'close', kind: 'issue.close', createdAt: at(1) }));
    await repository.insert(anAction({ id: 'elsewhere', issue: 99, createdAt: at(2) }));

    await stopFirst(repository, 'failed', at(2));

    assert.equal((await stored(repository, 'comment')).state, 'failed');
    assert.equal((await repository.claimNextRunnable(at(3)))?.id, 'elsewhere', 'another issue is not held up');
    for (const minutes of [4, 60, 24 * 60]) {
      assert.equal(await repository.claimNextRunnable(at(minutes)), null, `nothing runs past it at ${String(minutes)}m`);
    }
    assert.equal((await stored(repository, 'close')).state, 'queued');
  });

  it('keeps an issue held behind a blocked action', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'comment', kind: 'issue.comment', createdAt: at(0) }));
    await repository.insert(anAction({ id: 'close', kind: 'issue.close', createdAt: at(1) }));

    await stopFirst(repository, 'blocked', at(2));

    assert.equal(await repository.claimNextRunnable(at(3)), null);
    assert.equal(await repository.claimNextRunnable(at(60)), null);
    assert.equal((await stored(repository, 'close')).state, 'queued');
  });

  it('runs the stopped action again first once it is retried, and what follows it after', async (t) => {
    for (const stop of ['failed', 'blocked'] as const) {
      const repository = databaseIn(t)();
      await repository.insert(anAction({ id: 'comment', kind: 'issue.comment', createdAt: at(0) }));
      await repository.insert(anAction({ id: 'close', kind: 'issue.close', createdAt: at(1) }));
      await stopFirst(repository, stop, at(2));

      const retried = await stored(repository, 'comment');
      retried.retry(at(3));
      await repository.update(retried);

      const again = await repository.claimNextRunnable(at(4));
      assert.equal(again?.id, 'comment', `the ${stop} action goes first again`);
      assert.equal(await repository.claimNextRunnable(at(4)), null, 'the close waits while the comment runs');
      assert.ok(again !== null);
      again.succeed(at(5), 'posted');
      await repository.update(again);

      assert.equal((await repository.claimNextRunnable(at(6)))?.id, 'close');
    }
  });

  it('lets the next action run once the stopped one before it is cancelled', async (t) => {
    for (const stop of ['failed', 'blocked'] as const) {
      const repository = databaseIn(t)();
      await repository.insert(anAction({ id: 'comment', kind: 'issue.comment', createdAt: at(0) }));
      await repository.insert(anAction({ id: 'close', kind: 'issue.close', createdAt: at(1) }));
      await stopFirst(repository, stop, at(2));

      const cancelled = await stored(repository, 'comment');
      cancelled.cancel(at(3));
      await repository.update(cancelled);

      assert.equal((await repository.claimNextRunnable(at(4)))?.id, 'close', `a cancelled ${stop} action holds nothing`);
    }
  });

  it('lets the next action run once the one before it has ended', async (t) => {
    for (const ending of ['done', 'skipped'] as const) {
      const repository = databaseIn(t)();
      await repository.insert(anAction({ id: 'first', createdAt: at(0) }));
      await repository.insert(anAction({ id: 'second', createdAt: at(1) }));

      const first = await repository.claimNextRunnable(at(2));
      assert.ok(first !== null);
      if (ending === 'done') {
        first.succeed(at(3), 'written');
      } else {
        first.skip(at(3), 'the condition did not hold');
      }
      await repository.update(first);

      assert.equal((await repository.claimNextRunnable(at(4)))?.id, 'second', `a ${ending} action holds nothing`);
    }
  });

  it('does not hold an issue behind a held action', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'held', createdAt: at(0), hold: true }));
    await repository.insert(anAction({ id: 'comment', kind: 'issue.comment', createdAt: at(1) }));

    assert.equal((await repository.claimNextRunnable(at(2)))?.id, 'comment');
  });

  it('orders actions that name no issue against each other only', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'first', ref: null, createdAt: at(0) }));
    await repository.insert(anAction({ id: 'second', ref: null, createdAt: at(1) }));
    await repository.insert(anAction({ id: 'on-an-issue', createdAt: at(2) }));

    assert.equal((await repository.claimNextRunnable(at(5)))?.id, 'first');
    assert.equal((await repository.claimNextRunnable(at(5)))?.id, 'on-an-issue');
    assert.equal(await repository.claimNextRunnable(at(5)), null);
  });

  it('counts every state, including the ones nothing is in', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'queued', createdAt: at(0), issue: 1 }));
    await repository.insert(anAction({ id: 'held', createdAt: at(1), issue: 2, hold: true }));
    const running = await repository.claimNextRunnable(at(2));
    assert.ok(running !== null);

    assert.deepEqual(await repository.counts(), {
      queued: 0,
      held: 1,
      running: 1,
      done: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      cancelled: 0,
    });
  });

  it('lists what was asked for, oldest first', async (t) => {
    const repository = databaseIn(t)();
    await repository.insert(anAction({ id: 'one', createdAt: at(0), issue: 1 }));
    await repository.insert(anAction({ id: 'two', kind: 'issue.comment', createdAt: at(1), issue: 2 }));
    await repository.insert(anAction({ id: 'three', ref: SECOND, createdAt: at(2), issue: 3, hold: true }));

    assert.deepEqual((await repository.list({})).map((action) => action.id), ['one', 'two', 'three']);
    assert.deepEqual((await repository.list({ limit: 2 })).map((action) => action.id), ['one', 'two']);
    assert.deepEqual((await repository.list({ states: ['held'] })).map((action) => action.id), ['three']);
    assert.deepEqual((await repository.list({ kind: 'issue.comment' })).map((action) => action.id), ['two']);
    assert.deepEqual((await repository.list({ issue: 3 })).map((action) => action.id), ['three']);
    assert.deepEqual(
      (await repository.list({ repo: SECOND.toLowerCase() })).map((action) => action.id),
      ['three'],
      'a repository matches whatever case it is asked in',
    );
    assert.deepEqual(await repository.list({ states: ['done'] }), []);
  });

  it('keeps each board\'s catalog apart, so one board\'s option ids never answer for another\'s', async (t) => {
    const open = databaseIn(t);
    const repository = open();
    const organisation: FieldCatalog = {
      projectId: 'project-org',
      fields: [{ id: 'field-org', name: 'Module', dataType: 'SINGLE_SELECT', options: [{ id: 'option-org', name: 'Checkout' }] }],
    };
    const person: FieldCatalog = {
      projectId: 'project-user',
      fields: [{ id: 'field-user', name: 'Module', dataType: 'SINGLE_SELECT', options: [{ id: 'option-user', name: 'onboarding' }] }],
    };

    await repository.putCatalog(ORG_BOARD, organisation, at(0));
    assert.equal(await repository.getCatalog(USER_BOARD), null, 'a board nobody read has no catalog');
    await repository.putCatalog(USER_BOARD, person, at(5));
    await repository.putCatalog(ORG_BOARD, organisation, at(10));

    const other = open();
    assert.deepEqual((await other.getCatalog(ORG_BOARD))?.catalog, organisation);
    assert.equal((await other.getCatalog(ORG_BOARD))?.fetchedAt.getTime(), at(10).getTime());
    assert.deepEqual((await other.getCatalog(USER_BOARD))?.catalog, person);
    assert.equal((await other.getCatalog(USER_BOARD))?.fetchedAt.getTime(), at(5).getTime());
  });

  it('keeps notes, a pause and a catalog between readers', async (t) => {
    const open = databaseIn(t);
    const repository = open();

    assert.equal(await repository.getMeta('lastTickAt'), null);
    await repository.setMeta('lastTickAt', '2026-01-01T09:00:00.000Z');
    await repository.setMeta('lastTickAt', '2026-01-01T09:05:00.000Z');
    assert.equal(await repository.getMeta('lastTickAt'), '2026-01-01T09:05:00.000Z');

    await repository.setPause(new QueuePause({ until: at(30), reason: 'the burst limiter said so', consecutiveHits: 2 }));
    const catalog: FieldCatalog = {
      projectId: 'project-1',
      fields: [{ id: 'field-1', name: 'Severity', dataType: 'SINGLE_SELECT', options: [{ id: 'option-1', name: 'S2 · broken' }] }],
    };
    await repository.putCatalog(TEST_BOARD, catalog, at(0));

    // A second reader of the same file sees all of it.
    const other = open();
    const pause = await other.getPause();
    assert.equal(pause?.until.getTime(), at(30).getTime());
    assert.equal(pause?.reason, 'the burst limiter said so');
    assert.equal(pause?.consecutiveHits, 2);
    const cached = await other.getCatalog(TEST_BOARD);
    assert.equal(cached?.fetchedAt.getTime(), at(0).getTime());
    assert.deepEqual(cached?.catalog, catalog);

    await repository.setPause(null);
    assert.equal(await other.getPause(), null);
  });

  it('lets one tick at a time run, and takes the lock back from one that will not finish', async (t) => {
    const open = databaseIn(t);
    const holder = open();
    const thirtyOneMinutesLater = { now: () => new Date(Date.now() + 31 * 60 * 1000) };

    const ran: string[] = [];
    const outcome = await holder.withTickLock(async () => {
      const live = open();
      assert.equal(await live.withTickLock(() => Promise.resolve('never')), null, 'a tick that is running holds it');

      const later = open({ clock: thirtyOneMinutesLater });
      await later.withTickLock(() => {
        ran.push('after the holder fell silent');
        return Promise.resolve(null);
      });

      const afterACrash = open({ processes: { here: () => new LocalProcessTable().here(), startOf: () => null } });
      await afterACrash.withTickLock(() => {
        ran.push('after the holder died');
        return Promise.resolve(null);
      });

      return 'the tick ran';
    });

    assert.equal(outcome, 'the tick ran');
    assert.deepEqual(ran, ['after the holder fell silent', 'after the holder died']);
    assert.equal(await holder.withTickLock(() => Promise.resolve('again')), 'again', 'the lock is given back');
  });

  /** A process table that counts ids in one named place and says each id started when the test says. */
  function table(here: string, startOf: (pid: number) => string | null): ProcessTable {
    return { here: () => here, startOf };
  }

  it('takes the lock from a dead holder whose id a restarted container handed to another process', async (t) => {
    const open = databaseIn(t);
    const container = 'tools-board-queue:pid:[4026532200]';
    // The holder that took the lock started at one moment; the process that carries the same id now started at another.
    const beforeTheRestart = open({ processes: table(container, () => '1000') });
    const afterTheRestart = open({ processes: table(container, () => '2000') });

    const ran: string[] = [];
    await beforeTheRestart.withTickLock(async () => {
      await afterTheRestart.withTickLock(() => {
        ran.push('the restarted process got the lock');
        return Promise.resolve(null);
      });
      return null;
    });

    assert.deepEqual(ran, ['the restarted process got the lock']);
  });

  it('leaves a holder counted in another place alone while its lease is fresh, and takes the lock once it lapses', async (t) => {
    const open = databaseIn(t);
    const clock = new FakeClock('2026-03-02T09:00:00.000Z');
    const inTheContainer = open({ clock, processes: table('host:pid:[4026532200]', () => '1000') });
    // From the machine around it, the container's processes cannot be seen at all.
    const onTheHost = open({ clock, processes: table('host:pid:[4026531836]', () => null) });

    const outcomes: (string | null)[] = [];
    await inTheContainer.withTickLock(async () => {
      outcomes.push(await onTheHost.withTickLock(() => Promise.resolve('while the lease is fresh')));
      clock.advanceMinutes(6);
      outcomes.push(await onTheHost.withTickLock(() => Promise.resolve('once the lease lapsed')));
      return null;
    });

    assert.deepEqual(outcomes, [null, 'once the lease lapsed']);
  });

  it('keeps the lock for a live holder that works longer than a lease, because it renews it', async (t) => {
    const open = databaseIn(t);
    const clock = new FakeClock('2026-03-02T09:00:00.000Z');
    const holder = open({ clock, lockRenewEveryMs: 10, processes: table('host:pid:[1]', () => '1000') });
    const elsewhere = open({ clock, processes: table('host:pid:[2]', () => null) });

    const outcome = await holder.withTickLock(async () => {
      clock.advanceMinutes(4);
      await delay(60);
      clock.advanceMinutes(4);
      return elsewhere.withTickLock(() => Promise.resolve('taken from a live holder'));
    });

    assert.equal(outcome, null);
    assert.equal(await elsewhere.withTickLock(() => Promise.resolve('given back')), 'given back');
  });

  it('still reads a lock written before holders said where and when they started', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-test-'));
    const file = path.join(dir, 'queue.db');
    const clock = new FakeClock('2026-03-02T09:00:00.000Z');
    const alive = new SqliteActionRepository(file, { clock, processes: table('anywhere', () => '1000') });
    const gone = new SqliteActionRepository(file, { clock, processes: table('anywhere', () => null) });
    const db = new DatabaseSync(file);
    t.after(() => {
      db.close();
      alive.close();
      gone.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    db.prepare('INSERT INTO queue_state (key, value) VALUES (?, ?)')
      .run('tick_lock', JSON.stringify({ pid: 4242, at: clock.now().toISOString() }));

    assert.equal(await alive.withTickLock(() => Promise.resolve('taken')), null);
    assert.equal(await gone.withTickLock(() => Promise.resolve('taken')), 'taken');
  });

  it('tells a holder its lease is lost once another pass took the lock, and keeps telling it', async (t) => {
    const open = databaseIn(t);
    const container = 'host:pid:[4026532200]';
    const holder = open({ processes: table(container, () => '1000') });
    // To this pass the holder's process looks restarted, so it takes the lock.
    const thief = open({ processes: table(container, () => '2000') });

    const seen = await holder.withTickLock(async (lease) => {
      const before = await lease.stillHeld();
      const stolen = await thief.withTickLock(async () => {
        const after = await lease.stillHeld();
        return { after, again: await lease.stillHeld() };
      });
      return { before, stolen, later: await lease.stillHeld() };
    });

    assert.deepEqual(seen, { before: true, stolen: { after: false, again: false }, later: false });
    assert.equal(
      await thief.withTickLock(() => Promise.resolve('free')),
      'free',
      'the holder that lost the lock did not release the other pass\'s holding',
    );
  });

  it('renews the lease each time the holder asks, so a pass that keeps asking keeps the lock', async (t) => {
    const clock = new FakeClock('2026-03-02T09:00:00.000Z');
    const open = databaseIn(t);
    const holder = open({ clock, lockRenewEveryMs: 60 * 60 * 1000, processes: table('host:pid:[1]', () => '1000') });
    const elsewhere = open({ clock, processes: table('host:pid:[2]', () => null) });

    const outcome = await holder.withTickLock(async (lease) => {
      clock.advanceMinutes(4);
      assert.equal(await lease.stillHeld(), true);
      clock.advanceMinutes(4);
      return elsewhere.withTickLock(() => Promise.resolve('taken from a holder that kept asking'));
    });

    assert.equal(outcome, null);
  });

  it('never takes the lock from a live holder of an older release, whatever language it wrote its start in', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-test-'));
    const file = path.join(dir, 'queue.db');
    const clock = new FakeClock('2026-03-02T09:00:00.000Z');
    const here = new LocalProcessTable().here();
    const current = new SqliteActionRepository(file, { clock });
    const db = new DatabaseSync(file);
    t.after(() => {
      db.close();
      current.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    // A live process — this one — that an older release ran under a Ukrainian locale.
    db.prepare('INSERT INTO queue_state (key, value) VALUES (?, ?)').run('tick_lock', JSON.stringify({
      pid: process.pid,
      started: 'Вт 10 лист. 19:41:47 2026',
      where: here,
      lease: 'older-lease',
      at: clock.now().toISOString(),
    }));

    assert.equal(await current.withTickLock(() => Promise.resolve('taken from a live holder')), null);
  });
});
