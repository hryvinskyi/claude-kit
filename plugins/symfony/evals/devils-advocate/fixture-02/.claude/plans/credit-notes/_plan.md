# Implementation Plan — Credit notes for invoices

## Context & language

- Module: Billing (`packages/billing`), a feature module. Nothing outside it changes.
- Ubiquitous language: *issue* a credit note (never "create"); *remaining creditable
  amount* = invoice total minus everything already credited; *refund instruction* = the
  record that a refund is owed through a payment method.
- Invariants:
  1. The credited total of an invoice never exceeds its total.
  2. A credit note is in the invoice's currency and is greater than zero.
  3. An invoice number is never changed (accepted decision
     `kb/Decisions/2026-05-10 invoice-numbers-are-immutable.md`).

## Decisions taken in this plan

- `CreditNote` is its own aggregate and references the invoice **by id**.
- Reports pair a credit note with its invoice through `credit_note.invoice_id`. A `-C`
  suffix on the invoice number was considered and dropped: the decision record above
  rejects it by name, and this plan does not touch `Invoice::number()` anywhere.
- Issuing a credit note does **not** move money. It records a `RefundInstruction` row in
  the same transaction; executing instructions against a payment provider is a separate
  feature (see *Logged for later*). No HTTP client or gateway port is introduced here.

## Tech-debt in scope

- Blast radius: `Entity/Invoice.php`, `Api/InvoiceRepositoryInterface.php`,
  `Repository/DoctrineInvoiceRepository.php` (touched) — the module is five classes, so the
  whole module was audited.
- Findings: none to remediate. `Invoice` already carries a `Money` value object and a
  `PaymentMethod` enum; the repository port is owned by `Api/` and aliased in
  `Resources/config/services.yaml`; there is no `switch`/`elseif` dispatch in the module.
- Missing tests for touched code: `Invoice` and `DoctrineInvoiceRepository` have none
  today. Task 2 adds them at both levels for every method it touches.

## Task table

| # | Task | Depends on |
|---|------|------------|
| 1 | Migration: `billing_credit_note`, `billing_refund_instruction`, `billing_invoice.credited_minor` | — |
| 2 | `Invoice::credit()` + `InvoiceRepositoryInterface::getForUpdate()` | 1 |
| 3 | `CreditNote` and `RefundInstruction` entities + `CreditNoteRepositoryInterface` | 1, 2 |
| 4 | `RefundMethodInterface` strategies + `RefundMethodRegistry` | 3 |
| 5 | `CreditNoteIssuer` use case | 2, 3, 4 |
| 6 | `POST /api/invoices/{id}/credit-notes` + `InvoiceVoter::CREDIT` | 5 |
| 7 | Admin UI: button, form, banners; strings in `en` and `de` | 6 |

## Task 1 — migration

`packages/billing/src/Migrations/Version20260801100000.php`, hand-written, following
`Version20260401090000.php`.

- `up()`: `ALTER TABLE billing_invoice ADD credited_minor BIGINT NOT NULL DEFAULT 0`;
  `CREATE TABLE billing_credit_note (id UUID PRIMARY KEY, invoice_id UUID NOT NULL
  REFERENCES billing_invoice(id), amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL, reason VARCHAR(500) NOT NULL, idempotency_key VARCHAR(64) NOT
  NULL, issued_at TIMESTAMPTZ NOT NULL, UNIQUE (invoice_id, idempotency_key))`;
  `CREATE INDEX idx_credit_note_invoice ON billing_credit_note (invoice_id)`;
  `CREATE TABLE billing_refund_instruction (id UUID PRIMARY KEY, credit_note_id UUID NOT
  NULL UNIQUE REFERENCES billing_credit_note(id), payment_method VARCHAR(16) NOT NULL,
  amount_minor BIGINT NOT NULL, currency CHAR(3) NOT NULL, created_at TIMESTAMPTZ NOT NULL)`.
- `down()`: drops the two tables, then the column — the exact reverse.
- Integration test: migrate up, down, up against real Postgres, asserting the columns,
  constraints and indexes through `information_schema`. The mapping ↔ schema check belongs
  to Task 3, where the last of the mappings exists.

## Task 2 — the invariant lives in `Invoice`

- `Invoice` gains `private Money $credited` (mapped to `credited_minor` + the invoice
  currency; starts at zero) and two methods:
  - `remainingCreditable(): Money` — `total` minus `credited`.
  - `credit(Money $amount): void` — throws `CreditExceedsRemaining` (new, `Api/`) when
    `$amount` is greater than `remainingCreditable()`, and `InvalidArgumentException` from
    `Money` on a currency mismatch; throws `NothingToCredit` (new, `Api/`) when `$amount`
    is zero; otherwise adds to `credited`. There is no setter for `credited`.
- `InvoiceRepositoryInterface` gains one method. It does not exist today; this task adds
  it to the interface and to `DoctrineInvoiceRepository`:
  `public function getForUpdate(string $id): Invoice;` — `@throws InvoiceNotFound`; loads
  with `LockMode::PESSIMISTIC_WRITE`; must be called inside a transaction.
- Unit: `InvoiceTest` — credit within remaining, credit equal to remaining, exceeds,
  zero, currency mismatch, two credits accumulate. Integration:
  `DoctrineInvoiceRepositoryTest` — `get`, `save`, `getForUpdate` round-trip against
  Postgres, and `getForUpdate` on an unknown id throws `InvoiceNotFound`.

## Task 3 — `CreditNote`, `RefundInstruction`, repository port

- `Entity/CreditNote.php`: named constructor
  `CreditNote::issue(string $id, string $invoiceId, Money $amount, string $reason, string
  $idempotencyKey, \DateTimeImmutable $issuedAt): self`. Rejects a zero amount, an empty
  reason and a reason over 500 characters. No setters.
- `Entity/RefundInstruction.php`: named constructor
  `RefundInstruction::owe(string $id, string $creditNoteId, PaymentMethod $method, Money
  $amount, \DateTimeImmutable $createdAt): self`. No setters.
- `Api/CreditNoteRepositoryInterface.php`:
  - `public function save(CreditNote $note, RefundInstruction $instruction): void;`
  - `public function findByIdempotencyKey(string $invoiceId, string $key): ?CreditNote;`
- `Repository/DoctrineCreditNoteRepository.php` implements it; aliased in
  `Resources/config/services.yaml` next to the existing invoice alias.
- Unit: both entities' constructors. Integration: Doctrine's schema validation passes for
  the module (Tasks 1 and 2 are in by now); save + find round-trip; a second save
  with the same `(invoice_id, idempotency_key)` fails on the unique index.

## Task 4 — refund strategies, resolved from a registry

- `Api/RefundMethodInterface.php`, tagged on the interface itself:
  `#[AutoconfigureTag('acme.billing.refund_method')]`, with
  `supports(PaymentMethod $method): bool` and
  `instructionFor(CreditNote $note, \DateTimeImmutable $now): RefundInstruction`.
- Implementations in `Service/Refund/`: `CardRefund`, `BankTransferRefund`,
  `StoreCreditRefund` — one per `PaymentMethod` case.
- `Service/Refund/RefundMethodRegistry.php` takes
  `#[AutowireIterator('acme.billing.refund_method')] iterable $methods` and exposes
  `for(PaymentMethod $method): RefundMethodInterface` — a loop with a guard clause and an
  early return; throws `UnsupportedPaymentMethod` (new, `Api/`) when none supports it.
- Wiring: no `services.yaml` edit is needed and none is planned. The module's resource
  glob is `'../../'` and excludes only `Entity/`, `Migrations/` and `Resources/`, so `Api/`
  and `Service/` are already loaded and the tag registers. The integration test below is
  what proves it.
- Unit: each strategy's `supports()` and the instruction it builds; the registry with
  fakes, including the unsupported case. Integration: boot the kernel, fetch
  `RefundMethodRegistry` from the container, assert it resolves a strategy for **every**
  `PaymentMethod::cases()` entry — this fails if the pool is empty.

## Task 5 — `CreditNoteIssuer`

`Service/CreditNoteIssuer.php`, one public method:

`issue(IssueCreditNote $command): CreditNoteIssued` where `IssueCreditNote` (`Api/`,
readonly) carries `invoiceId`, `Money $amount`, `reason`, `idempotencyKey`, and
`CreditNoteIssued` (`Api/`, readonly) carries `creditNoteId` and
`Money $remainingCreditable`.

Steps, all inside one `EntityManagerInterface::wrapInTransaction()`:

1. `getForUpdate($invoiceId)` — the row lock comes first: it serialises concurrent issuers
   **and** two in-flight requests carrying the same key.
2. `findByIdempotencyKey()` under that lock — if a note exists, return its
   `CreditNoteIssued` and stop (a retried request is answered, not repeated). The unique
   index on `(invoice_id, idempotency_key)` is the backstop, not the mechanism.
3. `$invoice->credit($amount)` — the invariant is the entity's; the issuer has no `if`
   on amounts.
4. Build the `CreditNote`, ask the registry for the invoice's method, build the
   `RefundInstruction`, save both and the invoice.

The clock is `Psr\Clock\ClockInterface`, injected. Unit: the issuer against in-memory
fakes of both repository ports — happy path, idempotent replay, each domain exception
passes through untouched. Integration: real Postgres — the same key issued twice leaves
one note row, one instruction row and one credit; and two issuers racing for the same
invoice with amounts that only fit once: exactly one succeeds, the other gets
`CreditExceedsRemaining`, `credited_minor` equals the one amount.

## Task 6 — endpoint

`Controller/CreditNoteController.php`, invokable, translate-and-delegate only.

- Request: `POST /api/invoices/{id}/credit-notes`, header `Idempotency-Key` (required,
  ≤ 64 chars), body `{"amount_minor": int > 0, "currency": "EUR", "reason": string 1..500}`.
- Authorization: `InvoiceVoter` (new, `Security/`) grants `CREDIT` to `ROLE_BILLING_ADMIN`
  only; the controller calls `denyAccessUnlessGranted('CREDIT', $invoice)`.
- Responses: `201 {"id": uuid, "remaining_creditable_minor": int, "currency": string}` ·
  `400 {"error": "invalid_payload", "fields": {name: message}}` ·
  `403 {"error": "forbidden"}` · `404 {"error": "invoice_not_found"}` ·
  `409 {"error": "credit_exceeds_remaining", "remaining_creditable_minor": int}` ·
  `422 {"error": "nothing_to_credit"}`. Exception messages are never echoed. The payload
  rule already turns a zero amount into a `400`, so `nothing_to_credit` cannot be produced
  over HTTP; the mapping exists for callers of the issuer that are not this endpoint.
- Unit: payload → command mapping and each exception → status mapping, `422` included.
  Integration: `201`, `400`, `403`, `404` and `409` through the real kernel, plus a replay with the same
  `Idempotency-Key` returning the same `201` body and creating no second row.

## Task 7 — admin UI and strings

- The invoice detail screen gets an **Issue credit note** button (hidden without
  `CREDIT`), a form (amount prefilled with the remaining creditable amount, reason), a
  success banner, and an error banner per `409` / `422` / `400` response. While the
  request is in flight the button is disabled. When nothing remains to credit the button
  is replaced by a muted note.
- The banner names the refund route with the label that already exists per method. The
  lookup is a value→value map, no behavior hangs on it:
  `match ($method) { PaymentMethod::Card => 'invoice.payment_method.card',
  PaymentMethod::Bank => 'invoice.payment_method.bank',
  PaymentMethod::StoreCredit => 'invoice.payment_method.store_credit' }`.
- New strings, added to **both** `packages/billing/translations/messages.en.yaml` and
  `messages.de.yaml` in this task: `credit_note.issue`, `credit_note.issued`,
  `credit_note.reason`, `credit_note.amount`, `credit_note.error.exceeds_remaining`,
  `credit_note.error.nothing_to_credit`, `credit_note.error.invalid`,
  `credit_note.nothing_remaining`.
- The invoice header is re-rendered from the `201` body; the invoice number shown in it is
  the one the server returns and is never altered client-side.
- Unit: the label map covers every `PaymentMethod` case. Integration: the screen renders
  the button for an admin and not for a viewer; `TranslationParityTest` stays green.

## Dependency rule check

- `CreditNoteIssuer` → `InvoiceRepositoryInterface`, `CreditNoteRepositoryInterface`,
  `RefundMethodRegistry`, `ClockInterface`: interfaces owned by `Api/` or PSR. Inward.
- Entities import nothing from Doctrine or Symfony beyond mapping attributes.
- The controller depends on the issuer and the voter; nothing depends on the controller.

## Logged for later (outside this plan)

- Executing `RefundInstruction` rows against a payment provider — a separate feature with
  its own port, retries and reconciliation. One line is added to `kb/To DO.md` under
  `## Later` as part of Task 5.

## Risks & open questions

- None blocking. `RefundMethodInterface` has three real implementations on day one, so the
  port protects an actual axis of change.
