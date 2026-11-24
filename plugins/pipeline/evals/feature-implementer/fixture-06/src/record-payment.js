import { assertMinorUnits } from './money.js';

/**
 * Records a payment a member made at the desk.
 *
 * @param {{ memberId: string, amountMinor: number, ledger: { pay: (entry: { memberId: string, amountMinor: number }) => Promise<unknown> } }} payment
 * @returns {Promise<{ paidMinor: number }>} what was written to the member's account
 * @throws {RangeError} when the member is not named, or the amount is not a whole number above zero
 */
export async function recordPayment({ memberId, amountMinor, ledger }) {
  if (typeof memberId !== 'string' || memberId === '') {
    throw new RangeError('memberId must name a member');
  }
  assertMinorUnits(amountMinor, 'amountMinor');
  if (amountMinor === 0) {
    throw new RangeError('amountMinor must be more than nothing');
  }
  await ledger.pay({ memberId, amountMinor });
  return { paidMinor: amountMinor };
}
