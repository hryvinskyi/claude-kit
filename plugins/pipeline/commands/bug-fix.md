---
description: "Bug pipeline: reproduce as a failing test, find the root cause, fix it and its siblings, prove it with the project's gates"
argument-hint: "<symptom | file:line | @log-file | issue #N> [--dry-run to stop after the diagnosis]"
disable-model-invocation: true
---

Fix the bug described by: `$ARGUMENTS`

The order is the point: **a bug is not understood until a test fails because of it, and not fixed until that test passes for the right reason.** A fix written before the reproduction is a guess that happens to compile. This command is the small sibling of `/pipeline:feature` — no plan directory, no implementer subagents — and it is **project-agnostic**: every path, gate, runner and rule below is discovered from the repo you are in.

## Phase 0 — Orient

- **Project law first.** Read the repo's `CLAUDE.md`/`AGENTS.md`. If it demands a ticket before the first edit, a branch, or a board move, do that now, exactly as it says — this command does not replace it.
- **Has this been seen before?** Resolve the vault with `find-vault` (the kit's vault tooling puts it on `PATH`); search it (the `qmd` tool when connected, grep otherwise) for the symptom's words, the class name, the error text. Check `<vault>/To DO.md` for an open row. A journal entry that already explains the mechanism is where to start reading — then verify it against the code, which is the source of truth.
- **Parse the input.** A symptom in words; a `file:line`; a log file (`@path` — read the *first* occurrence of the error and the lines before it, not the last of a thousand repeats); an issue number (read the issue and its comments).

## Phase 1 — Diagnose (no edits)

1. **Locate.** Grep for the symbol or the error text to find the source and its callers. Follow the stack trace or the data from the symptom **backwards** to the first place where reality and intent diverge.
2. **State the mechanism in one paragraph**: the input or state, the line where it goes wrong, why that line does what it does, and why nothing caught it. If you cannot write it without "probably" or "likely", you have a hypothesis — go measure (a log line, a query against the dev database, a debugger, a five-line script) until you can. Say which parts you observed and which you inferred.
3. **Separate the root cause from the place it surfaced.** A null check where the exception was thrown treats the symptom; the question is why the value was null. Name both.
4. **Look for siblings.** The same mistake is rarely made once: search for the same pattern (the same misuse of the API, the same missing guard, a copy of the function). List what you find.
5. **Ask why it was not caught.** A missing test, a test that mocks the thing that broke, a static-analysis rule that is suppressed, a type that is `mixed`. That gap is part of the bug.

With `--dry-run`, report Phase 1 and stop.

## Phase 2 — Reproduce (red)

- Write the **regression test first**, at the level where the bug lives: a unit test when the defect is in one class's logic; an integration test (real database, real container — never a mocked one) when it is in wiring, a query, a transaction, a migration or a framework interaction. When the project mandates both levels for every change, write both.
- Run it and **watch it fail with the symptom that was reported** — the run teed into the session scratchpad (`red.log`): the done check reads it — the same exception, the same wrong value. A test that fails for another reason (a fixture that does not load) has reproduced nothing.
- The test asserts the **correct behaviour**, named in the domain's words (`testACreditLargerThanTheRemainderIsRefused`), not "does not throw" and not the issue number.
- If the bug genuinely cannot be reproduced in a test (a race that needs production load, a third-party outage), say so, say what you tried, and write down the manual reproduction instead. Do not skip this phase silently.

## Phase 3 — Fix (green)

- **Load the rubric before the first source edit** when the fix touches a seam, an entity, a port or in-scope debt: on PHP, the `architecture:clean-architecture-php` skill and the references the change needs; on JavaScript or TypeScript (including a PHP project's browser code), `architecture:clean-architecture-js` and its references; on a project a stack plugin covers, that plugin's architecture skill beside each; on another stack, the project's own rubric, and say so when it has none.
- **Fix the cause, at the place that owns the rule.** An invariant belongs in the entity, not in the one caller that tripped over it. The smallest diff that fixes the *cause* — not the smallest diff that silences the *symptom*.
- **Fix the siblings** from Phase 1 that are inside the blast radius (the files you touch and their direct collaborators in the same module), each with its own test. Siblings outside it are named in the report and get one line on the vault's TODO board — widening is the user's call.
- **In-scope debt goes in the same change** (the engineering standards in your user `CLAUDE.md`, §*Architecture and tech debt*): the missing test that let this through, a suppressed static-analysis error on the line you edit, the `switch` you would otherwise add a `case` to. No `TODO`, no suppression, no baseline entry.
- A message the fix shows to a person is written for that person: what happened and what to do — never an exception's text, a path, a host or a class name. The detail is logged.

## Phase 4 — Prove

- The regression test passes (`green.log`, teed). **Revert the fix once and confirm the test goes red again** when the fix was more than a line or two (`revert.log`) — a test that passes with and without the fix guards nothing.
- **Discover and run the project's gates** — `composer.json`/`package.json` scripts, Makefile, CI workflow, DDEV/Docker wrapper — targeted first (the touched tests, static analysis on the touched files at the project's level), then the full set the project requires before a push, run the way the project says to run it. A gate that does not exist is reported as absent, not as green. Keep each gate's output in the session scratchpad as it runs (`tee`): the done check reads it.
- When the symptom was visible in a browser or an API response, look at it there too (`/run`, the browser tools, `curl`). A green suite is not the same as a symptom that is gone.
- **The review.** Run `/pipeline:review` on the fix (the Skill tool: `pipeline:review`), with the issue's expected behaviour and the Phase 1 mechanism paragraph as its claims. A fix is a change like any other, and the fixes that came back from human review were the ones whose twin input stayed unbounded, whose test pinned nothing, whose message was rewritten on one screen and not the next, or whose listener ran before the commit that held the lock. Fix what it confirms before Phase 5, then run every gate once more, teed: the review's fixes are edits the earlier runs did not see. A finding it moves to a ticket is named in the report.

## Phase 5 — Close the loop

- User-visible behaviour changed and the project ships user docs → update them (the project's `docs-updater` agent when it has one).
- The mechanism is non-obvious, or the bug came from a decision → `/journal` it (what broke, why, why it was not caught, what now catches it); `/decision` when a choice with lasting consequences was made. Module note updated when the module's failure modes changed.
- Ticket and board moves as the project's law says — and no further: a fix that is merged is not a fix that is verified where the symptom was reported.
- **The done check, before the report** — the step of `/pipeline:feature` Phase 6: the report's factual claims, each as `{"claim": …, "evidence": [its files]}` so it is judged on its own evidence alone — the regression test red before the fix: `red.log`; green after it: `green.log`; red again with the fix reverted, when you reverted: `revert.log`, a claim of its own; each gate green: its last run, after the review's fixes. They are checked with `pipeline-decide done --claims <file> --evidence <file> …` when the decision model is on, and by reading the evidence yourself when it is not. That the symptom is gone where it was reported you check yourself, against the output of that check: a page or a response from an environment can hold customer data and never leaves the machine. A contradicted claim is fixed before the report; one nothing supports is reported as unverified.
- **Report**: the mechanism (observed vs inferred), the root cause vs where it surfaced, the fix, the regression test and that it was seen red then green, siblings fixed and siblings left (with where they were logged), gate results verbatim when any failed, and what still has to be checked by a person. Do not commit unless asked.
