---
name: clean-architecture-php
description: Review and plan PHP code with Robert C. Martin's Clean Architecture, Onion Architecture at module altitude, SOLID, and Domain-Driven Design, using concrete Symfony and Magento 2 examples. Use when reviewing architecture / the dependency rule / layer separation / module boundaries / module rings and resource ownership (who owns a config schema, translation, migration), when creating an implementation plan for a new feature or bounded context, or when refactoring toward ports & adapters / service contracts / a properly-ringed modular monolith in a Symfony or Magento 2 codebase. The JavaScript and TypeScript those modules ship (RequireJS/Knockout, Hyvä/Alpine, vanilla scripts rendered through hryvinskyi/magento2-theme-assets, Stimulus, React islands) is reviewed with the sibling skill architecture:clean-architecture-js; a change that touches both loads both. Also covers what leaves the transaction: dual writes and the transactional outbox, idempotent consumers, sagas and compensation, timeouts/retries/circuit breakers, and caching in front of a port.
---

# Clean Architecture for PHP (Symfony & Magento 2)

Analyze, **review**, and **plan** PHP code through four complementary lenses — **Clean Architecture** (Uncle Bob), **Onion Architecture** (Palermo) applied to the module graph, **SOLID**, and **Domain-Driven Design** — grounded in idiomatic **Symfony** and **Magento 2**.

The one rule everything else serves: **source-code dependencies point inward, toward higher-level policy.** The framework, the database, and the delivery mechanism (HTTP, CLI, queue) are details that depend on your business rules — never the reverse.

```
┌───────────────────────────────────────────────────────────────────┐
│  Frameworks & Drivers   (Symfony/Magento kernel, Doctrine, MySQL) │
│  ┌──────────────────────────────────────────────────────┐         │
│  │  Interface Adapters  (Controllers, Presenters, Repos)│         │
│  │  ┌──────────────────────────────────────────────┐    │         │
│  │  │  Use Cases  (Application services, handlers) │    │         │
│  │  │  ┌──────────────────────────┐                │    │         │
│  │  │  │  Entities  (Domain model,│                │    │         │
│  │  │  │  invariants, value objs) │                │    │         │
│  │  │  └──────────────────────────┘                │    │         │
│  │  └──────────────────────────────────────────────┘    │         │
│  └──────────────────────────────────────────────────────┘         │
└───────────────────────────────────────────────────────────────────┘
                 ← dependencies flow inward only
```

## The module graph is also an onion

In a modular monolith the same rule repeats one altitude up: packages form rings — **kernel/platform → capability modules → feature modules → bridges** — and every dependency (composer require, cross-package `use`, Magento `<sequence>`) points strictly inward. Full treatment, parable, and Deptrac recipe: `references/onion-modules.md`. The rules in brief:

1. **Each module owns exactly one zone of responsibility** — and owns it *totally*: source, `Api/` contract, config schema, translations, migrations, templates, DI wiring, admin surface all live in that module's package. **Resources are dependencies**: a config schema (or translation, route name, table) for zone X defined in package Y is a boundary violation with zero imports.
2. **Same ring never touches same ring.** When one module needs another's zone, a thin **bridge package** one ring outward depends on both public surfaces. Nothing ever depends on a bridge.
3. **The second consumer is the signal.** When a concept a sibling owns turns out to be needed by you, the concept moves one ring inward — a contract + extension point both depend on. Copying it sideways or hard-coding around it forks the concept. The inward move is in-scope work of the change that discovered it, not a TODO.
4. **Conformance is maintained by refactoring.** A review or plan that finds modules off their ring, or artifacts outside their owner, schedules the refactor to conformance as first-class tasks of the current change (within the blast radius — see *In-scope tech debt*).

## Two modes

This skill operates in two modes. Pick the one the request calls for (or run Plan → then Review the plan).

- **Review mode** — assess existing code or a diff against the rules → produce a *Review Report*.
- **Plan mode** — design a new feature/bounded context, or a refactor, from the domain outward → produce an *Implementation Plan*.

## When to use

- "Review this for clean architecture / SOLID / DDD." · "Check the dependency rule / layer separation / module boundaries."
- "Plan / design this feature cleanly." · "Write an implementation plan for <feature> in Symfony/Magento." · "How should I structure this bounded context?"
- "Is this domain model anemic? Where should this logic live?" · "Refactor this toward ports & adapters / service contracts."
- **Any tech-debt fix, of any size** (the engineering standards in your user `CLAUDE.md`, §*Architecture and tech debt*): name the smell in Review mode, design the fix domain-outward in Plan mode scaled to its size, then implement. A hook refuses PHP source edits until this skill is loaded in the session.

## Reference map — load what the task needs

Read `SKILL.md` fully, then open only the reference(s) the task touches. Each is self-contained with good-vs-bad PHP.

**Loading this file alone is not loading the skill.** A session that read only `SKILL.md` shipped a closed value object in a Magento `Api/Data/` with no extension point, unvalidated fields and no interface — three things the references say on their first page. Mandatory on every task, before the first edit:
- the **stack reference** — `magento2.md` on Magento, `symfony.md` on Symfony;
- **`solid.md`** for any code change or debt fix (every change is a design decision: OCP extension points, god classes, switch-on-type);
- **`ddd.md`** whenever the change touches an entity, value object, aggregate, or a Magento `Api/Data/` type (valid-by-construction, invariants, what is an interface and what is a class);
- `clean-architecture.md` / `onion-modules.md` when a boundary, port, or module placement is in play;
- `integration-patterns.md` when the change publishes or consumes a message, calls another system, or caches a port.

The guard hook `plan_skill_gate.py` refuses a PHP source edit or plan write until the session shows those Reads, and names the ones missing.

| File | Load it when the task involves… |
|------|--------------------------------|
| `references/clean-architecture.md` | The dependency rule, the four layers, crossing boundaries, DTOs vs entities, ports/adapters, screaming architecture, Deptrac enforcement |
| `references/onion-modules.md` | Module rings in a modular monolith, zone-of-responsibility & resource ownership (config schemas, translations, migrations), bridge packages, the second-consumer rule, extension points, ring enforcement |
| `references/solid.md` | SRP/OCP/LSP/ISP/DIP — diagnosing violations, splitting fat classes, Helper/god-object smells, extension points |
| `references/ddd.md` | Bounded contexts, ubiquitous language, context mapping/ACL, entities, value objects, aggregates, repositories, domain services, domain events |
| `references/symfony.md` | Symfony/API Platform/Doctrine/Messenger layering, DI wiring, keeping the domain framework-free, modular-monolith `Api/` contracts |
| `references/magento2.md` | Service Contracts (`Api/`, `Api/Data/`), repositories, `di.xml` preferences, plugins, ViewModels, how templates hand config and assets to the browser code (theme-assets from the PHP side), and DDD-lite within Magento's constraints |
| `references/integration-patterns.md` | Anything leaving the transaction: a message published from a use case, a consumer, an outbound HTTP call, a multi-step process across modules (saga), retries/timeouts/circuit breakers, a cache in front of a port. Where each piece lives, the review questions, detection recipes |
| `references/implementer-checklist.md` | Implementing one already-planned task (the `pipeline:feature-implementer` agent): the rules to honor while writing code, without the review/plan formats — read this *instead of* the whole skill |

## The layers, mapped to PHP

| Layer | Owns | Symfony | Magento 2 |
|-------|------|---------|-----------|
| **Entities** (Enterprise business rules) | Invariants, value objects, pure domain logic | Plain PHP under `Domain/` (framework-free) | Domain model / service logic kept off `AbstractModel` where feasible |
| **Use Cases** (Application business rules) | Orchestrate entities for one feature | Command/query handlers, application services | Service-contract implementations behind `Api/` |
| **Interface Adapters** | Translate outer ↔ inner; no business rules | Controllers, API Platform providers/processors, Doctrine repository impls, DTOs | Controllers, Blocks/ViewModels, `Api/Data/` DTOs, ResourceModels |
| **Frameworks & Drivers** | The details | Kernel, Doctrine, Messenger transport, HTTP client | Magento framework, MySQL, `di.xml` wiring |

**Litmus test for any dependency:** if renaming or replacing something in an *outer* layer (swap Doctrine for Eloquent, MySQL for an API, HTTP for CLI) forces edits *inside* Use Cases or Entities, the dependency rule is violated. Fix it by inverting — define the interface (port) in the inner layer, implement it outside.

---

## Mode A — Review workflow

1. **Map the code to layers — and the packages to rings.** Where does each class sit? Which layer *should* own each responsibility? In a modular monolith, also place every touched package on its ring (kernel / capability / feature / bridge) and check each package-level edge points inward (`references/onion-modules.md`).
2. **Trace dependency direction.** Follow every `use` / constructor arg across a boundary. Does any inner class name an outer concrete class (a Doctrine repo, an HTTP client, `di.xml` glue, a framework base class)? Each is a candidate violation.
3. **Inspect what crosses boundaries.** Persistence entities, ORM rows, or framework request/response objects reaching into Use Cases or the Domain = leak. Expect DTOs / value objects instead. Then check **resource ownership**: does every config schema, translation, migration, route, and template in the touched packages define its *own* module's vocabulary? A sibling's vocabulary in your package (or yours in theirs) is a boundary leak with zero imports.
4. **Check the domain model for richness.** Getters/setters with all logic in services = *anemic*. Invariants belong inside entities/aggregates (`references/ddd.md`).
5. **Run the SOLID pass** (`references/solid.md`), DIP first — it is the mechanism behind every boundary crossing. Start it, and steps 2–3, from the **detection recipes** at the end of `solid.md`, the stack reference and `integration-patterns.md`: they list the candidates to open, so the review covers the radius instead of what the reviewer happened to remember. A hit is read before it is graded; a finding quotes the line and names the rule it breaks.
6. **Weigh pragmatism** (see below) before recommending abstractions.
7. **Report** using the Review Report format.

### Review Report format

```markdown
# Clean Architecture Review — <scope>

## Summary
- Overall: [Solid / Needs work / Critical]
- 2–4 sentence headline: biggest structural risk and biggest strength.

## Dependency Rule
- Violations (file:line → which inner layer depends on which outer concrete).
- The inversion that fixes each (port to introduce, where it lives).

## Module rings & ownership (modular monolith)
- Ring placement of each touched package; any edge not pointing inward.
- Misplaced artifacts (config schema / translations / migrations / routes owned by the wrong package) and their home.
- Concepts duplicated or hard-coded sideways that belong one ring inward (second-consumer rule).

## Layers
- Entities / Domain: [assessment + anemia check]
- Use Cases / Application: [assessment]
- Interface Adapters: [assessment]
- Frameworks & Drivers: [assessment]

## SOLID
- Per principle: PASS, or the specific violation (SRP·OCP·LSP·ISP·DIP).

## DDD (if applicable)
- Bounded-context/module boundary integrity, aggregate & invariant placement,
  anemic-model findings, repository/domain-service correctness.

## Recommendations
1. High — correctness/coupling that will bite soon.
2. Medium — structural improvements.
3. Low / optional — only if it earns its cost.
```

---

## Mode B — Planning & design workflow

Design **from the domain outward**, so the plan honors the dependency rule by construction. Produce (or update) an Implementation Plan; do not write production code in this mode.

1. **Frame it.** Restate the goal in the **ubiquitous language**. Identify the **bounded context / module** it belongs to — including its **ring** (kernel / capability / feature / bridge) — and whether it reuses or crosses an existing boundary (`references/ddd.md`, `references/onion-modules.md`). If it crosses one, name the bridge package; if it needs a concept a sibling owns, plan the inward move first. Name the invariants and business rules up front.
2. **Scope the blast radius, then remediate its tech debt.** Determine every file the change touches and their **direct collaborators** in the same module (the definition below bounds it deliberately). Audit that scope against `clean-architecture.md`, `solid.md`, and `ddd.md`, and **fold the fixes into the plan as first-class tasks** — see *In-scope tech debt is fixed, not deferred* below. This step is mandatory, not optional.
3. **Model the domain.** List **entities, value objects, and the aggregate(s)** with their root and consistency boundary. State each invariant and where it is enforced. Keep this layer framework-free.
4. **Define use cases & ports.** For each application action, name the **use case** (handler/service) and the **ports** it depends on — repository, gateway, notifier, clock, and the **factory** behind every object it creates (no `new` outside one, pitfall 9) — as interfaces *owned by the inner layer*. Decide what DTOs cross the boundary in and out.
5. **Choose adapters.** For each port, name the **infrastructure implementation** (Doctrine repository, Magento `Api/` implementation, HTTP client, message bus) and where it lives. Confirm the dependency points inward.
6. **Delivery mechanism last.** Specify the **humble** entry point(s) — controller, API Platform resource + provider/processor, CLI command, message handler — that only translate and delegate.
7. **Wiring & enforcement.** Note the DI wiring (Symfony `services.yaml` alias/autowire + tags; Magento `di.xml` `<preference>`) and any boundary tooling (Deptrac layers, `@api` contracts).
8. **Test strategy.** Domain unit tests (no framework), use-case tests against port fakes, and integration tests through real wiring/DB — covering both the new work **and** every in-scope debt fix.
9. **Pragmatism pass.** Cut every abstraction that doesn't protect a real axis of change (see below). Call out remaining risks and open questions. Debt found *outside* the blast radius is logged here, not force-fixed.

### In-scope tech debt is fixed, not deferred

When planning a change, technical debt inside the **blast radius** is remediated as part of the *same* plan — never postponed with a TODO. The rule is global (the engineering standards in your user `CLAUDE.md`, §*Architecture and tech debt*): it binds every stack and every workflow, not only PHP plans; the guard hook `debt_guard.py` refuses an edit that parks debt behind a `TODO` or a suppression. Scope is bounded, deliberately, so this stays achievable:

> **Blast radius = the files you touch + their direct collaborators in the same module** — one hop: the classes they call and the classes that call them. It widens to the whole module only when the module is small (about fifteen classes or fewer) or the change already touches most of it. Debt strictly *outside* that set is logged as a follow-up (*Logged for later* below, plus one line on the vault's TODO board), never force-fixed: a feature is not a licence to refactor a module.

Audit the blast radius and fix what you find:
- **Dependency-rule violations** — an inner layer importing an outer concrete (`Doctrine`, `Magento\Framework`, `ObjectManager`, `Request`) → introduce a port.
- **Anemic models / misplaced logic** — business rules stranded in `*Service`/`*Helper`/Observers/Blocks that belong in an entity or aggregate.
- **God / Helper / Util classes** — SRP violations → split into focused services.
- **`switch`/`case` or `elseif` dispatch by type** — behavioral branching on a `type`/`kind`/`method` field → replace with injected polymorphic strategies resolved from a tagged collection/registry (see `solid.md` §OCP).
- **Leaky boundaries** — ORM entities or Magento `Model`s crossing the API/service-contract boundary instead of DTOs.
- **Sideways naming** — a comment, docblock, identifier or wiring entry naming a module, vendor or product this module does not declare as a dependency; reword to the situation, or declare the dependency.
- **Misplaced resources / sideways concepts** — a module's config schema, translations, or migrations living in a sibling package; a concept two consumers need duplicated or hard-coded instead of owned one ring inward (`onion-modules.md` §2–4).
- **A concept promoted inward without being re-modeled** — the first consumer's incidental choices (a foreign row id as a stored value, an inherited dangling-reference failure mode, its vocabulary, its hard-coded defaults) becoming the shared contract every future consumer inherits (`onion-modules.md` §5). Promotion is the moment to fix the model, not to freeze it.
- **Fat, ISP-violating interfaces**; **LSP-breaking subtypes**; **missing DIP wiring**.
- **Missing or mocked-DB tests** for code you are modifying; deprecated APIs; static-analysis errors suppressed in the touched files.

Rules of engagement:
- Every remediation ships **with its own tests** and must keep the quality gates green.
- If a debt fix is large, list it as **separate, ordered tasks** with clear boundaries — but still inside this plan, sequenced before or alongside the feature work it unblocks.
- Do **not** silently expand scope beyond the blast radius. If fixing in-scope debt forces a change in a neighboring module, surface that as an **open question**, don't sprawl.

### Implementation Plan format

```markdown
# Implementation Plan — <feature / bounded context>

## Context & language
- Module / bounded context: <where it lives, and why>
- Ubiquitous language: <term → meaning> (the words the code will use)
- Business rules & invariants: <the truths the model must never violate>

## Tech-debt in scope (must fix, with tests)
- Blast radius: <files touched> · <their direct collaborators> · <whole module only if small — say why>
- Debt → remediation (each ships with its own tests):
  - <file/class>: <smell — e.g. switch-on-type / anemic model / boundary leak / god Helper> → <fix>
- Logged for later (outside blast radius): <item → why deferred>

## Domain model (inner)
- Entities: <name → identity & responsibility>
- Value objects: <name → what it makes valid-by-construction>
- Aggregate(s): <root, boundary, invariant enforced inside>

## Use cases (application)
- <UseCaseName>: input DTO → output DTO; steps; ports required.

## Ports (interfaces owned inside)
- <PortInterface>: purpose & method contract.

## Adapters (infrastructure)
- <Adapter> implements <Port> — tech, location, notes.

## Delivery
- Entry points (controller / API resource / CLI / handler) — thin, translate-only.

## Dependency rule check
- One line per boundary: X depends on Y (inward). No inner→outer concrete refs.

## Wiring & enforcement
- DI registration; Deptrac/@api boundaries; migrations/config.

## Tests
- Unit (domain, no framework) · Use-case (port fakes) · Integration (real DB/wiring).

## Risks, tradeoffs & open questions
- Abstractions deliberately NOT added (and why). Decisions needing a human.
```

---

## Pragmatism — Clean Architecture is not a silver bullet

Boundaries cost indirection. Add one only where the benefit is real. Before recommending — or planning — an abstraction, pass it through these:

- **Does this seam protect a real axis of change?** A repository interface with exactly one forever-implementation, wrapping an ORM that already abstracts the DB, may be pure ceremony.
- **Would a wrong-layer bug actually escape today?** If not, you may be paying for a 0.001%-likely future.
- **Can you rename a class in an outer module without touching inner ones?** If yes, the boundary earns its keep. If not, it is decoration.
- **Layer count is flexible.** Two well-separated layers that honor the dependency rule beat four ritual ones. The rule is the point, not the diagram.

### Common PHP pitfalls this skill flags
1. **Anemic domain** — entities are data bags; all rules live in `*Service`/`*Manager`/`*Helper` classes.
2. **Framework leaking inward** — Doctrine/Magento base classes, `Request`, or `ObjectManager` referenced from domain or use-case code.
3. **Entities crossing the API boundary** — serializing ORM entities straight to JSON instead of DTOs; the DB schema becomes the public contract.
4. **God "Helper"/"Util" classes** — SRP violations that accrete unrelated logic. Prefer focused services. (Magento: never reach for `ObjectManager` to dodge injection.)
5. **`switch`/`case` and `elseif` chains that select behavior by type** — closed to extension and impossible to contribute to from another module. Replace with injected strategy objects resolved from a tagged collection/registry (Symfony `#[AutoconfigureTag]` + `!tagged_iterator`; Magento `di.xml` array/pool). A `match` used purely to map value→value, and guard-clause `if`s with early returns, are fine — the smell is dispatching *behavior* on a type field. Full recipe in `solid.md` §OCP.
6. **Over-abstraction** — ports and interfaces with a single trivial implementation and no plausible second one. A factory is the exception: creation always goes through one (9), however trivial.
7. **Sibling-owned vocabulary** — module X's config schema/translations/routes defined in sibling package Y, so X's other consumers copy or hard-code around it; the concept belongs one ring inward (`onion-modules.md` §3, the missed refactor).
8. **Foreign row ids as configuration or contract values** — a setting, event payload, or published contract keyed by another module's primary key. The id rots when the row is rotated or deleted, and it is meaningless at any scope broader than the row's owner. Key on the stable domain term instead and resolve the row at read time (`onion-modules.md` §5).
9. **`new` in written code.** Code never instantiates a class with `new`.
   - An object comes from the **container**, as an injected service typed on its interface.
   - Or it comes from an injected **factory** (`…FactoryInterface`), when a genuinely new instance is needed.
   - **A factory is an interface; the container writes its implementation, never a person.** Magento
     generates `…Factory`, whose `create()` asks the ObjectManager (`magento2.md`). Symfony ships no
     generator: use the compile-time one the project's docs name (`symfony.md` §10). If the project
     has none, that is a plan decision, not a licence to hand-write `new`.
   - Exempt: `throw new …Exception`, attribute metadata, tests, and the **composition root**: the one
     place that builds the container, before any exists (`new Kernel(...)` in the front controller or
     `bin/console`, Magento's bootstrap). It is not wiring code in general.
   - A static named constructor doing `new self(...)` is the same violation behind a different spelling.
   - A factory method only creates: one object per method, no computation. An operation that yields a
     value (summing two amounts) lives on the value or on a service, which asks the factory for the
     result object.
   - The typical offender is a controller building `new TranslatableMessage('catalog.x.saved', [], 'catalog')`,
     typing a helper on that concrete class, and writing a `(string $kind, mixed $message)` side channel
     (`addFlash`). The fix: the module's sentences have one owner, a service that takes each object from
     an injected factory, and the channel is a typed port owned by the module that renders it.
   - The whole touched file is in scope.

   Recipes: `solid.md` §DIP *No `new` — the container creates every object* and `symfony.md` §9.
10. **Business rules in the browser code a module ships** — a price, a permission or a validation that exists only in JS, or a Knockout/Stimulus component fusing rules, wording and transport. The browser half is reviewed with `architecture:clean-architecture-js` (below).

### The JavaScript you ship — `architecture:clean-architecture-js`

A PHP module's browser code is part of the same architecture and is reviewed to the same bar, in its own idiom, by the sibling skill **`architecture:clean-architecture-js`**: RequireJS/Knockout and jQuery widgets, Hyvä/Alpine, vanilla scripts and styles rendered through `hryvinskyi/magento2-theme-assets`, Stimulus controllers, Live/Twig Components' browser half, React islands, TypeScript.

- **A change that touches JS/TS loads that skill too** — `SKILL.md`, its `solid.md` and `javascript.md`, and its host reference (`magento2-frontend.md` or `symfony-frontend.md`; `react.md` for an island; `typescript.md` for `.ts`). A plan in a PHP project that orders JS/TS tasks needs both skills, and the guard hook `plan_skill_gate.py` refuses it until both are loaded.
- **The seam between the two halves is this skill's**: the ViewModel that builds a widget's config, the template that prints it escaped and asks the renderer for the asset, the endpoint the script calls (`magento2.md` §8, `symfony.md` §5). What the script does with them is the other skill's.

### Quick DIP check (the heart of every boundary)

```php
// ❌ Use case bound to a concrete infrastructure detail
final class PlaceOrderHandler
{
    private DoctrineOrderRepository $orders;              // concrete, framework-coupled
    public function __construct() {
        $this->orders = new DoctrineOrderRepository(/*…*/); // 'new'ing infra inside the application layer
    }
}

// ✅ Use case depends on a port it owns; infrastructure implements & is injected
final class PlaceOrderHandler
{
    public function __construct(
        private readonly OrderRepositoryInterface $orders, // abstraction, wired by the container
        private readonly OrderFactoryInterface $orderFactory, // a new Order comes from a factory, never `new Order(...)`
    ) {}
}
```

**Never `new` a class.** Services come from the container, and new instances come from an injected `…FactoryInterface` whose implementation the container writes (Magento's generated `…Factory`; in Symfony, the project's own compile-time generator — none is a plan decision, not a licence). Nothing a person writes says `new`, not even a factory. `throw new …Exception`, attribute metadata, tests and the composition root (the one place that builds the container, before any exists) are exempt.

## References
- Robert C. Martin, *The Clean Architecture* — https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- Robert C. Martin, *Clean Architecture: A Craftsman's Guide to Software Structure and Design*
- Jeffrey Palermo, *The Onion Architecture* — https://jeffreypalermo.com/2008/07/the-onion-architecture-part-1/
- Eric Evans, *Domain-Driven Design*; Vaughn Vernon, *Implementing Domain-Driven Design*
- Deptrac — https://github.com/deptrac/deptrac · Magento *Service Contracts* — https://developer.adobe.com/commerce/php/development/components/service-contracts/
