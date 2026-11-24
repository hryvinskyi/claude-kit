Plan slug: `payment-note` (`.claude/plans/payment-note/`). Your task: **Task 2 — a payment carries a note**.

Task text, verbatim from the plan: Extend `recordPayment` in `src/record-payment.js` with an optional `note`: `recordPayment({ memberId, amountMinor, note, ledger })` → `Promise<{ paidMinor: number }>`. A note is a string of at most 80 characters. A longer one is refused with a `RangeError` naming `note`, before anything is sent. With a note, `ledger.pay` receives `{ memberId, amountMinor, note }`; without one it receives `{ memberId, amountMinor }`, with no `note` key. Extend `pay` in `src/ledger-client.js` to send the note in the request body when there is one. It delivers AC-1, AC-2 and AC-3. Tests: AC-1 and AC-2 in `test/integration/record-payment.test.js`, beside the test that is there and written the same way, against the ledger; AC-3 in `test/unit/record-payment.test.js`. Do not touch any other file.

Acceptance criteria this task owns, verbatim from the plan:
- AC-1 — Given a member, when a payment of 700 is recorded with the note `cash at the desk`, then the member's ledger holds one new entry: a payment of 700 whose note is `cash at the desk`.
- AC-2 — Given a member, when a payment of 700 is recorded with no note, then the new entry in the member's ledger carries no note.
- AC-3 — Given a note of 81 characters, when the payment is recorded, then a `RangeError` is thrown whose message names `note`, and nothing is sent to the ledger.

Review-round context: none. The constraints in `_devils_advocate.md` are binding.
