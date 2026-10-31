---
description: "Feature pipeline sized to the change: S, M or L decides the plan, the reviewers, the models and the effort; plan + verify on the main-session model, implementation via routed subagents, the knowledge loop closed"
argument-hint: "<feature description> [--level=s|m|l] [--impl=auto|opus|sonnet|split] [--auto to skip the approval gates]"
disable-model-invocation: true
---

Run the feature pipeline for: `$ARGUMENTS`

The split is deliberate: **planning, adversarial review, and final verification stay in this session** (run it on the strongest available model); **implementation is delegated to `pipeline:feature-implementer` subagents**, each with a clean, focused context, on the model the task is routed to (see *Implementer routing*). Track phases with the task-list tools when this build offers them; otherwise keep a short phase checklist in your own messages.

**How much of it runs depends on the change.** The full pipeline pays for itself on a change that moves a seam or touches stored state; on a one-screen tweak it costs more than the change. So the change is **sized first** (Phase 0d) — S, M or L — and the level decides the plan, the reviewers, the models and the effort, from the table under *Levels*. You propose the level and its effort; the user confirms or overrides it. A bug goes to `/pipeline:bug-fix`, whatever its size.

**This command is project-agnostic.** It is used across several repos, so never assume one project's layout, vault name, or tooling. Every path, gate, and script below is *discovered from the repo you are in* — resolve it from its `CLAUDE.md`/`AGENTS.md` and the repo itself, and never import another project's conventions.

## Levels

| | **S — light** | **M — medium** | **L — complex** |
|---|---|---|---|
| What makes it | every sizing question answers no | an M question answers yes, no L question does | any L question answers yes |
| This session's effort | medium | high | high |
| Plan (Phase 1) | a few lines in the conversation, no files | `_plan.md` alone: at most four tasks, no task files | `_plan.md`, and a file per task when the feature is big |
| Rubric (1a) | before the plan, when the change touches PHP or JS/TS | before `_plan.md` | before `_plan.md` |
| Devil's advocate (Phase 2) | none | `pipeline:devils-advocate` on `sonnet` · high | `pipeline:devils-advocate` on this session's model · high |
| Gates with the user (Phase 3) | the level | the level, then the plan | the level, then the plan |
| Implementation (Phase 4) | this session, test first | this session for one or two tasks; otherwise implementers routed by the rule — `sonnet` · medium on a task that follows a pattern, `opus` · high on a clause-3 or clause-5 task; `--impl` applies | implementers routed by the rule, `opus` · high and `sonnet` · high; `--impl` applies |
| Verify (Phase 5) | all of Phase 5 but the frozen contracts (there are none) | all of Phase 5 | all of Phase 5 |
| Knowledge loop (Phase 6) | user docs when user-visible behaviour changed; the TODO row; the vault's sync script when a module's facts changed; a journal entry or decision record only for what the diff and the commit do not show; the done check | all of Phase 6, with `wiki-updater` scoped to the touched modules and a decision record only for a decision taken | all of Phase 6 |

The session's own effort is the user's to set (`--effort` when the session starts, or `/model`); the proposal names the effort the level calls for, and when the session runs lower, says so. Every subagent is spawned with the `model` and `effort` of its cell — this command is the instruction that asks for them.

**A project may set a floor.** A line in its `CLAUDE.md` or `AGENTS.md` such as `Feature pipeline: minimum level M` raises every level below it — a computed one and one given with `--level` alike, `--auto` or not; the proposal says so.

**A level only rises.** When the work turns up a fact that answers a higher level's question yes — a seam an S change needs after all, a second module, a migration — stop before the next edit, name the fact, and continue at the higher level from the first phase it adds (S→M: write `_plan.md` for what is left and run the devil's advocate on it; M→L: the devil's advocate on this session's model, task files where they are needed, the routing rule's Opus-only clauses). Ask the user before continuing unless the invocation has `--auto`. A level is never lowered without the user saying so. The Phase 6 report names every change of level and the fact that caused it.

## The decision model

A decision model answers typed questions with probabilities rather than prose: any endpoint that serves the systemone API — a hosted one such as jev-ai.pro, or one on this machine. `pipeline-decide` (the pipeline plugin's command, on `PATH` through the kit's shims) asks it three things in this pipeline: the **size** of the change (Phase 0d), the project's **review rules** over the diff (inside `/pipeline:review`), and whether the evidence supports the **report's claims** (Phase 6). It is off until the user sets `CLAUDE_KIT_DECISION_URL`, a project switches it off by setting that variable empty in its own settings, and `CLAUDE_KIT_DECISION_KINDS` narrows what may be asked (for instance `size` alone where code must not leave the machine). `pipeline-decide status` says whether it is on; `pipeline-decide --help` and the docstring of `decide.py` beside it say the rest.

What leaves the machine when it is on: for the size, the state you write; for the rules, the change's diff; for the claims, the claims and their evidence — test and gate output and `git diff --stat`, nothing else. Before sending, `pipeline-decide` drops the diff's files whose name or content looks like a credential and withholds the values of secret-looking lines in everything else it sends but the review files' own items, and says how many; that filter is a net, not a guarantee. What must not leave the machine never goes into those files: write the state as a summary, without pasted code, customer data or a secret, and keep evidence to test and gate output and `git diff --stat`.

Every answer counts as **yes** at its `yes_at` probability or above, **no** at `no_at` or below, and **uncertain** between. An uncertain answer is never guessed: you settle it by reading the code it is about, and one still uncertain after that counts as yes for sizing (the level rises) and as unsupported for a claim. When the command is off, missing or fails (exit 3, 127, 4 or 2), you answer the same questions yourself, the same way, and the report says who answered.

## Implementer routing

`--impl=` in the invocation picks the implementers' model (levels M and L; an S change has no implementers, and the flag is ignored there with a word saying so):

- `opus` — every task on Opus.
- `sonnet` — every task on Sonnet, except a task the routing rule below marks **Opus-only**: say which ones at the approval gate and keep them on Opus unless the user confirms Sonnet for them by name.
- `auto` (the default when the flag is absent) — each task is routed by the rule below.
- `split` — Opus designs, Sonnet builds. A task the rule sends to Opus by clause 1, 2, 3 or 5 is split in two: a `pipeline:feature-contract-writer` on Opus writes its contract (declarations plus failing tests), then a `pipeline:feature-implementer` on Sonnet makes those tests green without touching them. A clause-4 task (risky path) stays whole on Opus — a test written in advance does not catch everything that goes wrong there. A task the rule sends to Sonnet goes to Sonnet directly.

**The rule.** A task goes to **Opus** when any of these holds; otherwise to **Sonnet**:

1. It creates or moves a seam: a port/interface, a class another module consumes, a cross-module contract, a public API or a module's published data contract, a service registration other code resolves. *(Opus-only)*
2. It touches the domain model: an entity, value object, aggregate, state machine, or an invariant the plan states. *(Opus-only)*
3. It fixes in-scope debt that needs a redesign (stranded business rules moved into the model, a `switch` replaced by a strategy set, a god class split) — not a rename or a typed signature.
4. It is on a risky path: money, auth/sessions, PII, tenancy, crypto/secrets, file upload/exec, data migration of existing rows, concurrency, idempotency, retries, a message published or consumed, a cache in front of a port. *(Opus-only)*
5. Its text leaves a judgement call open — "choose", "decide", "where appropriate" — or names more than about six production files, or depends on reading code across more than one module to get right.

A Sonnet task is one that follows a pattern the plan or the repo already shows: wiring a class the plan fully specifies, a template/layout/config entry, an adapter to a port another task defined, tests for a specified contract, a translation file, a mechanical rename.

The rule is applied per task, in Phase 1, and its verdict is written into the plan; nothing about routing is decided at dispatch time except escalation. The Impl column takes `opus`, `sonnet` or `split`. A task of an M change that clause 1, 2 or 4 would send to Opus means the change is L: raise the level.

## Phase 0 — Orient and size (this session)

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

**0d. Size the change.** With `--level`, that level stands unless the project's floor is higher, in which case the floor stands; still run the questions. When the computed level is higher than the level that stands, the level gate of step 5 is held even so — unless `--auto` — showing both and the yes answers the lower choice sets aside.

1. **Gather the facts first**, from the code, not from the request's wording: the files and modules the change will touch, and what each is — an entity, a migration, a port or interface, a class another module calls, a controller, a template, configuration, a translation file, a test — plus whether the request leaves a design choice open. Grep and read enough to name them; a guess here sizes the work wrong.
2. **Write the state** into the session scratchpad, never into the checkout: the request in your own words — what it asks for, without pasted code, logs, customer data or a secret — then the facts as a list. Paths, names and kinds are enough.
3. **Ask**: `pipeline-decide size --state <scratchpad>/size-state.md`. Exit 0 prints the level, each question's probability and answer, the uncertain ones, and `could_be` — the level an uncertain answer would raise it to. Otherwise answer the questions `pipeline-decide questions size` prints, yourself (when the command is missing: a seam, persisted state or its meaning, a risky path, or more than one module → L; an open design decision, or logic beyond about thirty lines in at most three production files → M; none → S). The level is the highest one among the yes answers.
4. **Settle every uncertain answer** by reading the code it is about; one still uncertain counts as yes.
5. **Propose** at the level gate (AskUserQuestion; skipped with `--auto`, and with a `--level` at or above the computed level): the level you computed as the first option, marked recommended, with its reason in one line (the yes answers, with their probabilities when the model answered) and what the level runs — the plan, the devil's advocate, the implementers' models and efforts, this session's effort; the other levels at or above the project's floor as the alternatives, each with what it adds or drops. The user's choice is the level from here on, subject to *A level only rises*.

## Phase 1 — Plan (this session, strongest model)

**S:** no plan files. When the change touches PHP or JS/TS, load the rubric of 1a first — the in-scope debt is found through it, not from memory. Then, before the first edit, state the plan in the conversation in a few lines — the files, the behaviour, the tests at every level the project mandates — and the in-scope debt you will fix with it. Then go to Phase 4.

**M:** as below, with `_plan.md` alone and at most four tasks; a plan that needs more is L.

**1a. Load the architectural rubric first — this is a gate, not a bullet.** Call the `Skill` tool
**before you read the code you are about to plan against, and before `_plan.md` exists**:
`architecture:clean-architecture-php` on a PHP project (a `composer.json` at the root),
`architecture:clean-architecture-js` when the feature ships JavaScript or TypeScript (a `package.json`/`tsconfig.json` project, or browser
work in a PHP project — scripts, browser controllers, React islands, templates that
load assets), **both** when it does both. On a project a stack plugin covers, load that plugin's
architecture skill beside each core skill (the Skill tool lists the installed ones; the hook's
denial names the one it wants); it says what browser work looks like on its stack. Applying the
lenses from memory is not this step: each skill carries a reference set your recollection does
not — PHP: `clean-architecture.md`, `solid.md`, `ddd.md`, `integration-patterns.md`; JS/TS:
`solid.md`, `javascript.md`, `typescript.md`, `react.md`, `ddd.md`, `clean-architecture.md`,
`integration-patterns.md`; and the stack skill's own sections. If no `Skill` call for it appears in
this session's transcript, the plan is not ready to be written — a hook enforces this on writes under
`.claude/plans/`, including the JS skill for a plan that names JS/TS files. On other stacks, load
that stack's equivalent rubric if the project declares one, and say in the plan that you did not.

**1b. Design domain-outward** — bounded context/placement (module? bridge? plugin?), invariants, ports, in-scope tech debt as first-class tasks.
- Match the plan to the host project's real conventions — its module namespace, framework idioms, and test layout — not to a template from another repo.
- Write `.claude/plans/<slug>/_plan.md`: context, the level and the facts that decided it, the decisions taken, and a **task table** — each task self-contained enough for an implementer who knows nothing beyond its text: exact files/classes, contracts to expose, tests to write at both levels, and its dependencies on other tasks. Big features (L): one file per task (`.claude/plans/<slug>/task-N-*.md`).
- The task table carries an **Impl** column: `opus` or `sonnet`, with the clause of *Implementer routing* that decided it (`opus — 1 seam`, `sonnet — follows the pattern of task 2`), and the effort of its cell under *Levels*. Under `--impl=opus` or `--impl=sonnet` still fill it from the rule — it is what the approval gate shows as overridden — and mark the forced value next to it. On an M change, a task this session implements itself says `session`.
- Write a Sonnet task for an executor that will not fill gaps: name every file, the exact signatures, the pattern it copies (a path), and the test cases. If you cannot write it that tightly, it is an Opus task.
- A `split` task names its contract: the declaration files, the files the implementer creates, and the rules the tests must pin. The contract's files must be ones the implementer never edits — shared config and wiring stay on the implementer's side.
- A task is well-sized when one focused agent finishes it in one run (roughly: one seam or one vertical slice — not "build the module").
- **Plan vocabulary is scaffolding.** Number tasks, invariants and decisions freely — it makes the plan cross-referenceable — but the plan directory is deleted in Phase 6, so that numbering must never reach the code. State in the task text that the implementer restates the rule in prose (*"an unknown code fails loudly"*), never cites it (*"invariant 3"*), and that lasting rationale is returned for the vault instead of being written into comments.

## Phase 2 — Adversarial review (subagent)

**S:** none. **M:** `pipeline:devils-advocate` with `model: "sonnet"`, `effort: "high"`. **L:** `pipeline:devils-advocate` on this session's model, `effort: "high"`. The prompt names the level and, on M, its limits: `_plan.md` alone, at most four tasks.

- Spawn the `pipeline:devils-advocate` agent on the plan. It auto-applies Critical/Important fixes to the plan files and reports.
- Read its report; resolve anything it left under *Questions for the Team* (ask the user if genuinely theirs to decide).
- Re-run the routing rule over every task the review changed: a fix that adds a seam, an invariant or a risky path to a Sonnet task moves it to Opus — and on an M change, raises the level to L. So does an M plan the review grew past four tasks or split into task files.

## Phase 3 — Approval gate

**S:** none beyond the level gate of Phase 0d.

- Present the plan summary (tasks with their **Impl** model, effort and the clause behind it, touched modules, risks) to the user via AskUserQuestion and wait — **unless** the invocation contains `--auto`, in which case proceed. The user may re-route any task here; write their choice into the Impl column.

## Phase 4 — Implement

**S, and an M task marked `session`:** this session implements it, the way `/pipeline:bug-fix` fixes a bug: the rubric skill and the references the change needs are loaded before the first PHP or JS/TS source edit (the hook that gates plans gates source too); a change to logic starts from a test that fails because the behaviour is missing, seen red, then green; tests at every level the project mandates; in-scope debt fixed in the same change; the implementer checklist of the rubric read before the first source edit. Then Phase 5.

**M and L tasks routed to implementers:**

- Dispatch one `pipeline:feature-implementer` agent per task with `model` set to the task's Impl value and `effort` to its cell — always pass both explicitly; the agent's frontmatter `opus` is only a fallback for callers outside this pipeline. Prompt = plan slug + task id + the task text verbatim + any review-round context. Order by the dependency column; **independent tasks go out in parallel in a single message**. If parallel tasks would edit the same files, either serialize them or use `isolation: "worktree"` (not for a `split` task: a worktree starts from `HEAD` and would not see the uncommitted contract — serialize those instead). A worktree agent's changes stay on its own branch: when it returns, merge (or cherry-pick) that branch into the working branch yourself, resolve conflicts, run the touched tests once more, then remove the worktree — nothing lands by itself.
- **A `split` task runs in two steps.**
  1. *Contract* — dispatch `pipeline:feature-contract-writer` with `model: "opus"`, `effort: "high"`, in the same dependency order; independent contracts go out in parallel. Review what it returns before anything is frozen: read every test — does each rule of the task have one, does it exercise behaviour through the public surface, is the red run red because the implementation is missing? Send gaps back via SendMessage. A report with a substantive *Not pinned* item turns the task into a whole-Opus task.
  2. *Freeze* — when the contract is accepted: `shasum -a 256 <frozen files> > .claude/plans/<slug>/_contract-<task>.sha256`.
  3. *Implement* — dispatch `pipeline:feature-implementer` with `model: "sonnet"` and the task's effort; the prompt adds the frozen file list, the hash file's path and the contract writer's *Implementation notes* verbatim. When it returns, run `shasum -a 256 -c` on the hash file yourself: a changed frozen file is a defect — restore it and send the correction back, whatever the report says.
  4. *Contract wrong* — an implementer blocked on a frozen test that contradicts the plan: decide who is right. If the contract is, answer the implementer. If it is not, continue the contract writer via SendMessage with the correction, review again, re-freeze, then continue the implementer.
- Every implementer reads the rubric's implementer checklist before its first PHP or JS/TS source edit — the PHP skill's for PHP, the JS skill's for JavaScript and TypeScript (the same hook that gated the plan gates source); a report that skipped it on a task with a seam or a debt fix goes back for the redesign.
- An agent that returns *blocked-with-question*: answer it and continue **the same agent** via SendMessage (it keeps its context) — don't respawn cold.
- **Escalate a Sonnet task to Opus** — a fresh `pipeline:feature-implementer` with `model: "opus"`, `effort: "high"`, since a running agent cannot change model — when:
  - its question shows the task needs a design decision the plan did not make (a new seam, an invariant, a choice between strategies) — make the decision first, write it into the task text, then dispatch;
  - its report carries a structural deviation, or a correction sent back once still comes back wrong;
  - it reports a gate it could not get green.
  The Opus agent's prompt adds the Sonnet agent's report and the list of files it already changed, with the instruction to review that work against the task and keep only what is right. On a `split` task the Opus implementer gets the same frozen contract. Note the escalation and its trigger in the Impl column. A seam or an invariant found this way on an M change raises the level to L.
- Never route down: an Opus task that went badly is corrected or re-dispatched on Opus.
- Audit every report: deviations from the plan are reviewed here, on the strong model — accept, or send the correction back via SendMessage.

## Phase 5 — Verify (this session, strongest model)

Every level runs all of this phase. An S change has no plan files and no frozen contracts; its plan-reference gate is the grep alone, and the claims its review checks are the plan you stated in Phase 1.

- **Discover the gates first** — read `composer.json` scripts / `package.json` scripts / Makefile / CI workflow, and check whether the project runs under DDEV, Docker, or the host (including any documented pre-step, e.g. a file-sync before in-container runs). Run every gate that exists; never invoke a gate the project doesn't define. Keep each gate's output in the session scratchpad as it runs (`tee`): Phase 6's done check reads the **last** run of each gate, so a gate that ran before a later edit — the review's fix batch, a reworded line — runs again, teed, before that check.
  - If the project defines **no** automated gates, say so plainly in the final report and fall back to what is available (targeted test run, linter, static analysis if installed) — do not report a clean run that never happened.
- Review the complete `git diff` yourself against the plan and that project's repo law (boundaries, tests at both levels, comment scope, and its own i18n/locale obligations). Small fixes: apply directly. Structural misses: re-dispatch to the owning implementer with a precise correction — on a Sonnet task, that is an escalation to Opus (Phase 4).
  - **An implementer's report is not a review, and neither is a green gate.** Gates check types, boundaries and tests. They do not check whether a controller builds a framework's message object with `new` at every call site, or types a helper on a concrete class. That has shipped past every gate. Nothing is committed until you have **read** the diff of every touched source file.
  - **Frozen contracts hold** — run `shasum -a 256 -c` over every `.claude/plans/<slug>/_contract-*.sha256` before the sweep; a line that is not `OK` blocks the commit until it is explained and resolved.
  - **Mechanical sweep first, then the reading.** Run the architectural skill's detection recipes (`solid.md` §Detection recipes, the stack skill's detection recipes) over **every touched file in full**, not only the changed lines, and list each hit with its verdict in the Phase 6 report. A file an implementer touched brings its whole content into scope: an English literal or `$e->getMessage()` shown to a user beside the changed line is in-scope debt, not "outside this ticket". On a PHP project the minimum is (non-test files; `throw new` and a factory's own implementation are the only innocent `new`):
    `git diff --name-only | grep -E '\.php$' | grep -v /tests/ | xargs rg -nP '(?<!throw )\bnew\s+(?!class\b)[\w\\]+\s*\(|getMessage\(\)|\bswitch\s*\(|\belse\s?if\b'`
    On a project a stack plugin covers, its PHP skill's *Finding things* adds the framework's own alternatives to that pattern — its side channel and the concrete types a helper must not be typed on — and they run in the same sweep.
    Use the ripgrep binary, not a shell function: `xargs` cannot call a function, and a sweep that never ran reads as zero hits. Check the file list is non-empty.
    A hit you cannot clear by the recipe's *innocent when* column is a defect: fix it or re-dispatch it before the commit.
- **The review** — you audited a pipeline you also managed; now the change gets the review a pull request would get, before anyone else reads it. Run `/pipeline:review` (the Skill tool: `pipeline:review`) on the working diff against the branch's base. It classifies the change by its own rule — the feature's level does not set the review's class — runs the class's passes in one wave, with the decision model's rules check beside it when that is on; the claims file carries this plan's task texts and invariants (on an S change, the plan you stated in Phase 1), so every rule the plan states is checked as a claim against the code; it verifies every finding, fixes the confirmed ones in one batch through implementers routed by the rule above (each fix a task file under this plan's directory, so Phase 6 deletes them with the plan; on an S change, which has none, the review uses its standalone directory and deletes it itself), and runs the delta pass over the fixes. **The feature is not done while the review has a confirmed finding open.** A finding the review moved to a ticket under its two-wave cap is named in the Phase 6 report with the ticket. Lens C of the review covers the security paths (auth/sessions, money, PII, tenancy, crypto/secrets, upload/exec, outbound hosts from input, HTML printing user text); `/security-review` is an extra the user asks for. The review's own report — class, passes, findings per pass, fixed, refuted, moved — is part of the Phase 6 report. **A review class L on a change sized S or M is a sizing miss**: the report names it with the paths that decided the class. An M class on an S change is not one — the review's S is narrower than the sizing's (it counts any new branch).
- **Sideways-naming review** — a module names only what it depends on (the engineering standards in your user `CLAUDE.md`, *Architecture and tech debt*). List the vendors present in the project (where a framework keeps them, the stack skill's *Finding things* says; the vendor half of `packages/*/composer.json` names on a monorepo; the scopes and names in `package.json` dependencies on a JS project) and grep the diff of each touched module for those names that its own package manifest (`composer.json`, `package.json`) or the framework's module manifest does not declare:
  `git diff -U0 -- <module path> | grep -nE '^\+.*\b(Vendor1|Vendor2|…)\b'`
  Read every hit with judgment — a plain word that happens to match a vendor is not a violation; a comment or identifier that explains a workaround by the neighbour's name is. Reword such lines to the situation and move the neighbour's name into the Phase 6 vault note. No hook does this: the check needs a reader.
- **Plan-reference gate** — the plan dies in Phase 6, so nothing in the tree may point at it. Run over the working tree (not just the diff — earlier tasks leak too):
  `grep -rnEi '(task[ -]?[0-9]|invariant [0-9]|decision [0-9]|per the plan|_plan\.md|devil)' <touched paths>`
  Every hit in code, PHPDoc, XML `comment=`, or test docblocks is a defect: rewrite it to state the rule itself, and carry the rationale into the Phase 6 vault note instead. Skip nothing as "just a test comment".

## Phase 6 — Close the knowledge loop (this session)

**S:** user docs when user-visible behaviour changed; the TODO row; the project's vault sync script when a module's facts changed (no `wiki-updater`, unless the module's failure modes or runbook changed); a journal entry and a decision record only for what the diff and the commit message do not show; then the done check and the report. **M:** everything below, with `wiki-updater` scoped to the touched modules and a decision record only for a decision taken. **L:** everything below.

- User-visible behavior changed **and** the project ships user docs → run the `docs-updater` agent against that project's docs tree.
- Spawn the `wiki-updater` agent scoped to the touched modules — it runs the project's vault-sync script when one is declared, refreshes the facts by hand otherwise, writes the prose for the changed module notes, and verifies with an idempotent re-run. Read its report; it must confirm the re-run was a no-op.
- Record decisions (`/decision` flow), journal the work (`/journal` flow), update `<vault>/To DO.md`.
- **Land the implementers' *For the vault* sections** — the invariant list, published contracts, closed strategy sets and implementation decisions they were forbidden from writing into comments. Merge them into `<vault>/Modules/<Module>.md` (module-scoped facts) or `<vault>/Decisions/` (choices with alternatives). This is the *only* place that knowledge now lives; skipping it loses it for good.
- Retire the plan: verify the vault note answers what the plan answered, then delete `.claude/plans/<slug>/`.
- **The done check, before the report.** Write the report's factual claims as a JSON object of id to claim in the session scratchpad, each as `{"claim": …, "evidence": [its files]}` so it is judged on its own evidence alone: each gate green — the last run of that gate, re-run (teed) when this phase edited what it covers, such as the docs; the docs and the vault updated — `git diff --stat` of those trees. The review's findings all closed you check against the review's report yourself: that report quotes code and attack paths and never leaves the machine. Then `pipeline-decide done --claims <scratchpad>/claims.json --evidence <file> …`. A claim it answers `contradicted` is a report that is wrong or work that is unfinished: fix the one that is, before reporting. An `uncertain` or `not_shown` claim you check by reading the evidence yourself; one no evidence supports is reported as unverified, never as done. When the decision model is off, you read every claim against its evidence yourself; the step is the same.
- Report: what shipped, gate results (including gates that don't exist), decisions recorded, follow-ups added, the level (who sized it — the decision model with its probabilities, or this session — every change of level and its cause, and the review's class beside it), the done check's verdicts, and the routing outcome — each task's model and effort, every escalation with its trigger, every structural miss Phase 5 found in a Sonnet task, and in split mode every contract the implementer got blocked on (those are the evidence for tightening the routing rule and the sizing questions). Do not commit unless asked.
