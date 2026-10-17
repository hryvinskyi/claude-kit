# Implementer checklist — clean-architecture-php, cut for one planned task

Read this before writing code that creates or moves a seam: a class another module will
touch, a port/interface, an entity, a cross-module contract, a new service registration.
It is the rubric's rules without its review and planning formats; those live in `SKILL.md`
and are not needed to implement a task that has already been planned and reviewed.

## Dependency rule

- Inner code (Domain, Application / use cases) names no outer concrete: no Doctrine or
  `Magento\Framework` class, no `ObjectManager`, no `Request`/`Response`, no HTTP client, no
  framework base class. Need one? Define the port (interface) in the inner layer, implement it
  outside, wire it through DI.
- Litmus: swapping the ORM, the transport, or the framework must not touch use cases or entities.

## What crosses a boundary

- DTOs and value objects — never ORM entities, `AbstractModel`s, or request objects.
- Magento: `Api/` + `Api/Data/` contracts, `di.xml` preference/plugin. Symfony: `services.yaml`
  alias/autowire + tags. A class that is built but never wired ships nothing: check the
  registration (tag, preference, manifest) exists and is exercised by a test that resolves it
  through the real container (an integration test) — never by a unit test that parses the
  config file (the engineering standards in your user `CLAUDE.md`, §*Tests run code*).

## Never `new` — the container creates every object

- **Code never instantiates a class with `new`.** A collaborator comes from the container, injected
  through its interface. A genuinely new instance comes from an injected `…FactoryInterface`, and a
  factory is only that interface: the container writes its implementation, never a person. Magento
  generates `…Factory`, whose `create()` asks the ObjectManager. Symfony ships no generator: find
  the project's compile-time one in its docs (`symfony.md` §10). If the project has none, stop and
  return the question: it is a plan decision, not a licence to hand-write `new`. `throw new
  …Exception`, attribute metadata, tests and the composition root are exempt. The composition root
  is the one place that builds the container, before any exists (`new Kernel(...)` in the front
  controller or `bin/console`, Magento's bootstrap), not wiring code in general.
- A factory method only creates: one object per method, from its arguments, no computation.
- A static named constructor (`Foo::of(...)` doing `new self(...)`) is not an alternative: it is
  the same `new`, and nothing can substitute for it. Don't write one; plan a factory.
- Where each new thing comes from (`ddd.md` §*Creation lives in factories*): a value from its
  factory, and arithmetic on the value, which asks the factory for the result (`$a->plus($b, $this->money)`); an aggregate from
  its factory's `draft()`, its children from their own factory, handed to the root; an id from
  the repository's `nextIdentity()`; a domain event from the event factory the aggregate is handed;
  the time from an injected `ClockInterface`.
- Type every parameter and property on the **contract**, never the concrete class
  (`TranslatableInterface`, not `TranslatableMessage`; `TranslatorInterface`;
  `EventDispatcherInterface`), including a private helper in a controller.
- A controller never holds vocabulary literals (a translation key, a domain). It asks the
  module's vocabulary service, which owns them once and takes each object from a factory.
- A side channel is reached through a typed port, not a `(string $kind, mixed $message)` method.
  If the project publishes the port, use it. If it does not and your task touches such calls, stop
  and return the question: the port is a plan decision.
- **The whole file you touch is in scope**, not only your lines. A sibling `new`, English literal
  or `$e->getMessage()` shown to a person in the same file is debt you fix now or return as a
  question.

## Behavior selection

- No `switch` / `elseif` / `instanceof` ladder on a type, kind, or method field. Use the
  project's registry idiom (tagged iterator, DI-wired strategy map, plugin pool); an unknown key
  fails loudly. A `match` that maps value → value and guard clauses with early returns are fine.

## Where logic lives

- Invariants inside entities/aggregates through intention-revealing methods — not setters plus
  a `*Service` / `*Helper` that checks afterwards.
- No new god, Helper, or Util classes; split by concern.

## Ownership (module ring)

- Everything for zone X lives in X's package: config schema, translations, migrations, routes,
  templates, DI wiring. A sibling's vocabulary in your package (or yours in theirs) is a boundary
  leak even with zero imports.
- Name only what you depend on. No comment, docblock, identifier or wiring entry mentions a
  module, vendor or product outside this module's declared dependencies (module.xml sequence,
  composer require). A neighbour's quirk is described as a situation ("a request that renders no
  success page"), never by the neighbour's name; the name goes in your report for the vault.
- Need a concept a sibling owns? Do not copy it sideways or hard-code around it. That is a
  scope-check stop (the plan owns the inward move), not a decision you take alone.
- Never key configuration or a published contract on another module's row id; use the stable
  domain term and resolve the row at read time.

## The JavaScript you ship

- JS/TS source is written against `architecture:clean-architecture-js`: read its
  `references/implementer-checklist.md`, `solid.md`, `javascript.md` and the host reference
  before the first JS/TS edit (the same hook gates it). This skill's part is the seam: the
  ViewModel builds the config, the template prints it escaped and asks for the asset, the
  endpoint answers the script.

## Tests

- Domain unit (no framework), use-case against port fakes, integration through real wiring/DB —
  at every level the project mandates, for debt fixes as much as for the feature.

## Self-check before reporting

- `git diff -U0 | grep -nEi '^\+.*(task[ -]?[0-9]|invariant [0-9]|decision [0-9]|per the plan|_plan\.md|devil)'`
  — any hit on an added line is a defect: restate the rule, do not cite the plan.
- Every new class is registered where its kind is discovered; every port has exactly the
  implementations the plan names.
- Run the detection recipes of `solid.md` and the stack reference over **every file you
  touched** (whole files, not the diff), and put each hit with its verdict in your report.
  Minimum, for a Symfony controller you touched:
  `rg -nP '(?<!throw )\bnew\s+(?!class\b)[\w\\]+\s*\(|::of\(|addFlash\(|getMessage\(\)|function \w+\([^)]*\b(TranslatableMessage|Translator|EventDispatcher)\b\s+\$' <non-test files>`.
  Every `new` hit is a defect, other than `throw new`, attribute metadata, tests and the composition root; a hand-written
  factory's `new` included.
  An unexplained hit is a defect, not a note for later.

## When the checklist and your task text disagree

Stop and return the question (Loop step 1). Deeper rationale, good-vs-bad examples, and the
Symfony/Magento specifics: `SKILL.md` and its references (`clean-architecture.md`, `solid.md`,
`ddd.md`, `onion-modules.md`, `integration-patterns.md`, `symfony.md`, `magento2.md`).
