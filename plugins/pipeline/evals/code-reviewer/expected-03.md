# Answer key — code-reviewer / fixture-03 (acme-parcel, "an insured value on a quote")

Lens B on a change whose product code is right and whose tests are not all worth having. The fixture
measures the check *Tests that earn their place*: for each test and each row the change adds, the
rule it states and what else already fails on the defect it catches. `npm test` is green on the
change (94/94), and every criterion but one is pinned, so nothing below shows in a gate.

The project's `REVIEW.md` names no rule about the value of a test, so the definition's own check and
the `pipeline:test-value` rubric are what is measured. The project's `CLAUDE.md` does say what an
integration test costs (the application starts for each one) and that one check words every reason.

The key is proven by the mutants of `feature-implementer/fixture-09`, which is the same project
before the change:

```
cp -R <evals>/feature-implementer/fixture-09 <scratch>/proof && cp -R fixture-03/src/. <scratch>/proof/src/ \
  && cp -R fixture-03/tests/. <scratch>/proof/tests/ && python3 <evals>/feature-implementer/verify-09.py score <scratch>/proof
```

It prints `E2 FAIL … nothing fails for ['AC-3: express does not multiply the insurance']` (F6), six
surplus integration cases of the seven added (F1, F2: any six may go, one stays for the route), and
the surplus unit cases of F3, F4 and F5.

| ID | Seeded finding | Where | Expected |
|----|----------------|-------|----------|
| F1 | The price table repeated through the route: three rows (100, 100.01, 5000), each starting the application, prove what the unit rows prove; the route is proven by `the quote page prices the declared value` | `tests/integration/quotes.test.js:29-43` | `test-value`, Minor |
| F2 | Three refusals through the route (6000, -1, a text): the reasons are proven at the unit level, and the route's answer to a refused quote by the test that was there (`a refused quote is answered 422 …`) | `tests/integration/quotes.test.js:45-59` | `test-value`, Minor |
| F3 | A module's copy of the suite-wide wording check: `tests/unit/messages.test.js` already holds every registered reason to every language, and the project says a module adds none | `tests/unit/quote.test.js:94-100` | `test-value`, Minor |
| F4 | A read-back: the test asserts that the registry holds the two strings the change wrote into it | `tests/unit/quote.test.js:102-105` | `test-value`, Minor |
| F5 | Rows for a branch another row takes: 0 and 50 beside the boundary 100; 1000 and 2500 beside 100.01 and 5000 | `tests/unit/quote.test.js:53-62` | `test-value`, Minor |
| F6 | The express test cannot fail on its rule: it declares a value of 100, which is insured for free, so 9.75 comes out whether or not express multiplies the insurance. The express criterion (a value of 1000 → 19.75) is not pinned | `tests/unit/quote.test.js:70-72` | Important (test-strength; a criterion with no proof) |

Decoys — tests of the change that look removable and are not; reporting one as a finding is a false
positive:

| ID | Test | Why it stays |
|----|------|--------------|
| D1 | The unit rows 100, 100.01 and 5000 | the two sides of the free threshold, and the highest value insured |
| D2 | `the quote page prices the declared value` | the one joining fact the change adds: the value travels from the request to the price |
| D3 | `a parcel that is too heavy is refused for its weight, whatever it is worth` | it looks like the weight refusal again; it pins which refusal wins, and nothing else does |
| D4 | The three `a declared value … is refused` rows (below 0, a text, without end) | three branches of the check, not one class |

The row 133.33 is the criterion's own example and an interior value: reported or not, it is counted
neither way.

## Scoring

- **found**: N/6. F1 and F2 count when the finding says the rows repeat through the route what the
  lower level proves (one finding for both tables counts for both when it names both). F5 counts when
  at least the rows 0 and 50, or 1000 and 2500, are named as taking a branch another row takes. F6
  counts when the finding says the test cannot fail because its value is insured for free (or that
  the express criterion is not pinned for that reason).
- **false positives**: a decoy reported as a finding. Naming a decoy as the proof that stays is
  correct and expected.
- **severity**: F6 above the `test-value` findings.
- **verdicts**: every finding carries a failure scenario or, for `test-value`, the surviving proof
  quoted at its line, and a verdict.
- **rows asked for**: every place where the report asks for a test or a row to be added, and whether
  an existing row already takes that branch. The criterion names `null`; the text row `'250'` takes
  its branch, so a finding that asks for a `null` row asks for a row the rubric would not write. It
  is counted and reported beside the score; `null` under *Cleared*, with the row that covers it, is
  the right answer.
- **zero mutations**: `diff -rq fixture-03 <copy>` is empty (the agent is read-only).

PASS = F6 found, at least four of F1–F5 found, no false positive, zero mutations.

## The baseline

The definition on `main` before the check (`agent@f4089e4`) is run on the same fixture and prompt;
record both runs beside each other, and say plainly where they do not differ.

They differ less than this key first expected. The baseline passes: on both models it found F6, the
two tables through the route, the wording copy and the read-back, from the project's own words about
what an integration test costs and where wording is checked. What it did not do: it gave the
wording copy the severity of a defect, it missed F5, and both of its runs asked for a `null` row.
The fixture's weight is therefore on F5, on the severities and on the rows asked for.

## Calibration

See `runs.log`.
