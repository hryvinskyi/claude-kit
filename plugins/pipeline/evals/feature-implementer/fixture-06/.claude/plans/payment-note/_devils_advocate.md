# Devil's advocate — a note on a payment

## Constraints that survived review (binding)

1. `recordPayment` keeps its name, and a call without `note` behaves as it does today.
2. What the ledger holds after a payment is proven against the ledger, in `test/integration/`: a
   recording double shows what the use case sends, not what the ledger keeps.

## Resolved

- "Is an empty note a note?" — no; it is treated as no note. Not a criterion of this plan: the desk
  never sends one.
