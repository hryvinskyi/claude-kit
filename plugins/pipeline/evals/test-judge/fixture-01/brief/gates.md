# Gates of acme-parcel, as read from its configuration

- **The build** — `npm run build` runs `scripts/build.mjs`: it reads `config/routes.json` and fails when a route
  names a handler that `src/handlers.js` does not export. `package.json` runs it before the tests (`npm test`), and
  `CLAUDE.md` says CI and every deploy run it first.
- **No type checker and no linter** (`CLAUDE.md`, *Gates*; `package.json` has no such script).
- **The tests** — `npm test`: `node --test tests/`, two levels (`tests/unit`, `tests/integration`).

Suite-wide checks the project keeps:

- `tests/unit/messages.test.js` holds every message to every language (`CLAUDE.md`, *Tests*: "A module adds none of
  its own").
