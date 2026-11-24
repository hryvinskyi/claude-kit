# Answer key — feature-implementer / fixture-05 (acme-library, red before green)

A stack-neutral happy path in plain JavaScript (Node ES modules, `node --test`, no dependencies, no
`composer.json`), so the JavaScript cut of the rubric is the only one. The task owns five acceptance
criteria written as *Given … when … then …*, and the definition's *Red before green* applies: the
tests are written from the criteria, run and seen failing because the module is missing, their
hashes recorded in `.claude/plans/late-fee/_red-2.sha256`, and only then is `src/late-fee.js`
written.

What the fixture measures:
- **the order** — a test written after the code takes the code as its oracle; the transcript shows
  whether the failing run came first;
- **every criterion pinned** — each mutant in `mutants-05/` breaks one criterion and nothing else
  (the due day charged, an early return charged, grace days charged, the cap ignored, the cap not
  validated, a refusal that does not name its argument, a negative fee inside the grace period); a
  suite that pins every criterion kills all seven, and still passes against `reference.js`;
- **the record** — the hash file, and a report that shows the red run, the green run and which test
  pins which criterion;
- **plan vocabulary** — `AC-3` never reaches a test name or a comment.

| ID | Expectation | Artifact check |
|----|-------------|----------------|
| E1 | The module behaves as the criteria say, and exports `lateFee` only | `FIXTURE_ROOT=<copy> node <evals>/feature-implementer/verify-05.mjs` — every `E1` line `ok` |
| E2 | Red before green: the session wrote the tests, ran them and saw them fail before its first write of `src/late-fee.js` — in separate tool calls, so the failing output reached the agent before it wrote code; one shell command that writes the tests, runs them and then writes the module saw nothing, and the checker places that command's write before its run | `python3 <evals>/feature-implementer/verify-05-order.py <transcript>` prints `PASS`; read its timeline when it fails, since a write through an unusual shell form can escape its patterns |
| E3 | Every criterion is pinned: the agent's `test/late-fee.test.js` passes against the reference module and fails against all seven mutants | `verify-05.mjs` — every `E3` line `ok` |
| E4 | The red run is recorded: `.claude/plans/late-fee/_red-2.sha256` exists, names `test/late-fee.test.js`, and `shasum -a 256 -c` on it from the copy's root prints `OK` — or prints `FAILED` and the report names that change and its reason under deviations, and the changed test still pins its criterion (E3) | run the check in the copy; read the report |
| E5 | Scope and wording: only `src/late-fee.js`, `test/late-fee.test.js` and the hash file are new; nothing else created, modified or deleted; the module reuses `assertMinorUnits` and `daysBetween` and does no `Date` arithmetic; no plan vocabulary in either new file; no commit | `diff -rq fixture-05 <copy>` lists exactly the three files; `grep -nE 'new Date\|Date\.' src/late-fee.js` is empty; `grep -nEi '(^\|[^[:alnum:]_])ac[- ]?[0-9]\|task[ -]?[0-9]\|invariant [0-9]\|per the plan\|_plan\.md\|devil' src/late-fee.js test/late-fee.test.js` is empty |
| E6 | The report carries the red run (the failing tail, failing because the module is missing — not a syntax error or a wrong path), the green run's tail, the `shasum -c` output, and a map from each criterion to the test that pins it | final report text |
| E7 | The report names the rubric files read (the JS implementer checklist, `solid.md`, `javascript.md`) | final report text |

Scoring: PASS = E1 + E2 + E3 + E4 + E5 + E6. E7 is a hygiene check.

A baseline run of a definition without *Red before green* is expected to miss E2, E4 and E6, and
may miss E3 (a suite written from the code tends to test the due day and skip an early return, or
check the `RangeError` without the argument's name).
