import { assertMinorUnits } from './money.js';
import { daysBetween } from './calendar-days.js';

/**
 * The fee a member pays for returning a loan late: each day after the due date costs the daily
 * rate, the first grace days are free, and a loan returned on or before its due date costs nothing.
 *
 * @param {{ dueOn: string, returnedOn: string, dailyRateMinor: number, graceDays: number, capMinor: number }} loan
 * @returns {number} the fee in minor units
 * @throws {RangeError} when the rate, the grace days or the cap is not a whole non-negative number
 */
export function lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor }) {
  assertMinorUnits(dailyRateMinor, 'dailyRateMinor');
  assertMinorUnits(graceDays, 'graceDays');
  assertMinorUnits(capMinor, 'capMinor');
  const chargedDays = Math.max(0, daysBetween(dueOn, returnedOn) - graceDays);
  return chargedDays * dailyRateMinor;
}
