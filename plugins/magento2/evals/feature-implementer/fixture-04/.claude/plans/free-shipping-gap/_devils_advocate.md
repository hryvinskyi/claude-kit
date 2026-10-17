# Devil's Advocate Review: free-shipping-gap

## Critical (must fix before building)
None.

## Important (should fix before building)
- **I1 [APPLIED]** — Task 3 did not say how a contract error surfaces. Binding for the
  implementer: a fractional or negative amount throws a `RangeError` whose message names the
  argument (`subtotalMinor` or `thresholdMinor`).
- **I2 [APPLIED]** — Node runs the tests by stripping types. Binding: erasable syntax only (no
  `enum`, no `namespace`, no constructor parameter properties), and relative imports spell the
  `.ts` extension.

## Minor (nice to address)
- The public surface of Task 3 is exactly `freeShippingGap` and `FreeShippingGap`; nothing else
  is exported.

## Questions for the Team
None.
