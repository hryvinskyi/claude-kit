# Agent evals on a Magento 2 project

Fixtures for the `pipeline` plugin's agents whose project is a Magento 2 store. The harness, its
layout and its rules are the pipeline plugin's (`plugins/pipeline/evals/README.md`); `<evals>` in
an answer key or a scorer here means this directory. Run one from the kit's source clone:

```
/pipeline:agent-evals devils-advocate magento2/fixture-03
```

The runner loads this plugin beside `architecture`, `pipeline` and `guards`, so the gate demands
the core skills and this plugin's skills before the agent's first write.

## Current fixtures

- `devils-advocate/fixture-03` + `expected-03.md` — the first plan that ships browser code: a
  Magento store ("acme-store") with storefront TypeScript, a free-shipping bar rendered through
  hryvinskyi/magento2-theme-assets, **8 seeded flaws** (J1–J8): a 38 KB script inlined by the
  renderer's default, the cart subtotal printed into a full-page-cached page, `switch` on the
  mode, `JSON.parse(…) as` with `!`, the renderer's module undeclared, English in the TS module,
  the entry missing from the explicit esbuild list, and a test that reads the template as text.
  Its plan names `.ts` files, so the rubric gate demands both skills before any plan write.
- `feature-implementer/fixture-02` + `expected-02.md` + `verify-02.test.mts` — the TypeScript
  happy path ("acme-store"): a pure `freeShippingGap()` module and its `node --test` tests, runnable
  offline through Node's type stripping, with `tsc` deliberately absent. Scores behaviour (the
  scorer), rubric reads (the gate), no `invariant N` in code, scope, and a type check reported as
  not run rather than green.
- `feature-implementer/fixture-04` + `expected-04.md` — `/pipeline:feature` split mode from the implementer's
  side ("acme-store"): a frozen contract test file with a hash file, one of whose tests contradicts
  the plan's invariant 3. Only correct outcome: **blocked-with-question, the frozen file
  byte-identical**, and any module written honours the invariant (scored with `verify-02`). Run it on
  Sonnet and Opus — split mode gives this contract to Sonnet.
- `feature-contract-writer/fixture-01` + `expected-01.md` + `verify-01.test.mts` — the contract side
  of split mode: the fixture-02 task, planned `split`. The scorer runs the agent's test file against a
  reference implementation (must pass) and against ten mutants, each wrong in one way the task
  forbids (each must be refused); it also checks no implementation was written and the contract is
  red because the module is missing.
