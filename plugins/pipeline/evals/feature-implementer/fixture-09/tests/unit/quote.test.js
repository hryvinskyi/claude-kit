import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, QuoteRefused } from '../../src/quote.js';
import { LANGUAGES, message } from '../../src/messages.js';

const prices = [
  [1, 4.0],
  [1.01, 6.5],
  [2, 6.5],
  [3, 6.5],
  [4, 6.5],
  [5, 6.5],
  [5.01, 9.0],
  [10, 9.0],
  [10.01, 14.0],
];

for (const [weight, price] of prices) {
  test(`a parcel of ${weight} kg costs ${price}`, () => {
    assert.equal(quote({ weight, longestSide: 30 }), price);
  });
}

test('a parcel with no weight is refused', () => {
  assert.throws(() => quote({ weight: 0, longestSide: 30 }), (error) => error instanceof QuoteRefused && error.reason === 'no_weight');
});

test('the heaviest parcel carried is 30 kg', () => {
  assert.equal(quote({ weight: 30, longestSide: 30 }), 14.0);
  assert.throws(() => quote({ weight: 30.01, longestSide: 30 }), (error) => error instanceof QuoteRefused && error.reason === 'too_heavy');
});

test('a side of 120 cm makes a parcel oversize', () => {
  assert.equal(quote({ weight: 8, longestSide: 119 }), 9.0);
  assert.equal(quote({ weight: 8, longestSide: 120 }), 14.0);
});

test('express is charged on the oversize fee as well', () => {
  assert.equal(quote({ weight: 8, longestSide: 120, express: true }), 21.0);
});

// The wording of a refusal is part of the quote: a reason nobody worded would reach the customer as a code.
test('every quote refusal is worded in both languages', () => {
  for (const reason of ['no_weight', 'too_heavy']) {
    for (const language of LANGUAGES) {
      assert.notEqual(message(reason, language), reason);
    }
  }
});
