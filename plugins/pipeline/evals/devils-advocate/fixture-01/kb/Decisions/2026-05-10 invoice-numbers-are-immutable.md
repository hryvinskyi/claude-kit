---
type: decision
status: accepted
area: billing
---

# Invoice numbers are immutable once issued

## Context
Sequential invoice numbering is legally load-bearing (fiscal reporting, audits). Any gap or
mutation in issued numbers triggers manual reconciliation with the tax advisor.

## Decision
An invoice number is assigned exactly once, at issue time, and is **never changed
afterwards** — not on cancellation, not on crediting, not for reporting convenience.

## Alternatives considered
- Renumbering credited invoices with a suffix — rejected: mutates issued fiscal documents.
- Void-and-reissue — rejected: creates numbering gaps.

## Consequences
Corrections are modeled as **separate documents** (credit notes) that reference the original
invoice id; reports group by that reference, never by mutated numbers.
