import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, send } from './_app.js';

test('a quote is answered with the price', async () => {
  const app = await boot();

  const answer = send(app, 'POST', '/quotes', { body: { weight: 2, longestSide: 30 } });

  assert.deepEqual(answer, { status: 200, body: { price: 6.5 } });
});

test('a refused quote is answered 422 with its reason, worded for the reader', async () => {
  const app = await boot();

  const answer = send(app, 'POST', '/quotes', { body: { weight: 31, longestSide: 30 }, language: 'de' });

  assert.deepEqual(answer, { status: 422, body: { error: 'too_heavy', message: 'Wir befördern Pakete bis 30 kg.' } });
});
