/**
 * A client of the branch ledger, the service that keeps what each member owes and has paid.
 *
 * @param {string} baseUrl where the ledger listens
 * @returns {{
 *   charge: (entry: { memberId: string, amountMinor: number, reason: string, loanId: string }) => Promise<unknown>,
 *   pay: (entry: { memberId: string, amountMinor: number }) => Promise<unknown>,
 *   entriesOf: (memberId: string) => Promise<Array<Record<string, unknown>>>,
 * }}
 */
export function createLedgerClient(baseUrl) {
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`the ledger answered ${response.status} to ${method} ${path}`);
    }
    return response.json();
  };
  const account = (memberId) => `/members/${encodeURIComponent(memberId)}`;

  return {
    charge: ({ memberId, amountMinor, reason, loanId }) =>
      call('POST', `${account(memberId)}/charges`, { amountMinor, reason, loanId }),
    pay: ({ memberId, amountMinor }) => call('POST', `${account(memberId)}/payments`, { amountMinor }),
    entriesOf: (memberId) => call('GET', `${account(memberId)}/entries`),
  };
}
