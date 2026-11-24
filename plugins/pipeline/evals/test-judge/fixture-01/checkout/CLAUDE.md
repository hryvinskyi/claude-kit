# acme-parcel

A small parcel desk: a clerk hands a parcel in, the sender gets a quote and follows the parcel's state.
Plain JavaScript (ES modules), Node 22 or newer, no dependencies.

## Layout

- `src/` — the product. `quote.js`, `postcode.js`, `status.js`, `schedule.js` and `parcel.js` are rules with no I/O.
  `ledger.js` holds the parcels. `handlers.js` answers the routes. `app.js` starts the application: it reads
  `config/routes.json`, opens the ledger and issues the session token every request must carry.
- `config/routes.json` — the route table.
- `vendor/tiny-router/` — third-party code, copied in as released. It is not ours to change or to test.
- `tests/unit/` and `tests/integration/` — the two levels.

## Gates

- **The build** — `npm run build` (`scripts/build.mjs`). It fails when a route names a handler that `src/handlers.js`
  does not export. CI runs it before the tests, `npm test` runs it first, and a deploy runs it before the application
  starts.
- **The tests** — `npm test`. One level alone: `npm run test:unit`, `npm run test:integration`. A JUnit report of the
  whole suite: `npm run test:junit` writes `junit.xml`.

There is no type checker and no linter.

## Tests

- Every rule has a unit test, and every route has an integration test: a change to a rule that a route serves ships
  both.
- A unit test takes about a millisecond. An integration test starts the application (`createApp()`), which in the
  real deployment opens the ledger file and compiles the route table: count about a second for each start.
- One check holds every message to every language: `tests/unit/messages.test.js`. A module adds none of its own.
- A test runs code. It never reads a file of the project to assert what the file says.

## Things other systems rely on

- **The values of the states** (`booked`, `collected`, `delivered`, `returned`) are written into the ledger file
  and read by the depot's importer. A changed value breaks every stored parcel.
- **The reason codes of a refusal** (`no_weight`, `too_heavy`, `empty`, `too_long`) are matched by the web client.
- **The columns of the CSV export**, in their order, are read by the depot's spreadsheet.

## Things nothing relies on

- **Log lines** are for the operator's eyes while debugging. No alert and no parser reads them; their wording and
  their order may change freely.
- **The partner integration** was removed in 2025. Nothing in `src/` talks to the partner, and no environment —
  no workstation, no CI job — sets `PARTNER_SANDBOX_URL`.
