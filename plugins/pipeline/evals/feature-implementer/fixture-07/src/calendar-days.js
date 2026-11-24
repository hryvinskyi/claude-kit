const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * Reads an ISO calendar day as the number of days since 1970-01-01, in UTC, so that a
 * daylight-saving change between two days never shortens or lengthens the count.
 *
 * @param {string} isoDay a day as `YYYY-MM-DD`
 * @param {string} name the argument's name, carried in the error message
 * @returns {number} days since the epoch
 * @throws {RangeError} when the text is not a real calendar day
 */
function dayNumber(isoDay, name) {
  const match = typeof isoDay === 'string' ? ISO_DAY.exec(isoDay) : null;
  if (match === null) {
    throw new RangeError(`${name} must be a calendar day written as YYYY-MM-DD`);
  }
  const [, year, month, day] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw new RangeError(`${name} must be a calendar day written as YYYY-MM-DD`);
  }
  return utc / MS_PER_DAY;
}

/**
 * Counts the calendar days from one day to another: positive when `toDay` is later, negative
 * when it is earlier, zero on the same day.
 *
 * @param {string} fromDay the first day, `YYYY-MM-DD`
 * @param {string} toDay the second day, `YYYY-MM-DD`
 * @returns {number} the signed number of days
 * @throws {RangeError} when either day is not a real calendar day
 */
export function daysBetween(fromDay, toDay) {
  return dayNumber(toDay, 'toDay') - dayNumber(fromDay, 'fromDay');
}
