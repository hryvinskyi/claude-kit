# Devil's advocate — a late return is charged

## Constraints that survived review (binding)

1. The use case computes the fee with `lateFee`; it holds no fee arithmetic of its own.
2. What the ledger holds after a return is proven against the ledger, in `test/integration/`: a
   recording double shows what the use case sends, not what the ledger keeps.
3. The module exports `chargeLateFee` and nothing else.

## Resolved

- "Is a charge of zero written?" — no; AC-2 says so.
