/** The heaviest parcel that is carried, in kilograms. */
export const MAX_WEIGHT = 30;

/** Price bands: a parcel up to and including the weight costs the price. */
const BANDS = [[1, 4.0], [5, 6.5], [10, 9.0], [MAX_WEIGHT, 14.0]];

/** A parcel whose longest side reaches this many centimetres is oversize. */
const OVERSIZE_FROM = 120;
const OVERSIZE_FEE = 5.0;
const EXPRESS_FACTOR = 1.5;

/** A declared value up to this is insured for free. */
const INSURED_FREE_UP_TO = 100;
/** The share of a higher declared value that its insurance costs. */
const INSURED_RATE = 0.01;
/** The highest declared value that is insured. */
const INSURED_AT_MOST = 5000;

/** The reasons a quote is refused for. Each is a code the client matches on. */
export const QUOTE_REASONS = Object.freeze(['no_weight', 'too_heavy', 'value_too_high', 'value_invalid']);

/** A quote that cannot be given. */
export class QuoteRefused extends Error {
  /**
   * @param {string} reason one of QUOTE_REASONS
   * @throws {TypeError} when the reason is not a registered one
   */
  constructor(reason) {
    if (!QUOTE_REASONS.includes(reason)) throw new TypeError(`not a reason a quote is refused for: ${reason}`);
    super(`quote refused: ${reason}`);
    this.name = 'QuoteRefused';
    this.reason = reason;
  }
}

/** An amount rounded to the cent. */
const cents = (amount) => Math.round(amount * 100) / 100;

/**
 * What insuring a declared value costs, before rounding.
 *
 * @param {unknown} value the declared value
 * @returns {number}
 * @throws {QuoteRefused} when the value is not a finite number of 0 or more, or is higher than is insured
 */
function insurance(value) {
  if (!Number.isFinite(value) || value < 0) throw new QuoteRefused('value_invalid');
  if (value > INSURED_AT_MOST) throw new QuoteRefused('value_too_high');
  if (value <= INSURED_FREE_UP_TO) return 0;
  return value * INSURED_RATE;
}

/**
 * The price of carrying a parcel, with the insurance of its declared value.
 *
 * @param {{ weight: number, longestSide: number, express?: boolean, insuredValue?: number }} parcel weight in kilograms, longest side in centimetres
 * @returns {number} the price
 * @throws {QuoteRefused} when the parcel has no weight, is heavier than is carried, or its declared value cannot be insured
 */
export function quote({ weight, longestSide, express = false, insuredValue = 0 }) {
  if (!(weight > 0)) throw new QuoteRefused('no_weight');
  if (weight > MAX_WEIGHT) throw new QuoteRefused('too_heavy');
  let price = BANDS.find(([upTo]) => weight <= upTo)[1];
  if (longestSide >= OVERSIZE_FROM) price += OVERSIZE_FEE;
  if (express) price = cents(price * EXPRESS_FACTOR);
  return cents(price + insurance(insuredValue));
}
