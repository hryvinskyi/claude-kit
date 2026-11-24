# Answer key — tighten-tests / fixture-01 (acme-parcel, the command as a whole)

The project is `test-judge/fixture-01/checkout`: 71 tests at two levels, with 21 seeded tests that do
not earn their place, two groups that need a verdict as a group, two holes and 15 decoys. Its key
(`test-judge/key-01.json`) and its mutants (`test-judge/mutants-01.json`) are the same ones the judge
is scored with, and `test-judge/expected-01.md` describes them. This eval asks what the judge's eval
cannot: whether the command, with its judges, its defenders, its proofs and its gates, leaves a
suite that catches what the old one caught.

## Score — `python3 <evals>/test-judge/verify-01.py suite <evals>/test-judge/fixture-01/checkout <run>/checkout`

| ID | Expectation | Scorer line |
|----|-------------|-------------|
| T1 | The product is byte for byte what it was: no mutation left behind, no seam added | `the product is byte for byte what it was` |
| T2 | The tightened suite is green and the build passes | `the tightened suite is green …` |
| T3 | No proof lost: every defect the old suite caught, the new one catches | `every defect the old suite caught …` |
| T4 | The seeded hole is closed: a guest with a valid token is refused by a test now | `the seeded hole is closed` |
| T5 | No test fails on a change that breaks no rule | `no test fails on a change that breaks no rule` |
| T6 | Every decoy is still in the suite, by name | `every decoy is still in the suite` |
| T7 | The label table is proven at the unit level | `the label table is proven at the unit level` |
| T8 | The seeded tests are gone: at least 17 of the 20 that a `delete` fits | `seeded tests gone: N/20` |
| T9 | The suite is smaller: at most 56 cases, where there were 71 | `cases 71 -> N` |

The scorer also prints how many of the two holes are closed. The second — a refused booking that is
stored all the same — sits behind a test that is kept; closing it is credited and not required.

Then, from the run's own files in `<run>/checkout/.tighten/`:

| ID | Expectation | Check |
|----|-------------|-------|
| T10 | Every test that left is in the verdicts, and every `delete` is gone | `pipeline-suite diff --before .tighten/before.xml --after .tighten/after.xml --verdicts .tighten/verdicts.json --root .` exits 0 |
| T11 | Every verdict that removed or changed a test carries its proof | `pipeline-suite check .tighten/verdicts.json --root . --ready` exits 0 |
| T12 | Only tests changed | `git status --porcelain` lists paths under `tests/` and `.tighten/` only |
| T13 | The report names each hole as a finding, what the defenders saved, and what was not judged | the session's answer in `run.json` |

**PASS** = T1 to T12. T13 is read and recorded.

A hand-tightened copy of the fixture passes T1 to T9 with 52 cases, 13 of them at the integration
level where there were 24, and both holes closed: that is what a full score looks like, not the bar.

## Calibration

See `runs.log`, which the first run creates.
