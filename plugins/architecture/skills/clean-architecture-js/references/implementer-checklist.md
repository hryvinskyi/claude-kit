# Implementer checklist — clean-architecture-js, cut for one planned task

Read this before writing JavaScript or TypeScript that creates or moves a seam: a module another
feature will import, a port, a component or controller other code composes, a registry, a
public surface (`index.ts`, `mount()`, an event), a new entry point or registration. It is the
rubric's rules without its review and planning formats; those live in `SKILL.md` and are not
needed to implement a task that has already been planned and reviewed. `solid.md`,
`javascript.md`, the host reference and — for TypeScript — `typescript.md` are still read.

## Dependency rule

- Domain and use-case modules import no framework (React, Stimulus, Knockout, Alpine, jQuery,
  `mage/*`), no DOM or `window`, no `fetch`/storage/`process.env`, no adapter — types included.
- Need the network, storage, the clock or randomness? The use case owns a port; an adapter
  implements it; the composition root (mount function, root provider, bootstrap, `main`) wires it.
- No service locator: no `window.app.get(…)`, no module-level client singleton imported by hooks
  or controllers.

## What crosses a boundary

- Untrusted input (API bodies, `JSON.parse`, `data-*`, JSON script blocks, storage, URL, env) is
  `unknown` until a parser returns a domain type. No `as` over parsed JSON, no `any`, no `!` on
  values you did not check.
- Components and controllers receive parsed values and callbacks, not raw DTOs; framework objects
  (events, elements, observables) never reach a use case.

## Behavior selection

- No `switch` / `else if` / `instanceof` ladder choosing behavior by a type or kind. Open set →
  registry with an explicit unknown-key answer; closed set → exhaustive handler map typed over the
  union. Lookups for value → value and guard clauses are fine.

## Where logic lives

- Rules and calculations in pure modules a Node test can import; components, controllers,
  widgets, Knockout view models and Alpine objects only bind, render and choose wording.
- The client decides only what it owns; it mirrors server rules for feedback and displays server
  values — it never becomes their source of truth.
- No new `utils`/`helpers` file; one charter per module; importing a module does nothing.

## Ownership

- Everything for the feature lives in its module: scripts, styles, templates, wording/dictionaries,
  registrations. Hook into `data-*` attributes and events the owner publishes, not a theme's CSS
  classes or a neighbour's DOM.
- Name only what you depend on: no comment, identifier, attribute or event names a module, vendor
  or product outside the module's declared dependencies (`package.json`, `composer.json`,
  `module.xml`). A neighbour's quirk is described as a situation; its name goes to your report.
- Need a concept a sibling owns? Scope-check stop — the plan owns the inward move.

## Async and the DOM

- Every request: a deadline (`AbortSignal.timeout`) and a cancellation tied to the component's or
  controller's lifetime; stale responses dropped; retries only for repeatable calls, in one layer;
  writes that must happen once carry an idempotency key.
- Widgets mount idempotently per element, start correctly after `DOMContentLoaded`, render with
  `textContent`/templates (never data through `innerHTML`), and tear everything down through one
  `AbortController`.
- Errors are typed or result values, never swallowed; people see mapped, translated wording.

## Host specifics

- **Magento**: follow the area's delivery mechanism. theme-assets — get the renderer through a
  typed argument, the view-model registry or the ViewModel; inline only small critical code;
  external + defer by default; preload only what first paint needs; the module declares
  `hryvinskyi/magento2-theme-assets` and every module whose fileId it renders. Config and wording
  printed escaped (`JsonHexTag`, `escapeHtmlAttr`), parsed by the script; nothing private in
  cacheable output; no timing assumptions the project's script optimizers break.
- **Symfony**: controllers are humble; values/targets are the contract; `disconnect()` undoes
  `connect()`; wording arrives translated from Twig; the package registers its own controllers,
  asset path and importmap entries; islands are mounted/unmounted by a host controller.
- **React**: hooks bind use cases; nothing derived stored and synced by an effect; effects clean
  up and are never silenced; ports through context; variants through component maps.
- **TypeScript**: `strict` and the project's flags stay on; only erasable syntax; `import type`
  for types; a type-check gate runs.

## Tests

- Domain and use cases in Node against fakes; adapters against a fake network; one test that
  mounts or renders the real thing from real markup; flows end to end — at every level the project
  mandates, for debt fixes as much as for the feature. No test reads a source file as text.

## Self-check before reporting

- `git diff -U0 | grep -nEi '^\+.*(task[ -]?[0-9]|invariant [0-9]|decision [0-9]|per the plan|_plan\.md|devil)'`
  — any hit on an added line is a defect: restate the rule, do not cite the plan.
- `git diff -U0 | grep -nE '^\+.*(eslint-disable|@ts-(ignore|expect-error|nocheck)|: any\b|as unknown as|console\.log)'`
  — any hit in source is a defect to fix, not to explain.
- Every new controller, entry, registry entry and route is registered where its kind is
  discovered, and a test exercises it through that registration.

## When the checklist and your task text disagree

Stop and return the question. Deeper rationale, good-vs-bad examples and host specifics:
`SKILL.md` and its references.
