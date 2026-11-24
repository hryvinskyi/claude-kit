import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { match } from '../vendor/tiny-router/index.js';
import * as handlers from './handlers.js';
import { Ledger, DuplicateParcel } from './ledger.js';
import { QuoteRefused } from './quote.js';
import { PostcodeRefused } from './postcode.js';
import { message } from './messages.js';

const systemClock = Object.freeze({ now: () => new Date() });

/** What a refusal thrown by the rules is answered with, by the kind of refusal. */
const REFUSALS = Object.freeze([
  [QuoteRefused, (error, language) => ({ status: 422, body: { error: error.reason, message: message(error.reason, language) } })],
  [PostcodeRefused, (error, language) => ({ status: 422, body: { error: error.reason, message: message(error.reason, language) } })],
  [DuplicateParcel, () => ({ status: 409, body: { error: 'duplicate' } })],
]);

/**
 * Start the application: read the route table, open the ledger, issue the session token.
 *
 * @param {{ clock?: { now(): Date }, ledger?: Ledger }} [parts]
 * @returns {Promise<{ token: string, ledger: Ledger, handle(request: object): { status: number, body: object } }>}
 */
export async function createApp({ clock = systemClock, ledger = new Ledger() } = {}) {
  const routes = JSON.parse(await readFile(new URL('../config/routes.json', import.meta.url), 'utf8'));
  await wait(40); // stands for opening the ledger file and compiling the route table in the real deployment
  const token = randomUUID();

  return {
    token,
    ledger,
    handle(request) {
      if (request.token !== token) return { status: 403, body: { error: 'forbidden' } };
      const found = match(routes, request.method, request.path);
      if (found === null) return { status: 404, body: { error: 'not_found' } };
      try {
        return handlers[found.handler]({ ...request, params: found.params }, { ledger, clock });
      } catch (error) {
        const answer = REFUSALS.find(([kind]) => error instanceof kind);
        if (answer === undefined) throw error;
        return answer[1](error, request.language ?? 'en');
      }
    },
  };
}
