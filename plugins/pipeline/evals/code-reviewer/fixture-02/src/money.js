/**
 * Refuses a value that is not a whole, non-negative number of minor units.
 *
 * @param {unknown} value the amount to check
 * @param {string} name the argument's name, carried in the error message
 * @returns {number} the value, unchanged
 * @throws {RangeError} when the value is not a non-negative safe integer
 */
export function assertMinorUnits(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative whole number of minor units`);
  }
  return value;
}
