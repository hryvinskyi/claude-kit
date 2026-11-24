import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as handlers from '../../src/handlers.js';

// A route that names a handler nobody wrote answers 500 on its first request, so the table is
// held to the handlers here, where the mistake is made.
test('every route names a handler that exists', () => {
  const routes = JSON.parse(readFileSync(new URL('../../config/routes.json', import.meta.url), 'utf8'));

  assert.ok(routes.length > 0);
  for (const route of routes) {
    assert.equal(typeof handlers[route.handler], 'function', `${route.method} ${route.path}`);
  }
});
