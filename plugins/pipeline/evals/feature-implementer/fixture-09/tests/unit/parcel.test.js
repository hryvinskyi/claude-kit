import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parcel, publicView } from '../../src/parcel.js';

test('a parcel holds what it was given', () => {
  const parcel = new Parcel('P-1', 2, 30, 'AB12CD');

  assert.equal(parcel.id, 'P-1');
  assert.equal(parcel.weight, 2);
  assert.equal(parcel.longestSide, 30);
});

test("a parcel's postcode is stored the way postcodes are stored", () => {
  assert.equal(new Parcel('P-1', 2, 30, 'ab1 2cd').postcode, 'AB12CD');
});

test('a parcel without an id is refused', () => {
  assert.throws(() => new Parcel('  ', 2, 30, 'AB12CD'), /needs an id/);
});

test('the sender is shown the id, the postcode and the state', () => {
  const parcel = new Parcel('P-1', 2, 30, 'AB12CD');

  assert.deepEqual(publicView(parcel, 'booked'), { id: 'P-1', postcode: 'AB12CD', status: 'booked' });
});

test('the sender is never shown the depot note', () => {
  const parcel = new Parcel('P-1', 2, 30, 'AB12CD');

  const shown = JSON.stringify(publicView(parcel, 'booked'));

  assert.equal(shown.includes('leave with the neighbour'), false);
});
