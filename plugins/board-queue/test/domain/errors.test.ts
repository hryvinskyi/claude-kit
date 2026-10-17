import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AmbiguousOption,
  BoardQueueError,
  IllegalTransition,
  InvalidIssueRef,
  IssueNotFound,
  OptionNotFound,
  PrimaryRateLimited,
  ReadbackMismatch,
  RefusedByRule,
  SecondaryRateLimited,
  StaleAction,
  TransientFailure,
  UnknownKind,
} from '../../src/domain/errors.ts';

const resetAt = new Date('2026-09-16T14:00:00.000Z');

describe('the error taxonomy', () => {
  it('gives every failure a category the worker can decide from', () => {
    const cases: [BoardQueueError, string][] = [
      [new PrimaryRateLimited(resetAt), 'primary-rate-limited'],
      [new SecondaryRateLimited(60), 'secondary-rate-limited'],
      [new OptionNotFound('Module', 'Checkout', ['Cart']), 'option-not-found'],
      [new AmbiguousOption('Severity', 'S', ['S1', 'S2'], ['S1', 'S2']), 'ambiguous-option'],
      [new IssueNotFound('example-org/first-repo#3'), 'issue-not-found'],
      [new ReadbackMismatch('Status', 'In Progress', 'Backlog'), 'readback-mismatch'],
      [new TransientFailure('a 502 from the API'), 'transient-failure'],
      [new RefusedByRule('no'), 'refused-by-rule'],
      [new InvalidIssueRef('nonsense'), 'invalid-issue-ref'],
      [new IllegalTransition('a-1', 'done', 'start'), 'illegal-transition'],
      [new UnknownKind('board.magic', ['board.verify']), 'unknown-kind'],
      [new StaleAction('a-1', 4), 'stale-action'],
    ];
    for (const [error, category] of cases) {
      assert.ok(error instanceof BoardQueueError);
      assert.ok(error instanceof Error);
      assert.equal(error.category, category);
      assert.equal(error.name, error.constructor.name);
      assert.ok(error.describe().length > 0);
      assert.ok(!error.describe().includes('\n'), 'describe() stays one line');
    }
  });

  it('says what a person needs in order to act', () => {
    assert.ok(new PrimaryRateLimited(resetAt).describe().includes(resetAt.toISOString()));
    assert.ok(new SecondaryRateLimited(90).describe().includes('90s'));
    assert.ok(new SecondaryRateLimited(null).describe().includes('no waiting time'));
    assert.ok(new OptionNotFound('Module', 'Chekout', ['Cart', 'Catalog']).describe().includes('Cart, Catalog'));
    assert.ok(new AmbiguousOption('Severity', 'S', ['S1', 'S2'], ['S1', 'S2']).describe().includes('S1, S2'));
    assert.ok(new ReadbackMismatch('Status', 'In Progress', 'Backlog').describe().includes('Backlog'));
    assert.ok(new UnknownKind('board.magic', ['board.verify']).describe().includes('board.verify'));
    assert.ok(new StaleAction('a-1', 4).describe().includes('a-1'));
  });

  it('keeps the facts a caller may want to branch on', () => {
    assert.equal(new PrimaryRateLimited(resetAt).resetAt.getTime(), resetAt.getTime());
    assert.equal(new SecondaryRateLimited(null).retryAfterSec, null);
    assert.deepEqual(new OptionNotFound('Module', 'x', ['Cart']).accepted, ['Cart']);
    assert.deepEqual(new AmbiguousOption('Severity', 'S', ['S1'], ['S1']).matches, ['S1']);
    assert.equal(new IssueNotFound('example-org/first-repo#3').ref, 'example-org/first-repo#3');
    assert.equal(new TransientFailure('a 502 from the API').cause, 'a 502 from the API');
    assert.equal(new RefusedByRule('no').text, 'no');
    assert.equal(new IllegalTransition('a-1', 'done', 'start').transition, 'start');
    assert.equal(new StaleAction('a-1', 4).expectedVersion, 4);
  });
});
