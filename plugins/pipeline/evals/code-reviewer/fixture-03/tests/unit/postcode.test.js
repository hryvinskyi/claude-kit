import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, PostcodeRefused } from '../../src/postcode.js';

test('a postcode is stored without spaces, in upper case', () => {
  assert.equal(normalise(' ab1 2cd '), 'AB12CD');
});

test('a postcode of nothing but spaces is refused', () => {
  assert.throws(() => normalise('   '), (error) => error instanceof PostcodeRefused && error.reason === 'empty');
});

test('eight characters are stored, nine are refused', () => {
  assert.equal(normalise('ab12 cd34'), 'AB12CD34');
  assert.throws(() => normalise('ab12 cd345'), (error) => error instanceof PostcodeRefused && error.reason === 'too_long');
});
