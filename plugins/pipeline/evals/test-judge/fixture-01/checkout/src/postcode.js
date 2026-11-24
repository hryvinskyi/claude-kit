const LONGEST = 8;

/** A postcode that cannot be used; `reason` is a code the client matches on. */
export class PostcodeRefused extends Error {
  /** @param {'empty' | 'too_long'} reason */
  constructor(reason) {
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
