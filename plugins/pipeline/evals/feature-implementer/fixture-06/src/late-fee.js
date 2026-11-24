import { assertMinorUnits } from './money.js';
import { daysBetween } from './calendar-days.js';

/**
 * Counts the days a loan came back after its due day, refusing a bad day under the name the caller
 * gave it.
 *
 * @param {string} dueOn the day the loan was due, `YYYY-MM-DD`
 * @param {string} returnedOn the day it came back, `YYYY-MM-DD`
 * @returns {number} the signed number of days; negative for an early return
 * @throws {RangeError} when either day is not a real calendar day
 */
function daysLate(dueOn, returnedOn) {
  for (const [name, day] of [['dueOn', dueOn], ['returnedOn', returnedOn]]) {
    try {
      daysBetween(day, day);
    } catch {
      throw new RangeError(`${name} must be a calendar day written as YYYY-MM-DD`);
    }
  }
  return daysBetween(dueOn, returnedOn);
}

/**
 * The fee for a loan returned late: the daily rate for each day past the grace days, never more
 * than the cap.
 *
 * @param {{ dueOn: string, returnedOn: string, dailyRateMinor: number, graceDays: number, capMinor: number }} loan
 * @returns {number} the fee in minor units
 * @throws {RangeError} when a day is not a calendar day, or a rate, the grace days or the cap is
 *   not a whole non-negative number
 */
export function lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor }) {
  assertMinorUnits(dailyRateMinor, 'dailyRateMinor');
  assertMinorUnits(graceDays, 'graceDays');
  assertMinorUnits(capMinor, 'capMinor');
  const charged = Math.max(0, daysLate(dueOn, returnedOn) - graceDays);
  return Math.min(capMinor, charged * dailyRateMinor);
}
