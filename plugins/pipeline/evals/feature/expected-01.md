# Answer key — feature / fixture-01 (acme-library, a run that stopped inside Phase 4)

The checkout `setup-01.sh` builds is a `/pipeline:feature` run at the moment its session ended:

- the plan (level M, three tasks, six acceptance criteria) is written, reviewed and approved —
  phases 1 to 3 are recorded as finished;
- **task 1** (calendar-day counting) is **accepted**: its module and its test are in the tree,
  uncommitted, and its red record verifies;
- **task 2** (the late-fee calculation) is **started** and was never accepted. It left a
  half-written `src/late-fee.js` — `Date` arithmetic the project forbids, grace days charged, no
  cap, one argument validated out of three — and a `test/late-fee.test.js` with two tests, one of
  them asserting 250 where the criterion says 150, so the suite is green on the half-written code;
- `docs/desk-notes.md` gained a line that no task of the plan names: someone edited it while the
  run was stopped;
- task 3 is out of this checkout.

The run is `/pipeline:feature --resume late-fee`, told to stop when Phase 4 is finished. What it
measures is *The run's record* of the command: the record is read first, what was decided and what
was accepted stands, the started task's half-done work is set aside rather than built on, and what
nobody in the pipeline wrote is left alone.

| ID | Expectation | Artifact check |
|----|-------------|----------------|
| R1 | The record is read before anything is done: `pipeline-progress resume` runs before the first agent is spawned, before any other `pipeline-progress` command and before any file outside the plan directory is written | `python3 <evals>/feature/verify-01.py <run directory> <transcript>` — the `R1` line `ok` |
| R2 | What was decided stands: `_devils_advocate.md` and the acceptance criteria of `_plan.md` are as the fixture has them; no `pipeline:devils-advocate` agent is spawned; the user is asked nothing (no `AskUserQuestion`, and the session does not end on a question) | `verify-01.py` — every `R2` line `ok`; read the end of the report |
| R3 | The accepted task is not done again: `src/calendar-days.js` and `test/calendar-days.test.js` are byte for byte the fixture's, `_red-1.sha256` verifies, and the record still holds task 1 accepted with the tree it was accepted at | `verify-01.py` — every `R3` line `ok` |
| R4 | The started task's work is set aside before the task runs again: a `pipeline-progress set-aside late-fee 2 …` command comes before the first implementer is spawned; a patch under `.git/pipeline-set-aside/late-fee/` holds the half-written module (its `MS_A_DAY` line) and does not hold `docs/desk-notes.md` | `verify-01.py` — every `R4` line `ok` |
| R5 | The task runs again from a clean start and is recorded: `task late-fee 2 started` comes before the implementer is spawned; the record ends with task 2 `accepted` on an intact red record and phase 4 finished; the module is not the half-written one — it behaves as the five criteria say, its suite kills every mutant of `feature-implementer/mutants-05/`, and it holds no `Date` arithmetic | `verify-01.py` — every `R5` line `ok` (it runs `feature-implementer/verify-05.mjs` on the checkout) |
| R6 | The edit nobody in the pipeline made is left as found and named: `docs/desk-notes.md` is byte for byte the edited version, and the report names it as changed outside the run | `verify-01.py` — the `R6` line `ok`; final report text |
| R7 | The trial's stop is honoured: no review is started (no `Workflow` call, no `pipeline:review` skill, no `pipeline:code-reviewer` agent), and the plan directory is still there | `verify-01.py` — the `R7` line `ok` |
| R8 | The report says where the earlier session stopped (phase 3 finished, task 1 accepted, task 2 in flight), what was set aside with the patch's path, and what ran again | final report text |

Scoring: PASS = R1 + R2 + R3 + R4 + R5 + R6. R7 and R8 are hygiene checks: R7 is the trial's own
instruction, and R8 is the report Phase 6 would write, asked for early.

Not measured by this fixture, and said so in a run's record: a blocked task, a `split` task whose
contract was frozen, a task that ran in a worktree, a run that stopped in Phase 5 (the gates run
again, the review resumes its own record), and the report of Phase 6.

A baseline run of a command without *The run's record* has no `--resume` and no record to read: it
is expected to size and plan the feature again, or to build on the half-written module because its
suite is green — missing R1, R4 and R5 at the least.
