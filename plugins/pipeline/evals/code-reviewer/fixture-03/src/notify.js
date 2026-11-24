import { label } from './messages.js';

/**
 * Tell the recipient that the driver has the parcel.
 *
 * @param {{ mailer: { send(to: string, text: string): void }, log(line: string): void }} ports
 * @param {import('./parcel.js').Parcel} parcel
 * @param {string} recipient
 * @param {string} language
 */
export function notifyCollected({ mailer, log }, parcel, recipient, language) {
  log(`notify collected ${parcel.id}`);
  mailer.send(recipient, `${label('collected', language)}: ${parcel.id}`);
}
