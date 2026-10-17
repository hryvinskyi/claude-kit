Plan slug: `free-shipping-gap` (`.claude/plans/free-shipping-gap/`). Your task: **Task 3 — the gap calculation**, Impl `split`: write its contract.

Task text, verbatim from the plan: Create `app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts`, a pure module exporting the type `FreeShippingGap = { gapMinor: number; qualified: boolean; progress: number }` and the function `freeShippingGap(subtotalMinor: number, thresholdMinor: number): FreeShippingGap`. It must honour invariants 1–4.

Split: the contract is the test file `app/code/Acme/FreeShipping/Test/Js/free-shipping-gap.test.ts` (run by `npm run test:js`), pinning invariants 1–4 and the binding review constraints. The module has no separate declaration file — its type and function live together — so the implementer creates `free-shipping-gap.ts` itself. The contract writer touches no other file.

Review-round context: none. The constraints in `_devils_advocate.md` are binding.
