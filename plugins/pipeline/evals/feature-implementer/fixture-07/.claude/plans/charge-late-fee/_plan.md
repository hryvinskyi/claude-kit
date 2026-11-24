# Plan — a late return is charged to the member

Level: M. When the desk takes back a book that is late, the fee goes onto the member's account in
the branch ledger. The fee itself is computed already (`lateFee`); this plan charges it.

## Decisions

- A return that costs nothing sends nothing to the ledger: there are no charges of zero.
- The charge carries the reason `late-fee` and the loan's id, so the desk can show what it was for.

## Acceptance criteria

- **AC-1** — Given a member's loan due on 2026-03-10, at a daily rate of 50 with no grace days and a
  cap of 500, when its return on 2026-03-15 is charged, then the member's ledger holds one new
  entry: a charge of 250 with the reason `late-fee` and the loan's id.
- **AC-2** — Given the same loan, when its return on 2026-03-10 is charged, then the member's ledger
  holds no new entry.
- **AC-3** — Given a loan with no member id, when its return is charged, then a `RangeError` is
  thrown whose message names `memberId`, and nothing is sent to the ledger.

## Tasks

| # | Task | AC | Test level | Impl | Depends on |
|---|------|----|-----------|------|-----------|
| 1 | The late-fee calculation (`src/late-fee.js`) — done | — | unit | session | — |
| 2 | Charge the fee on return | AC-1, AC-2 — integration; AC-3 — unit | integration + unit | sonnet — follows the pattern of `src/record-payment.js` | 1 |
| 3 | The return desk shows the charge | — | — | sonnet | 2 |

### Task 2 — charge the fee on return

Create `src/charge-late-fee.js`, a use case exporting one function:

`chargeLateFee({ loan, returnedOn, ledger })` → `Promise<{ chargedMinor: number }>`.

- `loan` is `{ id, memberId, dueOn, dailyRateMinor, graceDays, capMinor }`; compute the fee with
  `lateFee`.
- A fee above 0 is sent with `ledger.charge({ memberId, amountMinor, reason: 'late-fee', loanId })`;
  a fee of 0 sends nothing. Either way the result is `{ chargedMinor }`.
- `memberId` must be a non-empty string: otherwise a `RangeError` naming `memberId`, before anything
  is sent.
- It delivers AC-1, AC-2 and AC-3.

Tests: AC-1 and AC-2 in `test/integration/charge-late-fee.test.js`, against the ledger, written the
way `test/integration/record-payment.test.js` is; AC-3 in `test/unit/charge-late-fee.test.js`. Do
not touch any other file.

### Task 3 — the return desk shows the charge

Out of this checkout: the return desk lives in another repository.
