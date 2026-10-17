---
name: clean-architecture-js
description: Review and plan JavaScript and TypeScript — framework-free browser modules, TypeScript, React, Node — with Robert C. Martin's Clean Architecture, the onion at module altitude, SOLID and Domain-Driven Design, including the browser code a server-rendered PHP application ships - vanilla scripts and styles (inline or external, async/defer, preload, fetch priority), the page's components and controllers, React islands mounted into a server-rendered page; a framework's own front-end idiom comes from its stack skill. Use when reviewing or planning components, hooks, controllers, stores, API clients, TypeScript types and module boundaries; whenever a change adds or edits .js/.mjs/.cjs/.ts/.tsx/.jsx source; when deciding how a template loads a script or stylesheet; when refactoring toward pure domain modules, ports and adapters, typed boundaries (parse, don't cast) and strategy registries instead of switch-on-type. Also covers the network from the client - timeouts and aborts, stale responses, retries and idempotency keys, optimistic updates, cache keys, private data in full-page-cached HTML.
---

# Clean Architecture for JavaScript and TypeScript

Analyze, **review**, and **plan** JS/TS through the four lenses of `architecture:clean-architecture-php` — **Clean Architecture**, the **onion at module altitude**, **SOLID**, **DDD** — in the idiom of the JavaScript ecosystem: framework-free browser modules, **TypeScript**, **React**, Node, and the browser code a server-rendered application ships.

The sibling skill `architecture:clean-architecture-php` owns the server side of a PHP module — the object that builds a widget's config, the template's PHP, the controller that answers the fetch. This skill owns everything that runs in the browser or in Node. A change that touches both loads both.

The one rule everything else serves: **an `import` is a source dependency, and it points inward.** The DOM, the network, storage, the framework (React, the page's component framework, the module loader), the bundler and the host page are details. The rules of the product must not know them.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Frameworks & drivers   React · component frameworks · module loaders    │
│                        the DOM · fetch · storage · the host page        │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Interface adapters  components · controllers · custom hooks      │   │
│  │                     API clients · storage adapters · parsers     │   │
│  │  ┌───────────────────────────────────────────────────────────┐   │   │
│  │  │ Use cases   plain functions and classes orchestrating     │   │   │
│  │  │             through ports they own — no DOM, no JSX       │   │   │
│  │  │  ┌────────────────────────────────────────────────────┐   │   │   │
│  │  │  │ Domain   types · value objects · rules             │   │   │   │
│  │  │  │          state machines · pure functions           │   │   │   │
│  │  │  └────────────────────────────────────────────────────┘   │   │   │
│  │  └───────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                        ← imports point inward only
```

## What is different on the client

- **The server owns the invariants.** Browser code is untrusted and can be skipped, so a rule enforced only in JS is not enforced. The client mirrors a rule for feedback (a hint, a disabled button) and the server checks it again. A price, a tax, a stock level or a permission is **displayed** in the browser, never **decided** there. When the client must compute something (the gap to free shipping), its inputs come from the server and the computation is one pure function with tests.
- **Time is a dependency.** A request can arrive late, twice, or never; a component unmounts mid-flight; a user clicks twice. Cancellation, stale-response guards and idempotency are design, not polish (`references/integration-patterns.md`).
- **The page often already exists.** A server-rendered application renders the HTML, often behind a full-page cache, and JS enhances it. Config and translated wording arrive in the markup; the initial state is the server's; whatever is printed into a cached page is shared by every visitor who gets that page.
- **Every abstraction ships to the user.** Bytes and parse time are costs the server never pays. A port earns its place by protecting a real axis of change or a test seam, not by symmetry with the server.

## The module graph is an onion too

Features, packages and modules form rings exactly as in `architecture:clean-architecture-php` (`onion-modules.md` there). Full treatment for JS, with boundary tooling: `references/clean-architecture.md` §8–9. In brief:

1. **Each module owns one zone, totally.** Components, controllers, state, API client, types, styles, wording, tests. In a server-rendered application: the module's asset directory, its templates and its asset registration (the stack skill says where each lives). SPA: `src/features/<name>/`.
2. **One public surface per module.** An `index.ts`, a package `exports` map, a `mount(el, props)` function, a documented custom event. A deep import into another feature is the JS equivalent of `use`-ing a neighbour's `Model\`.
3. **Same-ring features never import each other.** They meet in the app shell, the page, or a bridge, or they talk through props and events.
4. **Artifacts are dependencies.** A CSS class a script hooks into, a `data-*` attribute name, a custom event name, a storage key, a controller identifier, a module-loader id, an asset id — each has exactly one owner. A script that queries the theme's `.product-info-main` is coupled to the theme with zero imports. Hook into `data-*` attributes the owner publishes.

## Two modes

- **Review mode** — assess code or a diff against the rules → a *Review Report*.
- **Plan mode** — design a feature or a refactor from the domain outward → an *Implementation Plan*.

## When to use

- "Review this component / controller / hook / widget for clean architecture or SOLID." · "Where does this logic belong — component, hook, store, or a module?"
- "Plan this feature in React / TypeScript / a server-rendered page." · "How should this template load its script or stylesheet?"
- "Type this boundary." · "This API response is cast with `as`." · "There are `any`s everywhere."
- **Any tech-debt fix in JS/TS, of any size** (the engineering standards, §*Architecture and tech debt*): name the smell in Review mode, design the fix in Plan mode scaled to its size, then edit. A hook refuses JS/TS source edits until this skill and its references are loaded in the session.

## Reference map — load what the task needs

Read `SKILL.md` fully, then the references the task touches. Each is self-contained with good-vs-bad code and detection recipes.

**Loading this file alone is not loading the skill.** Mandatory before the first edit:
- **`solid.md`** and **`javascript.md`** for any code change — the principles, and the language itself (modules, async, the DOM, Node);
- the **host reference**: `react.md` in a React codebase and for any `.jsx`/`.tsx`; on a project with a stack plugin, that plugin's frontend skill (*The stack skill*, below). A React island in a server-rendered page needs both;
- **`typescript.md`** for any `.ts`, `.tsx`, `.mts` or `.cts` file;
- **`ddd.md`** when the change touches a domain module (`domain/`, `model/`, `entities/`, a value object, a state machine);
- `clean-architecture.md` when a boundary, a port, a feature's placement or a cross-feature import is in play;
- `integration-patterns.md` when the change calls the network, caches a response, retries, works offline, or prints data into full-page-cached HTML.

The guard hook `plan_skill_gate.py` refuses a JS/TS source edit until the session shows those reads, and a plan write that orders JS/TS work until it shows this file and the host reference (`javascript.md` when there is no host); the denial names what is missing.

**The stack skill.** This skill names no server framework. A framework's front-end idiom — how its pages load scripts, how a template hands config and wording to a script, what lands in its cached HTML, where a module registers its assets, which spellings the detection recipes look for — ships as a **frontend stack skill** in that framework's plugin. On a project with a stack plugin, load that plugin's frontend skill as well (`/plugin` lists them; the gate's denial names it). With none, apply the rules in the stack's idiom and say so. Wherever this skill says "the stack skill", it means that one.

| File | Load it when the task involves… |
|------|--------------------------------|
| `references/clean-architecture.md` | The dependency rule for imports, the four layers on the client and in Node, ports and the composition root, parsing at the edge, humble components, screaming structure, the module graph as rings, boundary enforcement (`no-restricted-imports`, `eslint-plugin-boundaries`, dependency-cruiser, TS project references, `exports`) |
| `references/solid.md` | SRP/OCP/LSP/ISP/DIP in JS/TS — `utils.js` grab-bags, god components and hooks, registries and exhaustive handler maps instead of `switch`, narrow props, injected ports; detection recipes |
| `references/ddd.md` | Ubiquitous language in components, features as bounded contexts, the anti-corruption layer over API DTOs, branded value objects, unions and state machines that make illegal states unrepresentable, client-side domain events, what the client must never decide |
| `references/javascript.md` | Module charter and import side effects, globals, errors, async discipline, registries; the DOM as an adapter — progressive enhancement, mounting, delegation, cleanup, config from markup, XSS; Node services; testing without a browser |
| `references/typescript.md` | Compiler settings as the floor, `unknown` and parsers at the edge, `any`/`as`/`!`, discriminated unions and mapped handler maps, branded types, ports as interfaces, erasable syntax, declaration files for module-loader modules and globals, TS in esbuild/Vite and server-side asset pipelines |
| `references/react.md` | Components as adapters, hooks binding use cases, the state taxonomy (server/URL/form/UI/global), effects discipline, context as DI, variant registries, islands mounted into a server page, Next.js server/client boundary, testing |
| `references/integration-patterns.md` | The network from the client: timeouts and cancellation, stale responses, retries only for repeatable calls, idempotency keys, optimistic updates, cache keys, full-page-cached HTML, realtime reconnects, errors shown to people |
| `references/implementer-checklist.md` | Implementing one already-planned task (the `pipeline:feature-implementer` agent): the rules to honor while writing code, without the review and plan formats — read it *instead of* this file |
| the frontend stack skill (its own plugin) | The framework's delivery mechanisms and render modes, config and wording from its templates, its cached HTML and private data, asset registration and ownership, its TypeScript builds, detection recipes in its spelling, and the stack lines of the implementer checklist |

## The layers, mapped

| Layer | Owns | Looks like |
|-------|------|-----------|
| **Domain** | Types, value objects, invariants, state transitions, calculations — no I/O, no framework, no clock, no randomness | `cart/domain/*.ts`; a pure module beside the widget or controller that uses it |
| **Use cases** | One application action (`addToCart`, `applyCoupon`), orchestrating domain code through **ports it owns** (gateway, storage, clock, analytics) | Plain functions or small classes taking their ports as parameters. A React hook is *not* a use case — it binds one |
| **Interface adapters** | Translation both ways, no business rules | Components, custom hooks, page controllers, framework view models, DOM widgets, API clients implementing ports, parsers and mappers, formatters and wording |
| **Frameworks & drivers** | The details | React, the router, the page's component framework, the module loader, the bundler, the asset pipeline and renderer, `fetch`, `localStorage`, Node's `fs` and `process` |

**Litmus test for any import:** if replacing something outer (React → Preact, `fetch` → a mock, one server's templates → another's, a component framework → vanilla) forces edits inside use cases or the domain, the rule is broken. Fix it by inversion: the inner module owns the interface, the outer one implements it, the composition root wires them.

---

## Mode A — Review workflow

1. **Map files to layers and modules to rings.** Which layer does each file sit in, and which should own each responsibility? Place every touched feature or package on its ring.
2. **Trace dependencies — imports and the couplings that are not imports.** Follow every `import`/`require`/`define` dependency across a boundary; then the invisible ones: `window.*` globals, CSS classes and DOM ids a script queries, event names, storage keys, asset ids, controller identifiers. Each outward edge is a candidate violation.
3. **Inspect what crosses a boundary.** Raw JSON reaching a component, a DOM node or an `Event` reaching a use case, a React element or a framework observable leaving the adapter layer, a backend DTO used as the UI model. Expect parsed domain values and DTOs owned by the inner side (`typescript.md` §2, `ddd.md` §2).
4. **Check the model.** Boolean soup (`isLoading && !error && data`) where a union belongs; rules inside components; a server rule re-implemented in the browser as the only check.
5. **Run the SOLID pass** (`solid.md`), DIP first, starting from the **detection recipes** at the end of `solid.md`, `javascript.md`, `typescript.md`, the host reference and `integration-patterns.md`. A hit is read before it is graded; a finding quotes the line and names the rule it breaks.
6. **Run the host pass.** React: effects, state placement, cache keys (`react.md`). A server-rendered host: how the page loads the code, what is escaped, what lands in cached HTML, registration, config and wording from the template — the stack skill's pass when one is loaded.
7. **Weigh pragmatism** (below) before recommending an abstraction.
8. **Report** in the format below.

### Review Report format

```markdown
# Clean Architecture Review — <scope>

## Summary
- Overall: [Solid / Needs work / Critical]
- 2–4 sentences: the biggest structural risk and the biggest strength.

## Dependency rule
- Violations (file:line → which inner module imports or reaches which outer detail).
- The inversion that fixes each (the port, where it lives, where it is wired).

## Modules & ownership
- Ring placement of each touched feature/package; any edge not pointing inward.
- Artifacts owned by the wrong module (CSS hooks, data attributes, event names, storage keys, asset ids, controller identifiers, wording).

## Types & boundaries
- Where untrusted data enters (API, JSON, data attributes, storage, URL) and whether it is parsed or cast.
- `any` / `as` / `!` / suppressions in the touched files.

## State & async
- State placement (server / URL / form / UI / global); illegal states representable?
- Cancellation, stale responses, retries, double submits, cleanup.

## Delivery & performance
- How the host loads the code (render mode, defer, preload, entry points, code splitting); what lands in cached HTML; CSP.

## SOLID
- Per principle: PASS, or the specific violation.

## Recommendations
1. High — correctness, security or coupling that will bite soon.
2. Medium — structural improvements.
3. Low / optional — only if it earns its cost.
```

---

## Mode B — Planning & design workflow

Design **from the domain outward**, so the plan honors the dependency rule by construction. Produce an Implementation Plan; do not write production code in this mode.

1. **Frame it.** Restate the goal in the ubiquitous language. Name the feature/module and its ring. Separate the rules the **server** owns from what the client only **mirrors** or **displays**. If the change needs a concept a sibling owns, plan the inward move first (`clean-architecture.md` §9).
2. **Scope the blast radius, then remediate its tech debt** — mandatory, below.
3. **Model the domain.** Types, value objects, the unions or state machine that make illegal states unrepresentable; where each piece of untrusted input is parsed and into what.
4. **Define use cases and ports.** Each action as a plain function or class; the ports it owns (gateway, storage, clock, notifier, analytics); the DTOs in and out.
5. **Choose adapters.** The API client (timeouts, cancellation, error mapping), storage adapters, parsers, formatters and wording — and where each lives.
6. **Delivery last.** Components, controllers, widgets, templates — humble. State how the page loads the code: the render mode and load strategy and why, the controller or entry registration, the island's `mount(el, props)` contract, the route-level code split.
7. **Wiring and enforcement.** The composition root, the registries, controller/entry registration, the build entry, the boundary lint rules.
8. **Tests.** Domain and use cases in plain Node against fakes; adapters against fakes of the network; one test that mounts the real thing from real markup or renders the real component; end-to-end only for flows.
9. **Pragmatism pass.** Cut every abstraction that protects nothing. Log debt outside the blast radius, don't fix it.

### In-scope tech debt is fixed, not deferred

The rule is global (the engineering standards, §*Architecture and tech debt*) and binds JS/TS exactly as it binds PHP; the guard hook `debt_guard.py` refuses an edit that parks debt behind a `TODO` or silences it with `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `biome-ignore` and their kin.

> **Blast radius = the files you touch + their direct collaborators in the same module** — one hop: the modules they import and the modules that import them. It widens to the whole module only when the module is small (about fifteen files) or the change already touches most of it. Debt outside that set is logged (*Logged for later* plus one line on the vault's TODO board), never force-fixed.

Audit the blast radius for:
- **Dependency-rule violations** — a domain or use-case module importing React, a store, `fetch`, `window`, `document`, storage, `process.env`, jQuery, the page's component framework or module loader → introduce a port.
- **Logic stranded in adapters** — business rules, calculations or wording decisions inside components, controllers, templates or framework view models.
- **God modules** — `utils.js` / `helpers.ts` / `common.js` grab-bags, 500-line components, a `useEverything` hook.
- **`switch`/`if`-`else` dispatch on a type or kind** → a registry (open set) or an exhaustive handler map (closed set) — `solid.md` §OCP.
- **Untyped or cast boundaries** — `any`, `as SomeDto` over parsed JSON, `!` on values never checked, `JSON.parse` results used raw.
- **Leaky boundaries** — backend DTOs used as the UI model; framework objects crossing into use cases.
- **Globals and load-order coupling** — `window.Foo =` namespaces, init flags on `window`, scripts that only work if another ran first.
- **Sideways naming and hooks** — a comment, identifier, CSS/`data-*` hook, event name or opt-out attribute naming a module, vendor or product the module does not declare (`package.json` dependencies, `composer.json` require, the framework's module manifest).
- **Async hazards** — no timeout or abort, stale responses overwriting fresh ones, listeners and timers without cleanup, floating promises, swallowed errors.
- **Wording in the wrong layer** — hard-coded user-facing strings in pure modules, or strings that bypass the project's translation mechanism.
- **Missing tests** for code you change; tests that assert a source file's text; suppressed lint or type errors in the touched files.

Rules of engagement — same as the PHP skill: every remediation ships with its own tests and keeps the gates green; a large fix becomes ordered tasks inside the same plan; never sprawl beyond the blast radius — a fix that forces a change in a neighbouring module is an **open question**.

### Implementation Plan format

```markdown
# Implementation Plan — <feature>

## Context & language
- Module / feature: <where it lives, its ring, and why>
- Ubiquitous language: <term → meaning>
- Rules: <which the server owns · which the client mirrors · which it only displays>

## Tech-debt in scope (must fix, with tests)
- Blast radius: <files touched> · <direct collaborators> · <whole module only if small — say why>
- Debt → remediation: <file>: <smell> → <fix>
- Logged for later (outside blast radius): <item → why deferred>

## Domain model
- Types / value objects / unions / state machine — what each makes impossible.
- Untrusted input → parser → domain type (for each edge).

## Use cases & ports
- <useCase>(ports)(input) → output; the ports it owns.

## Adapters
- <Adapter> implements <Port> — transport, timeout/abort, error mapping, location.

## Delivery
- Components / controllers / widgets / templates — humble.
- How the page loads it: <render mode + load strategy + preload, or entry/controller registration, or island mount contract, or code split>.

## Dependency rule check
- One line per boundary: X imports Y (inward). No inner → outer.

## Wiring & enforcement
- Composition root, registries, registration, build entries, boundary lint.

## Tests
- Domain / use case (Node, fakes) · adapter (fake network) · mount or render from real markup · e2e for flows.

## Risks, tradeoffs & open questions
- Abstractions deliberately NOT added (and why). Decisions needing a human.
```

---

## Pragmatism — clean, not ceremonial

- **Parameters are dependency injection.** A function that takes its gateway as an argument needs no container. A React context that provides the API client is enough DI for an app; a DI framework in the browser is almost always ceremony.
- **A thirty-line widget that toggles a class needs no ports.** It needs a root element, config in, cleanup out. The layers appear when there is logic worth testing without a browser, or a second consumer.
- **Wrap `fetch` once, at the port.** One API client per backend, parsing and mapping errors; not a `fetch` wrapper around a wrapper around a hook.
- **Generic `Repository<T>` and `BaseService` classes** hide the differences that matter. Name the port after what the use case needs.
- **Would the bug escape today?** If the seam protects against a 0.1% future, drop it. If renaming an outer thing does not touch inner ones, the boundary earns its keep.

### Common JS/TS pitfalls this skill flags
1. **The fat component** — fetch, parsing, rules, formatting and wording in one file; everything tested through the DOM or not at all.
2. **`useEffect` as a data layer and a calculator** — fetching without abort or race guard; deriving state that should be computed during render.
3. **Cast boundaries** — `await res.json() as Order`; the backend's schema becomes the UI's contract, and a renamed field fails at runtime three screens later.
4. **`utils.ts`** — the JS Helper class: unrelated exports accreting in one file that everything imports.
5. **`switch (block.type)` in JSX or in a widget** — every new variant edits the same file and cannot come from another module. A registry, or an exhaustive handler map.
6. **Globals and load order** — `window.App.cart = …`, `if (window.fooInitialized) return;`, an inline call to a function another script defines.
7. **Wording and rules hard-coded in shared components** — a reusable component that knows one consumer's attribute codes or English copy.
8. **Private data in cached HTML** — a customer name, a cart count or a group price printed into a full-page-cached template, then "fixed" in JS.
9. **Script-loading by habit** — every script inline, or every script preloaded, or synchronous by default (the stack skill's loading rules).
10. **Suppressed and loosened checks** — `eslint-disable`, `@ts-expect-error`, `strict: false`, `skipLibCheck` used to silence real errors.

### Quick DIP check (the heart of every boundary)

```ts
// ❌ The use case reaches for concrete details: the network, the clock, the page
export async function applyCoupon(code: string) {
  const res = await fetch(`/api/cart/coupons/${code}`, { method: 'PUT' });           // transport
  document.querySelector('.cart-summary')!.classList.add('updated');                // the DOM
  localStorage.setItem('coupon-applied-at', String(Date.now()));                    // storage + clock
  return res.ok;
}

// ✅ The use case owns its ports; adapters implement them; the composition root wires them
export interface CouponGateway { apply(code: CouponCode): Promise<CartTotals>; }
export interface Clock { now(): Date; }

export const applyCoupon = (deps: { coupons: CouponGateway; clock: Clock }) =>
  async (code: CouponCode): Promise<AppliedCoupon> => {
    const totals = await deps.coupons.apply(code);              // port, not fetch
    return { code, totals, appliedAt: deps.clock.now() };      // the adapter renders it
  };
```

## References
- Robert C. Martin, *The Clean Architecture* — https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- Jeffrey Palermo, *The Onion Architecture* — https://jeffreypalermo.com/2008/07/the-onion-architecture-part-1/
- Alexis King, *Parse, don't validate* — https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
- React, *You Might Not Need an Effect* — https://react.dev/learn/you-might-not-need-an-effect
- dependency-cruiser — https://github.com/sverweij/dependency-cruiser · eslint-plugin-boundaries — https://github.com/javierbrea/eslint-plugin-boundaries
