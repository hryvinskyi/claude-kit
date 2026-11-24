# Devil's advocate — late fee

## Constraints that survived review (binding)

1. The calculation reuses `assertMinorUnits` and `daysBetween`; no second validator and no `Date`
   arithmetic in the new module.
2. The module exports `lateFee` and nothing else.

## Resolved

- "Is the due date itself late?" — no; AC-1 says so.
