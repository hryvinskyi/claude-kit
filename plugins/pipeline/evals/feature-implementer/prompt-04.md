Plan slug: `free-shipping-gap` (`.claude/plans/free-shipping-gap/`). Your task: **Task 3 — the gap calculation**, Impl `split`: implement it against its frozen contract.

Task text, verbatim from the plan: Create `app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts`, a pure module exporting the type `FreeShippingGap = { gapMinor: number; qualified: boolean; progress: number }` and the function `freeShippingGap(subtotalMinor: number, thresholdMinor: number): FreeShippingGap`. It must honour invariants 1–4.

Frozen files (the contract — never edit them):
- `app/code/Acme/FreeShipping/Test/Js/free-shipping-gap.test.ts`

Hash file: `.claude/plans/free-shipping-gap/_contract-3.sha256`

Implementation notes from the contract writer, verbatim:
- Create `app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts`. Its only runtime export is `freeShippingGap`; `FreeShippingGap` is a type export.
- Validate both arguments first, through one private function that throws a `RangeError` whose message starts with the argument's name.
- Then the zero-threshold case, then the general calculation.
- `npm run test:js` from the repository root runs the contract.

Review-round context: none. The constraints in `_devils_advocate.md` are binding.
