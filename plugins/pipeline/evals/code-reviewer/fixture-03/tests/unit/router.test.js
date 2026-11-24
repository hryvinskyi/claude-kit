import { test } from 'node:test';
import assert from 'node:assert/strict';
import { match } from '../../vendor/tiny-router/index.js';

const routes = [{ method: 'GET', path: '/parcels/:id', handler: 'showParcel' }];

test('a path parameter is read from the address', () => {
  assert.deepEqual(match(routes, 'GET', '/parcels/P-1'), { handler: 'showParcel', params: { id: 'P-1' } });
});

test('an address with one segment too many matches nothing', () => {
  assert.equal(match(routes, 'GET', '/parcels/P-1/label'), null);
});
