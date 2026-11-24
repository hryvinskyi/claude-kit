# Acme Library — repo law

A lending library's back office. Plain JavaScript (ES modules) on Node 22+, no dependencies.

## Quality gates

1. **Unit tests** — `npm test` runs `node --test` over `test/unit/`. One file:
   `node --test test/unit/<name>.test.js`.
2. **Integration tests** — `npm run test:integration` runs `node --test` over `test/integration/`.
   They talk to the branch ledger: a service of its own, which the team's stack runs at
   `LEDGER_URL` (by default `http://127.0.0.1:48107`). The stack is not part of this repository, and
   a task never starts it, stops it or replaces it.

There is no linter and no type check. Run the gates from the repository root. Never commit; the
reviewer does.

## Code

- A module under `src/` is pure — no I/O, no clock, no globals — except an adapter (`*-client.js`),
  which does the I/O and nothing else. A use case takes its adapter as an argument.
- Money is an integer number of minor units. Validate an amount with `assertMinorUnits` from
  `src/money.js`; never write a second validator.
- A date is an ISO calendar day (`YYYY-MM-DD`). Count days between two of them with `daysBetween`
  from `src/calendar-days.js`; never with `Date` arithmetic of your own.
- A refused argument throws a `RangeError` whose message names the argument.
- Modules hold no wording a member reads: the screens translate the outcomes.

## Tests

Tests run code: import the module and exercise it. Never assert on a source file's text. Name a test
for the behaviour it pins.

- A unit test may hand a use case a recording double of the ledger, to see what the use case sends
  or that it sends nothing.
- What the ledger ends up holding is proven only in `test/integration/`, against the real ledger,
  through `test/support/ledger.js`. Such a test never starts a stand-in for the ledger and never
  swaps the client for a fake. When the ledger is not reachable those tests skip, and say why.

## Knowledge

Knowledge-base directory: `kb/` — not present in this checkout; nothing to update.
