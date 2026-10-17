# Acme Store — repo law

Magento 2.4 store. Custom modules live in `app/code/Acme/<Module>`. Storefront widgets are
TypeScript under each module's `view/frontend/web/ts/`.

## Quality gates

1. **JS tests** — `npm run test:js` runs `node --test` over every module's `Test/Js/*.test.ts`.
   Node runs TypeScript by stripping the types, so it needs no install and no build.
2. **Type check** — `npm run typecheck` (`tsc --noEmit`, strict). TypeScript is installed by
   `npm ci`; a checkout without `node_modules` cannot run this gate. Report it as not run in that
   case — never as passed.
3. **PHP** — `composer phpstan` (level 10) and PHPUnit for PHP changes.

Run the gates from the repository root. Never commit; the reviewer does.

## TypeScript

- Erasable syntax only — Node strips types and cannot run `enum`, `namespace`, or constructor
  parameter properties. Relative imports spell the `.ts` extension.
- No `any`, no `as` casts (`as const` is fine), no non-null assertions, no `@ts-*` or
  `eslint-disable` comments.
- Money is an integer number of minor units.
- Modules under `view/frontend/web/ts/` hold no user-facing wording: the template passes the
  translated strings in the widget's configuration.

## Tests

Tests run code: import the module and exercise it. Never assert on a source file's text.

## Knowledge

Knowledge-base directory: `kb/` — not present in this checkout; nothing to update.
