# Acme Library — repo law

A lending library's back office. Plain JavaScript (ES modules) on Node 22+, no dependencies.

## Quality gates

1. **Tests** — `npm test` runs `node --test` over `test/`. One file: `node --test test/<name>.test.js`.

There is no linter and no type check. Run the gates from the repository root. Never commit; the
reviewer does.

## Code

- Every module under `src/` is pure: no I/O, no clock, no globals. Callers pass what it needs.
- Money is an integer number of minor units. Validate an amount with `assertMinorUnits` from
  `src/money.js`; never write a second validator.
- A date is an ISO calendar day (`YYYY-MM-DD`). Count days between two of them with `daysBetween`
  from `src/calendar-days.js`; never with `Date` arithmetic of your own.
- A refused argument throws a `RangeError` whose message names the argument.
- Modules hold no wording a member reads: the screens translate the outcomes.

## Tests

Tests run code: import the module and exercise it. Never assert on a source file's text. Name a test
for the behaviour it pins.

## Knowledge

Knowledge-base directory: `kb/` — not present in this checkout; nothing to update.
