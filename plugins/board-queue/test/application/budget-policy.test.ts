import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetPolicy } from '../../src/application/budget-policy.ts';
import {
  CredentialRejected,
  IssueNotFound,
  PrimaryRateLimited,
  ReadbackMismatch,
  SecondaryRateLimited,
  TransientFailure,
} from '../../src/domain/errors.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';
import { testConfig } from '../fixtures/config.ts';

const NOW = new Date('2026-01-10T09:00:00.000Z');
const RESET = new Date('2026-01-10T09:40:00.000Z');

function policy(): BudgetPolicy {
  return new BudgetPolicy(testConfig.worker);
}

function budget(remaining: number): RateBudget {
  return new RateBudget({ resource: 'graphql', remaining, limit: 5000, used: 5000 - remaining, resetAt: RESET });
}

describe('BudgetPolicy deciding whether another action may start', () => {
  it('allows a start while there is room in the allowance and in the tick', () => {
    assert.deepEqual(policy().mayStart(budget(4000), 39), { ok: true });
  });

  it('stops once the tick has run as many actions as one tick may', () => {
    const decision = policy().mayStart(budget(4000), 40);
    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /40/);
  });

  it('stops below the floor, naming what is left, the floor and when it comes back', () => {
    const decision = policy().mayStart(budget(99), 0);
    assert.equal(decision.ok, false);
    const reason = decision.ok ? '' : decision.reason;
    assert.match(reason, /99/);
    assert.match(reason, /100/);
    assert.match(reason, /2026-01-10T09:40:00.000Z/);
  });

  it('treats the floor itself as room enough', () => {
    assert.deepEqual(policy().mayStart(budget(100), 0), { ok: true });
  });

  it('stops when the allowance could not be read at all', () => {
    const decision = policy().mayStart(null, 0);
    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /unknown/);
  });
});

describe('BudgetPolicy deciding how long the queue waits', () => {
  it('waits out the hourly allowance, with a little slack past the reset', () => {
    const pause = policy().pauseFor(new PrimaryRateLimited(RESET), 0, NOW);
    assert.ok(pause !== null);
    assert.equal(pause.until.getTime(), RESET.getTime() + 5000);
    assert.match(pause.reason, /allowance/);
  });

  it('doubles the burst wait per consecutive refusal, from the count it is handed', () => {
    const waits = [0, 1, 2, 3].map((hits) => {
      const pause = policy().pauseFor(new SecondaryRateLimited(null), hits, NOW);
      assert.ok(pause !== null);
      return (pause.until.getTime() - NOW.getTime()) / 1000;
    });
    assert.deepEqual(waits, [120, 240, 480, 960]);
  });

  it('never doubles past the cap, and never waits less than the API asked for', () => {
    const capped = policy().pauseFor(new SecondaryRateLimited(null), 10, NOW);
    assert.equal((capped?.until.getTime() ?? 0) - NOW.getTime(), 3600 * 1000);

    const asked = policy().pauseFor(new SecondaryRateLimited(300), 0, NOW);
    assert.equal((asked?.until.getTime() ?? 0) - NOW.getTime(), 300 * 1000);
    assert.match(asked?.reason ?? '', /300/);
  });

  it('counts this refusal into the wait it leaves behind', () => {
    assert.equal(policy().pauseFor(new SecondaryRateLimited(null), 2, NOW)?.consecutiveHits, 3);
  });

  it('waits a quarter of an hour for a credential nobody here can mend', () => {
    const pause = policy().pauseFor(new CredentialRejected('the board catalog'), 0, NOW);
    assert.ok(pause !== null);
    assert.equal(pause.until.getTime() - NOW.getTime(), 15 * 60 * 1000);
    assert.match(pause.reason, /credential/);
  });

  it('leaves the queue running for a failure that is the action own business', () => {
    for (const error of [
      new TransientFailure('a 502 from the API'),
      new IssueNotFound('example-org/first-repo#12'),
      new ReadbackMismatch('Severity', 'S2', 'S1'),
    ]) {
      assert.equal(policy().pauseFor(error, 0, NOW), null, error.category);
    }
  });
});

describe('BudgetPolicy deciding the waits and the reports', () => {
  it('doubles the wait after a failure that may pass, up to a quarter of an hour', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 10].map((attempts) => policy().backoffSec(attempts)),
      [30, 60, 120, 240, 480, 900, 900],
    );
  });

  it('never asks for a shorter wait than the first one', () => {
    assert.equal(policy().backoffSec(0), 30);
  });

  it('reports only when the last one is old enough and there is allowance to spare', () => {
    const sixHoursAgo = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
    const nearlySixHoursAgo = new Date(NOW.getTime() - 5.9 * 60 * 60 * 1000);
    assert.equal(policy().shouldAudit(sixHoursAgo, NOW, budget(2000)), true);
    assert.equal(policy().shouldAudit(nearlySixHoursAgo, NOW, budget(2000)), false);
    assert.equal(policy().shouldAudit(sixHoursAgo, NOW, budget(999)), false);
    assert.equal(policy().shouldAudit(sixHoursAgo, NOW, null), false);
  });

  it('reports at the first chance when it never has', () => {
    assert.equal(policy().shouldAudit(null, NOW, budget(2000)), true);
    assert.equal(policy().shouldAudit(null, NOW, budget(10)), false);
  });
});
