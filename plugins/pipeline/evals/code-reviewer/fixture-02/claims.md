# Claims

## Pull request body

**Late fee on a returned loan.** Adds `lateFee()`, the calculation the return desk calls when a
member brings a book back. It charges the daily rate for each day late, leaves the grace days free,
stops at the cap, and refuses a rate, grace days or a cap that is not a whole non-negative number.

Delivers the acceptance criteria below; `npm test` is green.

## Acceptance criteria, verbatim from the plan

- Given a loan due on 2026-03-10 with no grace days, when it is returned on 2026-03-10 or on any
  earlier day, then the late fee is 0.
- Given a daily rate of 50 and 2 grace days, when a loan is returned 5 days after its due date, then
  the late fee is 150: the grace days are not charged.
- Given a cap of 500 and a daily rate of 50, when a loan is returned 30 days late with no grace
  days, then the late fee is 500.
- Given a daily rate, grace days or a cap that is not a whole non-negative number, when the fee is
  computed, then a `RangeError` is thrown whose message names that argument (`dailyRateMinor`,
  `graceDays` or `capMinor`).
- Given 3 grace days, when a loan is returned 2 days after its due date, then the late fee is 0.

## Commit message

Late fee on a returned loan: daily rate after the grace days, capped, with its unit tests
