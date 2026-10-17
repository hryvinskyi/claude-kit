# Acme Store — repo law

Magento 2.4 store. Custom modules live in `app/code/Acme/<Module>`; the storefront theme is
Luma-based. Varnish full-page cache is on for every catalog page.

## Quality gates (all green before push)

1. **Static analysis** — `composer phpstan` (level 10) on `app/code`.
2. **PHP tests** — unit and integration for every PHP change.
3. **Storefront TypeScript** — `npm run typecheck` (`tsc --noEmit`, strict) and `npm run test:js`
   (`node --test`) for every change under `view/frontend/web/ts/`.
4. **Build** — `npm run build` compiles storefront TypeScript with `build/esbuild.mjs`. Its entry
   points are listed explicitly: a TypeScript file that is not in that list is never compiled, and
   the fileId that names its output renders nothing.
5. **Translations** — every user-facing string exists in both `i18n/en_US.csv` and
   `i18n/da_DK.csv` of the module that owns it.

## Storefront code

- Scripts and styles are rendered with hryvinskyi/magento2-theme-assets
  (`Hryvinskyi\ThemeAssets\Api\AssetRendererInterface`). Inline only files of 2 KB or less;
  everything else is `RENDER_EXTERNAL` + `LOAD_DEFER`. Preload only what the LCP element needs.
- The full-page cache serves one copy of a cacheable page to every visitor: cacheable templates
  print nothing customer-specific (name, cart, customer-group prices). Customer data reaches
  scripts through customer-data sections (`Magento_Customer/js/customer-data`).
- Configuration read from markup or from an API response is parsed with the helpers in
  `app/code/Acme/Base/view/frontend/web/ts/parse.ts` — never cast with `as`, never
  non-null-asserted with `!`.
- User-facing wording is translated in PHP with `__()` and handed to the script in its
  configuration. TypeScript modules contain no user-facing strings.
- A module declares every module it uses: `composer.json` `require` and `etc/module.xml`
  `<sequence>`.

## Tests

Tests run code. Never write a test that reads a template, a layout file or a script as text and
asserts what it contains; a template is proven by rendering it.

## Knowledge

Knowledge-base directory: `kb/` (decisions in `kb/Decisions/`, board `kb/To DO.md`).
Accepted decision records are binding until superseded.

Plan reviews: project-specific checks live in `.claude/docs/guidelines/plan-review.md`.
