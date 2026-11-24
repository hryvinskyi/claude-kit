import { assertMinorUnits } from './money.js';
import { daysLate as daysBetween } from './_days-late.js';

export function lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor }) {
  assertMinorUnits(dailyRateMinor, 'dailyRateMinor');
  assertMinorUnits(graceDays, 'graceDays');
  assertMinorUnits(capMinor, 'capMinor');
  const late = daysBetween(dueOn, returnedOn);
  const charged = late === 0 && graceDays === 0 ? 1 : Math.max(0, late - graceDays);
  return Math.min(capMinor, charged * dailyRateMinor);
}
