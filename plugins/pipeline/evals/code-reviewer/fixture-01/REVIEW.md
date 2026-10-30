# Review instructions — Acme Shop

## What Important means here

Critical: a customer pays the wrong amount; a code works after it was switched off; data of another
workspace is read or shown; user text reaches the page unescaped. Important: a rule of the repo law
broken; a claim no code enforces; a test that pins nothing; a logged TODO row inside the change's
blast radius. Minor: cleanup and wording.

## Classes

L: anything under `packages/*/src/Discount/`, `schema.sql`, `packages/*/src/Http/` (a request
reaches the code), a new field on `DiscountCode`. Security paths: `packages/*/src/Http/`, every
repository read.

## Always check

1. **Every reader of a changed meaning.** A new field or flag on `DiscountCode` is read by every
   service that applies a code (`rg -n 'DiscountCode' packages`); each one is read, not grepped.
2. **A client-side limit is not a guard.** A `maxlength` in `templates/` bounds nothing;
   `schema.sql` holds the bound, and the constructor or the save refuses what exceeds it.
3. **A TODO row inside the blast radius is a finding.** A `kb/To DO.md` row about touched code or
   its direct collaborators is reported with a severity, never skipped as known.
4. **Escaping.** Every value an `Http/` class prints is escaped on its way out: search for `echo`
   and `return "<` and follow the value to its source.
5. **Tenant scope on every read.** A repository method that reads by code without a workspace id
   reads across workspaces.

## Do not report

- Formatting and import order (the linter's job).
- The Makefile and `bin/app.php`, the composition root.

## Where reviews here have missed

- A value printed by an `Http/` class without escaping.
- A TODO row about the touched code, skipped as already known.
