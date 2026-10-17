# Onion Architecture — the module graph as rings

Jeffrey Palermo's onion draws the same dependency rule as Clean Architecture — all coupling points toward the center — but this file applies it at a different altitude: **the module graph of a modular monolith is itself an onion.** Inside one module the rings order layers (`clean-architecture.md`); across modules they order the packages. Every rule below holds for local Composer packages (`packages/{module}/`) and for a framework's own module unit alike.

## 1. Rings at module altitude

```
┌────────────────────────────────────────────────────────────┐
│  Bridges            leads-llm · livechat-llm · forms-crm   │ ← leaves: nothing
│  ┌──────────────────────────────────────────────────────┐  │   depends on them
│  │  Feature modules      leads · livechat · forms       │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  Capability modules    llm · config · identity │  │  │
│  │  │  ┌──────────────────────────────────────────┐  │  │  │
│  │  │  │  Kernel/platform   http · tenancy · bus  │  │  │  │
│  │  │  └──────────────────────────────────────────┘  │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                ← dependencies point inward only
```

- **Kernel/platform** — cross-cutting plumbing any zone may use (HTTP, tenancy, message bus). Knows nobody.
- **Capability modules** — one zone of responsibility each (`llm`, `config`, `identity`): a domain the product needs but no single feature owns. Know the kernel; never know their consumers.
- **Feature modules** — the user-facing product surfaces (`leads`, `livechat`, `forms`). Know capability public surfaces.
- **Bridges** — integration packages that exist because two zones must cooperate (`leads-llm`, `forms-crm`). Depend on the public surfaces of exactly the modules they connect.

Three structural rules fall out:

1. **Inward only.** A module depends only on the *public surfaces* (`Api/`, events, contracts) of modules in rings strictly inside its own. A capability never names a feature; a feature never names a bridge; the direction of every `composer.json` require, and of every entry in the framework's module manifest, is inward.
2. **Same ring → bridge one ring out.** Two neighbors on the same ring never learn about each other. When they must cooperate, a thin bridge package one ring outward depends on both.
3. **Bridges are leaves.** Nothing may depend on a bridge. The moment something *wants* to, the wanted thing is misplaced — it belongs in one of the modules the bridge connects, or in a new capability module one ring in.

## 2. A zone owns *all* of its artifacts — resources are dependencies

The dependency rule is usually policed at the `use` statement. That is not where most module coupling lives. A module couples to another through **any artifact it must know by name**:

config keys and schema files · translation domains · route names · template paths · DI service ids and tags · DB tables · event names · admin-menu entries · JS controller names.

Everything that describes a zone ships **inside that zone's package**: source, `Api/` contract, config schema, translations, migrations, templates, DI wiring, admin UI slice, tests, docs. A config schema for zone X sitting in package Y couples X→Y with **zero imports** — invisible to Deptrac, fully real at runtime and in every admin screen.

**Ownership litmus test.** For each file in a package, ask: *whose vocabulary does this file define?* If the honest answer is another module's zone, the file is misplaced. Move it home — never reference it sideways.

| Smell | What it really is |
|-------|-------------------|
| Package Y's `config-schema` defines settings for zone X | Y owns X's vocabulary; X's other consumers can't reach it |
| Translations for X's UI living in Y's translation files | X's wording hostage to Y's deploy/enable state |
| Y's migration creates or alters X's tables | schema ownership split; X can no longer evolve its own storage |
| Y's template/JS hard-codes X's route names or DOM ids | a rename inside X silently breaks Y |
| A "shared" bridge that other packages started requiring | a capability module trapped on the wrong ring |

**Vocabulary is a dependency too.** A module's source — code, docblocks, comments, templates, container configuration — names only modules, vendors and products it declares. *"Works around Acme One-Step Checkout's payment return"* in a module that does not depend on Acme One-Step Checkout is a sideways edge with zero imports: it rots when that checkout is replaced, and it tells the reader the module knows something it cannot know. Write the situation (*"a request that fires the success event without rendering a success page"*) and put the neighbour's name in the vault.

## 3. The parable — the refactor that didn't happen

**Day 1.** Bridge `leads-llm` (feature `leads` × capability `llm`) needs settings: which saved LLM connection, which model, plus copilot-specific knobs. It defines all of them in its own package:

```yaml
# packages/leads-llm/.../config-schema.yaml   (consumer #1 owns everything)
sections:
  leads:
    groups:
      ai:
        fields:
          connection:  { kind: tags,   label: 'LLM connection' }   # generic LLM vocabulary
          model:       { kind: string, label: 'Model' }            # generic LLM vocabulary
          autonomy:    { kind: enum,   label: 'Autonomy' }         # genuinely leads-specific
          max_tool_calls: { kind: int, label: 'Max tool steps' }   # genuinely leads-specific
```

With one consumer this is *fine* — locally clean, no speculation. The generic and the specific just happen to live together.

**Day 2.** Bridge `livechat-llm` arrives and needs the same connection+model vocabulary. Reaching into `leads/ai/*` would be a sideways dependency (rule 2), so it does the only thing left:

```php
// packages/livechat-llm/.../LlmConnectionResolver.php   (consumer #2 hard-codes)
private function modelFor(string $provider): string
{
    return match ($provider) {
        'openai'    => 'gpt-4o-mini',     // frozen defaults; admin can configure
        'anthropic' => 'claude-haiku-4-5', // the leads copilot but not this
        default     => self::FALLBACK_MODEL,
    };
}
// connection choice: "first active one" — also frozen
```

The concept now exists twice — once configurable, once frozen — and the copies drift: one feature gains planner/draft model overrides, the other can't express them at all. New consumers (`flow-engine-llm`, …) each re-decide from scratch. This is **the refactor that didn't happen**: on day 2 the shared vocabulary had revealed itself as belonging one ring inward, and nobody moved it.

**What day 2 should have shipped.** The capability module `llm` takes ownership of the concept "an LLM-backed feature has resolvable settings", publishing both the contract and the extension point; each bridge registers its feature and keeps only feature-specific fields at home:

```php
// packages/llm/src/Api/LlmFeatureInterface.php  (inner ring publishes the extension point)
// tagged 'llm.feature': the container collects every implementation into the llm module's registry
interface LlmFeatureInterface
{
    public function key(): string;        // 'leads_copilot', 'livechat_assist'
    public function label(): string;
}

// packages/llm/src/Api/FeatureLlmSettingsInterface.php  (…and the contract consumers call)
interface FeatureLlmSettingsInterface
{
    /** Resolved connection + model for a feature, with the llm module's fallback chain. */
    public function forFeature(string $tenantId, string $featureKey): ?ResolvedLlmSettings;
}
```

```yaml
# packages/llm/.../config-schema.yaml — llm owns the generic per-feature vocabulary
# (one settings group per registered llm.feature, generated from the tagged registry)

# packages/leads-llm/.../config-schema.yaml — keeps ONLY its own zone
sections:
  leads:
    groups:
      ai:
        fields:
          autonomy:       { kind: enum, label: 'Autonomy' }
          max_tool_calls: { kind: int,  label: 'Max tool steps' }
```

Source dependencies all point inward (`leads-llm → llm`, `livechat-llm → llm`); at runtime control flows the other way — the core iterates the registered features without naming any consumer. That is DIP at module altitude.

## 4. The second-consumer rule

Needing a concept a sibling already owns leaves exactly three options:

| Option | Verdict |
|--------|---------|
| Depend sideways on the sibling's keys/files | ❌ ring violation — invisible coupling, breaks on rename/disable |
| Copy the concept into your package (or hard-code around it) | ❌ forks the concept; the copies drift forever |
| **Move the concept one ring inward, then both depend on it** | ✅ the only end state that survives consumer #3 |

The inward move is **in-scope work of the change that discovered it** (see `SKILL.md` § In-scope tech debt) — sequenced before or alongside the new consumer, never deferred with a TODO. The commit series tells the story: *extract inward → migrate consumer #1 (with its stored values and translations) → add consumer #2 against the new contract.*

**And the pragmatic inverse:** with provably one consumer, do *not* build the generic version speculatively — that is the over-abstraction `SKILL.md` warns against. Owning vocabulary locally on day 1 is correct; the crime is only ever committed on day 2. When reviewing a first consumer, still run the forecast: *"if a second consumer appeared tomorrow, which files would it need to copy?"* — and make sure those files at least separate the would-move-inward fields from the feature-specific ones, so the day-2 refactor is a move, not surgery.

## 5. Promotion is a re-modeling, not a copy

The inward move of §4 has a trap: whatever the first consumer built becomes, verbatim, the contract every future consumer must live with. Its private compromises stop being one package's problem and start being the platform's. **A concept is re-modeled on the way in — never enshrined.**

Audit these before publishing the promoted contract:

| Carried-over defect | Why centralizing makes it worse | The re-modeling |
|---|---|---|
| **Foreign row id as a stored value** — settings/contract keyed by another module's primary key (`connection_id`, `template_id`) | The id rots (rotation, revocation, deletion) and is meaningless at a broader scope — a *global* default holding one tenant's row id resolves to nothing for everyone else | Key on the stable domain term the id was standing in for (a provider, a kind, a capability), and resolve the row from it at read time |
| **A failure mode nobody chose** — the first consumer's dangling-reference behavior (silently substitute? die?) | Every consumer inherits it, including ones where the wrong answer is a compliance incident | Pick a legible one and state it in the contract. Usually: an explicit choice is never silently substituted; an absent choice resolves automatically |
| **The first consumer's vocabulary** — field names, section ids and defaults carrying its domain | Consumer #3 reads a contract that describes someone else's feature | Neutral names owned by the inner module; the feature-specific remainder stays outside |
| **A default that was right for one caller** — a hard-coded literal (a model id, a timeout) | It is now the default for callers whose context differs, and it is silently wrong rather than absent | Derive the default from the thing it depends on, or make it required |
| **Fields that were never generic** riding along | The inner module accretes an outer module's domain — the inward move becomes an inward *leak* | Split: only the shared part is promoted; the rest stays in the consumer's own package |

The test: **the promoted contract must be defensible without naming its first consumer.** If a field can only be explained as "that's how the module it came from did it", it has been copied, not promoted.

## 6. Extension points: how outer rings contribute without being known

The inner module publishes a contract; outer modules contribute instances; the container assembles them. The inner ring iterates *contributions*, never *contributors*.

- **Contributions to a registry** — a tag on an inner `Api/` interface, or a pool argument of an inner composite, collected by the container; the inner service iterates the collection (or a locator).
- **Contributions of resources** — per-package discovery that collects each package's own config schema, routes, translations and admin sections at build time.
- **Contributions to data and events** — extension points on inner DTOs; listeners on inner events.

The stack skill names its framework's mechanism for each.

Litmus: delete any single outer package → the inner module still compiles, boots, and merely lists one fewer contribution.

## 7. Enforcing rings mechanically

- **Deptrac at package altitude** — one layer per ring, collectors over package paths, inward-only ruleset. Per-package deptrac files keep each module honest about its own edges; zero per-class exceptions.

```yaml
deptrac:
  layers:
    - { name: Kernel,     collectors: [{ type: directory, value: 'packages/(http|tenancy)/src/.*' }] }
    - { name: Capability, collectors: [{ type: directory, value: 'packages/(llm|config|identity)/src/.*' }] }
    - { name: Feature,    collectors: [{ type: directory, value: 'packages/(leads|livechat|forms)/src/.*' }] }
    - { name: Bridge,     collectors: [{ type: directory, value: 'packages/[a-z]+-[a-z]+/src/.*' }] }
  ruleset:
    Kernel: ~
    Capability: [Kernel]
    Feature: [Kernel, Capability]
    Bridge: [Kernel, Capability, Feature]
```

- **`composer.json` honesty** — each package requires only inward packages; the require graph *is* the ring diagram, so review it like code.
- **Cycle detection** — a ruleset that allows any `Api`→`Api` edge is blind to a cycle assembled from two individually-legal edges; run SCC detection over the real reference graph as a separate gate. Break a would-be cycle with a consumer-owned port or a scalar-id de-association, never with a mutual `Api` edge.
- **The framework's module manifest** — where the framework declares module order as well, that manifest and `composer.json` mirror the same inward edges; `@api` marks the public surface. No tool checks resource ownership, so grep for your module's config paths/table names in *other* modules' configuration during review.

## Review checklist

- [ ] Every package sits on an identifiable ring; every dependency edge (composer require, `use` across packages, the framework's module manifest) points strictly inward.
- [ ] No two same-ring modules reference each other — cooperation goes through a bridge one ring out.
- [ ] Nothing depends on a bridge; bridges depend on exactly the modules they connect.
- [ ] Every artifact in each package defines that package's own vocabulary (config schema, translations, routes, templates, migrations, menu entries) — run the ownership litmus test.
- [ ] No config keys, table names, route names, or service ids of zone X are defined or migrated by package Y.
- [ ] Concepts needed by ≥2 consumers live one ring inward as a contract + extension point — no sideways copies, no consumer hard-coding around a sibling's schema.
- [ ] A promoted concept was **re-modeled, not copied** — no foreign row ids as stored values, no inherited dangling-reference failure mode, no first-consumer vocabulary or defaults in the shared contract (§5).
- [ ] First-consumer packages keep would-generalize fields separable from feature-specific ones (the day-2 forecast).
- [ ] Rings are enforced by tooling: Deptrac layers per ring, honest composer requires, SCC cycle gate.
