import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ledger, ledgerUnavailable } from '../support/ledger.js';
import { recordPayment } from '../../src/record-payment.js';

const skip = (await ledgerUnavailable()) ?? false;

test("a recorded payment appears in the member's ledger", { skip }, async () => {
  const memberId = `member-${randomUUID()}`;

  await recordPayment({ memberId, amountMinor: 700, ledger: ledger() });

  const entries = await ledger().entriesOf(memberId);
  assert.deepEqual(
    entries.map(({ kind, amountMinor }) => ({ kind, amountMinor })),
    [{ kind: 'payment', amountMinor: 700 }],
  );
});
