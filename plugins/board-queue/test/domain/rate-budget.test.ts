import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateBudget } from '../../src/domain/rate-budget.ts';

function headersOf(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name] ?? null;
}

describe('RateBudget', () => {
  it('reads the headers and counts the reset in seconds', () => {
    const budget = RateBudget.fromHeaders(headersOf({
      'x-ratelimit-remaining': '4321',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-used': '679',
      'x-ratelimit-reset': '1789000000',
      'x-ratelimit-resource': 'graphql',
    }));
    assert.ok(budget !== null);
    assert.equal(budget.resource, 'graphql');
    assert.equal(budget.remaining, 4321);
    assert.equal(budget.limit, 5000);
    assert.equal(budget.used, 679);
    assert.equal(budget.resetAt.getTime(), 1789000000 * 1000);
    assert.equal(budget.describe(), `graphql 4321/5000 until ${new Date(1789000000000).toISOString()}`);
  });

  it('answers nothing when the headers carry no allowance', () => {
    assert.equal(RateBudget.fromHeaders(headersOf({})), null);
    assert.equal(RateBudget.fromHeaders(headersOf({ 'x-ratelimit-reset': '1789000000' })), null);
    assert.equal(RateBudget.fromHeaders(headersOf({ 'x-ratelimit-remaining': '10' })), null);
    assert.equal(
      RateBudget.fromHeaders(headersOf({ 'x-ratelimit-remaining': 'many', 'x-ratelimit-reset': '1' })),
      null,
    );
  });

  it('accounts anything that is not the graph against the other allowance', () => {
    const rest = RateBudget.fromHeaders(headersOf({
      'x-ratelimit-remaining': '10',
      'x-ratelimit-reset': '1789000000',
      'x-ratelimit-resource': 'core',
    }));
    const unnamed = RateBudget.fromHeaders(headersOf({
      'x-ratelimit-remaining': '10',
      'x-ratelimit-reset': '1789000000',
    }));
    assert.equal(rest?.resource, 'core');
    assert.equal(unnamed?.resource, 'core');
  });

  it('works out what it can when only part of the headers are there', () => {
    const budget = RateBudget.fromHeaders(headersOf({
      'x-ratelimit-remaining': '900',
      'x-ratelimit-limit': '1000',
      'x-ratelimit-reset': '1789000000',
    }));
    assert.equal(budget?.used, 100);
  });

  it('knows when it is spent and when it is below a floor', () => {
    const budget = new RateBudget({
      resource: 'graphql',
      remaining: 99,
      limit: 5000,
      used: 4901,
      resetAt: new Date('2026-09-16T14:00:00.000Z'),
    });
    assert.ok(!budget.isExhausted());
    assert.ok(budget.belowFloor(100));
    assert.ok(!budget.belowFloor(99));
    assert.ok(new RateBudget({ ...budget, remaining: 0 }).isExhausted());
  });
});
