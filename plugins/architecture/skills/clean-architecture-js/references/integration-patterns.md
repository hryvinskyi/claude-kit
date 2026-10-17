# Integration patterns — the network, seen from the client

Every call a browser (or a Node service) makes crosses a process boundary it does not control: the request can be slow, fail, succeed twice, or answer after the user has moved on. This file is the client-side companion of `clean-architecture-php/references/integration-patterns.md` — the server makes duplicates harmless; the client makes sure it sends them honestly and never shows a stale answer as the current one.

Placement is the first thing to review:

| Piece | Layer | Why |
|---|---|---|
| The *decision* (apply the coupon, reserve the slot) | Use case | an application action |
| The port (`CouponGateway`, `Clock`, `IdempotencyKeys`) | Owned by the use case | the policy names what it needs, not how |
| Timeout, cancellation, retry, backoff, cache, serialization, error mapping | The adapter (the API client) or the data library configured once | details; swapping them must not touch a use case or a component |

A component or controller containing a retry loop, a `setTimeout`-based backoff, a cache key or a `try { fetch } catch` that decides what to do next is carrying the adapter's job.

---

## 1. Every request has a deadline and can be cancelled

```ts
export async function getJson(url: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();                                   // unknown — the caller parses (typescript.md §2)
}
```

- `fetch` has **no default timeout**; a hung request is a spinner forever. Pick a deadline per call class (a search suggestion, a save, an upload) and write it down.
- The caller's signal is aborted on unmount, `disconnect()`, navigation or a newer request (§2). An aborted request is not an error to show.
- Distinguish `TimeoutError` (the deadline) from `AbortError` (the caller gave up) when mapping to wording.

## 2. Stale responses never overwrite fresh state

Requests race: the answer to "shoe" can arrive after the answer to "shoes".

- **Abort the previous request** when a new one starts (typeahead, filters, pagination), or
- **tag and compare**: keep the latest request id and drop any response that is not for it.
- Data libraries (TanStack Query, SWR) do this per cache key — one more reason the key must be complete (§6).

## 3. Retry only what is safe to repeat

- **Idempotent reads** (`GET`) and writes that carry an **idempotency key** (§4) may be retried. A plain `POST` that creates, charges or sends must not be retried blindly — a timeout does not mean it failed.
- Retry **transient** failures only: network errors, timeouts, `502/503/504`, `429` honouring `Retry-After`, `408`. Never a `4xx` that will fail the same way.
- **Exponential backoff with jitter, capped.** Fixed delays from many clients arrive together.
- **One layer retries.** A data library with `retry: 3` wrapped around a client that retries three times is nine attempts; pick the library's, or the client's, and switch the other off.

## 4. Double submits and idempotency keys

Disabling the button is UX, not protection: a double click, a retry after a timeout, a second tab and a flaky network all send the request twice. For a write that must happen once (place an order, pay, send, book):

- generate one **idempotency key per user intent** (`crypto.randomUUID()`) when the intent starts — not per attempt;
- send it with every attempt (`Idempotency-Key` header or a field the endpoint defines);
- the server stores it with the result and answers a replay with the stored result (`architecture:clean-architecture-php` integration-patterns §2).

The key is a port's concern (`IdempotencyKeys.forIntent()`), so tests can pin it.

## 5. Optimistic updates

Show the expected result immediately, reconcile with the server's answer, **roll back with a message** when it fails. Fit for reversible, low-stakes actions (a like, a toggle, reordering a list); never for money, stock or anything whose failure the user must not miss. The rollback path is tested like the happy one.

## 6. Caching on the client

- **HTTP caching first.** `Cache-Control` and `ETag` from the server beat a hand-written cache.
- **A cache key contains every dimension the value depends on**: store or website, locale, currency, customer group or tenant, the identity of the viewer, the query. A key without one of them serves one customer's data to another — a data leak, not a performance bug.
- **Invalidate on the event, not on a timer**: a successful mutation invalidates the queries it affects. A TTL is a decision that staleness up to the TTL is acceptable — write the number and who agreed to it.
- **Persistent client storage** (`localStorage`, IndexedDB): a versioned key, an expiry, and a clear on logout. No personal data unless the project has decided it may live there.
- **Service workers** never put private, authenticated responses in a cache another user of the device can read.

## 7. Full-page-cached HTML

Behind a full-page cache (a reverse proxy, the framework's HTTP cache, edge-side includes) the HTML itself is shared. Whatever a cacheable template prints is seen by everyone who receives that cached copy.

- Private data — the customer's name, cart count, group price, wishlist state, consent — is loaded **after** the page through the private channel (the framework's private-content mechanism, a private endpoint, ESI), and the script renders a neutral state until then.
- Config printed into a cached page contains nothing that varies per visitor.
- The frontend stack skill names its framework's cache and private channel.

## 8. Realtime: WebSocket, SSE, polling

Reconnect with backoff and jitter; resubscribe after reconnecting; deduplicate by event id (at-least-once is the only delivery there is); order by the server's sequence, not by arrival; stop polling when the tab is hidden (`visibilitychange`); close everything on unmount.

## 9. Errors shown to people

The adapter maps transport and HTTP failures to a small set of **error kinds** (`network`, `timeout`, `rejected`, `conflict`, `unauthorized`); the presentation layer maps kinds to translated wording. A person never reads `error.message`, a status line, a stack trace, an internal id or a raw server response. The detail goes to the log — through a logger port, not `console` scattered through components.

## 10. Offline and queued work

Only when it is designed: queued commands carry their idempotency keys, replay in order, and surface conflicts to the user. An accidental offline mode — a failed save silently dropped — is a data-loss bug.

---

## Detection recipes — candidates, not findings

ripgrep with the exclusions of `solid.md`. Most of these span several lines: a hit is where to read.

| Smell | Search | Then check |
|---|---|---|
| No deadline / no cancellation | `fetch\(` in files without `signal` | whether the call goes through a client that sets both |
| axios without timeout | `axios\.(create\|get\|post\|put\|patch\|delete)\(` | `timeout` on the instance or the call |
| Hand-rolled retries | `for \(let attempt\|while \(.*(retry\|attempt)\|setTimeout\([^)]*retry` | move into the adapter or the data library; one layer only |
| Retried creates | `retry:\s*[1-9]` near `useMutation\|method: 'POST'` | an idempotency key is sent |
| Stale responses | debounced search/filter handlers calling `fetch`/a client without aborting the previous request | abort or latest-id guard |
| Incomplete cache keys | `queryKey:\s*\[` and storage keys | store, locale, currency, group/tenant, viewer present |
| PII in storage | `localStorage\.setItem\|sessionStorage\.setItem\|indexedDB` | what is stored, its expiry, cleared on logout |
| Raw errors shown | `error\.message\|err\.message\|e\.message` in components, controllers, templates | only logged, never rendered |
| Swallowed failures | `\.catch\(\(\) => \{\s*\}\)\|catch\s*\{\s*\}` | an explicit decision with a comment on why losing it is fine |

## Review checklist
- [ ] Every request has a deadline and a cancellation tied to the component's or controller's lifetime.
- [ ] No stale response can overwrite newer state.
- [ ] Retries only for repeatable calls, only for transient failures, with capped jittered backoff, in exactly one layer.
- [ ] Writes that must happen once carry an idempotency key per intent.
- [ ] Optimistic updates roll back visibly and are never used for money or stock.
- [ ] Every client cache key carries every dimension its value depends on; invalidation follows events; persistent storage expires and clears on logout.
- [ ] Nothing private is printed into full-page-cached HTML.
- [ ] People see mapped, translated wording; details go to a logger port.
