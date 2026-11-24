import { normalise } from './postcode.js';

/** A parcel that was handed in. */
export class Parcel {
  /**
   * @param {string} id the id printed on the label
   * @param {number} weight kilograms
   * @param {number} longestSide centimetres
   * @param {string} postcode where it goes, as typed
   * @param {string} [internalNote] a note for the depot, never shown to the sender
   */
  constructor(id, weight, longestSide, postcode, internalNote = '') {
    if (id.trim() === '') throw new Error('A parcel needs an id');
    this.id = id;
    this.weight = weight;
    this.longestSide = longestSide;
    this.postcode = normalise(postcode);
    this.internalNote = internalNote;
  }
}

/**
 * What the sender is shown of a parcel.
 *
 * @param {Parcel} parcel
 * @param {string} status
 * @returns {{ id: string, postcode: string, status: string }}
 */
export function publicView(parcel, status) {
  return { id: parcel.id, postcode: parcel.postcode, status };
}
