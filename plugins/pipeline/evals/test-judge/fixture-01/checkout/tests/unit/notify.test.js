import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyCollected } from '../../src/notify.js';
import { Parcel } from '../../src/parcel.js';

const parcel = new Parcel('P-7', 2, 30, 'AB12CD');

test('the recipient gets one message that names the parcel, in their language', () => {
  const sent = [];
  const ports = { mailer: { send: (to, text) => sent.push({ to, text }) }, log: () => {} };

  notifyCollected(ports, parcel, 'jo@example.test', 'de');

  assert.deepEqual(sent, [{ to: 'jo@example.test', text: 'Abgeholt: P-7' }]);
});

test('the notice is logged before it is sent', () => {
  const calls = [];
  const ports = { mailer: { send: () => calls.push('send') }, log: (line) => calls.push(`log ${line}`) };

  notifyCollected(ports, parcel, 'jo@example.test', 'en');

  assert.deepEqual(calls, ['log notify collected P-7', 'send']);
});
