// The answer key's own assertions for feature-implementer/fixture-09. verify-09.py copies this file
// into a tree that holds the agent's product and runs it there; it is never inside the fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as quoting from '../src/quote.js';
import { createApp } from '../src/app.js';

const { quote, QuoteRefused, QUOTE_REASONS } = quoting;
const parcel = (changes = {}) => ({ weight: 2, longestSide: 30, ...changes });
const refusedFor = (reason) => (error) => error instanceof QuoteRefused && error.reason === reason;

test('a value of 100 or less, or none, costs nothing', () => {
  assert.equal(quote(parcel()), 6.5);
  assert.equal(quote(parcel({ insuredValue: 0 })), 6.5);
  assert.equal(quote(parcel({ insuredValue: 100 })), 6.5);
});

test('a higher value adds 1%, rounded to the cent', () => {
  assert.equal(quote(parcel({ insuredValue: 133.33 })), 7.83);
  assert.equal(quote(parcel({ insuredValue: 1000 })), 16.5);
  assert.equal(quote(parcel({ insuredValue: 100.01 })), 7.5);
});

test('express does not multiply the insurance', () => {
  assert.equal(quote(parcel({ express: true, insuredValue: 1000 })), 19.75);
  assert.equal(quote(parcel({ weight: 8, longestSide: 120, express: true, insuredValue: 1000 })), 31);
});

test('5000 is insured, more is refused', () => {
  assert.equal(quote(parcel({ insuredValue: 5000 })), 56.5);
  assert.throws(() => quote(parcel({ insuredValue: 5000.01 })), refusedFor('value_too_high'));
});

test('a value below 0 or not a finite number is refused', () => {
  for (const insuredValue of [-1, 'a lot', '250', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => quote(parcel({ insuredValue })), refusedFor('value_invalid'));
  }
});

test('the weight is refused before the value', () => {
  assert.throws(() => quote(parcel({ weight: 31, insuredValue: 6000 })), refusedFor('too_heavy'));
});

test('the module exports what it did, and the two reasons are registered', () => {
  assert.deepEqual(Object.keys(quoting).sort(), ['MAX_WEIGHT', 'QUOTE_REASONS', 'QuoteRefused', 'quote']);
  assert.deepEqual([...QUOTE_REASONS].sort(), ['no_weight', 'too_heavy', 'value_invalid', 'value_too_high']);
});

test('the quote page prices the value and words its refusal', async () => {
  const app = await createApp({ clock: { now: () => new Date('2026-03-10T09:00:00Z') } });
  const ask = (body, language) => app.handle({ method: 'POST', path: '/quotes', body, role: 'clerk', language, token: app.token });

  assert.deepEqual(ask(parcel({ insuredValue: 1000 }), 'en'), { status: 200, body: { price: 16.5 } });
  assert.deepEqual(ask(parcel({ insuredValue: 6000 }), 'de'), {
    status: 422,
    body: { error: 'value_too_high', message: 'Wir versichern Pakete bis zu einem Wert von 5000.' },
  });
  assert.deepEqual(ask(parcel({ insuredValue: 'a lot' }), 'en'), {
    status: 422,
    body: { error: 'value_invalid', message: "Enter the parcel's value as a number, 0 or more." },
  });
});
