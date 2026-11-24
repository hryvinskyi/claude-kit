import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lateFee } from '../src/late-fee.js';

const loan = { dueOn: '2026-03-10', dailyRateMinor: 50, graceDays: 0, capMinor: 500 };

test('a loan returned on or before its due date costs nothing', () => {
  assert.equal(lateFee({ ...loan, returnedOn: '2026-03-10' }), 0);
  assert.equal(lateFee({ ...loan, returnedOn: '2026-03-02' }), 0);
});

test('grace days are not charged', () => {
  assert.equal(lateFee({ ...loan, returnedOn: '2026-03-15' }), 250);
});

test('a loan returned inside its grace period costs nothing', () => {
  assert.equal(lateFee({ ...loan, graceDays: 3, returnedOn: '2026-03-12' }), 0);
});
