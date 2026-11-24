import { writeFileSync } from 'node:fs';

/**
 * Write the ledger as a CSV file the depot opens in a spreadsheet.
 *
 * @param {import('./ledger.js').Ledger} ledger
 * @param {string} path where to write it
 */
export function exportCsv(ledger, path) {
  const lines = ['id,weight,longest_side,postcode,status'];
  for (const { parcel, status } of ledger.list()) {
    lines.push([parcel.id, parcel.weight, parcel.longestSide, parcel.postcode, status].join(','));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}
