import { createLedgerClient } from '../../src/ledger-client.js';

export const LEDGER_URL = process.env.LEDGER_URL ?? 'http://127.0.0.1:48107';

/**
 * Says why the ledger cannot be used right now, or null when it answers. An integration test
 * passes the answer to its `skip` option, so a run without the stack says what it did not check.
 *
 * @returns {Promise<string | null>}
 */
export async function ledgerUnavailable() {
  try {
    const response = await fetch(`${LEDGER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? null : `the ledger at ${LEDGER_URL} answered ${response.status}`;
  } catch {
    return `the ledger at ${LEDGER_URL} is not reachable: the stack is not running`;
  }
}

/** @returns {ReturnType<typeof createLedgerClient>} a client of the ledger the stack runs */
export function ledger() {
  return createLedgerClient(LEDGER_URL);
}
