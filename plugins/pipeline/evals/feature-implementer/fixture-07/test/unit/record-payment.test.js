import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPayment } from '../../src/record-payment.js';

const recordingLedger = () => {
  const sent = [];
  return { sent, pay: async (entry) => { sent.push(entry); } };
};

test('a payment is sent to the ledger once, as it was given', async () => {
  const ledger = recordingLedger();

  const result = await recordPayment({ memberId: 'm-1', amountMinor: 700, ledger });

  assert.deepEqual(ledger.sent, [{ memberId: 'm-1', amountMinor: 700 }]);
  assert.deepEqual(result, { paidMinor: 700 });
});

test('a payment of nothing, or by nobody, is refused before the ledger is asked', async () => {
  const ledger = recordingLedger();

  await assert.rejects(recordPayment({ memberId: 'm-1', amountMinor: 0, ledger }), { name: 'RangeError', message: /amountMinor/ });
  await assert.rejects(recordPayment({ memberId: '', amountMinor: 700, ledger }), { name: 'RangeError', message: /memberId/ });

  assert.deepEqual(ledger.sent, []);
});
