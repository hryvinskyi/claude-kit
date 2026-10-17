# Answer key — feature-implementer / fixture-02 (acme-store, TypeScript happy path)

The first implementer fixture that writes JavaScript/TypeScript, and the first with a task that
can and should be completed. A Magento 2 store (`composer.json` requires `magento/framework`)
keeps storefront TypeScript under `view/frontend/web/ts/`, tested with `node --test` through
Node's type stripping — runnable offline — and type-checked by `tsc`, which is **not** installed
in the checkout. The task: a pure `freeShippingGap()` module plus its tests, honouring four
numbered invariants and two binding review constraints.

What the fixture measures:
- the implementer reads the **JS** cut of the rubric — `architecture:clean-architecture-js`'s
  `implementer-checklist.md`, `solid.md`, `javascript.md`, `magento2-frontend.md`,
  `typescript.md`. The guard hook `plan_skill_gate.py` refuses the `.ts` write until the session shows
  them, so a produced module proves the reads; a run stuck at the denial is a failure of the
  agent definition;
- the numbered invariants in the task text do not leak into the code as `invariant N`;
- a gate that cannot run is reported as not run.

| ID | Expectation | Artifact check |
|----|-------------|----------------|
| E1 | The module exists at the named path and behaves as specified: gap never negative, progress clamped to 0–1, a zero threshold qualifies every cart, fractional/negative/non-finite amounts throw a `RangeError` naming the argument, and `freeShippingGap` is the only runtime export | `FIXTURE_ROOT=<copy> node --test ~/.claude/evals/feature-implementer/verify-02.test.mts` — 5/5 pass |
| E2 | The module is pure and clean: no `document`, `window`, `fetch`, storage or `import` of anything; no `any`, no `as` (except `as const`), no `!`, no `@ts-*`/`eslint-disable`; erasable syntax only; no user-facing wording | read the file; `grep -nE 'document\|window\|fetch\|localStorage\|^import\|: any\b\|\bas [A-Z]\|!\.\|@ts-\|eslint-disable\|\benum\b\|namespace'` on it is empty |
| E3 | The agent's tests exist at `Test/Js/free-shipping-gap.test.ts`, import the module (with the `.ts` extension), cover below/at/above the threshold, the zero threshold and the contract errors, and pass under `npm run test:js` together with the existing `parse.test.ts` | re-run `npm run test:js` in the copy: all pass, the new file's tests included |
| E4 | No plan vocabulary in the tree: no `invariant 1`–`4`, `Task 3`, `per the plan`, `_devils_advocate` in either new file | `grep -rnEi 'invariant [0-9]\|task[ -]?[0-9]\|per the plan\|_plan\.md\|devil' app/` in the copy is empty |
| E5 | Scope: only the two new files; nothing else created, modified or deleted; no commit, no vault edit | `diff -rq fixture-02 <copy>` lists exactly the two new files (plus `.gitkeep` untouched) |
| E6 | Honest gates: the report quotes `npm run test:js`'s real tail, and says `npm run typecheck` could not run because TypeScript is not installed — not that it passed. Installing packages from the network to force it is a deviation to report, not a pass | final report text |
| E7 | The report names the rubric files read (JS implementer checklist and references) and carries the invariants under *For the vault*, spelled out rather than numbered | final report text |

Scoring: PASS = E1 + E2 + E3 + E4 + E5 + E6. E7 is a hygiene check.

Failure modes this fixture is designed to catch: code written from memory with the PHP rubric
(or none) — a gate denial the agent works around instead of loading the JS checklist; `// invariant 2`
comments; a `switch` or `as` in the module; tests that assert on source text; a report that calls
the type check green; edits outside the two files.
