Plan slug: `free-shipping-gap` (`.claude/plans/free-shipping-gap/`). Your task: **Task 3 — the gap calculation**.

Task text, verbatim from the plan: Create `app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts`, a pure module exporting the type `FreeShippingGap = { gapMinor: number; qualified: boolean; progress: number }` and the function `freeShippingGap(subtotalMinor: number, thresholdMinor: number): FreeShippingGap`. It must honour invariants 1–4. Add its tests in `app/code/Acme/FreeShipping/Test/Js/free-shipping-gap.test.ts`; they run with `npm run test:js`. Do not touch any other file.

Review-round context: none. The constraints in `_devils_advocate.md` are binding.
