# Answer key — devils-advocate / fixture-03 (plan: free-shipping-bar, Magento + TypeScript)

The first fixture whose plan ships browser code. A Magento 2 store (`composer.json` requires
`magento/framework`; `package.json` and `tsconfig.json` build storefront TypeScript) plans a
free-shipping progress bar: a ViewModel, a template that loads its script and stylesheet through
hryvinskyi/magento2-theme-assets, two TypeScript modules, wiring and tests. Eight seeded flaws,
each written against a rule the fixture states or code it ships. A finding counts as FOUND if it
points at the same defect, however phrased.

The plan names `.ts` files, so the guard hook `plan_skill_gate.py` refuses every write under
`.claude/plans/` until the run has loaded **both** rubrics — `architecture:clean-architecture-php` with
`magento2.md`, and `architecture:clean-architecture-js` with `magento2-frontend.md`. A run that produced
`_devils_advocate.md` or any `[APPLIED]` edit therefore loaded them; a run that stopped at a
denial it could not get past is a failure of the agent definition, recorded as such.

| ID | Seeded flaw | Where | Rule it breaks | Expected severity |
|----|-------------|-------|----------------|-------------------|
| J1 | `renderScript('Acme_FreeShipping::js/free-shipping-bar.js')` passes no render type, so it uses the interface default `RENDER_INLINE` (`vendor/…/Api/AssetRendererInterface.php`): a ~38 KB script inlined into every cached product page | Task 2 | CLAUDE.md §Storefront code (inline only ≤ 2 KB, else `RENDER_EXTERNAL` + `LOAD_DEFER`) and the accepted decision record `2026-06-02 …rendered-external` | Important+ (Critical accepted: it contradicts an accepted decision record) |
| J2 | The ViewModel reads the quote's `subtotalMinor`/`itemCount` from the checkout session and the template prints them into `catalog_product_view` — a cacheable page. One visitor's cart is served to everyone who gets that cached copy (or, with Magento's depersonalization, every visitor sees an empty cart; both framings count) | Task 1 + Task 2 + the plan decision "reads the cart subtotal from the page" | CLAUDE.md §Storefront code (cacheable templates print nothing customer-specific; customer data through customer-data sections) | Critical |
| J3 | `switch (config.mode)` selects behavior (`amount` vs `quantity`) — two computations, two wordings | Task 4 | devils-advocate check 15 (no behavioral `switch`; a handler map typed over the union, or a registry) | Important+ |
| J4 | `JSON.parse(root!.dataset.config!) as BarConfig` — a cast over parsed JSON and two non-null assertions, while `Acme/Base/…/ts/parse.ts` ships `jsonAttribute`, `int`, `str`, `oneOf` for exactly this | Task 4 | CLAUDE.md §Storefront code (parse with the `parse.ts` helpers, never `as`, never `!`) | Important+ |
| J5 | The module calls `AssetRendererInterface` but neither the existing `etc/module.xml` nor `composer.json` declares `Hryvinskyi_ThemeAssets` / `hryvinskyi/magento2-theme-assets`, and Task 5 adds only `Magento_Checkout` | Task 5 (+ the module's real `etc/module.xml`, `composer.json`) | CLAUDE.md §Storefront code (a module declares every module it uses) | Important+ |
| J6 | User-facing English hard-coded in the TypeScript module (`'You have free shipping!'`, `` `Add … more for free shipping` ``, `` `Add … more items …` ``), and no task adds the strings to `en_US.csv`/`da_DK.csv` | Task 4 | CLAUDE.md §Storefront code (wording translated in PHP, passed in config; TS holds no user-facing strings) + gate 5 + checklist item 2 | Important+ |
| J7 | No task adds `free-shipping-bar.ts` (the entry) to `build/esbuild.mjs`, whose entry points are explicit — the compiled file never exists, and the inline render of a missing file prints nothing: the feature silently does not ship | whole plan (Task 4 says "compiled by `npm run build`") | CLAUDE.md gate 4 + checklist item 1 + the decision record's consequence | Critical |
| J8 | `BarTemplateTest` reads `bar.phtml` with `file_get_contents()` and asserts on its text | Task 6 | CLAUDE.md §Tests (tests run code; prove a template by rendering it) | Important+ |

## Not flaws — a finding here is noise

| Item | Why it is fine |
|------|----------------|
| The stylesheet rendered inline (`renderStyle(...)` with the default) | the file is 992 bytes, inside the ≤ 2 KB rule |
| `$escaper->escapeHtmlAttr($…->getConfigJson())` into `data-config` | the rubric's recommended way to print JSON into an attribute |
| Task 3's pure module | exactly what the rubric asks for |
| `render()` using `textContent` | no injection sink |

A **Minor** or a **Question** that asks about one of these without changing the plan is not
noise, but note it.

## Real extras a sharp run may add (not seeded — judge each, do not penalize)

- `config.itemCount / config.minimumItems` divides by zero when `minimumItems` is 0, and the
  quantity progress is not clamped.
- Only the first `[data-free-shipping-bar]` is mounted; the widget does not start safely when
  `DOMContentLoaded` has already passed; nothing re-renders when the cart changes after an AJAX
  add-to-cart (part of J2's fix: subscribe to the `cart` customer-data section).
- `format()` takes the locale from `<html lang>` — a store view whose `lang` differs from its
  price locale formats wrongly; the currency formatting belongs with the server's locale.
- A 38 KB bundle for a progress bar: the price formatting could use the browser's `Intl`
  without bundling anything.
- Task 6 lacks a test that mounts the widget from real markup, and an integration test that
  renders the template through the real renderer.
- `$viewModels->require(…)` in the template: the variable exists only where a package puts it
  into the template engine (hryvinskyi/magento2-base, Hyvä), and this store installs neither, so
  a finding that asks for a typed layout argument checked with `instanceof` — or constructor
  injection into the ViewModel — is real.

## Scoring

- **found**: N/8, per-flaw hit/miss with the agent's own wording.
- **severity accuracy**: J2 and J7 Critical; the rest at least Important.
- **apply-check**: every Critical/Important finding on J1–J8 has an `[APPLIED]` plan edit. J2
  may instead land in *Questions for the Team* when the agent judges that dropping the plan's
  "reads the cart subtotal from the page" decision changes its intent — correct handling, not a
  miss, as long as the finding itself is Critical.
- **rubric-check**: the artifacts exist (see above), and the report or findings speak the JS
  rubric's language where it applies (render mode and load strategy, cached HTML, parse-don't-cast).
- **noise**: findings against the *Not flaws* table are noise; other extras are judged real or
  hallucinated.

## Calibration (2026-09-29)

The key first listed `$viewModels->require(…)` under *Not flaws*. The first run flagged it (I3:
"neither package is declared") and it was right: the fixture installs neither package that
provides the variable. That was an authoring mistake, corrected in the key before the fixture was
ever committed — the item moved to the real extras; the fixture itself is unchanged.
