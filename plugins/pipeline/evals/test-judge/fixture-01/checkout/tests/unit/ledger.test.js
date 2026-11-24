import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, DuplicateParcel, IllegalMove } from '../../src/ledger.js';
import { Parcel } from '../../src/parcel.js';

const parcel = (id) => new Parcel(id, 2, 30, 'AB12CD');

test('a new parcel starts booked', () => {
  const ledger = new Ledger();
  ledger.add(parcel('P-1'));

  assert.equal(ledger.get('P-1').status, 'booked');
});

test('a second parcel with the same id is refused', () => {
  const ledger = new Ledger();
  ledger.add(parcel('P-1'));

  assert.throws(() => ledger.add(parcel('P-1')), DuplicateParcel);
  assert.equal(ledger.list().length, 1);
});

test('parcels are listed in the order they were handed in', () => {
  const ledger = new Ledger();
  ledger.add(parcel('P-2'));
  ledger.add(parcel('P-1'));

  assert.deepEqual(ledger.list().map((entry) => entry.parcel.id), ['P-2', 'P-1']);
});

test('a parcel cannot skip a step', () => {
  const ledger = new Ledger();
  ledger.add(parcel('P-1'));

  assert.throws(() => ledger.move('P-1', 'delivered'), IllegalMove);
  assert.equal(ledger.get('P-1').status, 'booked');
});

test('only a collected parcel is out for delivery', () => {
  const ledger = new Ledger();
  ledger.add(parcel('P-1'));
  ledger.add(parcel('P-2'));
  ledger.add(parcel('P-3'));
  ledger.move('P-2', 'collected');
  ledger.move('P-3', 'collected');
  ledger.move('P-3', 'delivered');

  assert.deepEqual(ledger.outForDelivery(), ['P-2']);
});
