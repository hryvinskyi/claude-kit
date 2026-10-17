import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExecutionContext } from '../../src/domain/kinds/action-kind.ts';
import { CloseKind } from '../../src/domain/kinds/close.ts';
import { CommentKind } from '../../src/domain/kinds/comment.ts';
import { ReadbackMismatch, RefusedByRule } from '../../src/domain/errors.ts';
import { FieldRequest } from '../../src/domain/field-request.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { applyFields } from '../../src/domain/kinds/fields.ts';
import { marker } from '../../src/domain/kinds/posts.ts';
import { VerifyKind } from '../../src/domain/kinds/verify.ts';
import { FakeBoardGateway, seedItem } from '../fakes/fake-board-gateway.ts';
import type { SeededItem } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import type { SeededIssue } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { boardCatalog } from '../fixtures/board.ts';
import { testConfig } from '../fixtures/config.ts';

const FIRST = 'example-org/first-repo';
const FILED = new Date('2026-01-10T09:00:00.000Z');
const twelve = IssueRef.of(FIRST, 12);

type Stage = {
  ctx: ExecutionContext;
  board: FakeBoardGateway;
  issues: FakeIssueGateway;
  sleeper: FakeSleeper;
};

function stage(options: {
  items?: readonly SeededItem[];
  issues?: readonly SeededIssue[];
  actionId?: string;
  enqueuedAt?: Date;
} = {}): Stage {
  const clock = new FakeClock(FILED);
  const sleeper = new FakeSleeper(clock);
  const board = new FakeBoardGateway({ catalog: boardCatalog(), items: options.items ?? [], clock });
  const issues = new FakeIssueGateway(options.issues ?? []);
  return {
    ctx: {
      board,
      issues,
      clock,
      sleeper,
      paceMs: 1500,
      refusedStatus: testConfig.refusedStatus,
      actionId: options.actionId ?? 'a-1',
      enqueuedAt: options.enqueuedAt ?? FILED,
    },
    board,
    issues,
    sleeper,
  };
}

describe('the comment kind', () => {
  it('posts the body with the signature that keeps it from being posted twice', async () => {
    const it_ = stage({ issues: [{ ref: twelve }] });
    const result = await new CommentKind().execute({ repo: FIRST, issue: 12, body: 'the fix is live' }, it_.ctx);

    assert.equal(it_.issues.posted.length, 1);
    assert.equal(it_.issues.posted[0]?.body, `the fix is live${marker('a-1')}`);
    assert.match(result.summary, /issuecomment-/);
  });

  it('adopts what an earlier run already posted and writes nothing', async () => {
    const it_ = stage({
      issues: [{ ref: twelve, comments: [{ body: `the fix is live${marker('a-1')}`, createdAt: FILED }] }],
    });

    const result = await new CommentKind().execute({ repo: FIRST, issue: 12, body: 'the fix is live' }, it_.ctx);

    assert.equal(it_.issues.posted.length, 0);
    assert.match(result.summary, /already there/);
    assert.match(result.summary, /issuecomment-1/);
  });

  it('never adopts a comment another action signed', async () => {
    const it_ = stage({
      issues: [{ ref: twelve, comments: [{ body: `something else${marker('a-2')}`, createdAt: FILED }] }],
    });

    await new CommentKind().execute({ repo: FIRST, issue: 12, body: 'the fix is live' }, it_.ctx);

    assert.equal(it_.issues.posted.length, 1);
  });

  it('reads only the comments written since the action was filed', async () => {
    const before = new Date(FILED.getTime() - 60_000);
    const it_ = stage({
      issues: [{ ref: twelve, comments: [{ body: `an older one${marker('a-1')}`, createdAt: before }] }],
    });

    await new CommentKind().execute({ repo: FIRST, issue: 12, body: 'the fix is live' }, it_.ctx);

    assert.equal(it_.issues.posted.length, 1);
  });
});

describe('the close kind', () => {
  it('leaves the evidence, closes the issue and reads the state back', async () => {
    const it_ = stage({ issues: [{ ref: twelve }] });

    const result = await new CloseKind().execute(
      { repo: FIRST, issue: 12, reason: 'completed', comment: 'shipped in 1.4.2' },
      it_.ctx,
    );

    assert.deepEqual(it_.issues.closed, [{ ref: 'example-org/first-repo#12', reason: 'completed' }]);
    assert.equal(it_.issues.stateOf(twelve), 'closed');
    assert.match(result.summary, /commented/);
    assert.match(result.summary, /closed as completed/);
    // The comment and the close are two writes, and they are paced apart.
    assert.deepEqual(it_.sleeper.slept, [1500]);
    assert.deepEqual(it_.issues.calls, ['listComments', 'comment', 'get', 'close', 'get']);
  });

  it('leaves an issue that is already closed alone, and needs no second look at it', async () => {
    const it_ = stage({ issues: [{ ref: twelve, state: 'closed' }] });

    const result = await new CloseKind().execute({ repo: FIRST, issue: 12, reason: 'completed' }, it_.ctx);

    assert.equal(it_.issues.closed.length, 0);
    assert.deepEqual(it_.issues.calls, ['get']);
    assert.match(result.summary, /already closed/);
  });

  it('refuses to call it closed when the issue still reads open', async () => {
    const it_ = stage({ issues: [{ ref: twelve }] });
    it_.issues.closesStick = false;

    await assert.rejects(
      () => new CloseKind().execute({ repo: FIRST, issue: 12, reason: 'completed' }, it_.ctx),
      (error: unknown) => error instanceof ReadbackMismatch && error.actual === 'open',
    );
  });
});

describe('the verify kind', () => {
  const values = (row: Record<string, string>): SeededItem[] => [seedItem(twelve, 'item-7', row)];

  it('accepts the status the queue may never write, because reading it is the point', async () => {
    const it_ = stage({ items: values({ Status: 'Done', Severity: 'S2 · broken · no workaround' }) });

    const result = await new VerifyKind(testConfig).execute(
      { repo: FIRST, issue: 12, expect: { status: 'Done' } },
      it_.ctx,
    );

    assert.deepEqual(result.readback, { Status: 'Done' });
    assert.equal(it_.board.written.length, 0);
    assert.equal(it_.board.ensured.length, 0);
  });

  it('matches an expectation by its first letters, exactly as a write is matched', async () => {
    const it_ = stage({ items: values({ Severity: 'S2 · broken · no workaround' }) });

    const result = await new VerifyKind(testConfig).execute(
      { repo: FIRST, issue: 12, expect: { severity: 'S2' } },
      it_.ctx,
    );

    assert.deepEqual(result.readback, { Severity: 'S2 · broken · no workaround' });
  });

  it('confirms an absence without being told what to compare', async () => {
    const it_ = stage();

    const result = await new VerifyKind(testConfig).execute({ repo: FIRST, issue: 12, onBoard: false }, it_.ctx);

    assert.match(result.summary, /not on the board, as expected/);
    assert.equal(it_.board.written.length, 0);
  });

  it('reports a row where it was told there should be none', async () => {
    const it_ = stage({ items: values({ Status: 'Todo' }) });

    await assert.rejects(
      () => new VerifyKind(testConfig).execute({ repo: FIRST, issue: 12, onBoard: false }, it_.ctx),
      (error: unknown) => error instanceof ReadbackMismatch && error.actual === 'on the board',
    );
  });

  it('reports both texts when the board says something else', async () => {
    const it_ = stage({ items: values({ Severity: 'S1 · blocking' }) });

    await assert.rejects(
      () => new VerifyKind(testConfig).execute({ repo: FIRST, issue: 12, expect: { severity: 'S2' } }, it_.ctx),
      (error: unknown) => error instanceof ReadbackMismatch
        && error.expected === 'S2 · broken · no workaround'
        && error.actual === 'S1 · blocking',
    );
  });

  it('reports an empty field as nothing rather than as a blank', async () => {
    const it_ = stage({ items: values({}) });

    await assert.rejects(
      () => new VerifyKind(testConfig).execute({ repo: FIRST, issue: 12, expect: { severity: 'S2' } }, it_.ctx),
      (error: unknown) => error instanceof ReadbackMismatch && error.actual === 'nothing',
    );
  });

  it('reports an issue that is missing from the board', async () => {
    const it_ = stage();

    await assert.rejects(
      () => new VerifyKind(testConfig).execute({ repo: FIRST, issue: 12, expect: { severity: 'S2' } }, it_.ctx),
      (error: unknown) => error instanceof ReadbackMismatch
        && error.field === 'membership'
        && error.actual === 'absent',
    );
  });

  it('confirms an issue that is meant to stay off the board, and reports one that did not', async () => {
    const away = stage();
    const result = await new VerifyKind(testConfig).execute(
      { repo: FIRST, issue: 12, expect: { severity: 'S2' }, onBoard: false },
      away.ctx,
    );
    assert.match(result.summary, /not on the board/);

    const there = stage({ items: values({ Severity: 'S2 · broken · no workaround' }) });
    await assert.rejects(
      () => new VerifyKind(testConfig).execute(
        { repo: FIRST, issue: 12, expect: { severity: 'S2' }, onBoard: false },
        there.ctx,
      ),
      (error: unknown) => error instanceof ReadbackMismatch && error.actual === 'on the board',
    );
  });
});

describe('the last guard before a board write', () => {
  it('refuses a value that resolves to the status the board closes issues on', async () => {
    const it_ = stage({ items: [seedItem(twelve, 'item-7', {})] });
    // A request that was not built through the write rules — which is what a
    // payload filed before the configuration named that status looks like when a
    // worker finally reaches it. The text in a payload is not the value that
    // lands on the board; the option it resolves to is, and that is what the
    // board's own automation would react to.
    const request = FieldRequest.forRead({ Status: 'Done' }, testConfig);

    await assert.rejects(
      () => applyFields(twelve, request, it_.ctx),
      (error: unknown) => error instanceof RefusedByRule && /auto-close/.test(error.describe()),
    );
    assert.equal(it_.board.written.length, 0);
    assert.equal(it_.board.ensured.length, 0, 'nothing reached the board at all');
  });

  it('writes a value that only shares a letter with it', async () => {
    const it_ = stage({ items: [seedItem(twelve, 'item-7', {})] });

    const readback = await applyFields(twelve, FieldRequest.forRead({ Status: 'In Rev' }, testConfig), it_.ctx);

    assert.deepEqual(readback, { Status: 'In Review' });
  });
});
