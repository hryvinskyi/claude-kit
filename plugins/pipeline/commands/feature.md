---
description: "Feature pipeline: plan + verify on the main-session model, implement via subagents routed to Opus or Sonnet per task, close the knowledge loop"
argument-hint: "<feature description> [--impl=auto|opus|sonnet|split] [--auto to skip the approval gate]"
disable-model-invocation: true
---

Run the two-model feature pipeline for: `$ARGUMENTS`

The split is deliberate: **planning, adversarial review, and final verification stay in this session** (run it on the strongest available model); **implementation is delegated to `pipeline:feature-implementer` subagents**, each with a clean, focused context, on the model the task is routed to (see *Implementer routing*). Track phases with the task-list tools when this build offers them; otherwise keep a short phase checklist in your own messages.

**This command is project-agnostic.** It is used across several repos, so never assume one project's layout, vault name, or tooling. Every path, gate, and script below is *discovered from the repo you are in* — resolve it from its `CLAUDE.md`/`AGENTS.md` and the repo itself, and never import another project's conventions.

## Implementer routing

`--impl=` in the invocation picks the implementers' model:

- `opus` — every task on Opus.
- `sonnet` — every task on Sonnet, except a task the routing rule below marks **Opus-only**: say which ones at the approval gate and keep them on Opus unless the user confirms Sonnet for them by name.
- `auto` (the default when the flag is absent) — each task is routed by the rule below.
- `split` — Opus designs, Sonnet builds. A task the rule sends to Opus by clause 1, 2, 3 or 5 is split in two: a `pipeline:feature-contract-writer` on Opus writes its contract (declarations plus failing tests), then a `pipeline:feature-implementer` on Sonnet makes those tests green without touching them. A clause-4 task (risky path) stays whole on Opus — a test written in advance does not catch everything that goes wrong there. A task the rule sends to Sonnet goes to Sonnet directly.

**The rule.** A task goes to **Opus** when any of these holds; otherwise to **Sonnet**:

1. It creates or moves a seam: a port/interface, a class another module consumes, a cross-module contract, a public API or `Api/Data` type, a service registration other code resolves. *(Opus-only)*
2. It touches the domain model: an entity, value object, aggregate, state machine, or an invariant the plan states. *(Opus-only)*
3. It fixes in-scope debt that needs a redesign (stranded business rules moved into the model, a `switch` replaced by a strategy set, a god class split) — not a rename or a typed signature.
4. It is on a risky path: money, auth/sessions, PII, tenancy, crypto/secrets, file upload/exec, data migration of existing rows, concurrency, idempotency, retries, a message published or consumed, a cache in front of a port. *(Opus-only)*
5. Its text leaves a judgement call open — "choose", "decide", "where appropriate" — or names more than about six production files, or depends on reading code across more than one module to get right.

A Sonnet task is one that follows a pattern the plan or the repo already shows: wiring a class the plan fully specifies, a template/layout/config entry, an adapter to a port another task defined, tests for a specified contract, a translation file, a mechanical rename.

The rule is applied per task, in Phase 1, and its verdict is written into the plan; nothing about routing is decided at dispatch time except escalation. The Impl column takes `opus`, `sonnet` or `split`.

## Phase 0 — Orient (this session)

**0a. Resolve the knowledge vault**: run `find-vault` from the repo root (the kit's vault tooling puts it on `PATH`) — the same rule `/decision`, `/journal`, `/todo`, `/wiki-sync` and the hooks use (the declared `Knowledge-base directory:` line in `CLAUDE.md`/`AGENTS.md`, else a **unique** dir holding `To DO.md` + `Decisions/` at depth 1 or under `.claude/`). Exit 1 = no vault → 0b. Exit 2 = ambiguous → ask the user which one. Do not assume any particular vault name; if you resolved via the fallback, add the missing declaration line to the project's `CLAUDE.md` so future runs are deterministic. Below, `<vault>/` denotes that directory.

**0b. If no vault exists, create it before planning** — the pipeline's knowledge loop (Phase 6) has nowhere to land otherwise. Create at `.claude/kb/` unless the project suggests a better home, and seed it from what the repo already knows (CLAUDE.md, module/package list, README) rather than leaving empty stubs:

```
<vault>/00 <Project> — Project Overview.md   # stack, layout, conventions, envs
<vault>/To DO.md                             # tracked work, this feature appended
<vault>/Decisions/                           # one file per accepted decision
<vault>/Modules/                             # one note per module/package
```

Tell the user you created it and where — do not silently invent a vault.

**0c. Orient.** Check `<vault>/To DO.md` (is this feature already tracked, with context?) and grep `<vault>/Decisions/` for records constraining this area. Read the vault notes of the modules involved. If the request conflicts with an accepted decision, surface that to the user before planning.

## Phase 1 — Plan (this session, strongest model)

**1a. Load the architectural rubric first — this is a gate, not a bullet.** Call the `Skill` tool
**before you read the code you are about to plan against, and before `_plan.md` exists**:
`architecture:clean-architecture-php` on a PHP project (a `composer.json` at the root),
`architecture:clean-architecture-js` when the feature ships JavaScript or TypeScript (a `package.json`/`tsconfig.json` project, or browser
work in a Magento or Symfony project — scripts, Stimulus controllers, React islands, templates that
load assets), **both** when it does both. Applying the lenses from memory is not this step: each
skill carries a reference set your recollection does not — PHP: `clean-architecture.md`, `solid.md`,
`ddd.md`, `integration-patterns.md`, `symfony.md`, `magento2.md`; JS/TS: `solid.md`,
`javascript.md`, `typescript.md`, `react.md`, `magento2-frontend.md`, `symfony-frontend.md`,
`ddd.md`, `clean-architecture.md`, `integration-patterns.md`. If no `Skill` call for it appears in
this session's transcript, the plan is not ready to be written — a hook enforces this on writes under
`.claude/plans/`, including the JS skill for a plan that names JS/TS files. On other stacks, load
that stack's equivalent rubric if the project declares one, and say in the plan that you did not.

**1b. Design domain-outward** — bounded context/placement (module? bridge? plugin?), invariants, ports, in-scope tech debt as first-class tasks.
- Match the plan to the host project's real conventions — its module namespace, framework idioms, and test layout — not to a template from another repo.
- Write `.claude/plans/<slug>/_plan.md`: context, the decisions taken, and a **task table** — each task self-contained enough for an implementer who knows nothing beyond its text: exact files/classes, contracts to expose, tests to write at both levels, and its dependencies on other tasks. Big features: one file per task (`.claude/plans/<slug>/task-N-*.md`).
- The task table carries an **Impl** column: `opus` or `sonnet`, with the clause of *Implementer routing* that decided it (`opus — 1 seam`, `sonnet — follows the pattern of task 2`). Under `--impl=opus` or `--impl=sonnet` still fill it from the rule — it is what the approval gate shows as overridden — and mark the forced value next to it.
- Write a Sonnet task for an executor that will not fill gaps: name every file, the exact signatures, the pattern it copies (a path), and the test cases. If you cannot write it that tightly, it is an Opus task.
- A `split` task names its contract: the declaration files, the files the implementer creates, and the rules the tests must pin. The contract's files must be ones the implementer never edits — shared config and wiring stay on the implementer's side.
- A task is well-sized when one focused agent finishes it in one run (roughly: one seam or one vertical slice — not "build the module").
- **Plan vocabulary is scaffolding.** Number tasks, invariants and decisions freely — it makes the plan cross-referenceable — but the plan directory is deleted in Phase 6, so that numbering must never reach the code. State in the task text that the implementer restates the rule in prose (*"an unknown code fails loudly"*), never cites it (*"invariant 3"*), and that lasting rationale is returned for the vault instead of being written into comments.

## Phase 2 — Adversarial review (subagent, inherits this session's model)

- Spawn the `pipeline:devils-advocate` agent on the plan. It auto-applies Critical/Important fixes to the plan files and reports.
- Read its report; resolve anything it left under *Questions for the Team* (ask the user if genuinely theirs to decide).
- Re-run the routing rule over every task the review changed: a fix that adds a seam, an invariant or a risky path to a Sonnet task moves it to Opus.

## Phase 3 — Approval gate

- Present the plan summary (tasks with their **Impl** model and the clause behind it, touched modules, risks) to the user via AskUserQuestion and wait — **unless** the invocation contains `--auto`, in which case proceed. The user may re-route any task here; write their choice into the Impl column.

## Phase 4 — Implement (routed subagents)

- Dispatch one `pipeline:feature-implementer` agent per task with `model` set to the task's Impl value — always pass it explicitly; the agent's frontmatter `opus` is only a fallback for callers outside this pipeline. Prompt = plan slug + task id + the task text verbatim + any review-round context. Order by the dependency column; **independent tasks go out in parallel in a single message**. If parallel tasks would edit the same files, either serialize them or use `isolation: "worktree"` (not for a `split` task: a worktree starts from `HEAD` and would not see the uncommitted contract — serialize those instead). A worktree agent's changes stay on its own branch: when it returns, merge (or cherry-pick) that branch into the working branch yourself, resolve conflicts, run the touched tests once more, then remove the worktree — nothing lands by itself.
- **A `split` task runs in two steps.**
  1. *Contract* — dispatch `pipeline:feature-contract-writer` with `model: "opus"`, in the same dependency order; independent contracts go out in parallel. Review what it returns before anything is frozen: read every test — does each rule of the task have one, does it exercise behaviour through the public surface, is the red run red because the implementation is missing? Send gaps back via SendMessage. A report with a substantive *Not pinned* item turns the task into a whole-Opus task.
  2. *Freeze* — when the contract is accepted: `shasum -a 256 <frozen files> > .claude/plans/<slug>/_contract-<task>.sha256`.
  3. *Implement* — dispatch `pipeline:feature-implementer` with `model: "sonnet"`; the prompt adds the frozen file list, the hash file's path and the contract writer's *Implementation notes* verbatim. When it returns, run `shasum -a 256 -c` on the hash file yourself: a changed frozen file is a defect — restore it and send the correction back, whatever the report says.
  4. *Contract wrong* — an implementer blocked on a frozen test that contradicts the plan: decide who is right. If the contract is, answer the implementer. If it is not, continue the contract writer via SendMessage with the correction, review again, re-freeze, then continue the implementer.
- Every implementer reads the rubric's implementer checklist before its first PHP or JS/TS source edit — the PHP skill's for PHP, the JS skill's for JavaScript and TypeScript (the same hook that gated the plan gates source); a report that skipped it on a task with a seam or a debt fix goes back for the redesign.
- An agent that returns *blocked-with-question*: answer it and continue **the same agent** via SendMessage (it keeps its context) — don't respawn cold.
- **Escalate a Sonnet task to Opus** — a fresh `pipeline:feature-implementer` with `model: "opus"`, since a running agent cannot change model — when:
  - its question shows the task needs a design decision the plan did not make (a new seam, an invariant, a choice between strategies) — make the decision first, write it into the task text, then dispatch;
  - its report carries a structural deviation, or a correction sent back once still comes back wrong;
  - it reports a gate it could not get green.
  The Opus agent's prompt adds the Sonnet agent's report and the list of files it already changed, with the instruction to review that work against the task and keep only what is right. On a `split` task the Opus implementer gets the same frozen contract. Note the escalation and its trigger in the Impl column.
- Never route down: an Opus task that went badly is corrected or re-dispatched on Opus.
- Audit every report: deviations from the plan are reviewed here, on the strong model — accept, or send the correction back via SendMessage.

## Phase 5 — Verify (this session, strongest model)

- **Discover the gates first** — read `composer.json` scripts / `package.json` scripts / Makefile / CI workflow, and check whether the project runs under DDEV, Docker, or the host (including any documented pre-step, e.g. a file-sync before in-container runs). Run every gate that exists; never invoke a gate the project doesn't define.
  - If the project defines **no** automated gates, say so plainly in the final report and fall back to what is available (targeted test run, linter, static analysis if installed) — do not report a clean run that never happened.
- Review the complete `git diff` yourself against the plan and that project's repo law (boundaries, tests at both levels, comment scope, and its own i18n/locale obligations). Small fixes: apply directly. Structural misses: re-dispatch to the owning implementer with a precise correction — on a Sonnet task, that is an escalation to Opus (Phase 4).
  - **An implementer's report is not a review, and neither is a green gate.** Gates check types, boundaries and tests. They do not check whether a controller builds `new TranslatableMessage('key', [], 'domain')` at every call site, or types a helper on a concrete class. That has shipped past every gate. Nothing is committed until you have **read** the diff of every touched source file.
  - **Frozen contracts hold** — run `shasum -a 256 -c` over every `.claude/plans/<slug>/_contract-*.sha256` before the sweep; a line that is not `OK` blocks the commit until it is explained and resolved.
  - **Mechanical sweep first, then the reading.** Run the architectural skill's detection recipes (`solid.md` §Detection recipes, the stack reference's §Detection recipes) over **every touched file in full**, not only the changed lines, and list each hit with its verdict in the Phase 6 report. A file an implementer touched brings its whole content into scope: an English literal or `$e->getMessage()` shown to a user beside the changed line is in-scope debt, not "outside this ticket". On a PHP project the minimum is (non-test files; `throw new` and a factory's own implementation are the only innocent `new`):
    `git diff --name-only | grep -E '\.php$' | grep -v /tests/ | xargs rg -nP '(?<!throw )\bnew\s+(?!class\b)[\w\\]+\s*\(|addFlash\(|getMessage\(\)|function \w+\([^)]*\b(TranslatableMessage|Translator|EventDispatcher)\b\s+\$|\bswitch\s*\(|\belse\s?if\b'`
    Use the ripgrep binary, not a shell function: `xargs` cannot call a function, and a sweep that never ran reads as zero hits. Check the file list is non-empty.
    A hit you cannot clear by the recipe's *innocent when* column is a defect: fix it or re-dispatch it before the commit.
- **Independent adversarial code review** — you audited a pipeline you also managed; now get fresh eyes. Run `/code-review` on the working diff if available in this environment; otherwise spawn a reviewer subagent with a clean context, prompted to *refute* the diff against the plan and repo law. Verify each finding before acting (a plausible-sounding finding is not yet a real one); fix confirmed ones most-severe-first.
- **Conditional security pass** — if the diff touches auth/sessions, money movement, PII, tenancy/RLS, crypto/secrets, or file-upload/exec paths: run `/security-review` (or a security-focused subagent if unavailable) before calling the feature done. Note in the final report that it ran and what it found — or explicitly that it wasn't needed and why.
- **Sideways-naming review** — a module names only what it depends on (the engineering standards in your user `CLAUDE.md`, *Architecture and tech debt*). List the vendors present in the project (`ls app/code vendor` on Magento; the vendor half of `packages/*/composer.json` names on a monorepo; the scopes and names in `package.json` dependencies on a JS project) and grep the diff of each touched module for those names that its own `composer.json` / `module.xml` / `package.json` does not declare:
  `git diff -U0 -- <module path> | grep -nE '^\+.*\b(Vendor1|Vendor2|…)\b'`
  Read every hit with judgment — a plain word that happens to match a vendor is not a violation; a comment or identifier that explains a workaround by the neighbour's name is. Reword such lines to the situation and move the neighbour's name into the Phase 6 vault note. No hook does this: the check needs a reader.
- **Plan-reference gate** — the plan dies in Phase 6, so nothing in the tree may point at it. Run over the working tree (not just the diff — earlier tasks leak too):
  `grep -rnEi '(task[ -]?[0-9]|invariant [0-9]|decision [0-9]|per the plan|_plan\.md|devil)' <touched paths>`
  Every hit in code, PHPDoc, XML `comment=`, or test docblocks is a defect: rewrite it to state the rule itself, and carry the rationale into the Phase 6 vault note instead. Skip nothing as "just a test comment".

## Phase 6 — Close the knowledge loop (this session)

- User-visible behavior changed **and** the project ships user docs → run the `docs-updater` agent against that project's docs tree.
- Spawn the `wiki-updater` agent scoped to the touched modules — it runs the project's vault-sync script when one is declared, refreshes the facts by hand otherwise, writes the prose for the changed module notes, and verifies with an idempotent re-run. Read its report; it must confirm the re-run was a no-op.
- Record decisions (`/decision` flow), journal the work (`/journal` flow), update `<vault>/To DO.md`.
- **Land the implementers' *For the vault* sections** — the invariant list, published contracts, closed strategy sets and implementation decisions they were forbidden from writing into comments. Merge them into `<vault>/Modules/<Module>.md` (module-scoped facts) or `<vault>/Decisions/` (choices with alternatives). This is the *only* place that knowledge now lives; skipping it loses it for good.
- Retire the plan: verify the vault note answers what the plan answered, then delete `.claude/plans/<slug>/`.
- Report: what shipped, gate results (including gates that don't exist), decisions recorded, follow-ups added, and the routing outcome — each task's model, every escalation with its trigger, every structural miss Phase 5 found in a Sonnet task, and in split mode every contract the implementer got blocked on (those are the evidence for tightening the routing rule). Do not commit unless asked.
