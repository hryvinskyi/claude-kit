/** The heaviest parcel that is carried, in kilograms. */
export const MAX_WEIGHT = 30;

/** Price bands: a parcel up to and including the weight costs the price. */
const BANDS = [[1, 4.0], [5, 6.5], [10, 9.0], [MAX_WEIGHT, 14.0]];

/** A parcel whose longest side reaches this many centimetres is oversize. */
const OVERSIZE_FROM = 120;
const OVERSIZE_FEE = 5.0;
const EXPRESS_FACTOR = 1.5;

/** A quote that cannot be given; `reason` is a code the client matches on. */
export class QuoteRefused extends Error {
  /** @param {'no_weight' | 'too_heavy'} reason */
  constructor(reason) {
    super(`quote refused: ${reason}`);
    this.name = 'QuoteRefused';
    this.reason = reason;
  }
}

/**
 * The price of carrying a parcel.
 *
 * @param {{ weight: number, longestSide: number, express?: boolean }} parcel weight in kilograms, longest side in centimetres
 * @returns {number} the price
 * @throws {QuoteRefused} when the parcel has no weight or is heavier than is carried
 */
export function quote({ weight, longestSide, express = false }) {
  if (!(weight > 0)) throw new QuoteRefused('no_weight');
  if (weight > MAX_WEIGHT) throw new QuoteRefused('too_heavy');
  let price = BANDS.find(([upTo]) => weight <= upTo)[1];
  if (longestSide >= OVERSIZE_FROM) price += OVERSIZE_FEE;
  if (express) price = Math.round(price * EXPRESS_FACTOR * 100) / 100;
  return price;
}
