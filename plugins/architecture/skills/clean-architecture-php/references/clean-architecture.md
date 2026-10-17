# Clean Architecture — the dependency rule in PHP

Deep dive into Uncle Bob's rules with Symfony and Magento 2 code. Load `solid.md` for the principles, `ddd.md` for the domain patterns, and the framework files for wiring.

## 1. The Dependency Rule (the whole game)

> Source-code dependencies may point **only inward**. Nothing in an inner circle may know anything about an outer circle — not a name, not a type, not a function.

Concentric circles, outer → inner: **Frameworks & Drivers → Interface Adapters → Use Cases → Entities.** Business rules (inner) are the reason the software exists; frameworks and the database (outer) are *delivery details* that could be swapped. Point every `use` statement that crosses a boundary toward the center.

The corollary that trips people up: **the flow of control and the direction of the source dependency can be opposite.** A use case *calls out* to a database at runtime, yet the *source dependency* runs from the database adapter *into* the use case — because the use case defines the interface and the adapter implements it. That inversion is Dependency Inversion (DIP), and it is how every boundary is crossed cleanly.

## 2. The four layers, and what lives where

### Entities — Enterprise Business Rules
Pure domain: aggregates, entities, value objects, domain services, domain events. **Zero framework imports.** No Doctrine, no `Magento\Framework\*`, no `Symfony\*`, no `Request`, no annotations that pull in a library at runtime. If the business would have this rule even with pen and paper, it belongs here.

### Use Cases — Application Business Rules
One class per application action ("place order", "cancel subscription"). Orchestrates entities and **declares the ports** (interfaces) it needs from the outside world: repositories, gateways, clocks, notifiers. Depends on Entities and on its own port interfaces — never on a concrete adapter.

### Interface Adapters
The translation layer. Controllers, presenters/ViewModels, API Platform state providers/processors, Doctrine repository *implementations*, Magento repository *implementations*, DTO ↔ entity mappers. Converts between the shape the outer world speaks (HTTP JSON, DB rows) and the shape the use cases speak (DTOs, domain objects). **Contains no business rules.**

### Frameworks & Drivers
Symfony/Magento kernel, Doctrine, the message transport, the HTTP client, MySQL, `di.xml`/`services.yaml` glue. Mostly configuration and third-party code. The most volatile ring — and nothing inward is allowed to depend on it.

## 3. Crossing a boundary with DIP (Output Port)

A use case must hand results to a presenter, or persist through a repository, without depending on either. It **owns the interface**; the outer layer implements it.

```php
// ── Use Case layer (inner) ────────────────────────────────
namespace App\Application\Order;

/** Output port — defined by the use case, implemented outside. */
interface PlaceOrderOutput
{
    public function placed(OrderId $id, Money $total): void;
    public function rejected(string $reason): void;
}

/** Driven port the use case needs from infrastructure. */
interface OrderRepository
{
    public function save(Order $order): void;
    public function nextIdentity(): OrderId;
}

final class PlaceOrder
{
    public function __construct(
        private readonly OrderRepository $orders,   // port, not a Doctrine class
        private readonly OrderFactoryInterface $orderFactory,      // creation goes through factories,
        private readonly OrderLineFactoryInterface $orderLines,    // never `new` or `Order::draft()`
        private readonly OrderEventFactoryInterface $orderEvents,  // (ddd.md §Creation lives in factories)
        private readonly MoneyFactoryInterface $money,
    ) {}

    public function handle(PlaceOrderCommand $cmd, PlaceOrderOutput $out): void
    {
        $order = $this->orderFactory->draft($this->orders->nextIdentity(), $cmd->customerId);
        foreach ($cmd->lines as $line) {
            $order->addLine($this->orderLines->line($line->productId, $line->qty, $line->unitPrice));
        }
        $order->place($this->orderEvents);   // invariant lives in the entity
        $this->orders->save($order);
        $out->placed($order->id(), $order->total($this->money));
    }
}

// ── Interface Adapters layer (outer) — depends inward ─────
namespace App\Infrastructure\Http;

final class JsonOrderPresenter implements PlaceOrderOutput
{
    public array $body = [];
    public int $status = 200;

    public function placed(OrderId $id, Money $total): void
    { $this->body = ['id' => (string) $id, 'total' => $total->format()]; }

    public function rejected(string $reason): void
    { $this->status = 422; $this->body = ['error' => $reason]; }
}
```

Control flows `PlaceOrder → PlaceOrderOutput` at runtime; the *source dependency* runs `JsonOrderPresenter → PlaceOrderOutput` (inward). Boundary crossed, rule intact.

> **Pragmatic note.** The full Input/Output-Port ceremony pays off for complex flows or when one use case feeds several presenters (HTTP + CLI + export). For a plain CRUD action, returning a DTO from the handler and letting the controller shape the response is honest and lighter — don't invent a presenter interface with one implementation. See the pragmatism section of `SKILL.md`.

## 4. What is allowed to cross a boundary

Only **simple, inward-friendly data**: DTOs, value objects, primitives. **Never** a persistence entity, an ORM row, a `Request`/`Response`, or a Magento `Model`. If the database schema or an HTTP payload can reach a use case unchanged, the schema/payload has become your business contract — and every DB migration or API tweak now ripples inward.

```php
// ❌ ORM/persistence entity escaping to the delivery mechanism
final class OrderController
{
    public function show(int $id): JsonResponse
    {
        $order = $this->doctrine->find(OrderEntity::class, $id); // Doctrine entity
        return new JsonResponse($order); // schema is now the public API; lazy-loads leak (and `new` in a controller)
    }
}

// ✅ A DTO defines the contract; mapping happens in the adapter
final class OrderView
{
    /** @param list<array{sku:string, qty:int}> $lines */
    public function __construct(
        public string $id,
        public string $status,
        public string $total,
        public array $lines,
    ) {}
}
```

In Magento this discipline is built in: **`Api/Data/` interfaces are the DTOs** that cross the service-contract boundary, never the `Model`. See `magento2.md`.

## 5. Wiring the inversion (DI is where it becomes real)

An interface alone inverts nothing until the container binds it to an implementation.

**Symfony** — alias the port to its adapter (or autowire by type):
```yaml
# config/services.yaml
services:
    App\Application\Order\OrderRepository:
        alias: App\Infrastructure\Doctrine\DoctrineOrderRepository
```

**Magento 2** — a `<preference>` is the same inversion:
```xml
<!-- etc/di.xml -->
<preference for="Acme\Sales\Api\OrderRepositoryInterface"
            type="Acme\Sales\Model\OrderRepository"/>
```

Both let you swap the outer implementation (Postgres → in-memory fake in tests, one gateway → another) without touching a line of inner code. That swappability *is* the payoff you are testing for in review.

## 6. The Humble Object pattern (thin edges)

Hard-to-test boundary code (controllers, Blocks, message handlers, CLI commands) should be **humble**: extract everything testable into a use case, leave only untestable glue at the edge.

```php
// ✅ Humble controller — parse, delegate, present. No business logic, no `new`.
#[Route('/orders', methods: ['POST'])]
final class PlaceOrderController extends AbstractController
{
    public function __construct(
        private readonly PlaceOrder $useCase,
        private readonly JsonOrderPresenterFactoryInterface $presenters,  // per-request state: a fresh one each call
    ) {}

    public function __invoke(#[MapRequestPayload] PlaceOrderCommand $cmd): JsonResponse  // translate
    {
        $out = $this->presenters->create();
        $this->useCase->handle($cmd, $out);                       // delegate
        return $this->json($out->body, $out->status);             // present
    }
}
```
Each object has a named source: the command is mapped by the framework (`#[MapRequestPayload]`), the presenter holds one request's state and so comes from its factory rather than being a shared service, and the response comes from the framework's own helper (`AbstractController::json()`). A project that keeps controllers off the base class injects a responder service from the container instead, and the responder takes its `JsonResponse` from a generated factory (`symfony.md` §10).

Magento equivalents: keep controllers/Blocks humble and push logic into a **ViewModel** (`ArgumentInterface`) or a service behind `Api/` — never business logic in a `.phtml` template or a fat Block.

## 7. Screaming Architecture

The top-level structure should **scream the domain, not the framework**. Opening `src/` should tell you the app is about *ordering* and *billing*, not that it is "a Symfony app." Group by capability/bounded context, then by layer inside — not one global `Controllers/`, `Models/`, `Services/` triad.

```
# ✅ Screams the domain (Symfony)                 # ❌ Screams the framework
src/Ordering/                                     src/Controller/
  Domain/        (entities, VOs, ports)           src/Entity/
  Application/   (use cases, DTOs)                 src/Repository/
  Infrastructure/(Doctrine, HTTP, CLI)             src/Service/
src/Billing/                                       src/Form/
  Domain/ Application/ Infrastructure/
```

Magento already forces capability-first modules (`Vendor/Ordering`, `Vendor/Billing`), each with its own `Api/ Model/ etc/`. That module boundary *is* your architectural boundary — respect it (see `magento2.md`).

**A modular-monolith Symfony project** takes the same stance: one Composer package per bounded context under `packages/{module}/`, each exposing only `Api/`, `Event/`, `Entity/` to the outside. That package boundary is the clean-architecture boundary.

## 8. Enforcing boundaries mechanically

Discipline decays; enforce it in CI.

- **Deptrac** (Symfony) — declare layers and the only-inward ruleset; the build fails on any violation. Run it with zero per-class exceptions — that is what forces a cross-module dependency to go through an `Api/` interface.

```yaml
# deptrac.yaml (illustrative)
deptrac:
  layers:
    - name: Domain
      collectors: [{ type: directory, value: 'src/.*/Domain/.*' }]
    - name: Application
      collectors: [{ type: directory, value: 'src/.*/Application/.*' }]
    - name: Infrastructure
      collectors: [{ type: directory, value: 'src/.*/Infrastructure/.*' }]
  ruleset:
    Domain: ~                      # Domain may depend on nothing outward
    Application: [Domain]
    Infrastructure: [Domain, Application]
```

- **Magento** — no Deptrac by default; rely on the `@api` annotation to mark stable contracts, depend only on other modules' `Api/`, and keep `composer.json` `require` honest so module dependencies are explicit and acyclic.

## Review checklist

- [ ] No inner layer names an outer concrete class (grep domain/application for `Doctrine`, `Magento\Framework`, `Symfony\Component\HttpFoundation`, `ObjectManager`).
- [ ] Every cross-boundary dependency is an interface owned by the inner side.
- [ ] Only DTOs/value objects/primitives cross boundaries — no ORM entities or `Model`s, no `Request`/`Response`.
- [ ] The container actually binds each port to an adapter (`services.yaml` alias / `di.xml` preference).
- [ ] Controllers/Blocks/handlers are humble; business rules sit in use cases/entities.
- [ ] Top-level packages read as domain capabilities, not framework folders.
- [ ] Boundaries are enforced by tooling (Deptrac / `Api/`-only rule / `@api`), not just convention.
- [ ] Each abstraction protects a *real* axis of change (no single-impl ceremony). Factories are not ceremony: they are interfaces the container implements, and nothing else may create an object (`solid.md` §DIP).
