# Integration patterns — crossing a process boundary without losing the dependency rule

The other references keep one process honest. This one covers what happens the moment a use case has to tell **something outside its transaction** — a broker, a payment provider, a neighbour's HTTP API, a cache. Every pattern here answers one question: *the database commit and the outside effect cannot both be atomic, so which one is allowed to be late, and what makes lateness safe?*

Load it when a plan or review touches: a message published from a use case, a consumer, an outbound HTTP call, a multi-step process across modules or services, or a cache in front of a port.

Placement is the same for all five patterns and is the first thing to review:

| Piece | Layer | Why |
|---|---|---|
| The *decision* that something must happen (an event recorded, a refund owed) | Entity / aggregate | it is a business fact |
| The port (`PaymentGateway`, `EventOutbox`, `Clock`) | owned by the use case / `Api/` | the policy names what it needs, not how |
| Retry, backoff, circuit breaker, timeout, cache, serializer, broker client | Adapter (decorators around the port's implementation) | they are details; swapping them must not touch a use case |

A use case that contains `sleep()`, a retry loop, a `try { $http->request } catch` or a cache key is carrying an adapter's job.

---

## 1. Transactional outbox — the state change and the message commit together

**The defect it removes:** *dual write*. `save($order); $bus->dispatch($event);` has two failure windows — the dispatch succeeds and the commit rolls back (a message about something that never happened), or the commit succeeds and the process dies before the dispatch (a fact nobody hears about).

```php
// ❌ Two systems, no shared transaction (and `new OrderPlaced` in a use case: events come from the
//    aggregate's event factory, ddd.md §Creation lives in factories)
$this->transactions->run(function () use ($order): void {      // a transaction port the use case owns
    $this->orders->save($order);
    $this->bus->dispatch(new OrderPlaced($order->id()));   // broker is outside the transaction
});

// ✅ The message is a row in the same commit; a relay publishes it afterwards
$this->transactions->run(function () use ($order): void {
    $this->orders->save($order);
    foreach ($order->releaseEvents() as $event) {
        $this->outbox->record($event);                      // port owned by the use case
    }
});
```

A message transport that **writes to the same database connection** *is* an outbox — dispatching inside the transaction writes the message row in the same commit, and the transport's consumer is the relay. It stops being one the moment the transport is a network broker (AMQP, Redis, SQS): then either route through a database transport first and forward, or dispatch after the commit knowing it narrows the window without closing it. The stack skill names which of its framework's transports is which.

Review questions:
- Is the message written by the **same connection and transaction** as the state change? (Two entity managers = two transactions.)
- Does the relay mark a row published **after** the broker acknowledged, so a crash re-sends rather than drops? Delivery is therefore **at-least-once** — see §2.
- Is the batch bounded, is there a retry count, and where does a poison message go? An outbox with no dead-letter path fills the table and blocks everything behind it.
- If consumers need order, is it ordered **per aggregate** (partition/route by aggregate id), not globally?
- Does anything make an HTTP call or publish to a network broker **inside** the transaction? That holds row locks for the duration of someone else's latency.

## 2. Idempotent consumer — at-least-once is the only delivery there is

Every relay, retry and redelivery in this file produces duplicates. The consumer makes them harmless; the producer cannot.

```php
final class ReserveStockHandler
{
    public function __invoke(OrderPlaced $event): void
    {
        $this->transactions->run(function () use ($event): void {
            if (!$this->processed->claim($event->messageId, self::class)) {
                return;                                  // duplicate: already handled
            }
            $this->stock->reserveFor($event->orderId);
        });
    }
}
```

`claim()` is an `INSERT` into a table with a unique key on `(message_id, handler)`, in the **same transaction** as the effect — a separate "have I seen this?" `SELECT` followed by the work is check-then-act and races with the redelivery it is guarding against. Where the effect is naturally idempotent (`SET status = 'paid'`, an upsert keyed by a business id), say so in a comment and skip the table.

The same rule faces outward: an HTTP endpoint that a client may retry takes an **idempotency key**, stores it with the result under a unique index, and answers a replay with the stored result.

Review questions: what is the key, and is it the *message's* identity rather than a payload hash? Is the claim in the same transaction as the effect? Is the handler acknowledged only after that transaction commits?

## 3. Saga — a business process across transactions, undone by compensation

Use it when one business action spans several aggregates, modules or services and no single transaction can hold them. There is no distributed rollback; each completed step has a **compensating action** that is itself a business operation (`Payment::refund()`, not `DELETE FROM payments`).

- **Choreography** — each module reacts to the previous module's event. Fits a modular monolith's `Event/` surface and two or three steps. Past that, nobody can say where a process is.
- **Orchestration** — one process manager owns the state machine and sends commands. Fits four or more steps, timeouts, or anything support staff must be able to look up. In a modular monolith the orchestrator lives in a **bridge package** — it depends on every participant's `Api/`, and nothing depends on it (`onion-modules.md`).

What a review checks, in this order:
1. **Saga state is persisted after every step** (its own table, keyed by a correlation id). An in-memory saga is lost on the first deploy.
2. **Every step that can be followed by a failure has a compensation**, and the data the compensation needs (the charge id, the reservation id) is stored when the step succeeds — not re-derived later.
3. Compensations run in **reverse order** and are **idempotent and retried**; a compensation that fails is an alert for a person, never a swallowed exception.
4. Steps are idempotent (§2) — the orchestrator will re-send after a timeout.
5. Each wait has a **timeout** that leads to a defined state, not a process stuck forever in `pending`.
6. The **pivot** is named: the step after which the process only goes forward (the charge that is captured, the order that is shipped). Steps before it are compensatable; steps after it must be retriable until they succeed — so nothing that can fail for a business reason may come after the pivot.

Not a saga: two writes in one module. That is one transaction, and introducing steps and compensations there is the over-abstraction `SKILL.md` §Pragmatism warns about.

## 4. Stability — timeouts, retries, circuit breakers, bulkheads

All four are **decorators around an adapter**, composed in the container. The use case sees a port.

```php
// The port's one real implementation talks HTTP; resilience wraps it without the use case knowing
final class RetryingPaymentGateway implements PaymentGateway
{
    public function __construct(
        private readonly PaymentGateway $inner,
        private readonly RetryPolicy $policy,           // attempts, base delay, jitter, which failures
    ) {}

    public function charge(ChargeRequest $request): ChargeResult
    {
        return $this->policy->run(fn (): ChargeResult => $this->inner->charge($request));
    }
}
```
The container registers `RetryingPaymentGateway` as a decorator of the HTTP implementation, so whoever asks for `PaymentGateway` gets the wrapped one. Frameworks ship most of these pieces — a retrying HTTP client, per-client timeouts, a transport's retry strategy and failure destination, a rate limiter, locks and semaphores; the stack skill lists its framework's. Reach for those before writing a class.

Rules, each a review finding when broken:
- **Every outbound call has a timeout**, connect and total. The default of most clients is "wait forever", and in a worker that is a process that never comes back.
- **Retry only what is safe to repeat**: an idempotent operation (§2) or one carrying an idempotency key. Retrying a non-idempotent charge is a double charge. Retry **transient** failures (timeouts, 502/503/504, 429 honouring `Retry-After`), never a 4xx that will fail identically.
- **Backoff is exponential with jitter**, capped. Fixed-delay retries from many workers arrive together and keep the dependency down.
- **Retries multiply across layers.** Three attempts in the client × three in the handler × three in the queue is twenty-seven calls for one user action. Pick one layer — for anything asynchronous, the queue's.
- **A circuit breaker's state is shared** (Redis, APCu per host at least) when there is more than one process; per-object state in a PHP-FPM request protects nothing, and in a long-running worker it is mutable service state that has to be reset deliberately.
- **Every open circuit has a defined answer**: a cached value, a degraded feature, or an honest error written for the person reading it. "Throw the client's exception" is not a fallback.
- **Bulkhead the slow dependency**: its own queue/transport and worker pool, so its backlog cannot starve the rest.

## 5. Caching in front of a port

A cache is an adapter decision. The shape that keeps it one: a **decorator implementing the same port**, registered in the container so the port resolves to the decorator and the decorator receives the real implementation (the stack skill shows its framework's wiring). A use case calling `$cache->get()` has learned about a detail and now owns key naming and invalidation too.

Review questions:
- **Who invalidates, and on what event?** TTL-only is a decision that staleness up to the TTL is acceptable — write the number and who agreed to it. Anything stricter invalidates on the domain event, by tag.
- **What is in the key?** Everything the value depends on: tenant, locale, currency, the viewer's permissions. A key without the tenant is a cross-tenant data leak, not a performance bug.
- **What happens on a miss under load?** A hot key expiring sends every request to the origin at once. A cache call that takes the recompute callback and recomputes early under a lock (probabilistic early expiration) prevents it; use it instead of `getItem`/`save` pairs where the cache library offers one.
- **What is cached?** Values and DTOs — never a managed ORM entity (it comes back detached, with lazy associations that fail later) and never an object holding a service.
- **Is a negative result cached?** "Not found" with a short TTL, or every miss is an origin hit forever.
- **Per-process memo caches** (`private ?array $byCode = null` on a service) are the same decision at the smallest scale: in a long-running worker they are process-lifetime state and need the same answer to "who invalidates" — usually a reset hook the worker calls between requests.

---

## Detection recipes — candidates, not findings

ripgrep; add `-g '!**/tests/**'`; pass a pattern that starts with `->` as `-e '…'`, or it is read as a flag. Single-quote every pattern (double quotes let the shell rewrite backslashes, and the sweep silently matches nothing), and drop the backslash of a table cell's `\|`. Run a recipe on a file known to contain a hit first: a sweep that finds nothing proves nothing until it has found something. Most of these smells span several lines, so a search finds the **place to read**, never the verdict.

| Smell | Search | Then check |
|---|---|---|
| Dual write | `->dispatch\(\|->publish\(` in `**/{Service,Handler,Application,UseCase}/**/*.php` | the transport for that message class (the framework's message routing configuration): same DB connection as the state change, or a network broker? |
| Network call inside a transaction | files matching both `beginTransaction\|->transactional\(` (plus the ORM's transaction wrapper, from the stack skill) and `->request\(\|->sendRequest\(\|curl_exec` — `rg -l A \| xargs grep -lE B` (`grep` on the right: where `rg` is a shell function, `xargs` cannot run it) | whether the call is inside the closure |
| Consumer with no idempotency | every message consumer class — the framework's handler attribute or interface (the stack skill's row) | a claim on a unique key in the same transaction, or a naturally idempotent effect |
| Outbound call with no timeout | `new \\?GuzzleHttp\\Client\|curl_init\|ClientInterface` (plus the framework's HTTP client, from the stack skill) | a timeout on the client or the request options; `CURLOPT_TIMEOUT` **and** `CURLOPT_CONNECTTIMEOUT` |
| Retry in the wrong layer | `\bsleep\(\|usleep\(\|for \(\$attempt\|while \(\$(tries\|attempt\|retry)` in non-adapter folders | move to a decorator or the transport's retry configuration |
| No failure destination | a transport configured with retries and no failure destination (the stack skill spells the keys) | where a message goes after the last retry |
| Cache in a use case | `CacheInterface\|CacheItemPoolInterface` (plus the framework's tag-aware cache, from the stack skill) in `**/{Service,Handler,Application,Domain}/**/*.php` | whether the class is a decorator of a port (fine) or a use case (move it) |
| Cache key missing a dimension | every `->get\(` on a cache in a multi-tenant or multi-locale project | tenant / locale / permission in the key |

## Review checklist
- [ ] No dual write: a message leaves in the same commit as the state change, or the plan says which side may be lost and why that is acceptable.
- [ ] Every consumer and every retried endpoint is idempotent, with the claim inside the effect's transaction.
- [ ] A multi-transaction process has persisted state, a compensation per step with its data stored, timeouts, and a named pivot.
- [ ] Every outbound call has a timeout; retries are for transient failures of repeatable operations, with capped jittered backoff, in exactly one layer.
- [ ] Resilience and caching are decorators around adapters; no use case contains a retry loop, a `sleep`, an HTTP `catch`, or a cache key.
- [ ] Every cache answers: who invalidates, what is in the key (tenant first), what happens on a hot miss.
- [ ] None of it was added where a single transaction would do.

## References
- Chris Richardson, *Microservices Patterns* — transactional outbox, saga, idempotent consumer — https://microservices.io/patterns/
- Michael Nygard, *Release It!* — timeouts, circuit breaker, bulkhead
