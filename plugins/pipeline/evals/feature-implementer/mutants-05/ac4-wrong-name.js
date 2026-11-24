import { assertMinorUnits } from './money.js';
import { daysLate as daysBetween } from './_days-late.js';

export function lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor }) {
  assertMinorUnits(dailyRateMinor, 'amount');
  assertMinorUnits(graceDays, 'amount');
  assertMinorUnits(capMinor, 'amount');
  const charged = Math.max(0, daysBetween(dueOn, returnedOn) - graceDays);
  return Math.min(capMinor, charged * dailyRateMinor);
}
