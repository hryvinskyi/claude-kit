import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, send, typed } from './_app.js';

test('a clerk books a parcel: it is stored and answered with its id, price and collection day', async () => {
  const app = await boot();

  const answer = send(app, 'POST', '/parcels', { body: typed() });

  assert.deepEqual(answer, { status: 201, body: { id: 'P-1', price: 6.5, collectedOn: '2026-03-10' } });
  assert.equal(app.ledger.get('P-1').status, 'booked');
});

test('booking a parcel answers 201', async () => {
  const app = await boot();

  const answer = send(app, 'POST', '/parcels', { body: typed() });

  assert.equal(answer.status, 201);
  assert.ok(answer.body.id);
});

test('a second parcel with the same id is answered 409', async () => {
  const app = await boot();
  send(app, 'POST', '/parcels', { body: typed() });

  const answer = send(app, 'POST', '/parcels', { body: typed() });

  assert.deepEqual(answer, { status: 409, body: { error: 'duplicate' } });
  assert.equal(app.ledger.list().length, 1);
});

test('a postcode that cannot be stored is answered 422 with its reason', async () => {
  const app = await boot();

  const answer = send(app, 'POST', '/parcels', { body: typed({ postcode: '   ' }) });

  assert.deepEqual(answer, { status: 422, body: { error: 'empty', message: 'Enter a postcode.' } });
  assert.equal(app.ledger.list().length, 0);
});

test('a guest may not book a parcel', async () => {
  const app = await boot();

  const answer = app.handle({ method: 'POST', path: '/parcels', body: typed(), role: 'guest', token: 'x' });

  assert.equal(answer.status, 403);
});

test('a request without the session token is refused', async () => {
  const app = await boot();

  const answer = app.handle({ method: 'GET', path: '/parcels/P-1', role: 'clerk', token: 'not-the-token' });

  assert.deepEqual(answer, { status: 403, body: { error: 'forbidden' } });
});

test('a booked parcel is shown to its sender', async () => {
  const app = await boot();
  send(app, 'POST', '/parcels', { body: typed() });

  const answer = send(app, 'GET', '/parcels/P-1');

  assert.deepEqual(answer, { status: 200, body: { id: 'P-1', postcode: 'AB12CD', status: 'booked' } });
});

test('a parcel nobody booked is answered 404', async () => {
  const app = await boot();

  assert.deepEqual(send(app, 'GET', '/parcels/P-9'), { status: 404, body: { error: 'not_found' } });
});

test('an address nobody serves is answered 404', async () => {
  const app = await boot();

  assert.deepEqual(send(app, 'GET', '/drivers'), { status: 404, body: { error: 'not_found' } });
});
