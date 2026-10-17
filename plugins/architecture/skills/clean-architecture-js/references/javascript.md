# JavaScript — modules, async, the DOM, Node

The language-level rules every host builds on: how a module is shaped, how async code stays correct, how framework-free browser code (a Magento widget, a theme-assets script, a Stimulus controller's helpers, a custom element) treats the DOM as an adapter, and how a Node service is composed. The host references (`react.md`, `magento2-frontend.md`, `symfony-frontend.md`) add their idioms on top; TypeScript specifics are in `typescript.md`.

---

## Part 1 — Modules

### 1. One charter per module
A file answers one question: `expression-tree.js` (the tree model and its serialization), `expression-value.js` (leaf-value shapes and validator predicates), `price-format.js` (turning minor units into display strings). A file whose honest name is `utils.js` has no charter — split it by concern (`solid.md` §SRP). Name files after what they hold, not after the framework category (`helpers/`, `services/`, `managers/`).

### 2. Explicit, named exports
Prefer named exports; a default export is for what a framework requires (a Stimulus controller, a React route module). A barrel `index.js` is a feature's **public surface**, deliberately small — not a re-export of every file, which hides cycles and defeats tree-shaking.

### 3. Importing does nothing
Module scope holds definitions only. No `fetch`, no `document.querySelector`, no listeners, no timers, no writes to `window` at import time. Only **entry points** start work — the page's bootstrap, a widget's mount, an island's `mount()`, a CLI's `main`. A module with top-level effects cannot be imported by a test without triggering them, runs its effect on every page that bundles it, and turns import order into behavior.

### 4. No globals, no load-order contracts
`window.Foo = …`, `if (window.fooInitialized) return;`, and an inline script that calls a function another file defined are the JS service locator and hidden sequencing. Each works until an optimizer defers, merges or lazy-loads one of the scripts (`magento2-frontend.md` §6). Pass what a module needs as arguments; keep the "already mounted" fact on the element (below), not on `window`. When classic scripts genuinely must share something, publish **one** namespaced object from one entry point and document it as that module's public surface.

### 5. Immutability by default
`const`; spread or `structuredClone` instead of mutating arguments; `Object.freeze` on exported config and lookup tables. A function that mutates its input has a second, hidden output.

### 6. Errors are values or typed throws, and never swallowed
- Domain failures are **expected outcomes**: return a result (`{ ok: false, error: 'format' }`) or throw a named `Error` subclass with a code. Never throw strings.
- `catch {}` and `.catch(() => {})` delete information. Catch where you can do something: map to a user message in the adapter, retry at the one layer that retries, or rethrow with context (`new Error('…', { cause })`).
- The text a person reads is chosen by the presentation layer; an `error.message` from a server or a library is logged, not shown.

### 7. Async discipline
- **Every network call can be cancelled and has a deadline**: `AbortSignal.timeout(ms)`, combined with the caller's signal through `AbortSignal.any([...])`. Unmount, disconnect and navigation abort.
- **Stale responses never win.** A search box aborts the previous request, or tags requests and ignores all but the latest.
- **No floating promises.** Every promise is awaited, returned, or explicitly handed to an error handler; an unhandled rejection is a bug report nobody receives.
- `Promise.allSettled` for independent work whose partial failure is acceptable; `Promise.all` only when one failure should fail the whole.
- Retries, backoff, caching and idempotency keys belong to adapters — `integration-patterns.md`.

### 8. Behavior by name → a registry
When config or markup names a behavior (`data-validator="postcode"`, a block type, a payment method), resolve it through a registry (`Map` or frozen object) with an explicit answer for an unknown name — never an `if`/`else` chain (`solid.md` §OCP).

---

## Part 2 — The DOM is an adapter

Framework-free browser code: a widget a Magento template renders through theme-assets, a script in a Symfony page, a custom element, the DOM half of a Stimulus controller.

### 9. Progressive enhancement
The server renders working HTML where it can — links link, forms submit — and JS enhances it. Initial state comes from the markup, not from a request the script fires on load.

### 10. A widget is: a root, config in, cleanup out
Split every widget the same way: **parse config** (adapter) → **pure logic** (domain module, testable in Node) → **render and bind** (adapter). Mounting is idempotent per element and returns a teardown.

```js
const mounted = new WeakSet();

export function mount(root) {
  if (mounted.has(root)) return () => {};                    // idempotent per element, no window flag
  mounted.add(root);

  const config = parseConfig(root);                           // strings from the markup → typed values
  const controller = new AbortController();
  const { signal } = controller;

  root.addEventListener('click', (event) => {                 // delegation on the root
    const button = event.target.closest('[data-action="apply"]');
    if (!button) return;
    const result = evaluate(readInput(root), config);         // pure, imported from a domain module
    renderResult(root, result, config.wording);               // textContent, never innerHTML with data
  }, { signal });

  return () => { controller.abort(); mounted.delete(root); };  // removes every listener at once
}

export function mountAll(scope = document) {
  scope.querySelectorAll('[data-coupon-box]').forEach(mount);
}
```

Start safely whatever the timing — a deferred, merged or lazy-loaded script may run long after `DOMContentLoaded`:

```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAll(), { once: true });
} else {
  mountAll();
}
```

Content inserted later (an AJAX block, a Turbo frame, Magento's `contentUpdated`) is handled by calling `mountAll(newContent)` again — which is why mounting must be idempotent.

### 11. Config comes from the markup, and is parsed
- `data-*` attributes are **strings**; `<script type="application/json">` content is text. Parse both, validate the shape, and fail loudly (a console error in development, a quiet no-op with a logged reason in production) — never proceed on `undefined`.
- The server escapes what it prints (`$escaper->escapeHtmlAttr(json)` in Magento, Twig's auto-escaping plus `|json_encode` in Symfony); the script never evaluates config as code.
- Wording arrives the same way — translated by the server — so the script holds no user-facing English.

### 12. Rendering without injection
`textContent` for text; `<template>` cloning or `createElement` for structure; attributes through `setAttribute`/`dataset`. `innerHTML`, `insertAdjacentHTML` and `outerHTML` only with markup the server already escaped (a Turbo stream, an HTML fragment from the project's own endpoint) — never with data. Building HTML by string concatenation is an XSS finding.

### 13. Lifecycle and cleanup
Every listener, observer, timer and in-flight request created by a widget ends when the widget ends: an `AbortController` whose `signal` is passed to every `addEventListener` and `fetch`; `disconnect()` on observers; `clearTimeout`. Leaks show up as double handlers after a partial page update, and as memory growth in long sessions.

### 14. Custom elements
`connectedCallback`/`disconnectedCallback` are the lifecycle; observed attributes are the element's published language; the class stays a humble adapter that delegates to pure modules.

### 15. Performance
Batch DOM reads before writes (no layout thrash in loops); `requestAnimationFrame` for visual updates; `IntersectionObserver` to initialize below-the-fold widgets when they approach the viewport; passive listeners for scroll and touch. Initializing everything on load is the default to question.

### 16. Accessibility
Keyboard reachable, focus managed when content appears or disappears, `aria-live` for asynchronous messages, native elements before ARIA re-implementations.

---

## Part 3 — Node

- **One composition root** (`main.js`/`main.ts`): read `process.env` once into a typed, parsed config object; build the adapters; hand them to the use cases. Nothing below reads `process.env`.
- `fs`, `child_process`, `net`, HTTP clients and database drivers sit behind ports owned by the use cases.
- No synchronous file or process calls on a request path; graceful shutdown through an `AbortSignal` passed down to everything long-running.
- Route handlers, CLI command handlers and queue consumers are humble: parse, delegate, map the result.

---

## Testing without a browser

- **Pure modules** run under the test runner the project has — `node --test`, Vitest, Jest — with no DOM at all. That they can is the proof that their dependencies point inward.
- **Legacy module formats** are still testable in Node: an AMD module behind a small `define` shim (a stubbed `underscore` at most), a classic IIFE script loaded into a `vm` context with the few globals it needs, or a factory that assigns `module.exports` when it exists.
- **DOM adapters** are driven with real markup — jsdom or happy-dom when the project has them, a real browser (Playwright) otherwise: mount, dispatch the user's event, assert what the user would see.
- **Never** a test that reads a script or template as text and asserts what it contains (the engineering standards in your user `CLAUDE.md`, §*Tests run code*).

---

## Detection recipes — candidates, not findings

ripgrep over the blast radius with `-g '*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}' -g '!**/node_modules/**' -g '!*.min.js'` and the test exclusions of `solid.md`. Each hit is read before it is graded.

| Smell | Search | Cleared when |
|---|---|---|
| Import-time side effects | `^(document\|window)\.\|^(fetch\|setInterval\|setTimeout)\(\|^\s*addEventListener\(` (`-P`, column 0 means module scope in most formatting) | the file is an entry point (bootstrap, mount script, `main`) |
| Globals / load order | `window\.\w+\s*=\|globalThis\.\w+\s*=\|window\.\w+Initialized` | one documented namespace written by one entry point |
| XSS sinks | `innerHTML\s*[+]?=\|insertAdjacentHTML\|outerHTML\s*=\|document\.write\(` | the markup is server-escaped HTML from the project's own endpoint, never data |
| String-built HTML | `` `<[a-z][^`]*\$\{ `` (`-P`) | every interpolation is escaped by a function the project owns and tests |
| Leaked listeners | files with `addEventListener\(` and neither `signal` nor `removeEventListener` | the element's lifetime equals the page's |
| Swallowed errors | `catch\s*(\(\w*\))?\s*\{\s*\}\|\.catch\(\(\)\s*=>\s*(\{\s*\}\|undefined\|null)\)` | never — at least log with context |
| Unparsed config | `JSON\.parse\(\|dataset\.\w+` in widget code | the value goes through a parser that checks its shape |
| No deadline | `fetch\(` in files without `signal` | the call goes through the project's API client, which sets one |
| Floating promises | `^\s*\w+(\.\w+)*\([^)]*\);\s*$` on async functions (read) | awaited, returned, or given a handler |

A search that returns nothing clears only the spelling it looked for.

## JavaScript review checklist
- [ ] Every touched module has one charter; no `utils`/`helpers`; named exports; small public surfaces.
- [ ] Importing a module does nothing; only entry points start work; no globals or load-order contracts.
- [ ] Errors are typed or result values, never swallowed; people see wording from the presentation layer, not `error.message`.
- [ ] Every request has a deadline and a cancellation; stale responses cannot overwrite fresh state; no floating promises.
- [ ] Widgets mount idempotently from parsed config, delegate to pure modules, render with `textContent`/templates, and clean up everything through one `AbortController`; they start correctly after `DOMContentLoaded` has passed.
- [ ] Node code reads `process.env` once in the composition root; I/O sits behind ports.
- [ ] Pure modules are tested in Node without a DOM; adapters are driven with real markup; no test reads source as text.
