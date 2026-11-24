/**
 * The states of a parcel. The values are written into the ledger and read by the partner's
 * importer, so a changed value breaks every stored parcel.
 */
export const STATUS = Object.freeze({
  BOOKED: 'booked',
  COLLECTED: 'collected',
  DELIVERED: 'delivered',
  RETURNED: 'returned',
});

const NEXT = {
  booked: ['collected'],
  collected: ['delivered', 'returned'],
  delivered: [],
  returned: [],
};

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean} whether a parcel may move from one state to the other
 */
export function canMove(from, to) {
  return (NEXT[from] ?? []).includes(to);
}

/**
 * @param {string} status
 * @returns {boolean} whether nothing more happens to a parcel in this state
 */
export function isFinal(status) {
  return status in NEXT && NEXT[status].length === 0;
}
