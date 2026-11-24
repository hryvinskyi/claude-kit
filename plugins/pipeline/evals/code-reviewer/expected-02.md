# Answer key — code-reviewer / fixture-02 (acme-library, "late fee on a returned loan")

Lens B on a change whose claims carry five acceptance criteria in *Given … when … then …* form. The
fixture measures whether the reviewer traces **each criterion** to the code that delivers it and the
test that pins it, and reports only the ones that fail — not whether it finds generic defects. The
project is plain JavaScript; `npm test` is green on the change (8/8), which is the point: every gap
below passes the gate.

| ID | Seeded defect | Where | Expected severity |
|----|---------------|-------|-------------------|
| F1 | The cap criterion is not delivered: `capMinor` is validated and never applied, so a loan 30 days late at 50 a day costs 1500, not 500 — while the pull request body says the fee "stops at the cap". No test sets up the cap either | `src/late-fee.js:17` (with `:15`) | Critical or Important (a fee a member pays is wrong; `REVIEW.md` §What to report) |
| F2 | The test `grace days are not charged` runs with `graceDays: 0` (the shared `loan` fixture) and expects 250 = 5 × 50: it never sets up a grace period, so it would pass if grace days were charged. The grace criterion (2 grace days, 5 days late → 150) is not pinned | `test/late-fee.test.js:12-13` (with `:5`) | Important (test-strength) |
| F3 | The refusal criterion is delivered (three `assertMinorUnits` calls, each with its own name) but no test exercises a refusal: a change that dropped the `capMinor` check or the argument's name would stay green | `test/late-fee.test.js` (no such test), `src/late-fee.js:13-15` | Important (test-strength) |

Decoys — delivered and pinned; reporting either as a finding is a false positive:

| ID | Criterion | Why it holds |
|----|-----------|--------------|
| D1 | On or before the due date, no grace days → 0 | `Math.max(0, …)` at `src/late-fee.js:16`; `test/late-fee.test.js:7-10` checks the due date and an earlier day with `graceDays: 0` |
| D2 | 3 grace days, 2 days late → 0 | `Math.max(0, 2 - 3)`; `test/late-fee.test.js:16-17` sets `graceDays: 3` and asserts 0 |

## Scoring

- **found**: N/3. F1 counts when the cap is named as not applied (a finding on the missing test
  alone does not count for F1). F2 counts when the finding says the grace test does not set grace
  days (or that it would pass with grace days charged). F3 counts when it says no test exercises a
  refusal (a mention inside F1's text counts only if it names the refusals, not only the cap).
- **false positives**: D1 or D2 reported as a finding. Listing them under *Cleared* (or as traced)
  is correct and expected of a definition that traces criteria.
- **verdicts**: every finding carries a failure scenario (state → action → wrong outcome) and a
  verdict; a finding with neither is not counted.
- **zero mutations**: `diff -rq fixture-02 <copy>` is empty (the agent is read-only).

A real extra, not noise: a bad `dueOn` or `returnedOn` is refused under `daysBetween`'s own names
(`fromDay`, `toDay`), while `CLAUDE.md` says a refused argument names the argument (Important).

PASS = 3/3 found, no false positive, zero mutations. A hygiene note, not scored: whether the report
accounts for all five criteria (three findings and two cleared).

A baseline run of a definition without the criterion-by-criterion trace may still find F1 through
*Claims against code* and F2 through *Tests as strong as their names*; F3 — a delivered criterion
with no test at all, which no test name points at — is the one it is expected to miss.
