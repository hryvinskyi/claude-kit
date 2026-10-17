---
name: symfony-architecture-frontend
description: Symfony's front-end idiom for the architecture:clean-architecture-js rubric — AssetMapper/importmap, Webpack Encore and Vite pipelines; Stimulus controllers as humble adapters (values, targets, outlets, events); wording from Twig; Turbo, Live and Twig Components; React islands mounted by a controller; per-package asset registration in a modular monolith; CSRF and CSP nonces; TypeScript builds; detection recipes in Symfony's spelling. Use together with architecture:clean-architecture-js whenever JavaScript or TypeScript a Symfony project ships is reviewed, planned or written; the PHP half is symfony:symfony-architecture-php.
---

Load this skill together with `architecture:clean-architecture-js`. A file named without a skill
(`javascript.md`, `typescript.md`, `react.md`, `ddd.md`, `clean-architecture.md`,
`integration-patterns.md`, `solid.md`) is that core skill's.

# Symfony frontend — Stimulus, AssetMapper, UX and islands

Symfony renders the page with Twig and JavaScript enhances it: Stimulus controllers bound by `data-controller`, optionally Turbo, Live and Twig Components, and bundles (often React) mounted into one element. The PHP half — controllers, Twig components' PHP classes, Live Component actions, the endpoints a script calls — is reviewed with `architecture:clean-architecture-php` and `symfony:symfony-architecture-php`. This skill covers the browser half. Read `javascript.md` first; `typescript.md` for TypeScript; `react.md` for islands.

## 1. Discover the pipeline

| Pipeline | Recognize it by | Notes |
|---|---|---|
| **AssetMapper + importmap** | `symfony/asset-mapper`, `importmap.php`, `assets/` | No build step: files are served as they are, versioned by `asset-map:compile`. `missing_import_mode: strict` turns a typo into an error, not a silent 404 |
| **Webpack Encore** | `webpack.config.js`, `encore_entry_*_tags` | TypeScript through `enableTypeScriptLoader()` |
| **Vite** | `pentatrion/vite-bundle`, `vite.config.*` | Types erased, never checked — `tsc --noEmit` is the gate |
| **A separate esbuild/Vite build for islands** | `build/*.mjs` scripts writing bundles outside `assets/` | The host loads the bundle with `import()`; the island is type-checked by its own `tsconfig` |

TypeScript under AssetMapper goes through `sensiolabs/typescript-bundle` or a separate build; see `typescript.md` §9. Follow the pipeline the project already runs.

## 2. Stimulus controllers are humble adapters

A controller binds markup to behavior. Its **static `values`, `targets`, `classes` and `outlets` are its published language** — the contract the Twig side fills with `stimulus_controller('name', { … })` or `data-*-value` attributes.

- `connect()` sets up, `disconnect()` tears down **everything** `connect()` started: listeners (one `AbortController`), observers, timers, in-flight requests, a mounted island. With Turbo or Live Components, controllers connect and disconnect many times per visit.
- **Logic lives in pure modules** the controller imports (`javascript.md` §10): parsing, calculations, validation, state transitions. The controller keeps DOM work, value parsing, and wording.
- **Elements come from targets**, not from `document.querySelector` — a selector outside the controller's element couples it to markup it does not own.
- **Other controllers are reached through events**, not through their instances: `this.dispatch('saved', { detail })` (prefixed with the identifier: `autosave:saved`), listened to with `data-action="autosave:saved->toast#show"`. For page-wide notifications, a namespaced event on `window` or `document` whose name and detail are documented by the package that owns it (`ddd.md` §7). Outlets are for a real parent-child composition; `application.getControllerForElementAndIdentifier()` in feature code is a service locator.

```js
// assets/controllers/coupon_controller.js
import { Controller } from '@hotwired/stimulus';
import { parseCouponCode } from '../coupon/coupon-code.js';      // pure, tested in Node
import { couponClient } from '../coupon/coupon-client.js';       // the port's adapter: fetch, timeout, parsing

export default class extends Controller {
  static values = { endpoint: String, csrf: String, invalid: String, failed: String };   // wording arrives translated
  static targets = ['input', 'message'];

  #requests = new AbortController();

  disconnect() { this.#requests.abort(); }

  async apply(event) {
    event.preventDefault();
    const code = parseCouponCode(this.inputTarget.value);
    if (!code.ok) { this.messageTarget.textContent = this.invalidValue; return; }

    try {
      const totals = await couponClient(this.endpointValue, this.csrfValue).apply(code.value, this.#requests.signal);
      this.dispatch('applied', { detail: { totals } });            // listeners own what happens next
    } catch (error) {
      if (!this.#requests.signal.aborted) this.messageTarget.textContent = this.failedValue;
    }
  }
}
```

**`fetch` inside a controller** is acceptable when the controller is the humble delivery for its *own* form or endpoint — posting the form it is attached to and showing the outcome — provided the URL and CSRF token come in as values, the request has a deadline and is aborted on `disconnect()`, the response is parsed, and failures map to wording from Twig. It becomes a finding when two controllers speak to the same endpoint (the protocol is duplicated — extract the client module), when the response drives decisions beyond display (the rule belongs in a pure module), or when any of those conditions is missing.

## 3. Wording comes from Twig

Translation happens on the server, where the translator, the locale and the translation domain of the owning package are:
- one string per value: `data-coupon-invalid-value="{{ 'coupon.invalid'|trans({}, 'checkout') }}"`;
- several strings as a JSON map value: `data-goal-editor-i18n-value="{{ { counts: 'reads.counts'|trans({}, 'goal_editor') }|json_encode }}"`, parsed in the controller;
- or `symfony/ux-translator` when the project uses it.

The controller holds no user-facing English — not even as a fallback — and toggling server-rendered variants (`hidden` on pre-translated elements) is a fine alternative to assembling text in JS.

## 4. Registration and ownership

- A **controller identifier is a resource** owned by the package that ships the controller; so are its value names, event names and the CSS it relies on (`clean-architecture.md` §8).
- In a modular monolith **each package registers its own assets**: its asset path in `framework.asset_mapper.paths`, its controller directory in `stimulus.controller_paths`, its importmap entries (a per-package fragment merged into the root `importmap.php`), its translation path. The package that owns the page shell owns the global bootstrap and the third-party controllers manifest (`controllers.json`). A controller registered by a different package than the one that ships it is a misplaced resource.
- **An unregistered controller fails silently** — every `data-action` on it does nothing, with no console error and no 404. The proof is a test that starts a real Stimulus application with the controller under its real identifier, or a real page in a browser — not a test that reads `controllers.json` or a YAML file.
- Rarely used controllers are loaded lazily (`/* stimulusFetch: 'lazy' */`), so every page does not pay for them.

## 5. Turbo (when installed)

Turbo makes the server the UI: Frames and Streams replace markup the server rendered. Business rules stay on the server; JS enhances what arrives. Page-level setup listens to `turbo:load`, not `DOMContentLoaded`; every controller is written to connect and disconnect repeatedly; `innerHTML` of a Turbo Stream's server-escaped HTML is the platform's mechanism, never a precedent for inserting data.

## 6. Live Components and Twig Components

- Their PHP classes are adapters too — humble, delegating to services (`architecture:clean-architecture-php`, `symfony:symfony-architecture-php`).
- A Live Component's template is re-rendered and morphed on every action, so **behavior belongs in Stimulus controllers attached to it, not in inline scripts** inside it; an element the component must not morph is marked `data-live-ignore`.
- A controller that needs the component uses its public API — `getComponent(element)` then `component.action('name', args)` — and never edits the component's DOM or props behind its back.
- Anonymous Twig Components with `{% props %}` are the page's component library: their props are their published language; keep consumer vocabulary out of shared ones.

## 7. React islands

When a feature needs a real client-side application (an editor, a canvas, a console), it ships as an **island** (`react.md` §10):
- a Stimulus controller is the host: `connect()` lazy-loads the bundle with `import()` and calls `mountX(this.element, props)`; `disconnect()` calls the returned `unmount()`;
- **props are values**: API base URL, CSRF token, locale, ids — plus callbacks for what the host owns (`navigate: (href) => window.location.assign(href)`);
- the island parses its props at mount, never reads the host's globals, never queries outside its element, and carries its own dictionaries for every locale the project ships;
- `symfony/ux-react` (`react_component('Name', props)`) is the packaged alternative; the props, serialized from Twig, are then the published language.

## 8. Security in the browser half

- **CSRF**: tokens arrive as values (or from one meta tag read by one module) and go out in a header; same-origin requests with `credentials: 'same-origin'`.
- **CSP**: an inline `<script>` carries the request's nonce — `nonce="{{ csp_nonce('script') }}"` with NelmioSecurityBundle, or the project's own nonce function; behavior never lives in inline event-handler attributes (`onclick="…"`) — it lives in controllers; Live Component templates carry no inline scripts.
- **Output**: `textContent` for data; the only HTML inserted is HTML the server rendered and escaped.
- **What a person reads** is never a raw server response, an exception message or an internal id.

## 9. Testing

- **Pure modules**: `node --test` or the project's runner, no DOM. Projects that keep zero JS dependencies bundle TypeScript tests with the esbuild they already have, or run them through Node's type stripping.
- **Controllers**: start a real `Application`, register the controller under its real identifier, render real markup (jsdom or happy-dom when available, otherwise a real browser), dispatch the user's event, assert what the user sees — this also proves registration.
- **Islands**: `mount(el, props)` and `unmount()` on real markup.
- **Flows**: Panther or Playwright against the running app.
- **Twig**: a render test asserting the attributes and values a controller needs is a render, and is allowed; a test that reads a template, stylesheet or script file as text is not (the engineering standards, §*Tests run code*).

## Detection recipes — candidates, not findings

ripgrep over the package's `assets/` (or `src/Resources/assets/`) and templates.

| Smell | Search | Cleared when |
|---|---|---|
| Network in a controller | `fetch\(` in `**/controllers/**` | the §2 conditions hold: own endpoint, values, deadline, abort on disconnect, parsed, mapped wording |
| Selector outside the element | `document\.querySelector\|document\.getElementById` in `**/controllers/**` | a page-level singleton the controller documents (a toast region) |
| Reaching into controllers | `getControllerForElementAndIdentifier` | never in feature code |
| No teardown | controllers with `addEventListener\|setInterval\|setTimeout\|observe\(` and no `disconnect()` | the resource is scoped to `this.element` and dies with it |
| Hard-coded wording | `textContent\s*=\s*['"\`][A-Z]\|alert\(\|confirm\(` in `**/controllers/**` | never — values from Twig |
| XSS sinks | `innerHTML\|insertAdjacentHTML` in `**/controllers/**` | server-escaped HTML the controller fetched from the project's own endpoint |
| Inline handlers | `\bon(click\|change\|submit\|input\|load)=` in `*.twig` | never |
| Inline scripts without nonce | `<script(?![^>]*nonce)` in `*.twig` (`-P`) | a JSON data block (`type="application/json"`) |
| Registration in the wrong package | `controller_paths\|asset_mapper` config naming another package's directory | the shell package's documented global manifest |

## Symfony frontend review checklist
- [ ] The project's pipeline is followed; TypeScript is type-checked by a gate that runs.
- [ ] Controllers are humble: values/targets are the contract, logic sits in pure modules, `disconnect()` undoes `connect()`.
- [ ] Network calls go through a client module, or meet the own-endpoint conditions; every request has a deadline and is aborted on disconnect.
- [ ] Controllers communicate through events and documented contracts, not through each other's instances or selectors outside their element.
- [ ] Wording is translated in Twig and arrives as values; no English in controllers.
- [ ] Each package registers its own assets, controllers, importmap entries and translations; unregistered controllers are caught by a test that runs them.
- [ ] Islands are mounted and unmounted by a host controller, receive everything as props, and stay inside their element.
- [ ] CSRF, CSP nonces, no inline handlers, no data through `innerHTML`, no raw errors shown.
- [ ] Pure modules, controllers, islands and flows are each tested at their level; no test reads a source file as text.

## 10. The core rules in Symfony's idiom

The core skill states each rule without a server framework. This section is where those rules meet Symfony's names.

### Where things sit

- **A module's zone** in a Symfony modular monolith: the package's `assets/` plus its registration (asset path, controller path, importmap fragment, translations). A Symfony package's controllers, styles, translations and asset registration ship in that package (§4).
- **Artifacts with one owner** include Stimulus identifiers and importmap entries.
- **Layers:** a pure module of a Stimulus package is domain code; Stimulus controllers are interface adapters (a Stimulus controller *binds* a use case, it is not one, and a controller instance never crosses inward); Stimulus and AssetMapper are frameworks and drivers. A domain or use-case module that imports Stimulus breaks the dependency rule.
- **The composition root** of a small widget can be a Stimulus controller's `connect()`.
- **Litmus:** replacing a Twig template with another server's must not touch use cases or the domain.

### Review and plan passes

- **The host pass** on Symfony: registration, values as the contract, wording from Twig (§2–§4).
- **Plan mode, delivery:** state the AssetMapper/Stimulus registration of every controller and entry point.
- **A React island in a Symfony page** needs both `react.md` and this skill.

### The humble controller, in Stimulus

The core's humble widget (`clean-architecture.md` §5), written as a Stimulus controller:
```js
// ✅ A humble Stimulus controller: parse values, delegate, render. No rules.
export default class extends Controller {
  static values = { threshold: Number, currency: String, remaining: String };
  static targets = ['bar', 'label'];

  update({ detail: { subtotalMinor } }) {
    const gap = freeShippingGap(subtotalMinor, this.thresholdValue);   // pure domain function
    this.barTarget.style.width = `${gap.progressPercent}%`;
    this.labelTarget.textContent = gap.reached ? '' : this.remainingValue.replace('%amount', format(gap.missingMinor, this.currencyValue));
  }
}
```

### Language-level rules on this stack

- **Framework-free browser code** here is a script in a Symfony page, a Stimulus controller's helpers, or the DOM half of a Stimulus controller.
- **Default exports:** a Stimulus controller is one of the default exports a framework requires.
- **Content inserted later:** a Turbo frame is mounted again with `mountAll(newContent)`.
- **Escaping:** the server prints config through Twig's auto-escaping plus `|json_encode` (§3).
- **Server-escaped markup:** a Turbo stream is markup the server already escaped (§5).
- **Events between parts of the page:** `this.dispatch('updated', { detail })`, prefixed with the controller identifier (§2), is Stimulus's form of the typed event contract (`ddd.md` §7).
- **Variants (OCP):** one controller per behavior, chosen by the markup's `data-controller`.
- **Injection (DIP):** values, outlets and the controller's `connect()`.
- **The DIP import recipe** (`solid.md`) adds `@hotwired/stimulus` to its list of framework imports.

### Islands, caching and TypeScript

- **Islands:** the host is a Stimulus controller (§7); it lazy-loads the bundle in `connect()` and unmounts in `disconnect()`, so Turbo navigation, Live Component re-renders and removed markup do not leak roots. Encore is one of the pipelines that build the bundle.
- **Full-page-cached HTML:** Symfony's HTTP cache and ESI share the HTML itself; private data arrives through ESI or a private endpoint, and the security rules of §8 apply.
- **The published language of the backend** is the endpoint's API resource, not the entity behind it.
- **TypeScript pipelines** (`typescript.md` §9):

  | Pipeline | What compiles `.ts` | What type-checks |
  |---|---|---|
  | Symfony AssetMapper | `sensiolabs/typescript-bundle` (swc binary), or an esbuild script whose output lands outside `assets/` | `tsc --noEmit` per `tsconfig` |
  | Symfony Webpack Encore | `enableTypeScriptLoader()` | `enableForkedTypeScriptTypesChecking()` or `tsc --noEmit` |

### References

- Stimulus Handbook — https://stimulus.hotwired.dev/handbook/introduction · Symfony AssetMapper — https://symfony.com/doc/current/frontend/asset_mapper.html

## Implementer checklist on this stack

Read with the core skill's `references/implementer-checklist.md`.

- Controllers are humble; values/targets are the contract; `disconnect()` undoes `connect()`; wording arrives translated from Twig; the package registers its own controllers, asset path and importmap entries; islands are mounted/unmounted by a host controller.
- Domain and use-case modules import no Stimulus.
