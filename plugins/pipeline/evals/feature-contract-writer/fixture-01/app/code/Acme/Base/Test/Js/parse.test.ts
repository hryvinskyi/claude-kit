import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, int, str } from '../../view/frontend/web/ts/parse.ts';

test('a string passes through unchanged', () => {
  assert.equal(str('abc', '$.name'), 'abc');
});

test('a number where a string belongs is a contract error naming its path', () => {
  assert.throws(() => str(1, '$.name'), (error: unknown) => error instanceof ContractError && error.path === '$.name');
});

test('an integer passes; a fraction is refused', () => {
  assert.equal(int(1250, '$.amount'), 1250);
  assert.throws(() => int(12.5, '$.amount'), ContractError);
});
