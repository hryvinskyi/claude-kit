import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lateFee } from '../../src/late-fee.js';

const loan = { dueOn: '2026-03-10', dailyRateMinor: 50, graceDays: 0, capMinor: 500 };

test('a loan returned on its due date or earlier costs nothing', () => {
  assert.equal(lateFee({ ...loan, returnedOn: '2026-03-10' }), 0);
  assert.equal(lateFee({ ...loan, returnedOn: '2026-03-01' }), 0);
});

test('each day past the grace days costs the daily rate, up to the cap', () => {
  assert.equal(lateFee({ ...loan, graceDays: 2, returnedOn: '2026-03-15' }), 150);
  assert.equal(lateFee({ ...loan, returnedOn: '2026-04-09' }), 500);
});

test('a rate, grace days or a cap that is not a whole non-negative number is refused by name', () => {
  for (const name of ['dailyRateMinor', 'graceDays', 'capMinor']) {
    assert.throws(() => lateFee({ ...loan, returnedOn: '2026-03-12', [name]: -1 }), { name: 'RangeError', message: new RegExp(name) });
  }
});
