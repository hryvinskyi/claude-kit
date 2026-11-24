import { STATUS, canMove } from './status.js';

/** A second parcel was handed in under an id the ledger already holds. */
export class DuplicateParcel extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`parcel ${id} is already in the ledger`);
    this.name = 'DuplicateParcel';
    this.id = id;
  }
}

/** A parcel was asked to move to a state it cannot reach from where it is. */
export class IllegalMove extends Error {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    super(`a parcel cannot move from ${from} to ${to}`);
    this.name = 'IllegalMove';
  }
}

/** Every parcel handed in, with the state it is in. */
export class Ledger {
  /** @type {Map<string, { parcel: import('./parcel.js').Parcel, status: string }>} */
  #entries = new Map();

  /**
   * @param {import('./parcel.js').Parcel} parcel
   * @throws {DuplicateParcel} when the id is already held
   */
  add(parcel) {
    if (this.#entries.has(parcel.id)) throw new DuplicateParcel(parcel.id);
    this.#entries.set(parcel.id, { parcel, status: STATUS.BOOKED });
  }

  /**
   * @param {string} id
   * @returns {{ parcel: import('./parcel.js').Parcel, status: string } | null}
   */
  get(id) {
    return this.#entries.get(id) ?? null;
  }

  /** @returns {Array<{ parcel: import('./parcel.js').Parcel, status: string }>} in the order handed in */
  list() {
    return [...this.#entries.values()];
  }

  /**
   * @param {string} id
   * @param {string} to
   * @throws {IllegalMove} when the parcel cannot reach that state from where it is
   */
  move(id, to) {
    const entry = this.#entries.get(id);
    if (!canMove(entry.status, to)) throw new IllegalMove(entry.status, to);
    entry.status = to;
  }

  /** @returns {string[]} the ids of the parcels a driver holds and has not yet delivered */
  outForDelivery() {
    return this.list().filter((entry) => entry.status === STATUS.COLLECTED).map((entry) => entry.parcel.id);
  }
}
