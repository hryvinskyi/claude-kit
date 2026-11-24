# acme-parcel — repo law

A small parcel desk: a clerk hands a parcel in, the sender gets a quote and follows the parcel's state.
Plain JavaScript (ES modules), Node 22 or newer, no dependencies.

## Layout

- `src/` — the product. `quote.js`, `postcode.js`, `status.js`, `schedule.js` and `parcel.js` are rules with no I/O.
  `ledger.js` holds the parcels. `handlers.js` answers the routes. `app.js` starts the application: it reads
  `config/routes.json`, opens the ledger and issues the session token every request must carry.
- `config/routes.json` — the route table.
- `vendor/tiny-router/` — third-party code, copied in as released. It is not ours to change or to test.
- `tests/unit/` and `tests/integration/` — the two levels.

## Quality gates

1. **The build** — `npm run build` (`scripts/build.mjs`). It fails when a route names a handler that
   `src/handlers.js` does not export.
2. **The tests** — `npm test` runs the build and then `node --test` over `tests/`. One level alone:
   `npm run test:unit`, `npm run test:integration`. One file: `node --test tests/unit/<name>.test.js`.

There is no type checker and no linter. Run the gates from the repository root. Never commit; the reviewer does.

## Code

- A rule module under `src/` is pure: no I/O, no clock, no globals. Callers pass what it needs.
- A request that cannot be served is refused with the module's own refusal (`QuoteRefused`, `PostcodeRefused`)
  carrying a reason. A reason is a code the web client matches on: it is registered in its module's list
  (`QUOTE_REASONS`, `POSTCODE_REASONS`), and a refusal with an unregistered reason cannot be made.
- Wording a person reads lives in `src/messages/<language>.js`, by key; a reason's key is the reason itself.
  The application turns a refusal into its answer and its wording (`src/app.js`); a rule module holds no wording.

## Tests

- Every rule has a unit test, and every route has an integration test: a change to a rule that a route serves ships
  both.
- A unit test takes about a millisecond. An integration test starts the application (`createApp()`), which in the
  real deployment opens the ledger file and compiles the route table: count about a second for each start.
- One check holds every message and every registered reason to every language: `tests/unit/messages.test.js`.
  A module adds no wording check of its own.
- A test runs code. It never reads a file of the project to assert what the file says. Name a test for the
  behaviour it pins.

## Things other systems rely on

- **The values of the states** (`booked`, `collected`, `delivered`, `returned`) are written into the ledger file
  and read by the depot's importer.
- **The reason codes of a refusal** are matched by the web client.
- **The columns of the CSV export**, in their order, are read by the depot's spreadsheet.

## Knowledge

Knowledge-base directory: `kb/` — not present in this checkout; nothing to update.
