# Acme Billing — repo law

Symfony modular monolith. One Composer package per bounded context under `packages/{module}/`
(namespace `Acme\{Module}\`, tests under `packages/{module}/tests/`). Cross-module access only
via `Api/`, `Event/`, `Entity/`.

## Quality gates (all green before push)

1. **Static analysis** — `composer phpstan`. Level 9, no baseline; must pass clean.
2. **Tests at both levels** — Unit AND Integration (real Postgres, no mocked DB) for every change.
3. **Translation parity** — every user-facing string exists in BOTH locales (`en`, `de`);
   per-module `TranslationParityTest`s fail otherwise.
4. **Migrations** — schema changes ship hand-written, reversible migrations in the module's
   `src/Migrations/`.

## Service wiring

Services, listeners, and tagged `Api/` interfaces are registered in the module's
`Resources/config/services.yaml`. A tagged interface missing from the resource glob never
registers — the strategy pool is silently empty.

## Package activation

The application's root `config/` is not part of this repository excerpt, and it names no
package. For every package it loads, by glob:
- `src/Resources/config/services.yaml` as service definitions;
- every file in `src/Resources/config/packages/` as bundle configuration;
- `src/Resources/config/routes.yaml` as routes.

So a package registers its own Doctrine mapping (`doctrine.orm.mappings`), Twig namespace
(`twig.paths`) and route imports in those files. A package with none of them has no mapping,
no templates and no routes.

## Knowledge IDE

Knowledge-base directory: `kb/` (decisions in `kb/Decisions/`, board `kb/To DO.md`).
Accepted decision records are binding until superseded.

Plan reviews: project-specific checks live in `.claude/docs/guidelines/plan-review.md`.
