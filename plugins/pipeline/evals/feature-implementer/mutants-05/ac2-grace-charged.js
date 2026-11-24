import { assertMinorUnits } from './money.js';
import { daysLate as daysBetween } from './_days-late.js';

export function lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor }) {
  assertMinorUnits(dailyRateMinor, 'dailyRateMinor');
  assertMinorUnits(graceDays, 'graceDays');
  assertMinorUnits(capMinor, 'capMinor');
  const late = daysBetween(dueOn, returnedOn);
  const charged = late <= graceDays ? 0 : late;
  return Math.min(capMinor, charged * dailyRateMinor);
}
