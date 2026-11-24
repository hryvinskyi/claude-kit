import en from './messages/en.js';
import de from './messages/de.js';

const CATALOGUES = Object.freeze({ en, de });

/** The languages the product ships. */
export const LANGUAGES = Object.freeze(Object.keys(CATALOGUES));

/**
 * Every key the product words.
 *
 * @returns {string[]}
 */
export function keys() {
  return Object.keys(CATALOGUES.en);
}

/**
 * A message in the reader's language.
 *
 * @param {string} key
 * @param {string} language
 * @returns {string} the wording, or the key itself when the language has none
 */
export function message(key, language) {
  return CATALOGUES[language]?.[key] ?? key;
}

/**
 * The name of a state as a sender reads it.
 *
 * @param {string} status
 * @param {string} language
 * @returns {string}
 */
export function label(status, language) {
  return message(`label.${status}`, language);
}
