import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, send } from './_app.js';

const prices = [
  [1, 4.0],
  [5, 6.5],
  [5.01, 9.0],
  [30, 14.0],
];

for (const [weight, price] of prices) {
  test(`the quote page prices a parcel of ${weight} kg at ${price}`, async () => {
    const app = await boot();

    const answer = send(app, 'POST', '/quotes', { body: { weight, longestSide: 30 } });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.price, price);
  });
}
