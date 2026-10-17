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

A fixture lives in the `evals/` directory of the plugin it belongs to: a fixture that is a project
of one stack ships with that stack's plugin (`plugins/<stack>/evals/<agent-name>/`), with the same
layout and these same rules; a fixture that names no stack stays here. `<evals>` in an answer key or
a scorer's header is the `evals/` directory of the plugin that holds the fixture, which
`/pipeline:agent-evals` resolves for a fixture given as `<plugin>/<fixture-NN>`.

Evals are a maintainer tool: they run from the kit's source clone, never from the plugin cache.

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

Here, in the pipeline plugin:

- `wiki-updater/fixture-01` + `expected-01.md` — vault project ("acme-notes") with a real
  sync script (`scripts/kb-sync.py`), a stale managed block, empty prose, and an orphan
  note. Tests: sync-not-hand-edit, prose outside markers grounded in code, orphan
  reported-not-deleted, idempotence re-run, working-memory layer untouched.
- `feature-implementer/fixture-01` + `expected-01.md` — scope-check trap ("acme-tasks"):
  the task orders extending a method that doesn't exist while a review constraint freezes
  public names. Only correct outcome: **blocked-with-question with zero mutations**.

The pipeline plugin has no `devils-advocate` fixture and no `feature-contract-writer` fixture of
its own: every one written so far is a project of one stack, so it ships with that stack's plugin
and is listed in that plugin's `evals/README.md`. The first stack-neutral `devils-advocate`
fixture would be the JS-only `fixture-04` of the backlog below.

## Backlog

- `devils-advocate/fixture-04` — a JS-only project (no `composer.json`: a React SPA or a Node
  service) to prove the branch where the JS rubric is the only one, and a precision twin of
  fixture-03 (correct render modes, parsed config, a registry) to score what the JS checks
  manufacture.
- `feature-implementer/fixture-03` — the PHP happy path: a buildable fixture with runnable gates
  (make lint/test) and a clean implementable task.
