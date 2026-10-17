---
name: magento2-architecture-php
description: Magento 2's idiom for the architecture:clean-architecture-php rubric — Service Contracts (Api/ and Api/Data/) as ports and published language, di.xml preferences, virtual types and injected pools, plugins and observers with their caveats, ViewModels, generated factories, module.xml sequence and @api, DDD-lite within Magento's constraints, the outbox on the db queue connection, and how templates hand config and assets to the browser code (theme-assets from the PHP side). Use together with architecture:clean-architecture-php whenever PHP in a Magento 2 project is reviewed, planned or written; the browser half (RequireJS/Knockout, theme-assets, Hyvä/Alpine) is magento2:magento2-architecture-frontend.
---

Load this skill together with `architecture:clean-architecture-php`. A file named without a skill
(`clean-architecture.md`, `solid.md`, `ddd.md`, `onion-modules.md`, `integration-patterns.md`,
`SKILL.md`) is that core skill's.

# Clean Architecture in Magento 2

Magento is framework-first: models extend `AbstractModel`, persistence runs through ResourceModels/Collections, and wiring is `di.xml`. You will not get a textbook four-layer app — but the dependency rule, SOLID, and DDD-lite apply directly, and Magento gives you a first-class boundary mechanism: **Service Contracts**. Read `clean-architecture.md`, `solid.md`, `ddd.md` first.

## 1. Service Contracts = ports + published language

A **Service Contract** is a module's public API expressed as interfaces under `Api/`:
- **`Api/*Interface`** — *service* interfaces (behavior): `OrderRepositoryInterface`, `OrderManagementInterface`. These are your **use-case ports**.
- **`Api/Data/*Interface`** — *data* interfaces (DTOs) that cross the boundary: `OrderInterface`. These are your **published language** — the only shapes other modules should see.

**Rule:** other modules (and your own controllers/blocks) depend on `Api/` and `Api/Data/`, **never** on concrete `Model\` classes. Mark stable contracts `@api` so backward compatibility is a promise.

```php
namespace Acme\Sales\Api;

use Acme\Sales\Api\Data\OrderInterface;
use Magento\Framework\Api\SearchCriteriaInterface;

/**
 * @api  ← published, backward-compatible contract
 */
interface OrderRepositoryInterface
{
    public function save(OrderInterface $order): OrderInterface;
    public function get(int $id): OrderInterface;                 // throws NoSuchEntityException
    public function getList(SearchCriteriaInterface $criteria): OrderSearchResultsInterface;
    public function deleteById(int $id): void;
}
```

`Api/Data/OrderInterface` is the DTO — getters/setters plus field-name constants, no business logic, no persistence:
```php
namespace Acme\Sales\Api\Data;

interface OrderInterface
{
    public const STATUS = 'status';
    public function getEntityId(): ?int;
    public function getStatus(): string;
    public function setStatus(string $status): self;
}
```

## 2. DIP wiring — `di.xml` `<preference>` and constructor injection

A `<preference>` binds a contract to an implementation — the inversion the core skill calls the container's binding:
```xml
<!-- etc/di.xml -->
<preference for="Acme\Sales\Api\OrderRepositoryInterface"
            type="Acme\Sales\Model\OrderRepository"/>
<preference for="Acme\Sales\Api\Data\OrderInterface"
            type="Acme\Sales\Model\Data\Order"/>
```
Always **inject the interface** by constructor; let Magento's compiled DI resolve it:
```php
final class PlaceOrder implements PlaceOrderInterface   // Api/ port
{
    public function __construct(
        private readonly OrderRepositoryInterface $orders,     // contract, not the Model
        private readonly OrderInterfaceFactory $orderFactory,  // generated factory for Data models
    ) {}
}
```
The generated `…Factory` is the factory the no-`new` rule asks for (`solid.md` §DIP): a new instance is `$this->orderFactory->create()`, never `new Order()` and never a static named constructor. A value object gets one the same way: Magento generates a `…Factory` for any class a constructor asks for, so nobody writes a factory class by hand. Publish a `…FactoryInterface` of its own, bound by `<preference>` to the generated factory, only when other modules must hold it.

### The `ObjectManager` anti-pattern (DIP + SRP violation)
Never call `ObjectManager::get()`/`create()` in business code. It hides dependencies, defeats constructor injection, breaks testability, and is a hard review-fail. Allowed only in a few framework corners (factories you can't inject, static test setup). If you see it in a Block, Model, or service — that is debt to remediate.

### `virtualType` — configure, don't subclass
Need the same class with different constructor args? Use a **virtual type** in `di.xml` instead of a subclass. It's OCP-friendly configuration:
```xml
<virtualType name="AcmeSalesExpressValidator" type="Acme\Sales\Model\OrderValidator">
    <arguments><argument name="mode" xsi:type="string">express</argument></arguments>
</virtualType>
```

## 3. OCP without `switch`/`elseif` — injected pools

Same rule as everywhere: **no `switch`/`case` or `elseif` dispatch by type** (`solid.md` §OCP). In Magento, inject a **pool/array of strategy objects** via `di.xml` and resolve by `foreach`. Adding a variant = adding a class + an `<item>`, editing no existing code — and the strategy can live in a different module.

```php
namespace Acme\Shipping\Model;

use Acme\Shipping\Api\ShippingRateInterface;   // supports()/cost()

final class ShippingCostCalculator
{
    /** @param ShippingRateInterface[] $rates */
    public function __construct(private readonly array $rates) {}

    public function cost(ShipmentInterface $shipment): MoneyInterface
    {
        foreach ($this->rates as $rate) {
            if ($rate->supports($shipment->getMethod())) {
                return $rate->cost($shipment);        // guard clause + early return, no elseif
            }
        }
        throw new UnsupportedShippingMethodException(__($shipment->getMethod()));
    }
}
```
```xml
<type name="Acme\Shipping\Model\ShippingCostCalculator">
    <arguments>
        <argument name="rates" xsi:type="array">
            <item name="flat"   xsi:type="object">Acme\Shipping\Model\Rate\FlatRate</item>
            <item name="weight" xsi:type="object">Acme\Shipping\Model\Rate\WeightRate</item>
        </argument>
    </arguments>
</type>
```
This "pool via di.xml array" is the idiomatic Magento OCP pattern (the core uses it for command pools, validators, etc.).

## 4. Extension points — plugins & observers (with caveats)

- **Plugins** (`before`/`after`/`around` in `di.xml`) intercept public methods — powerful for extending *without editing*. But: `around` plugins obscure control flow and can break the intercepted method's contract (**LSP risk**); overuse turns behavior into spaghetti. Prefer `after` > `before` > `around`, and prefer an injected strategy pool over a plugin when *you* own the code.
- **Observers** (`events.xml`) — good for genuinely decoupled reactions (a domain-event seam). **Don't** hide core business logic in a fat observer; that scatters a use case across the codebase and is a common anemic-logic smell. Keep observers thin and delegate to a service behind `Api/`.

## 5. Where business logic must (and must not) live

| Put logic here | Never here |
|---|---|
| Service classes behind `Api/` (use cases) | Controllers (keep them humble — resolve, delegate, respond) |
| Domain service / model methods | Blocks (view logic only) and `.phtml` templates (never queries or rules) |
| Value objects (money, sku, qty) | Fat Observers as a hiding place for use cases |
| Repositories for persistence | Anywhere via `ObjectManager` |

Presentation logic belongs in a **ViewModel** (`Magento\Framework\View\Element\Block\ArgumentInterface`), injected into the template — not a fat Block:
```php
final class OrderSummary implements ArgumentInterface
{
    public function __construct(private readonly OrderRepositoryInterface $orders) {}
    public function totalFor(int $orderId): string { /* format for view */ }
}
```

## 6. A pragmatic "clean-ish" module layout
```
Acme/Sales/
  Api/            # service contracts (ports)  — @api
    Data/         # DTO interfaces (published language) — @api
  Model/          # implementations: repositories, services, Data models
    Rate/         # strategy objects for the pool
  Domain/         # (optional) pure VOs / domain services for complex modules
  etc/            # di.xml (preferences, pools, plugins), events.xml, webapi.xml
  Setup/ or db_schema.xml
```

## 7. DDD-lite in Magento — how far to go
Full tactical DDD (pure aggregates mapped to persistence) usually **isn't worth it** in Magento — the framework fights you and most modules are transaction scripts. Earn your abstractions:
- **Always cheap wins:** Value Objects for money/sku/quantity; Service Contracts as boundaries; logic in services not Blocks/Observers; injected strategy pools instead of `switch`.
- **Only for genuinely complex modules:** a pure `Domain/` layer (framework-free aggregates + VOs) mapped to/from `Model`s via a repository. Introduce it when invariants are complex and scattered — not by default.
- **Backward compatibility is part of the contract:** changing an `@api` interface's signature breaks consumers. Add a new method/interface rather than mutating a published one (OCP at the contract level).

## 8. The module's browser code — the PHP side of the seam

The script itself — its structure, how the page loads it, what it may assume — is reviewed with `architecture:clean-architecture-js` and `magento2:magento2-architecture-frontend` (RequireJS/Knockout, theme-assets vanilla scripts, Hyvä/Alpine). This skill owns what the module's PHP hands to it:

- **The ViewModel builds the config** — a typed array or DTO computed from services behind `Api/`, never in the template. When the block is cacheable, it contains nothing private: a customer's name, cart count or group price printed into full-page-cached HTML is served to every visitor of that page; private data reaches the script through customer-data sections or a private endpoint.
- **The template prints it escaped**: `Magento\Framework\Serialize\Serializer\JsonHexTag` into a `<script type="application/json">` block, or `$escaper->escapeHtmlAttr($json)` into a `data-*` attribute. Never `window.fooConfig = <?= json_encode(...) ?>` and never JSON assembled by hand around an unescaped `<?= $block->getX() ?>`.
- **The template asks for the asset through the renderer the project uses** — with `hryvinskyi/magento2-theme-assets`, `Hryvinskyi\ThemeAssets\Api\AssetRendererInterface` obtained through a typed layout argument checked with `instanceof`, through `$viewModels->require()`, or by constructor injection into the feature's ViewModel. `$viewModels->require()` is `ObjectManager::get()` underneath — one shared instance per request: fine for a stateless view model, wrong for one holding per-block state, which is built per block by a factory. Never `ObjectManager` in the template.
- **The module declares what it renders**: the package (`composer.json` require, `Hryvinskyi_ThemeAssets` in the `module.xml` sequence) and every module whose fileId (`Vendor_Module::js/file.js`) it renders — or the asset moves to its owner.
- **Wording** is translated with `__()` into the config or the markup, or with `$t()` and the module's `i18n/*.csv` in AMD code — never assembled in the browser from English literals.
- **The seam is tested by rendering**: a template test with a recording fake of `AssetRendererInterface` (a marker tag per fileId, mode and attributes) asserts what the template requests and the escaped config it prints. A test that reads the `.phtml` as text proves nothing (the engineering standards, §*Tests run code*).

## Magento 2 review checklist
- [ ] Consumers depend on `Api/` + `Api/Data/`, never on concrete `Model\`.
- [ ] No `ObjectManager` in business code; everything is constructor-injected.
- [ ] No `switch`/`elseif` behavioral dispatch — variants are a `di.xml`-injected strategy pool.
- [ ] `around` plugins are justified (not used where an `after` plugin or injected strategy would do); no plugin silently breaks a method's contract.
- [ ] No business logic in controllers, Blocks, `.phtml`, or fat Observers; ViewModels handle view logic.
- [ ] Stable contracts are marked `@api`; changes are additive (backward compatible).
- [ ] Value objects used for money/ids/quantities; complex modules only add a pure `Domain/` layer when invariants justify it.
- [ ] Browser-code seam: ViewModels build the config (nothing private in cacheable output); templates print it escaped (`JsonHexTag`, `escapeHtmlAttr`) and request assets through the project's renderer, never `ObjectManager`; the module declares the renderer's package and every module whose asset it renders; the browser code itself passes `architecture:clean-architecture-js`.

## 9. The core lenses in Magento's idiom

The core skill states each rule in plain PHP. This section is where those rules meet Magento's names.

### Layers

| Layer | In Magento 2 |
|-------|--------------|
| **Entities** | Domain model / service logic kept off `AbstractModel` where feasible |
| **Use Cases** | Service-contract implementations behind `Api/` |
| **Interface Adapters** | Controllers, Blocks/ViewModels, `Api/Data/` DTOs, ResourceModels, Magento repository *implementations* |
| **Frameworks & Drivers** | The Magento framework and kernel, MySQL, `di.xml` wiring and glue |

- **What the inner layers never import:** no `Magento\Framework\*`. In review, grep domain and application code for `Magento\Framework` and `ObjectManager`; an inner class that needs `di.xml` glue to work is a candidate violation. Magento base classes and the `ObjectManager` reached from domain or use-case code are the framework leaking inward.
- **What crosses a boundary:** never a Magento `Model`. In Magento this discipline is built in: **`Api/Data/` interfaces are the DTOs** that cross the service-contract boundary, never the `Model` (§1). A Magento `Model` crossing the API/service-contract boundary is a leaky boundary.
- **Plan mode in Magento's terms:** an adapter is the Magento `Api/` implementation (a repository, a management service); the wiring is a `di.xml` `<preference>` (§2); published contracts carry `@api`.
- **Debt specific to Magento:** business rules stranded in Observers and Blocks; never reach for `ObjectManager` to dodge injection (§2).

### Humble edges

Keep controllers and Blocks humble and push logic into a **ViewModel** (`ArgumentInterface`) or a service behind `Api/` — never business logic in a `.phtml` template or a fat Block (§5).

### Modules, rings and enforcement

- Magento already forces capability-first modules (`Vendor/Ordering`, `Vendor/Billing`), each with its own `Api/ Model/ etc/`. That module boundary *is* your architectural boundary — respect it. One bounded context ≈ one module `Vendor_Module`, exposing only its `Api/` service contracts.
- Every `module.xml` `<sequence>` entry is a package-level edge like a `composer.json` require, and points inward.
- Magento core models bridges: `Magento_CatalogInventory`, `Magento_GroupedProduct` are bridges over `Catalog`+`Inventory`, `Catalog`+`Sales`.
- Vocabulary is a dependency in `di.xml` too: it names only modules the module declares.
- **Enforcement:** no Deptrac by default; rely on the `@api` annotation to mark stable contracts, depend only on other modules' `Api/`, and keep `composer.json` `require` honest so module dependencies are explicit and acyclic. `module.xml` `<sequence>` + `composer.json` mirror the same inward edges; no tool checks resource ownership, so grep for your module's config paths/table names in *other* modules' `etc/` during review.
- **Outer rings contributing to an inner module:** `di.xml` array/pool arguments into an inner composite; `system.xml` sections shipped per module; extension attributes on inner DTOs; observers on inner events.

### SOLID

- **OCP:** strategy pools are a `di.xml` array (§3). Other extension points: plugins and `events.xml` observers. Prefer adding a strategy to the pool over an `around` plugin — plugins are powerful but obscure control flow (§4).
- **LSP:** a plugin that changes a public method's documented contract for some callers is an LSP hazard.
- **ISP:** Magento's Service Contracts are deliberately split (`OrderRepositoryInterface` vs `OrderManagementInterface`) for the role-interface reason.
- **DIP:** the service locator is `ObjectManager::get()`/`create()` (§2). Detection recipe, with `solid.md`'s conventions:

  | Principle | Search | Cleared when |
  |---|---|---|
  | DIP | `ObjectManager::` | never in domain or application code |

  A client a recipe finds is built by the container from its definition in `di.xml`.

### No `new`, in Magento's vocabulary

- **Factories:** Magento generates a `…Factory` for any class, and its `create()` asks the ObjectManager (§2).
- **The composition root** is Magento's bootstrap.

### DDD

- **Published Language:** the module's `Api/Data/` DTOs.
- **Load `ddd.md` for any `Api/Data/` type.** A session that read only the core `SKILL.md` shipped a closed value object in a Magento `Api/Data/` with no extension point, unvalidated fields and no interface.
- **DDD-lite:** Magento is a framework-first model. Its models extend `\Magento\Framework\Model\AbstractModel` and are coupled to ResourceModels — genuinely rich, persistence-free aggregates are hard, and full tactical DDD is usually **overkill** for a typical module. Treat **Service Contracts** (`Api/` + `Api/Data/`) as your published language and use-case boundary; concentrate business rules in domain service classes, not in Blocks, controllers, templates, or fat Observers. How far to go: §7.
- **Repositories:** the implementation is a Magento repository behind `Api/OrderRepositoryInterface` (§1).

### Integration patterns on Magento

- **Outbox:** `queue_message` written through the publisher inside the same DB transaction behaves as an outbox with the `db` connection, and not with `amqp`.
- **Dual-write recipe:** the transport for a message class is declared in `queue_topology.xml`.
- **Consumer recipe:** the consumers to check for idempotency are the `ConsumerInterface` implementations.
- **A cache or resilience decorator** is wired by a `di.xml` `<preference>` for the port that points at the decorator, whose `<type>` argument injects the real implementation.

### The browser half

The JavaScript a Magento module ships — RequireJS/Knockout and jQuery widgets, Hyvä/Alpine, vanilla scripts and styles rendered through `hryvinskyi/magento2-theme-assets` — is reviewed with `architecture:clean-architecture-js` and `magento2:magento2-architecture-frontend`; a change that touches JS/TS loads both. A Knockout component fusing rules, wording and transport is the PHP rubric's pitfall 10 on this stack. The seam on the PHP side is §8: the ViewModel that builds a widget's config, the template that prints it escaped and asks the renderer for the asset.

### References

- Magento *Service Contracts* — https://developer.adobe.com/commerce/php/development/components/service-contracts/

## Implementer checklist on this stack

Read with the core skill's `references/implementer-checklist.md`.

- Inner code names no `Magento\Framework` class and no `ObjectManager`.
- What crosses a boundary: `Api/` + `Api/Data/` contracts, never `AbstractModel`s. Wiring is a `di.xml` preference or plugin; a class that is built but never wired ships nothing, so a test resolves it through the real container.
- Factories: Magento generates `…Factory`, whose `create()` asks the ObjectManager; nobody writes one by hand. The composition root is Magento's bootstrap.
- Declared dependencies are the `module.xml` sequence and the composer require; a neighbour's name appears in neither the code nor the wiring unless it is declared there.
- The browser seam: the ViewModel builds the config, the template prints it escaped and asks the renderer for the asset (§8). JS/TS source is written against `architecture:clean-architecture-js` and `magento2:magento2-architecture-frontend`.
