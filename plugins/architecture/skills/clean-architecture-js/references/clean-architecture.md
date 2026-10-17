# Clean Architecture — the dependency rule in JavaScript and TypeScript

Uncle Bob's rules, applied to ES modules, React, the browser code of server-rendered pages and Node. `solid.md` has the class- and module-level mechanics, `ddd.md` the domain patterns, the host references the wiring.

## 1. The rule, restated for imports

> Source-code dependencies point **only inward**. An inner module never names an outer one — not in an `import`, not in a `require`, not in a `define([...])` list, not in a type.

Type-only imports count. `import type { AxiosResponse } from 'axios'` in a domain module ties the domain to a transport as surely as a runtime import; `verbatimModuleSyntax` erases the import from the bundle, not from the design.

The corollary that trips people up is the same as on the server: **control flow and source dependency can point in opposite directions.** A use case calls the network at runtime, yet the source dependency runs from the HTTP adapter *into* the use case, because the use case declares the interface (`CartGateway`) and the adapter implements it. That inversion is how every boundary below is crossed.

## 2. The four layers, on the client and in Node

### Domain
Types, value objects, invariants, state transitions, calculations. **No I/O and no framework**: no React, no DOM, no `fetch`, no storage, no `process`, no `Date.now()`, no `Math.random()` — time and randomness arrive as ports (`Clock`, `IdGenerator`) or as arguments. A reducer is domain code when it is a pure `(state, event) => state`.

### Use cases
One application action per function or small class: `addToCart`, `applyCoupon`, `saveDraft`. Orchestrates domain code and **declares the ports** it needs — gateway, storage, clock, notifier, analytics. No DOM, no JSX, no hooks. A React hook, a page controller or a framework view model *binds* a use case to a framework; it is not one.

### Interface adapters
Translation in both directions, **no business rules**. Components, custom hooks, page controllers, framework view models and components, DOM widgets, API clients implementing gateway ports, storage adapters, parsers (unknown → domain), mappers (domain → DTO), formatters (`Intl`), wording.

### Frameworks & drivers
React and its router, the page's component framework, the module loader, the bundler, the asset pipeline and renderer, the browser APIs, Node's `fs`/`net`/`process`. Configuration and third-party code; nothing inward may depend on it.

**In Node** the same four layers hold: the domain and use cases as above; adapters are HTTP route handlers, repository implementations, queue consumers, CLI parsers; drivers are the framework (Express, Fastify, Nest), the database client, the file system.

## 3. Ports and the composition root

A port is an `interface` (or a function type) **owned by the inner module**. The adapter implements it. One place — the **composition root** — builds the graph: `main.ts` in Node, the island's `mount()` function, the root component's provider, the widget's bootstrap script, a page controller's connect step for a small widget.

```ts
// ── cart/application/add-to-cart.ts  (inner — owns its port) ──────────────
import type { CartLine, Sku, Quantity } from '../domain/cart';

export interface CartGateway {
  addLine(sku: Sku, qty: Quantity, signal?: AbortSignal): Promise<readonly CartLine[]>;
}

export const addToCart = (cart: CartGateway) =>
  (sku: Sku, qty: Quantity, signal?: AbortSignal) => cart.addLine(sku, qty, signal);

// ── cart/adapters/http-cart-gateway.ts  (outer — depends inward) ───────────
import type { CartGateway } from '../application/add-to-cart';
import { parseCartLines } from './cart-dto';

export const httpCartGateway = (baseUrl: string, csrf: string): CartGateway => ({
  async addLine(sku, qty, signal) {
    const res = await fetch(`${baseUrl}/cart/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ sku, qty }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new CartRejected(res.status);
    return parseCartLines(await res.json());        // unknown → domain, never `as`
  },
});

// ── cart/mount.ts  (composition root: the only place that knows both) ──────
const add = addToCart(httpCartGateway(config.baseUrl, config.csrfToken));
```

No DI container is needed: **parameters and factories are dependency injection.** The anti-pattern is the JS service locator — `window.app.services.get('cart')`, a module-level singleton imported from everywhere, `require()` at call time to dodge a cycle. It is a server container's service locator in another language: dependencies hidden, tests forced to patch modules.

## 4. What crosses a boundary — parse at the edge

Only **inner-owned shapes** cross inward: domain types, value objects, DTOs the use case declares. Never raw JSON, a `Response`, an `Event`, an `HTMLElement`, a React element, a framework observable, a page controller instance.

Everything from outside the process is `unknown` until **parsed**: API responses, `JSON.parse`, `data-*` attributes (always strings), `<script type="application/json">` config, `localStorage`, `postMessage`, the URL, `process.env`. The parser lives in the adapter and returns a domain type or a typed failure. Details and parser choices: `typescript.md` §2.

```ts
// ❌ The backend's schema becomes the UI's contract; a renamed field fails three screens later
const order = (await res.json()) as Order;

// ✅ The adapter owns the DTO shape and the translation; the domain never sees the wire format
const order: Order = toOrder(parseOrderDto(await res.json()));
```

Money travels as integer minor units plus a currency, never a float. Dates arrive as strings and become a value (a `Date`, a `Temporal` type, a branded ISO string) at the edge.

## 5. Humble objects at the edges

Code that is hard to test — components, controllers, templates, DOM bindings, route handlers — stays **humble**: it translates input, calls a use case, renders output. Everything worth testing moves inward, where a plain Node test can reach it.

```js
// ✅ A humble widget: parse its config, delegate, render. No rules.
export function mountFreeShippingBar(root, config, signal) {   // config parsed from the markup; signal tears it down
  const bar = root.querySelector('[data-role="bar"]');
  const label = root.querySelector('[data-role="label"]');

  document.addEventListener('cart:updated', ({ detail: { subtotalMinor } }) => {
    const gap = freeShippingGap(subtotalMinor, config.threshold);       // pure domain function
    bar.style.width = `${gap.progressPercent}%`;
    label.textContent = gap.reached ? '' : config.remaining.replace('%amount', format(gap.missingMinor, config.currency));
  }, { signal });
}
```
The frontend stack skill shows the same widget written as its framework's controller.

## 6. Import side effects and entry points

**Importing a module must not do anything** except define things. No `fetch`, no `document.querySelector`, no `addEventListener`, no `setInterval`, no mutation of a global at module scope. Only **entry points** — the page's bootstrap, the island's mount, a CLI's `main` — start work. A module with top-level effects cannot be imported by a test without triggering them, cannot be tree-shaken, and runs its effect on every page that bundles it.

## 7. Screaming structure

The top level names the product's capabilities, not the framework's categories.

```
# ✅ Screams the domain                       # ❌ Screams the framework
src/features/cart/                            src/components/
  domain/  application/  adapters/  ui/       src/hooks/
  index.ts          (public surface)          src/utils/
src/features/checkout/                        src/services/
src/shared/          (kernel: no features)    src/store/
src/app/             (composition, routing)
```

Feature-Sliced Design, "features/" folders and a server framework's module-per-capability all express the same idea. Pick the project's convention; do not impose four folders on a feature that is one component and one parser.

## 8. The module graph is an onion too

The rings of `clean-architecture-php/references/onion-modules.md` hold for JS unchanged: **kernel/shared → capability → feature → bridges**, every edge inward.

- **A feature exports one public surface** (`index.ts`, a package's `exports` map, a `mount(el, props)` function, a documented event). Everything else is private; a deep import (`../../checkout/components/StepTwo`) is a boundary violation.
- **Same-ring features never import each other.** They compose in the app shell or page, exchange data through props and events, or meet in a bridge one ring out.
- **Artifacts are dependencies.** The ownership litmus test applies to everything a script must know by name: CSS classes and DOM ids it queries, `data-*` attribute names, custom event names, storage keys, route names, module-loader ids and override targets, asset ids, controller identifiers, import-map entries, translation keys. Each belongs to exactly one module; a sibling's vocabulary in your code couples you with zero imports.
- **Resources ship with their owner.** A server module's scripts, styles, templates, translations and asset registration in that module (the stack skill says where each lives); a feature's dictionary files beside its components.

## 9. The second consumer and the inward move

When a concept one feature owns turns out to be needed by another, the three options are the same as on the server: depend sideways (❌), copy it (❌ — the copies drift), or **move it one ring inward and have both depend on it** (✅). A shared `price-format.ts` copied into three widgets, three `useDebounce` hooks with different semantics, the same endpoint's DTO typed twice — each is the refactor that did not happen. Promotion is a re-modeling, not a copy: the promoted module must be explainable without naming its first consumer (`onion-modules.md` §5 in the PHP skill).

With provably one consumer, keep it local — a speculative `shared/` is over-abstraction.

## 10. Enforcing boundaries mechanically

Discipline decays; enforce it in the build.

- **`no-restricted-imports`** / **`import-x/no-restricted-paths`** zones — the cheapest gate: "nothing under `domain/` imports `react`, `../adapters`, or `window`-touching modules".
- **`eslint-plugin-boundaries`** — element types (domain, application, adapters, ui, feature) and the allowed edges between them.
- **dependency-cruiser** — rules over the real import graph: `no-circular`, feature isolation, "domain depends on nothing outside domain", `not-to-dev-dep`, orphans.

```js
// .dependency-cruiser.cjs (illustrative)
forbidden: [
  { name: 'domain-is-pure', from: { path: 'src/features/[^/]+/domain' },
    to: { pathNot: 'src/features/[^/]+/domain|src/shared/domain' } },
  { name: 'no-cross-feature-deep-imports', from: { path: 'src/features/([^/]+)/' },
    to: { path: 'src/features/(?!$1)[^/]+/(?!index\\.ts$)' } },
  { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
],
```

- **TypeScript project references** (`composite` + `references`) — a domain project that physically cannot see the app project.
- **`package.json` `exports`** — the published surface of a workspace package; everything not exported is unreachable.
- **`knip`** — unused exports and files, which is how a public surface stays small.

A project that runs none of these still has the rule; say in the review which gate would have caught the violation, and do not invent a gate the project does not run.

## Review checklist

- [ ] No domain or use-case module imports a framework, the DOM, `fetch`, storage, `process`, or an adapter — types included.
- [ ] Every cross-boundary dependency is an interface owned by the inner side, wired in one composition root; no service locator, no module-level singleton imported across layers.
- [ ] Untrusted input is parsed at the edge into inner-owned types; no raw JSON, DOM node, event or framework object crosses inward.
- [ ] Components, controllers, widgets and templates are humble; rules live in use cases and domain modules a Node test can reach.
- [ ] Importing a module has no side effects; only entry points start work.
- [ ] Features expose one public surface; no deep imports across features; artifacts (CSS hooks, attributes, events, keys, ids, asset ids) have one owner.
- [ ] Boundaries are enforced by the project's tooling where it has any; each abstraction protects a real axis of change.
