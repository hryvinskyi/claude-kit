import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lateFee } from '../src/late-fee.js';

const loan = { dueOn: '2026-03-10', dailyRateMinor: 50, graceDays: 0, capMinor: 10_000 };

test('a loan returned on its due date costs nothing', () => {
  assert.equal(lateFee({ ...loan, returnedOn: '2026-03-10' }), 0);
});

test('a loan returned five days late is charged for each day', () => {
  assert.equal(lateFee({ ...loan, graceDays: 2, returnedOn: '2026-03-15' }), 250);
});
