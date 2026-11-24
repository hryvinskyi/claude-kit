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

test('the quote page prices the declared value', async () => {
  const app = await boot();

  const answer = send(app, 'POST', '/quotes', { body: { weight: 2, longestSide: 30, insuredValue: 1000 } });

  assert.deepEqual(answer, { status: 200, body: { price: 16.5 } });
});

const insured = [
  [100, 6.5],
  [100.01, 7.5],
  [5000, 56.5],
];

for (const [insuredValue, price] of insured) {
  test(`the quote page prices a parcel worth ${insuredValue} at ${price}`, async () => {
    const app = await boot();

    const answer = send(app, 'POST', '/quotes', { body: { weight: 2, longestSide: 30, insuredValue } });

    assert.deepEqual(answer, { status: 200, body: { price } });
  });
}

const refused = [
  [6000, 'value_too_high'],
  [-1, 'value_invalid'],
  ['a lot', 'value_invalid'],
];

for (const [insuredValue, reason] of refused) {
  test(`the quote page refuses a declared value of ${insuredValue}`, async () => {
    const app = await boot();

    const answer = send(app, 'POST', '/quotes', { body: { weight: 2, longestSide: 30, insuredValue } });

    assert.equal(answer.status, 422);
    assert.equal(answer.body.error, reason);
  });
}
