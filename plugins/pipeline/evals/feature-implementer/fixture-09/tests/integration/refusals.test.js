import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, send, typed } from './_app.js';

const refusals = [
  ['no_weight', { weight: 0 }],
  ['too_heavy', { weight: 31 }],
];

for (const path of ['/quotes', '/parcels']) {
  for (const [reason, changes] of refusals) {
    test(`POST ${path} refuses a parcel for ${reason}`, async () => {
      const app = await boot();

      const answer = send(app, 'POST', path, { body: typed(changes) });

      assert.equal(answer.status, 422);
      assert.equal(answer.body.error, reason);
    });
  }
}
