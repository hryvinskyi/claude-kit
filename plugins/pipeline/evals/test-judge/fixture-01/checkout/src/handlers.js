import { Parcel, publicView } from './parcel.js';
import { quote } from './quote.js';
import { collectionDay } from './schedule.js';
import { label } from './messages.js';
import { STATUS } from './status.js';

/** POST /quotes — the price of carrying a parcel. */
export function quoteParcel({ body }) {
  return { status: 200, body: { price: quote(body) } };
}

/** POST /parcels — a clerk hands a parcel in. */
export function bookParcel({ body, role }, { ledger, clock }) {
  if (role !== 'clerk') return { status: 403, body: { error: 'forbidden' } };
  const parcel = new Parcel(body.id, body.weight, body.longestSide, body.postcode, body.internalNote);
  const price = quote(body);
  ledger.add(parcel);
  return { status: 201, body: { id: parcel.id, price, collectedOn: collectionDay(clock) } };
}

/** GET /parcels/:id — what the sender is shown. */
export function showParcel({ params }, { ledger }) {
  const entry = ledger.get(params.id);
  if (entry === null) return { status: 404, body: { error: 'not_found' } };
  return { status: 200, body: publicView(entry.parcel, entry.status) };
}

/** GET /labels/:status — the name of a state on the tracking page. */
export function showLabel({ params, language }) {
  if (!Object.values(STATUS).includes(params.status)) return { status: 404, body: { error: 'not_found' } };
  return { status: 200, body: { label: label(params.status, language) } };
}
