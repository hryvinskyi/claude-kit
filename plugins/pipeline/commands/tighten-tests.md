---
description: "Tighten a test suite — fewer and faster tests with no proof lost, and weak proofs made real: a census says where the cases and the seconds are, fresh judges give every test of the scope a verdict by the pipeline:test-value rubric, a fresh defender tries to save each test a verdict removes, every removal is then proven by a run, only tests are edited, and a run before and after accounts for every test that left"
argument-hint: "[<path>...] [--top N] [--changed [<base>]] [--report <junit.xml>...] [--dry-run] [--max-agents N] [--model <model>] — with no path: the census and a proposal, nothing judged"
disable-model-invocation: true
---

Tighten the tests described by: `$ARGUMENTS`

A suite is worth what it catches. This command takes out of a suite what catches nothing that something cheaper does not already catch, and rewrites what claims to catch a defect and does not. It is the sibling of `qa:tighten` for tests: **every rule the suite proved before, it proves after.** It edits tests and nothing else, and it is **project-agnostic**: every path, runner, gate and rule below is discovered from the repository you are in. The rubric is the `pipeline:test-value` skill; this command is the procedure around it.

## What it rests on

Measured once, on a suite of 49,000 cases (2026-11-24): the cases and the seconds of a census, a random sample of 220 tests judged by ten fresh readers, and every verdict that removed a test handed to four more readers told to defend it.

1. **The count and the time are in different places.** Two thirds of the cases were unit tests, and they took 1.4% of the seconds. A third were integration tests, and they took 97%. Half of all the seconds sat in 4% of the cases. So the census decides where the reading starts: removing unit tests buys reading time, and only the expensive level buys waiting time.
2. **Most of what can go is proven twice, not badly written.** After both readings, 68% of the sample stood as it was, 23% could be deleted, 4% trimmed and 4% had to be rewritten. Four removals in five were duplicates: a test whose assertions a sibling repeats, a table repeated one level up, a module's copy of a suite-wide check, rows of one equivalence class, a product of independent factors. A search finds none of these. They are found by reading two tests side by side.
3. **A reader who proposes a removal is wrong about one in five.** The defenders refuted one proposal in ten with a defect only that test caught, and found in one more a real rule that the test only pretended to prove. So no test leaves on one reading: a fresh defender tries to save it, and then a run decides.
4. **The rewrites are the gain that matters.** One sampled test in twenty-five claimed a rule that nothing proved: a refusal produced by another check for everybody, an absence asserted on data that never held the thing, a name that promised more than the body checked. Deleting such a test hides the hole. Rewriting it closes one.
5. **A removed test's seconds are not the saving.** An expensive fixture is charged to whichever test of its class runs first. The saving is what the run after shows, never what the census promised.
6. **Pruning loses to the inflow unless the writers change, and the inflow that costs is at the expensive level.** The suite measured grew by 46% in 38 days. The integration tests that joined it in those days cost 2,400 seconds of every run, a third of the whole; the unit tests that joined, twice as many, cost 25. Nearly half of those seconds were single integration tests of a quarter of a second each, a hundred a day, and a sixth were rows of parameterised tests. `pipeline-suite diff --before <base report> --after <change's report> --budget integration=<seconds>` says what a change's new tests cost at a level, and fails over the budget: a number a pipeline can hold a change to. The same rubric binds whoever writes a test (`pipeline:feature-implementer`, `pipeline:feature-contract-writer`) and whoever reviews one (`pipeline:code-reviewer`, lens B); this command is for what is already there.

## Phase 0 — Orient (this session)

- **Project law first.** Read the repo's `CLAUDE.md`/`AGENTS.md` and the testing guideline it names: how tests are run (a wrapper, a lock, a sync step), which levels it requires, which kinds of test it forbids, which suite-wide checks it keeps. If it demands a ticket before the first edit, a branch or a board move, do that now, exactly as it says. A level the project requires is never removed; what a test at that level repeats is.
- **Load the rubric**: `pipeline:test-value` with the Skill tool, and the project's stack skill when a stack plugin covers it — its testing section says what each level costs there and what its build already proves.
- **Has this been done before?** Resolve the vault with `find-vault` (the `vault` plugin puts it on `PATH`), or with no `find-vault` from the `Knowledge-base directory:` line in `CLAUDE.md`/`AGENTS.md`; a declared directory that does not exist, no declaration, or exit 1 means no vault, and nothing is created for one. With a vault, search it for earlier runs of this command (journal entries titled `tighten-tests-…`) and for decisions about the tests in scope: a recorded reason why a module keeps a check of its own is a claim the judges check, not a verdict.
- **The test paths.** Read the runner's configuration (its suites, its discovery patterns) and write the directories it runs, with the directories that hold only test support, as git pathspecs into `<scratchpad>/test-paths.txt`, one per line. Everything else is production code.
- **A clean tree outside the tests.** `git status --porcelain` may list changes under the test paths only. Anything else stops the command, and you say so: the proofs below apply changes to production code and take them back, and work in progress there cannot be told from a mutation left behind.
- **The gates** into `<scratchpad>/gates.md`: what the project's build rejects before any test runs, read from its configuration and not from memory — the type checker or analyser and the level it runs at, whether it analyses the tests, the boundary checker, the build steps (a container compile, a bundle build, a schema validation) — and the suite-wide tests the project keeps.

## Phase 1 — Census (this session; scripted)

1. **A report of the whole suite**, JUnit XML, into `<scratchpad>/census.xml`: the files `--report` names; else the newest one the project's CI kept for the default branch, when its workflow keeps one; else one run of the whole suite with the runner's JUnit flag, the way the project runs it and never another way.
2. `pipeline-suite census <scratchpad>/census.xml --root . --json > <scratchpad>/census.json`, and the same without `--json` for the table. Read it: the levels, where the seconds concentrate, the costliest areas and files, the widest parameter sets.
3. **With no path in the arguments, stop here.** Report the census and a proposal: the three places where a run of this command would pay first — the costliest files at the expensive level, the widest parameter sets there, the largest area at the cheap level — each with its cases, its seconds and the number of judges it needs (Phase 2). Two reports of different dates also say how fast the suite grows and where (`pipeline-suite diff --before <old> --after <new>`): the cases and seconds of each level, and what the tests that joined cost there. Nothing is judged, and nothing is edited.

## Phase 2 — The scope and the budget (this session)

- **The scope** is the test files under the paths given. `--top N` keeps the N costliest of them by the census. `--changed [<base>]` keeps the test files the branch added or changed against the base (its upstream, else `origin/main`, else `main`).
- **The list.** For every file in scope, its tests with their cases and seconds from `census.json` (`by_test`), and the line each starts at, into `<scratchpad>/tests.json` as `{ "file", "test", "line", "cases", "seconds" }`. A test the report does not hold (written since) has `null` for both numbers.
- **The budget.** A judge takes about twenty tests; the tests of one file stay with one judge, and the files of one directory stay together, so that siblings are read side by side. A defender takes about twenty verdicts. `--max-agents` (default 10) bounds the judges and the defenders together, three judges for each defender. What does not fit is not judged, the costliest first inside the budget, and the report lists the rest: nothing is skipped silently.
- **Say what the run costs before it starts**, so the user can object: the number of judges and defenders, each a fresh agent on `opus` unless `--model` names another (a judge of twenty tests took 220,000 to 310,000 tokens and six to nine minutes when this was measured, a defender of twenty verdicts about the same). On the eval fixture a `sonnet` judge and defender reached the key's verdicts at about two fifths of the cost; on a real suite only `opus` was measured, so `--model sonnet` is a choice to say out loud, not a default, and one targeted test run for each removal a run must prove.
- **The scope's tests before the first edit**: run the scope's test files with the runner's JUnit flag, the way the project runs tests, into `<scratchpad>/before.xml`. This is the run Phase 6 compares against. A report of the whole suite taken at this commit serves as well.

## Phase 3 — Judge (fresh agents, read-only, started in one message)

The Agent tool's list of agent types in this session must name `pipeline:test-judge`. A session loads its plugins' agents when its process starts and on `/reload-plugins`; when the type is missing, stop and ask the user to run `/reload-plugins`.

One `pipeline:test-judge` agent for each group of Phase 2, all in one message, each with this brief and nothing of this session's own opinion of the tests:

```
Stance: judge
Checkout: <the checkout directory>
Tests: <scratchpad>/judge-<n>.json          (this group's slice of tests.json)
Gates: <scratchpad>/gates.md
Levels: <the project's levels and the milliseconds a case costs at each, from the census>
Output: <scratchpad>/verdicts-<n>.json
Never read: .claude/plans/
```

When they return:

1. Join the outputs into `<scratchpad>/verdicts.json`, one array, with a script (`python3 -c` over the files), never by retyping.
2. `pipeline-suite check <scratchpad>/verdicts.json --root .` — a verdict nobody defined, a removal with no quoted evidence, a duplicate with no survivor, a duplicate whose every survivor is costlier than it is, a quote that is not at its line, a survivor that the same batch removes. Each entry it names goes back to its judge once, through SendMessage, with the problems as printed. An entry that still does not hold up becomes `keep`: a verdict that cannot quote its evidence is not a verdict.
3. A test that is on a judge's list and has no entry is not judged, and the report says so.

## Phase 4 — Defend (fresh agents, read-only)

Every entry whose verdict is `trim`, `delete`, `rewrite` or `move` goes to a `pipeline:test-judge` agent in the stance `defend` — about twenty entries each, in one message, with the same brief, `Stance: defend`, `Tests:` a file holding those entries and `Output: <scratchpad>/defended-<n>.json`. A defender is told what the first reader concluded and never how sure that reader was.

Apply what they answer to `verdicts.json`, one entry at a time with the file-editing tool:

- `agreed` — the entry stands.
- `objection` — the verdict becomes `keep`, the class `none`; the defender's `unique_defect` is kept under `note`.
- `partly` — the verdict becomes the defender's `should_be`, and `action` becomes its `must_stay`. A test that becomes a `rewrite` must fail on the defender's `unique_defect`: that goes into `mutation`.
- `unsure` — the run its `settle_by` names, in Phase 5, or `keep`.

**Where a judge and a defender disagree, the test stays or a run decides. This session never settles a disagreement in favour of a removal on its own reading.** Run `pipeline-suite check` again. With `--dry-run`, report the verdicts and the defence and stop: nothing is edited.

## Phase 5 — Prove, then apply (this session, one mutation at a time)

The rubric's table *The proof a verdict owes* says what each class owes. Two mutations in one checkout at once prove nothing, so the proofs are run one after another, by this session.

1. **A proof by a run.** Group the entries that share a mutation; then, for each mutation:
   1. Make the change the entry's `mutation` names, in the production file, with the file-editing tool.
   2. Keep it: `git diff -- <the production file> > <scratchpad>/mutation-<n>.patch`.
   3. Run the tests the proof names — each surviving test of a `duplicate` or a `level`; the old test and the rewritten one of a `vacuous`, `file-read`, `implementation` or `fixture` — the way the project runs one test, teed into `<scratchpad>/red-<n>.log`. Read the result of each named test, not the exit status: a run that executed no test exits 0.
   4. Take the change back: `git apply -R <scratchpad>/mutation-<n>.patch`, then `git diff --quiet -- <the production file>` must succeed. For a rewrite, run the new test once more, into `<scratchpad>/green-<n>.log`: it passes.
   5. Write the entry's `proof`: `{ "kind": "run", "result": <which tests failed and which did not>, "logs": [<the log files>] }`.

   A survivor that stays green under the mutation was no survivor: the entry becomes `keep`, and the report names it as a judge's miss. An old test that fails under the mutation was not vacuous: it stays as it is.
2. **A rewrite is written before its proof and before anything is deleted**: the new test beside the old one, in the test file, by the rules of `pipeline:test-value` §Writing a test. A `move` writes the cases at the lower level and keeps one case for each joining fact. The old test goes only after the new one was seen red and green.
3. **A proof by the gate**: with the mutation applied, the gate fails; its output is the log (`"kind": "gate"`).
4. **A proof by a reading** is the defender's `agreed` (`"kind": "read"`), for the classes that owe one. **A proof by the runner's word** (`"kind": "list"`) is the runner's own listing or skip output for a dead test.
5. **Where the project runs mutation testing for a level**, one run over the production files the entries cover, before the batch and after it, stands in for the single runs of that level's `duplicate` entries: no mutant escapes after that was killed before.
6. `pipeline-suite check <scratchpad>/verdicts.json --root . --ready` must pass. It refuses an entry with no proof, and a reading where a run is owed.
7. **Apply**: delete the tests of every `delete`, the rows and assertions of every `trim`, and the old tests that a rewrite or a move replaced. A helper, a parameter set, a fixture or an import that nothing uses any more goes with them; a file left with no test is deleted. A kept test keeps its name.
8. **A test that cannot be made honest without a new seam in the production code** — a clock nobody can set, a collaborator built inside the method — stays as it is. It is reported with the seam it needs, and the seam is work for `/pipeline:feature`.

A session that stops inside this phase may leave a mutation in the tree. The first thing a session that continues does is `git status --porcelain`: a change outside the test paths is that mutation, taken back with its patch file.

## Phase 6 — Gates

- **Only tests changed**: `git status --porcelain` lists paths under `<scratchpad>/test-paths.txt` and nothing else.
- **Every test that left is accounted for.** Run the scope's test files again with the JUnit flag into `<scratchpad>/after.xml`, then `pipeline-suite diff --before <scratchpad>/before.xml --after <scratchpad>/after.xml --verdicts <scratchpad>/verdicts.json --root .` exits 0. Exit 1 names a test that left with no verdict — a rename or a move took it out of the runner's sight — or a deletion that still runs. Fix the tree, never the verdict file.
- **The project's gates** over the touched files (static analysis at the project's level where it analyses the tests, the linter), then the full suite once, the way the project runs it, teed into the scratchpad. A gate that does not exist is reported as absent, not as green.

## Phase 7 — Report and record

- **The numbers**, from `pipeline-suite diff --json` and `pipeline-suite check --json`, never retyped from memory: cases and tests before and after; seconds before and after, said to be comparable only when both runs were on one machine with one setting; the verdicts by kind and by class.
- **Every test that left or changed**: its verdict and class, its survivors or its gate, its proof and the log that holds it.
- **The holes**: every `rewrite`, as the rule that had no proof until now and the defect its new test fails on. These are the findings a person should read.
- **What the defenders saved**: every `objection` with its `unique_defect`. They show where the judges err.
- **What was not judged**, and every `unsure` with the run that would settle it.
- **The seams** the production code lacks (Phase 5, step 8).
- **Where these tests came from**: the two or three habits behind most of the verdicts — a table repeated one level up, a check copied into every module, a row for every value — each as one line the project's testing guideline could say. The project's rules are the user's to change: propose the lines, do not edit them in.
- With a vault: `/vault:journal` the run as `tighten-tests-<scope>` — the scope, the commit, the numbers, the holes — so the next run starts after it, and one TODO row for each seam. With no vault, that goes into the report.
- Ticket and board moves as the project's law says. Do not commit unless asked.
