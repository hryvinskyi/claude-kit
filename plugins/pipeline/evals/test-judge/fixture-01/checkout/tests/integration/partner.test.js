import { test } from 'node:test';
import assert from 'node:assert/strict';

const sandbox = process.env.PARTNER_SANDBOX_URL;

test('a delivered parcel is reported to the partner', { skip: sandbox ? false : 'the partner sandbox is not reachable' }, async () => {
  const response = await fetch(`${sandbox}/deliveries`, { method: 'POST', body: JSON.stringify({ id: 'P-1' }) });

  assert.equal(response.status, 202);
});
