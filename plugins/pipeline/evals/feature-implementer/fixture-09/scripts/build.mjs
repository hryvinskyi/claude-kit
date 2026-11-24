// The build: every route of config/routes.json must name a handler that src/handlers.js exports.
// CI runs it before the tests, and a deploy runs it before the application starts.
import { readFileSync } from 'node:fs';
import * as handlers from '../src/handlers.js';

const routes = JSON.parse(readFileSync(new URL('../config/routes.json', import.meta.url), 'utf8'));
const broken = routes.filter((route) => typeof handlers[route.handler] !== 'function');
if (broken.length > 0) {
  for (const route of broken) {
    console.error(`${route.method} ${route.path} names the handler "${route.handler}", which src/handlers.js does not export`);
  }
  process.exit(1);
}
console.log(`build ok: ${routes.length} routes`);
