const LONGEST = 8;

/** The reasons a postcode is refused for. Each is a code the client matches on. */
export const POSTCODE_REASONS = Object.freeze(['empty', 'too_long']);

/** A postcode that cannot be used. */
export class PostcodeRefused extends Error {
  /**
   * @param {string} reason one of POSTCODE_REASONS
   * @throws {TypeError} when the reason is not a registered one
   */
  constructor(reason) {
    if (!POSTCODE_REASONS.includes(reason)) throw new TypeError(`not a reason a postcode is refused for: ${reason}`);
    super(`postcode refused: ${reason}`);
    this.name = 'PostcodeRefused';
    this.reason = reason;
  }
}

/**
 * A postcode as it is stored: no spaces, upper case.
 *
 * @param {string} text the postcode as typed
 * @returns {string} the stored form
 * @throws {PostcodeRefused} when nothing is left, or more than eight characters are
 */
export function normalise(text) {
  const stored = text.replace(/\s+/g, '').toUpperCase();
  if (stored === '') throw new PostcodeRefused('empty');
  if (stored.length > LONGEST) throw new PostcodeRefused('too_long');
  return stored;
}
