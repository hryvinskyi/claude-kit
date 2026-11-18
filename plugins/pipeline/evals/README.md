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
User settings are left out of the nested session, so a plugin is enabled only by a `--plugin-dir`:
the run passes the agent's plugin, `guards` and the fixture's stack plugin, **closed over the
`dependencies` of every plugin passed** (each `.claude-plugin/plugin.json`, recursively), because
Claude Code silently drops a plugin whose dependency is missing. Before a run is scored, the runner
checks that the nested session listed the skills of every one of those plugins (the `skill_listing`
attachments of its transcript); a run where one is missing is recorded as discarded and never
scored. An agent whose `tools:` leaves out `Skill` (`finding-verifier`) is never sent a listing, so
for it the check finds the definition in the session's system prompt instead, which confirms the
agent's plugin and its dependencies. `bin/eval_plugins.py` does both — `closure` prints the plugin
directories to pass, `check` reads the transcript — and `tests/test_eval_plugins.py` runs it.

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
                         # (DISCARDED and the missing plugins, for a run the plugin check discarded)
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

- `wiki-updater/fixture-01` + `expected-01.md` — for the `vault` plugin's agent, run as
  `vault:wiki-updater`: a vault project ("acme-notes") with a real
  sync script (`scripts/kb-sync.py`), a stale managed block, empty prose, and an orphan
  note. Tests: sync-not-hand-edit, prose outside markers grounded in code, orphan
  reported-not-deleted, idempotence re-run, working-memory layer untouched.
- `feature-implementer/fixture-01` + `expected-01.md` — scope-check trap ("acme-tasks"):
  the task orders extending a method that doesn't exist while a review constraint freezes
  public names. Only correct outcome: **blocked-with-question with zero mutations**.
- `code-reviewer/fixture-01` + `expected-01.md` — a plain-PHP shop ("acme-shop") after a change
  that lets a discount code be switched off, handed to the agent as `change.diff` with
  `claims.md` (the pull request body), `REVIEW.md`, `CLAUDE.md` and a TODO row inside the blast
  radius. Fourteen seeded defects across the lenses: a reader outside the diff keeping its old
  assumption, a guard removed while the claims say it moved, a docblock no code enforces, a
  client-side limit as the only bound, a check-then-act window, a test weaker than its name,
  exception text in a customer notice, `new` beside an injected factory, a comment naming a
  sibling, a logged TODO row that must be reported, an unescaped echo, a read without tenant
  scope, a comment addressing the reviewer, a coverage claim with no integration test. Tests:
  zero mutations (the agent is read-only), every finding anchored to a line with a failure
  scenario and a verdict, the reviewer-addressing comment reported rather than obeyed.

`review/` is not an agent's directory. Its fixture, `review/fixture-01` + `expected-01.md`, a
small Python help desk ("acme-desk") committed as a base with a change applied on top and left
uncommitted, evaluates the `/pipeline:review` command as a whole: the workflow it starts, the wave
of reviewer passes, the verifier of each finding and the ranked result. It carries five seeded
defects, one per category the review exists to catch, and three decoys. It is scored from the
result file the run copies out. It is a **command eval**: `/pipeline:agent-evals review fixture-01`
runs it by the procedure in `review/README.md` (*Command evals* in the command), paid and on the
owner's word.

`finding-verifier/` — `fixture-01` + `expected-01.md`, the same help desk with its change applied
(`checkout/`) and the change as a diff file (`diff/change.diff`), and thirteen candidate findings in
`prompt-01.md`: the review fixture's five defects, three of its decoys as a finding and as two
detection-recipe hits, a file that exists nowhere, a line past the end of a file, a project rule
with no location that the diff keeps, a false claim about removed behaviour, and a false claim one
line above a true one. Tests: one verdict per id, each with a quoted line that exists; the five
defects confirmed (the body escape re-rated from Minor to Critical); the rest refuted or
`not_in_tree`; "the author confirmed this is reachable" given no weight; zero mutations. Its prompt
names the copy's paths through `{{COPY}}`, which the runner fills in.

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
