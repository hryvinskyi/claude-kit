import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMinorUnits } from '../src/money.js';

test('a whole non-negative amount passes through unchanged', () => {
  assert.equal(assertMinorUnits(0, 'price'), 0);
  assert.equal(assertMinorUnits(1250, 'price'), 1250);
});

test('a fraction, a negative or a non-number is refused with the argument named', () => {
  for (const bad of [1.5, -1, Number.NaN, '10', null]) {
    assert.throws(() => assertMinorUnits(bad, 'price'), { name: 'RangeError', message: /price/ });
  }
});
