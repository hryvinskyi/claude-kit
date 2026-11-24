# Plan — late fee on a returned loan

Level: M. A member who returns a book late pays a fee per day late, after a few free grace days,
never more than a cap. The rates come from the branch's settings; this plan builds the calculation
the return desk calls.

## Decisions

- The fee is computed from calendar days, not hours: a book returned any time on its due date is on
  time.
- Grace days are free days: a loan five days late with two grace days is charged for three.
- The cap bounds the fee of one loan.

## Acceptance criteria

- **AC-1** — Given a loan due on 2026-03-10 with no grace days, when it is returned on 2026-03-10 or
  on any earlier day, then the late fee is 0.
- **AC-2** — Given a daily rate of 50 and 2 grace days, when a loan is returned 5 days after its due
  date, then the late fee is 150: the grace days are not charged.
- **AC-3** — Given a cap of 500 and a daily rate of 50, when a loan is returned 30 days late with no
  grace days, then the late fee is 500.
- **AC-4** — Given a daily rate, grace days or a cap that is not a whole non-negative number, when
  the fee is computed, then a `RangeError` is thrown whose message names that argument
  (`dailyRateMinor`, `graceDays` or `capMinor`).
- **AC-5** — Given 3 grace days, when a loan is returned 2 days after its due date, then the late
  fee is 0.

## Tasks

| # | Task | AC | Test level | Impl | Depends on |
|---|------|----|-----------|------|-----------|
| 1 | Calendar-day counting (`src/calendar-days.js`) — done | — | unit | session | — |
| 2 | The late-fee calculation | AC-1, AC-2, AC-3, AC-4, AC-5 | unit | sonnet — follows the pattern of `src/money.js` | 1 |
| 3 | The return desk shows the fee | — | — | sonnet | 2 |

### Task 2 — the late-fee calculation

Create `src/late-fee.js`, a pure module exporting one function:

`lateFee({ dueOn, returnedOn, dailyRateMinor, graceDays, capMinor })` → the fee in minor units, an
integer.

- `dueOn` and `returnedOn` are ISO calendar days; count the days late with `daysBetween`.
- Validate `dailyRateMinor`, `graceDays` and `capMinor` with `assertMinorUnits`, each under its own
  name.
- It delivers AC-1, AC-2, AC-3, AC-4 and AC-5.

Its tests go in `test/late-fee.test.js` and run with `npm test`. Do not touch any other file.

### Task 3 — the return desk shows the fee

Out of this checkout: the return desk lives in another repository.
