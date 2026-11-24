import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween } from '../../src/calendar-days.js';

test('days are counted forward and backward', () => {
  assert.equal(daysBetween('2026-03-10', '2026-03-15'), 5);
  assert.equal(daysBetween('2026-03-15', '2026-03-10'), -5);
  assert.equal(daysBetween('2026-03-10', '2026-03-10'), 0);
});

test('a daylight-saving change does not change the count', () => {
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
});

test('a day that does not exist is refused with the argument named', () => {
  assert.throws(() => daysBetween('2026-02-30', '2026-03-01'), { name: 'RangeError', message: /fromDay/ });
  assert.throws(() => daysBetween('2026-03-01', '1 March'), { name: 'RangeError', message: /toDay/ });
});
