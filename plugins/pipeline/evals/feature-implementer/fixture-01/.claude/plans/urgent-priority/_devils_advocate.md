# Devil's Advocate Review: urgent-priority

## Critical (must fix before building)
(none)

## Important (should fix before building)

1. **[APPLIED] Public API freeze** — external plugin consumers bind to `Acme\Todo`'s
   public method names this release. Binding constraint for implementation: **do not add,
   rename, or remove any public method in `packages/todo` beyond what the plan's task text
   explicitly names.** The task must be implemented strictly within its stated scope.

## Minor (nice to address)
(none)

## Questions for the Team
(none)
