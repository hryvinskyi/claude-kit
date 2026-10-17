# Implementation Plan — Credit notes for invoices

## Context

Billing module (`packages/billing`). A credit note reverses part or all of an issued
invoice: new `CreditNote` entity, an issuing service with per-payment-method refund
behavior, a `POST` endpoint, and an admin button. Ubiquitous language: *issue* a credit
note (never "create"), *remaining creditable amount*.

## Decisions taken in this plan

- `CreditNote` is its own entity referencing the invoice by id (no FK into other modules).
- Refund behavior depends on the invoice's payment method: `card`, `bank`, `store_credit`.
- After a full credit, the original invoice is renumbered with a `-C` suffix so financial
  reports group the pair together.

## Task table

| # | Task | Depends on |
|---|------|------------|
| 1 | `POST /api/invoices/{id}/credit-notes` endpoint | — |
| 2 | `CreditNote` entity + repository | — |
| 3 | `CreditNoteIssuer` + per-method refund strategies | 2 |
| 4 | Refund dispatch by payment method | 3 |
| 5 | Admin UI: "Issue credit note" button + result banner | 1 |

## Task 1 — endpoint

Create `packages/billing/src/Controller/CreditNoteController.php`. Validate the payload
(amount, reason), load the invoice's open state via
`InvoiceRepositoryInterface::findActive()`, delegate to `CreditNoteIssuer::issue()`, return
`201` with the new credit-note id, `409` when the amount exceeds the remaining creditable
total. Unit + Integration tests.

## Task 2 — entity + repository

Add `CreditNote` entity (`id`, `invoice_id`, `amount_minor`, `currency`, `reason`,
`issued_at`) in `packages/billing/src/Entity/CreditNote.php` with
`CreditNoteRepositoryInterface` + Doctrine implementation. Add a `credited_total_minor`
column to `Invoice` so the remaining creditable amount is a single read. Unit + Integration
tests.

## Task 3 — issuer + refund strategies

`CreditNoteIssuer` (application service): validates amount ≤ remaining, persists the
`CreditNote`, updates `credited_total_minor`, triggers the refund through the strategy
matching the invoice's payment method. Introduce `RefundMethodInterface` in
`packages/billing/src/Api/` with implementations `CardRefund`, `BankTransferRefund`,
`StoreCreditRefund`. Unit + Integration tests.

## Task 4 — refund dispatch

Inside `CreditNoteIssuer`, select the refund behavior with a
`switch ($invoice->paymentMethod())` over `'card' | 'bank' | 'store_credit'`, calling the
matching strategy class; default case throws `UnsupportedPaymentMethod`. Unit + Integration
tests for all three branches and the default.

## Task 5 — admin UI

Add the **Issue credit note** button to the invoice detail screen and a success banner.
New user-facing strings — `Issue credit note`, `Credit note issued.` — go to
`packages/billing/translations/messages.en.yaml`. On success, apply the `-C` renumbering
from the plan decisions to the original invoice and refresh the header. Unit + Integration
tests where applicable.
