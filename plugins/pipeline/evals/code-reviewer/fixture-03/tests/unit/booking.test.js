import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookParcel } from '../../src/handlers.js';

test('booking a parcel answers its id', () => {
  const held = [];
  const ledger = { add: (parcel) => held.push(parcel) };
  const clock = { now: () => new Date('2026-03-10T09:00:00Z') };

  const answer = bookParcel(
    { role: 'clerk', body: { id: 'P-1', weight: 2, longestSide: 30, postcode: 'AB12CD' } },
    { ledger, clock },
  );

  assert.equal(answer.status, 201);
  assert.equal(answer.body.id, 'P-1');
});
