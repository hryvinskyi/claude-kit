---
name: magento2-architecture-frontend
description: Magento 2's front-end idiom for the architecture:clean-architecture-js rubric — the three delivery mechanisms (RequireJS/Knockout and jQuery widgets, vanilla scripts and styles rendered through hryvinskyi/magento2-theme-assets, Hyvä/Alpine); AssetRendererInterface render modes (inline or external), async/defer, preload and fetch priority; config and wording from templates; the full-page cache and private data; script-rewriting optimizers; mixins; TypeScript builds; module ownership of assets; detection recipes in Magento's spelling. Use together with architecture:clean-architecture-js whenever storefront or admin JavaScript or TypeScript in a Magento 2 project is reviewed, planned or written, and when deciding how a template loads a script or stylesheet; the PHP half is magento2:magento2-architecture-php.
---

Load this skill together with `architecture:clean-architecture-js`. A file named without a skill
(`javascript.md`, `typescript.md`, `react.md`, `ddd.md`, `clean-architecture.md`,
`integration-patterns.md`, `solid.md`) is that core skill's.

# Magento 2 frontend — the browser code a module ships

Magento renders the page in PHP, usually behind a full-page cache, and JavaScript enhances it. The PHP half of every widget — the ViewModel that builds its config, the layout that places the block, the template's PHP — is reviewed with `architecture:clean-architecture-php` and `magento2:magento2-architecture-php`. This skill covers the other half: what runs in the browser, how a template loads it, and what it may assume about the page. Read `javascript.md` first; `typescript.md` when the code is TypeScript.

## 1. Discover the delivery mechanism before writing a line

Magento stores mix three ways of shipping browser code. Find out which one the area you touch uses — `composer.json` requires, the theme's `theme.xml` parent chain, the module's existing templates — and follow it. Do not introduce a fourth.

| Mechanism | How to recognize it | Code shape |
|---|---|---|
| **RequireJS · jQuery widgets · Knockout** (Luma family) | `requirejs-config.js`, `define([...])`, `x-magento-init` / `data-mage-init`, `uiComponent` | AMD modules, widgets, KO view models (§7) |
| **Vanilla scripts and styles through `hryvinskyi/magento2-theme-assets`** | the package in `composer.json`; templates calling `AssetRendererInterface` | classic scripts (IIFE) or ES modules, plain CSS (§2–§6) |
| **Hyvä** (Alpine.js + Tailwind) | `hyva-themes/*` required; a theme whose parent chain reaches `Hyva/*` | Alpine components in templates (§8) |

## 2. theme-assets — getting the renderer, naming the asset

The package's surface: `AssetRendererInterface::renderScript($fileId, $renderType, $loadStrategy, $preload, $params, $options)`, `renderStyle($fileId, $renderType, $preload, $params, $options)`, `getContent($fileId, $params)`, `createAsset()`, and `AssetPathResolverInterface::getViewFilePath()` / `getViewFileContent()`. Constants: `RENDER_INLINE` (the default!) / `RENDER_EXTERNAL`; `LOAD_SYNC` (default) / `LOAD_ASYNC` / `LOAD_DEFER`; `PRELOAD_ENABLED` / `PRELOAD_DISABLED`; `PRIORITY_HIGH` / `PRIORITY_LOW` / `PRIORITY_AUTO`. Options: `attributes`, `priority`, and — inline scripts only — `content_before` / `content_after`.

**Getting the renderer into a template** — never through `ObjectManager`:
- a typed **layout argument** (`<argument name="asset_renderer" xsi:type="object">Hryvinskyi\ThemeAssets\Api\AssetRendererInterface</argument>`), checked with `instanceof` in the template before use — the explicit form, preferred for a block the module owns;
- **`$viewModels->require(AssetRendererInterface::class)`** — the template-engine registry (hryvinskyi/magento2-base; in Hyvä themes Hyvä's own registry wins). It is `ObjectManager::get()` underneath: one shared instance per request. Fine for the stateless renderer; wrong for a view model that holds per-block state, which is built per block (a factory) instead;
- **constructor injection into the feature's ViewModel**, when the ViewModel decides what to render (render-once logic, a mode chosen from config).

**Naming the asset.** A fileId `Vendor_Module::js/file.js` resolves through Magento's view-file fallback: the active theme's `Vendor_Module/web/js/file.js` wins over the module's `view/<area>/web/js/file.js`. A bare `js/file.js` is the theme's own `web/js/` asset.
- **The asset lives in the module that owns the feature** and is rendered by that module's template under that module's fileId. A theme **overrides** an asset through the fallback when its behavior must change for that theme; it does not fork the template to swap a script.
- **A module that renders another module's fileId depends on that module** — declare it (`module.xml` sequence, `composer.json` require) or move the asset to its owner.
- **A module that calls `AssetRendererInterface` declares the package**: `hryvinskyi/magento2-theme-assets` in `composer.json`, `Hryvinskyi_ThemeAssets` in the `module.xml` sequence. Being pulled in transitively by a neighbour is a sideways dependency that breaks the day the neighbour is removed.

## 3. Choosing how the page loads it

| The code is… | Render | Load | Preload |
|---|---|---|---|
| A few hundred bytes that must run before first paint or before other scripts; critical above-the-fold CSS | `RENDER_INLINE` | — | no — nothing to fetch |
| An ordinary enhancement script | `RENDER_EXTERNAL` | `LOAD_DEFER` | no |
| Independent of DOM order and of other scripts (a beacon, a self-contained widget) | `RENDER_EXTERNAL` | `LOAD_ASYNC` | no |
| Needed for the LCP element or the first interaction above the fold | `RENDER_EXTERNAL` | `LOAD_DEFER` | `PRELOAD_ENABLED`, `PRIORITY_HIGH` |
| A stylesheet not needed for first paint | `RENDER_EXTERNAL` (plus the project's lazy-CSS pattern) | — | no, or `PRIORITY_LOW` |
| An ES module | `RENDER_EXTERNAL` with `'attributes' => ['type' => 'module']` | deferred by the browser | when it is LCP-critical |

What drives the table:
- **Inline content is part of the HTML.** It is cached with the page by the full-page cache, re-sent on every page view, never cached by the browser on its own, and a change to the file shows only after the page cache is flushed. Inline is a tool for small critical code — not a default, although it *is* the method's default: a `renderScript('…')` with no render type inlines the whole file.
- **An inline script is a self-contained classic script**: no `import`, and no `define()` unless RequireJS is certain to be loaded first.
- **`LOAD_SYNC` blocks parsing.** The only reason to use it is a later inline script that calls into it synchronously — and that load-order contract is itself the smell (`javascript.md` §4).
- **ES modules** resolve relative imports against their own URL (the versioned static path), so sibling imports work from an external module; an inline module's relative imports resolve against the page URL and break. With JS minification on (`dev/js/minify_files`), the asset is published and linked as `file.min.js` while a relative `import './other.js'` asks for a name static deploy never wrote: ship each module as one built file with no relative imports, or exclude its directory through `dev/js/minify_exclude`.
- **Preload is a hint in `<head>`**, added through HeadTagManager, and only on the external path. `priority` affects that hint and nothing else — `PRIORITY_LOW` with `PRELOAD_DISABLED` does nothing. Preloading a deferred, below-the-fold script takes bandwidth from the resource that decides LCP.
- **The method returns the tag** for both render types: echo it where it belongs — a stylesheet before the content it styles, a script after the markup it enhances. The docblocks' "empty string … HeadTagManager" describes only the preload hint, and the `position` option is documented but not read (1.0.x).
- **Version:** in 1.0.0 an external `renderStyle()` prints a `<link>` without `href`; a module rendering external styles requires `^1.0.1`.
- **CSP comes with the renderer.** Tags go through Magento's `SecureHtmlRenderer`: inline scripts receive a nonce and inline styles a hash when CSP forbids inline code, and remote hosts are allow-listed. Content echoed into a hand-written `<script>` or `<style>` bypasses all of that; when content must be printed by hand (`getContent()` into a template's own `<style>`), it carries the nonce the project uses.
- **Failure is silent.** When no content strategy can read the file, the inline render returns an empty string and logs to `var/log/asset_renderer.log`; the feature vanishes without an error on the page. The template test of §10 is what notices, and the static-content deploy must include the file.

## 4. Config and wording come from the template

The ViewModel builds the config (PHP skill); the template prints it, escaped; the script parses it (`javascript.md` §11).

- **Preferred:** a `<script type="application/json" data-role="…">` block printed with a serializer that hex-escapes tags (`Magento\Framework\Serialize\Serializer\JsonHexTag`), found by the script relative to its root element; or a JSON `data-*` attribute printed through `$escaper->escapeHtmlAttr()`.
- **Avoid:** `'content_before' => 'window.fooConfig = ' . json_encode($config) . ';'` — a global, a load-order contract, and plain `json_encode` lets `</script>` in the data end the script. Hand-built JSON with an unescaped `<?= $block->getX() ?>` inside is an XSS finding.
- **Wording** is translated in PHP (`__()`) and printed into the config or markup, or — in AMD code — `$t()` from `mage/translate` with the strings in the module's `i18n/*.csv`. Pure modules never hold wording.

## 5. The full-page cache and private data

Everything a cacheable template prints is **shared by every visitor who receives that cached page**: a customer's name, a cart count, a customer-group price, a wishlist flag, a consent state.
- Private data reaches the page through the project's private-content channel — customer-data sections (`Magento_Customer/js/customer-data`, Hyvä's `private-content-loaded`), a private AJAX endpoint, ESI — and the script shows a neutral state until it arrives.
- `cacheable="false"` on a block to "fix" leaked private data disables the page cache for the whole page: a performance incident, not a fix.
- Any client-side cache of server data carries every dimension it depends on — store, currency, customer group, locale (`integration-patterns.md` §6).

## 6. Script-rewriting optimizers

Many stores run modules that rewrite `<script>` tags after rendering: moving every script to the end of `<body>` (hryvinskyi/magento2-deferjs), rewriting eligible scripts to a non-executing type and running them on first interaction or after a delay (an extreme lazy-load module), merging external scripts, and consent managers that hold scripts until consent. Discover which ones the project runs before assuming anything about timing.

- **A script cannot rely on its position or on `DOMContentLoaded` still being ahead.** Start with the `readyState` check (`javascript.md` §10).
- **An inline "call the function the external file defined" contract breaks** as soon as one side is moved, delayed or merged.
- **A script that must run early and untouched** needs each optimizer's opt-out attribute — for example `data-deferjs="false"` (the *string* `'false'`: a boolean `false` renders as an empty value and is not recognised), `data-ignore-extreme-lazy-load`, `data-pagespeed-ignore-merge`, `data-cookieconsent="ignore"`.
- **Those attribute names are the optimizers' vocabulary.** A feature module that spells all of them in its own template names modules it does not declare. Keep one project-owned place that turns the intent — "critical script: run early, unmodified" — into the attributes (a `di.xml` array or a small ViewModel the templates ask), so adding or removing an optimizer is one change instead of a sweep of templates.

## 7. RequireJS, jQuery widgets and Knockout

- **A uiComponent or KO view model is an interface adapter** — observables, bindings, `$t()` wording, DOM events. It delegates every non-trivial computation and holds no business rules.
- **Pure logic lives in dependency-light AMD modules, split by concern.** One charter per file — a condition builder splits into `expression-tree.js` (tree model and serialization), `expression-value.js` (leaf-value shapes and validator predicates), `expression-options.js` (option-list indexing). A growing `utils.js` is the JS god-Helper.
- **Registries over branching:** export named strategies and resolve by key — config names the strategy, the module owns the behavior; the JS twin of the `di.xml` pool.
- **Shared components carry no consumer's vocabulary.** A reusable admin component receives wording, attribute codes and semantic rules through its config object — its published language. Prove it by running the component with a second consumer's config in a test, not by scanning its source for words.
- **A pure module loads in plain Node** behind a small `define` shim (a stubbed `underscore` at most). If it needs `Magento_Ui`, `ko` or `mage/translate`, it belongs to the presentation layer.
- **RequireJS mixins are JS plugins** — the same OCP seam and the same caution as `around` plugins: call `this._super()`, keep the method's contract (LSP), and prefer a registry or config extension point you own. A `requirejs-config.js` `map`/`paths` entry that swaps another module's file is a fork of that file.
- **`x-magento-init` / `data-mage-init` JSON is the component's published language**, printed with `JsonHexTag` or `$block->getJsLayout()` — never assembled by hand in the template.
- **jQuery widgets**: `_destroy` undoes everything `_create` did; options are config, not a place for rules.

```js
// ❌ predicates, branching and English fused inside the KO component
rowValueError: function (row) {
    if (row.operator() === '~') {
        try { new RegExp(row.value()); } catch (e) { return 'Invalid regular expression'; }
    } else if (this.isNumeric(row)) { /* …more branches, more wording… */ }
}

// ✅ predicates in a pure, Node-testable module; wording stays in the component
// expression-value.js  (pure — no ko, no $t)
return { validators: { 'regex': isValidRegex, 'number': isFiniteNumberValue } };

// expression-builder.js  (presentation)
var VALIDATOR_MESSAGES = { 'regex': $t('Invalid regular expression'), 'number': $t('Enter a number') };
rowValueError: function (row) {
    var name = this.validatorNameFor(row),
        predicate = name && expressionValue.validators[name];
    return predicate && !predicate(row.value()) ? VALIDATOR_MESSAGES[name] : '';
}
```

## 8. Hyvä and Alpine.js

- **Alpine components are adapters.** `x-data` binds state and events; the logic sits in a function defined once — registered with `Alpine.data('name', …)` on `alpine:init`, or a module-level function — not re-declared inline in every template instance with PHP interpolated into the JavaScript.
- **Config is printed escaped** (`$escaper->escapeJs()`, or JSON through `escapeHtmlAttr()` / a JSON script block) — never a raw `<?= ?>` inside a JS expression.
- **CSP:** inline scripts carry the project's nonce (a CSP nonce view model); a strict CSP setup forbids Alpine expressions that need `eval` — follow the theme's CSP mode.
- In a Hyvä theme `$viewModels` is Hyvä's registry, and private data arrives with `private-content-loaded`.

## 9. TypeScript in a Magento project

- A build step turns the `.ts` sources into the `.js` the fileId names — `module: amd` when RequireJS loads it, an IIFE or ES module when theme-assets renders it — and a gate runs `tsc --noEmit` (`typescript.md` §9).
- The AMD modules the code imports are typed by narrow declaration files (`typescript.md` §8).
- A compiled `.js` committed beside its `.ts` with no build in the project's tooling is a fork: wire the build or delete one of them.
- No `import $ = require('jquery')` and no `module Foo {}` in new code — both are non-erasable syntax.

## 10. Testing

- **Pure modules** under the project's runner — `node --test` needs no install: AMD behind a `define` shim, a classic script run in a `vm` context with fakes, or a factory that exports to `module.exports` when it exists (`javascript.md`, *Testing without a browser*).
- **The template**: a PHP test renders it with a recording fake of `AssetRendererInterface` (returning a marker tag per fileId, mode and attributes) and asserts what the template asks for and the escaped config it prints. That is a render, which the engineering standards, §*Tests run code* allow; an integration test through the real renderer proves the file itself resolves.
- **Flows** that cross the server (add to cart, checkout steps) in a real browser (Playwright) against a real store.
- **Never** a test that greps a template or a script for words.

## Detection recipes — candidates, not findings

ripgrep over the module (`app/code/<Vendor>/<Module>`) or theme; `-g '*.phtml'`, `-g '*.js'`, `-g '*.xml'` per row.

| Smell | Search | Cleared when |
|---|---|---|
| ObjectManager in a template | `ObjectManager` in `*.phtml` | never |
| Hand-written script with logic | `<script(?![^>]*type="(text/x-magento-init\|application/json)")` in `*.phtml` (`-P`) | a one-line bootstrap calling a mount function, through the renderer or with the project's nonce |
| Unescaped or unhexed JSON | `json_encode\(` in `*.phtml` | printed through `escapeHtmlAttr()` or produced by `JsonHexTag` |
| Config as a global | `content_before.*window\.\|window\.\w+\s*=\s*<\?=` | never in new code |
| Inline by default | `renderScript\(\s*'[^']+'\s*\)` and `renderScript\([^)]*RENDER_INLINE` | the file is small and critical — `wc -c` the asset |
| No-op or contradictory hints | `PRIORITY_\w+` with `PRELOAD_DISABLED`; `PRELOAD_ENABLED` with `RENDER_INLINE` | never |
| External styles on 1.0.0 | `renderStyle\([^)]*RENDER_EXTERNAL` with `hryvinskyi/magento2-theme-assets` at `1.0.0` in `composer.lock` | the constraint is `^1.0.1` |
| Undeclared package | `AssetRendererInterface` in a module whose `composer.json`/`module.xml` do not declare theme-assets | never |
| Another module's asset | `render(Script\|Style)\('(\w+_\w+)::` where the prefix is not the module itself | the module declares that dependency |
| Optimizer vocabulary in a feature module | `data-deferjs\|data-ignore-extreme-lazy-load\|data-pagespeed-ignore-merge\|data-cookieconsent` in `*.phtml` | the project's single intent-to-attributes place |
| Page cache disabled | `cacheable="false"` in layout XML | a genuinely private page (customer account, checkout) |
| Globals from module JS | `window\.\w+\s*=` in `view/*/web/js/**` | one documented namespace from one entry point |
| Mixins | `mixins` in `requirejs-config.js` | each mixin calls `_super()` and keeps the contract — read them |
| XSS sinks | `innerHTML\|\.html\(` in `view/*/web/js/**` | server-escaped HTML only |

## Magento frontend review checklist
- [ ] The area's delivery mechanism was followed; no new mechanism introduced.
- [ ] Templates get the renderer through a typed argument, the view-model registry or the ViewModel — never `ObjectManager`; the module declares theme-assets and every module whose fileId it renders.
- [ ] Assets live in the module that owns the feature; themes override through fallback.
- [ ] Each asset's render mode, load strategy and preload are justified by the table in §3; nothing large is inlined; nothing below the fold is preloaded.
- [ ] Config and wording come from the template, escaped (`JsonHexTag`, `escapeHtmlAttr`), and are parsed by the script; no config globals.
- [ ] Nothing private is printed into a cacheable template; private data comes through the private-content channel.
- [ ] Scripts survive the project's optimizers: no position or timing assumptions; opt-outs come from one project-owned place.
- [ ] KO/uiComponents, widgets and Alpine components are presentation only; pure logic sits in Node-testable modules; mixins keep their contracts.
- [ ] TypeScript is built and type-checked by the project's tooling; no hand-maintained compiled output.
- [ ] Pure modules, the template's asset requests, and the flow are each tested at their level; no test greps source.

## 11. The core rules in Magento's idiom

The core skill states each rule without a server framework. This section is where those rules meet Magento's names.

### Where things sit

- **A module's zone** in Magento: the module's `view/<area>/web/` and its templates. A Magento module's JS, CSS, templates and `i18n/*.csv` ship in that module.
- **Artifacts with one owner** include RequireJS module ids and mixin targets, and theme-assets fileIds (`Vendor_Module::js/file.js`).
- **Layers:** a pure AMD or ES module in a Magento module's `web/js/` is domain code; Knockout view models and uiComponents, Alpine components and jQuery widgets are interface adapters (a Knockout view model *binds* a use case, it is not one, and a Knockout observable never crosses inward); Knockout, Alpine, RequireJS and theme-assets are frameworks and drivers. A domain or use-case module importing `ko` or `mage/*`, or rules inside Knockout view models or Alpine objects, break the dependency rule.
- **Litmus:** replacing a Magento template with another server's, or Knockout with vanilla, must not touch use cases or the domain.
- **Module-per-capability:** Magento's module per capability is the screaming structure on this stack.
- **The JS service locator** is Magento's `ObjectManager` in another language.
- **Declared dependencies** of a module's browser code include its `module.xml` sequence.

### Review and plan passes

- **The host pass** on Magento: how the page loads the code, what is escaped, what lands in cached HTML (§3–§5).
- **Plan mode, delivery:** state the theme-assets render mode and why (§3).
- **Script-loading by habit** — every script inline, every script preloaded, or synchronous by default — is judged against §3's table.

### Language-level rules on this stack

- **Framework-free browser code** here is a widget a Magento template renders through theme-assets.
- **Globals and load order** break under the script-rewriting optimizers of §6.
- **Content inserted later:** Magento's `contentUpdated` is answered by calling `mountAll(newContent)` again.
- **Escaping:** `$escaper->escapeHtmlAttr(json)` (§4).
- **Events between parts of the page:** widgets rendered by different templates announce through a typed event; the customer-data sections and their invalidation are the platform's own version of this seam.
- **The published language of the backend** is the endpoint's contract — the PHP skill's `Api/Data/` DTOs — not the entity behind it.
- **Variants (OCP):** a registry module or a `rendererList` the component iterates (the checkout's payment renderers are this pattern), never a new `else if` in someone else's widget.
- **LSP:** a RequireJS mixin or an overridden widget method that changes the return type or skips `this._super()` for some inputs is the JS `around` plugin, with the same LSP risk (§7).
- **Injection (DIP):** the config object passed to a Magento widget or uiComponent.
- **Detection recipes** (`solid.md`): add `pub/static` to the excluded served copies, and `knockout\|alpinejs` to the DIP import list.

### Islands, caching and TypeScript

- **Islands:** in Magento, React also runs as an island mounted into one element of a server-rendered page (`react.md` §10).
- **Full-page-cached HTML:** Magento's full-page cache and Varnish share the HTML itself; private data arrives through customer-data sections or a private endpoint (§5).
- **Platform globals:** `window.checkoutConfig`, printed by the page, is declared with `declare global` and typed as `unknown` or a parsed shape.
- **Declaration files** for AMD / RequireJS modules: a local `types/` folder with `declare module 'Vendor_Module/js/price-box' { … }` for the few modules the TypeScript code imports — typed as narrowly as the code uses them.
- **TypeScript pipeline** (`typescript.md` §9):

  | Pipeline | What compiles `.ts` | What type-checks |
  |---|---|---|
  | Magento storefront | a build step (esbuild, `tsc`) emitting the `.js` that `view/<area>/web/js/` serves — `module: amd` when RequireJS loads it, an IIFE or ES module when theme-assets renders it | `tsc --noEmit` |

- **REST endpoints:** a coupon applied through `/rest/V1/carts/mine/coupons/${code}` is a transport detail the use case reaches through its gateway port.

### References

- hryvinskyi/magento2-theme-assets — the package README (`vendor/hryvinskyi/magento2-theme-assets/README.md` in a project that requires it)

## Implementer checklist on this stack

Read with the core skill's `references/implementer-checklist.md`.

- Follow the area's delivery mechanism. theme-assets — get the renderer through a typed argument, the view-model registry or the ViewModel; inline only small critical code; external + defer by default; preload only what first paint needs; the module declares `hryvinskyi/magento2-theme-assets` and every module whose fileId it renders. Config and wording printed escaped (`JsonHexTag`, `escapeHtmlAttr`), parsed by the script; nothing private in cacheable output; no timing assumptions the project's script optimizers break.
- Domain and use-case modules import no Knockout, Alpine or `mage/*`; Knockout view models and Alpine objects only bind, render and choose wording.
- Declared dependencies include the `module.xml` sequence.
