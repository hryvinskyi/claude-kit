import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, canMove, isFinal } from '../../src/status.js';

test('the stored values of the states are the published ones', () => {
  assert.deepEqual({ ...STATUS }, { BOOKED: 'booked', COLLECTED: 'collected', DELIVERED: 'delivered', RETURNED: 'returned' });
});

test('the states are written in lower case', () => {
  for (const value of Object.values(STATUS)) {
    assert.equal(value, value.toLowerCase());
  }
});

const finality = [
  ['booked', false],
  ['collected', false],
  ['delivered', true],
  ['returned', true],
];

for (const [status, final] of finality) {
  test(`${status} is ${final ? 'the end of the road' : 'not the end of the road'}`, () => {
    assert.equal(isFinal(status), final);
  });
}

test('a parcel moves only along the allowed steps', () => {
  assert.equal(canMove('booked', 'collected'), true);
  assert.equal(canMove('booked', 'delivered'), false);
  assert.equal(canMove('collected', 'delivered'), true);
  assert.equal(canMove('collected', 'returned'), true);
  assert.equal(canMove('delivered', 'returned'), false);
});

test('a state nobody defined ends nothing and leads nowhere', () => {
  assert.equal(isFinal('lost'), false);
  assert.equal(canMove('lost', 'booked'), false);
});
