import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionDay } from '../../src/schedule.js';

const at = (time) => ({ now: () => new Date(`2026-03-10T${time}:00Z`) });

test('a parcel booked before five is collected the same day', () => {
  assert.equal(collectionDay(at('16:59')), '2026-03-10');
});

test('a parcel booked at five is collected the next day', () => {
  assert.equal(collectionDay(at('17:00')), '2026-03-11');
});
