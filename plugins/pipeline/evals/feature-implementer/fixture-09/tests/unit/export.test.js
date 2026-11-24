import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportCsv } from '../../src/export.js';
import { Ledger } from '../../src/ledger.js';
import { Parcel } from '../../src/parcel.js';

test('the export holds a heading and one line for each parcel', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'acme-parcel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = new Ledger();
  ledger.add(new Parcel('P-1', 2, 30, 'AB12CD'));
  ledger.add(new Parcel('P-2', 12.5, 140, 'EF34GH'));
  ledger.move('P-2', 'collected');

  exportCsv(ledger, join(directory, 'ledger.csv'));

  assert.equal(
    readFileSync(join(directory, 'ledger.csv'), 'utf8'),
    'id,weight,longest_side,postcode,status\nP-1,2,30,AB12CD,booked\nP-2,12.5,140,EF34GH,collected\n',
  );
});
