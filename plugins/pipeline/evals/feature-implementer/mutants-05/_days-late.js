import { daysBetween } from './calendar-days.js';

const isCalendarDay = (day) => {
  try {
    daysBetween(day, day);
    return true;
  } catch {
    return false;
  }
};

// The scorer's helper: counts the days late and refuses a bad day under the name lateFee's caller
// knows it by, as the repo law asks, so the reference and the mutants differ only where a mutant
// breaks its criterion.
export function daysLate(dueOn, returnedOn) {
  for (const [name, day] of [['dueOn', dueOn], ['returnedOn', returnedOn]]) {
    if (!isCalendarDay(day)) throw new RangeError(`${name} must be a calendar day written as YYYY-MM-DD`);
  }
  return daysBetween(dueOn, returnedOn);
}
