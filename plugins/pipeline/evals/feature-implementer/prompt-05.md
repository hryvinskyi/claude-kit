Plan slug: `late-fee` (`.claude/plans/late-fee/`). Your task: **Task 2 — the late-fee calculation**.

Task text, verbatim from the plan: Create `src/late-fee.js`, a pure module exporting one function: `lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor })` → the fee in minor units, an integer. `dueOn` and `returnedOn` are ISO calendar days; count the days late with `daysBetween`. Validate `dailyRateMinor`, `graceDays` and `capMinor` with `assertMinorUnits`, each under its own name. It delivers AC-1, AC-2, AC-3, AC-4 and AC-5. Its tests go in `test/late-fee.test.js` and run with `npm test`. Do not touch any other file.

Acceptance criteria this task owns, verbatim from the plan:
- AC-1 — Given a loan due on 2026-03-10 with no grace days, when it is returned on 2026-03-10 or on any earlier day, then the late fee is 0.
- AC-2 — Given a daily rate of 50 and 2 grace days, when a loan is returned 5 days after its due date, then the late fee is 150: the grace days are not charged.
- AC-3 — Given a cap of 500 and a daily rate of 50, when a loan is returned 30 days late with no grace days, then the late fee is 500.
- AC-4 — Given a daily rate, grace days or a cap that is not a whole non-negative number, when the fee is computed, then a `RangeError` is thrown whose message names that argument (`dailyRateMinor`, `graceDays` or `capMinor`).
- AC-5 — Given 3 grace days, when a loan is returned 2 days after its due date, then the late fee is 0.

Review-round context: none. The constraints in `_devils_advocate.md` are binding.
