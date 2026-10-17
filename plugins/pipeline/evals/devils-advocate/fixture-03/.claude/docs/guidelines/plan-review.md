# Plan-review checklist — Acme Store

Project-specific checks applied by the `pipeline:devils-advocate` agent on top of its generic checks.

1. **Build entries** — every new storefront TypeScript entry file is added to the entry list in
   `build/esbuild.mjs` within the same plan. Entries are explicit; an unlisted file is never
   compiled.
2. **Translations** — every new user-facing string lands in both `i18n/en_US.csv` and
   `i18n/da_DK.csv` of the owning module within the same plan.
