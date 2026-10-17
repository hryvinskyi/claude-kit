# Agent evals — prompts are code, so they get regression tests

Every agent definition (a plugin's `agents/*.md`, or a user or project agent) is a program
executed by a model. This harness
tests them the only way that matters: run the agent on a **fixture with seeded flaws** and
score what it caught against an **answer key**.

## When to run

- After ANY edit to an agent definition (before committing it).
- After a Claude Code model change (the same prompt can behave differently).
- When adding a new project-type the agent must generalize to (add a fixture for it).

Runner: the `/pipeline:agent-evals` command (`commands/agent-evals.md` in this plugin). It runs
the agent **as registered** — `claude -p --agent <registered name>`, e.g.
`pipeline:devils-advocate`, inside a scratch copy of the fixture —
so the definition's own `tools:` and `model:` are what gets tested, not a paraphrase of it.

## Layout

```
evals/
  README.md
  <agent-name>/
    fixture-NN/          # a self-contained fake project the agent runs against
    prompt-NN.md         # the invocation handed to the agent (what a caller would say)
    expected-NN.md       # answer key — NEVER inside fixture-NN/ (the agent must not see it)
    verify-NN.*          # optional scorer run against the copy after the agent finishes — outside
                         # the fixture for the same reason as the answer key
    runs.log             # one line per run: date · agent@<content hash> · score · misses
```

`<evals>` in an answer key or a scorer's header is this directory: `evals/` of the pipeline plugin,
which `/pipeline:agent-evals` resolves as `${CLAUDE_PLUGIN_ROOT}/evals/`.

## Rules

1. **Always run on a copy** (the runner copies the fixture to the scratchpad) — agents like
   devils-advocate edit plan files as part of their job.
2. **Answer keys stay outside the fixture dir** so the agent can't read them.
3. A fixture flaw must be **objectively verifiable** — seeded against a written rule
   (fixture CLAUDE.md gate, plan-review checklist item, decision record, or real code in the
   fixture). No "vibes" flaws.
4. Score = seeded flaws found / total, plus severity accuracy and false-positive noise.
   A finding phrased differently but pointing at the same defect counts as found.
5. Fixture edits after a run are a bug in the runner — re-copy, never reuse a dirty copy.
6. The run record's hash is `git hash-object` of the agent's definition file (a content hash), not the
   last commit touching the file: evals run *before* the commit, so a commit hash would
   always name the previous version.
7. Fixtures must be safe to run under `--dangerously-skip-permissions`: nothing in a fixture
   may reach outside its own directory.

## Current fixtures

- `devils-advocate/fixture-01` + `expected-01.md` — Symfony-ish modular monolith
  ("acme-billing"), plan "credit-notes" with **7 seeded flaws** (F1–F7): missing task
  dependency, unwired tagged services, nonexistent repository method, switch-on-type
  dispatch, entity change without migration, missing locale, and a plan step that
  contradicts an accepted decision record.
- `devils-advocate/fixture-02` + `expected-02.md` — the precision case: the same project and
  feature planned **correctly**, with **7 decoys** (D1–D7) that look like F1–F7 until the
  file the plan points at is read. Expected: 0 Critical, no decoy tripped, no `[APPLIED]`
  edit that rests on nothing. fixture-01 scores recall; this one scores what a reviewer
  that edits plans does to a plan that was right.
- `devils-advocate/fixture-03` + `expected-03.md` — the first plan that ships browser code: a
  Magento store ("acme-store") with storefront TypeScript, a free-shipping bar rendered through
  hryvinskyi/magento2-theme-assets, **8 seeded flaws** (J1–J8): a 38 KB script inlined by the
  renderer's default, the cart subtotal printed into a full-page-cached page, `switch` on the
  mode, `JSON.parse(…) as` with `!`, the renderer's module undeclared, English in the TS module,
  the entry missing from the explicit esbuild list, and a test that reads the template as text.
  Its plan names `.ts` files, so the rubric gate demands both skills before any plan write.
- `wiki-updater/fixture-01` + `expected-01.md` — vault project ("acme-notes") with a real
  sync script (`scripts/kb-sync.py`), a stale managed block, empty prose, and an orphan
  note. Tests: sync-not-hand-edit, prose outside markers grounded in code, orphan
  reported-not-deleted, idempotence re-run, working-memory layer untouched.
- `feature-implementer/fixture-01` + `expected-01.md` — scope-check trap ("acme-tasks"):
  the task orders extending a method that doesn't exist while a review constraint freezes
  public names. Only correct outcome: **blocked-with-question with zero mutations**.
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

## Backlog

- `devils-advocate/fixture-04` — a JS-only project (no `composer.json`: a React SPA or a Node
  service) to prove the branch where the JS rubric is the only one, and a precision twin of
  fixture-03 (correct render modes, parsed config, a registry) to score what the JS checks
  manufacture.
- `feature-implementer/fixture-03` — the PHP happy path: a buildable fixture with runnable gates
  (make lint/test) and a clean implementable task.
