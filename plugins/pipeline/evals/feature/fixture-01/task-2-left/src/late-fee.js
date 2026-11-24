import { assertMinorUnits } from './money.js';

const MS_A_DAY = 86_400_000;

export function lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor }) {
  assertMinorUnits(dailyRateMinor, 'dailyRateMinor');
  const late = Math.round((new Date(returnedOn) - new Date(dueOn)) / MS_A_DAY);
  if (late <= 0) {
    return 0;
  }
  return late * dailyRateMinor;
}
