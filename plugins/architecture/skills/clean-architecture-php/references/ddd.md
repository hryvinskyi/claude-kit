# Domain-Driven Design in PHP

DDD supplies the *content* of the inner circles that `clean-architecture.md` keeps pure. **Strategic** DDD draws the boundaries (which map to modules); **tactical** DDD shapes the model inside one. Use it where the domain is complex enough to earn it — for CRUD, a rich aggregate is over-engineering (see pragmatism in `SKILL.md`).

---

## Part 1 — Strategic design

### Ubiquitous language
One language per context, shared by code and domain experts. The class, method, and event names *are* the domain terms. If experts say "place an order" and "fulfil a shipment", the code has `$order->place()` and `$shipment->fulfil()` — not `OrderService::process()`. A review that finds CRUD verbs (`create/update/save`) where the business has real verbs is finding a language leak.

### Bounded context = module
A **bounded context** is a boundary within which one model and one language are consistent. The same word means different things across contexts: a *Product* in Catalog (title, media, attributes) is not the *Product* in Sales (sku, price, qty ordered). Do not build one shared "Product" class for both — model each context's own.

- **Symfony modular monolith:** one bounded context ≈ one Composer package under `packages/{module}/`, exposing only `Api/`, `Event/`, `Entity/`.
- **Magento 2:** one bounded context ≈ one module `Vendor_Module`, exposing only its `Api/` service contracts.

### Context mapping — how contexts relate

| Pattern | Meaning | PHP realization |
|---|---|---|
| **Published Language** | A stable, shared contract vocabulary | Magento `Api/Data/` DTOs; a module's `Api/` VOs/interfaces |
| **Open Host Service** | A context offers a defined service to others | A module's `Api/` service interfaces |
| **Anti-Corruption Layer (ACL)** | Translate another context's model so it can't leak in | An adapter that maps the other module's DTO → your domain VO |
| **Shared Kernel** | A small model shared by two teams (use sparingly) | A `Shared` module of common VOs (`Money`, `EmailAddress`) |
| **Conformist / Customer-Supplier** | Downstream conforms to / negotiates with upstream | Consuming another module's `Api/` as-is vs. agreeing a contract |

**Anti-Corruption Layer in PHP** — the key defensive pattern. Never let another context's shape become your domain's:
```php
// Billing context must not depend on Sales' internals — translate at the seam
namespace App\Billing\Infrastructure\Acl;

use App\Sales\Api\OrderData;          // the ONLY thing we import from Sales (its published language)

final class SalesOrderTranslator
{
    public function __construct(
        private readonly InvoiceLineFactoryInterface $invoiceLines,   // Billing's own factories create Billing's values
        private readonly SkuFactoryInterface $skus,
        private readonly MoneyFactoryInterface $money,
    ) {}

    /** Map the foreign DTO into Billing's own value objects. */
    public function toInvoiceLines(OrderData $order): InvoiceLines
    {
        return $this->invoiceLines->lines(array_map(
            fn (array $l): InvoiceLine => $this->invoiceLines->line(
                $this->skus->create($l['sku']),
                $this->money->create($l['amount'], Currency::from($l['currency'])),
            ),
            $order->lines,
        ));
    }
}
```
A modular monolith's "cross-module access only via `Api/`, `Event/`, `Entity/`" rule *is* Published Language + OHS (enforce it with Deptrac); when the foreign shape is awkward, wrap it in an ACL rather than bending your model.

---

## Part 2 — Tactical building blocks

### Creation lives in factories
**Code never writes `new`, and never hides one in a static named constructor** (`Money::ofMinor()`, `Order::draft()`, `OrderId::generate()` each do `new self(...)`). An object comes from the container, or — when a genuinely new instance is needed — from an injected factory. **A factory is an interface; the container writes its implementation, never a person**: Magento generates `…Factory` (its `create()` asks the ObjectManager); Symfony ships no generator, so use the compile-time one the project's docs name (`symfony.md` §10) — and if there is none, that is a plan decision, not a licence to hand-write `new`. **A factory method only creates**: one object per method, from its arguments, no computation.

Why: it is DIP at the call site. A `new`, or a static call that makes one, binds the caller to one concrete class, and nothing can be substituted for it — not a fake, not a decorator, not a second implementation. A factory interface is a seam the container fills.

- **Value object** — created by its factory (`$this->money->create(500, Currency::EUR)`). An operation that yields a new value computes on the value or in a domain service, then asks the factory for the object carrying the result (`$a->plus($b, $this->money)`). The VO stays immutable and its constructor still refuses an invalid value.
- **Aggregate** — `OrderFactoryInterface::draft(OrderId, CustomerId): Order`. A child is created by its own factory (`OrderLineFactoryInterface`) in the use case and handed to the root (`$order->addLine($line)`), which enforces its invariants on what it is given.
- **Identity** — the repository's `nextIdentity()`, backed by an injected `OrderIdGeneratorInterface::next()`: a service that draws the value and asks the id factory for the `OrderId`.
- **Domain event** — the aggregate records it through an event factory the use case holds and hands to the behaviour method: `$order->place($this->orderEvents)`. The root decides *that* it happened; the factory creates the object. This is the one pattern for events throughout this skill.
- **Time** — an injected clock (`ClockInterface`, PSR-20; Symfony's extends it), never `new \DateTimeImmutable()`.

An aggregate has no container, so a factory reaches it as a method argument — `place()` receives `$events`, `total()` receives `$money`.

Exempt: `throw new …Exception`, attribute metadata, tests, and the composition root (the one place that builds the container, before any exists: `new Kernel(...)` in the front controller or `bin/console`, Magento's bootstrap), not wiring code in general.

### Value Object — immutable, equality by value, valid by construction
No identity; two are equal iff their values are. Enforce invariants in the constructor so an invalid instance cannot exist; only the value's factory calls that constructor. PHP 8.2+ `readonly` classes are ideal.

```php
final readonly class Money
{
    public function __construct(              // reached only through MoneyFactoryInterface
        public int $minorUnits,               // store integer minor units; never float money
        public Currency $currency,            // a backed enum: Currency::from('EUR') instantiates nothing
    ) {}

    public function isNegative(): bool { return $this->minorUnits < 0; }

    public function equals(self $other): bool
    {
        return $this->minorUnits === $other->minorUnits && $this->currency === $other->currency;
    }

    /** The rule stays on the value; the new value comes from the factory it is handed. */
    public function plus(self $other, MoneyFactoryInterface $money): self
    {
        if ($this->currency !== $other->currency) {
            throw new CurrencyMismatch($this->currency, $other->currency);
        }

        return $money->create($this->minorUnits + $other->minorUnits, $this->currency);
    }
}

interface MoneyFactoryInterface               // the whole factory: the container generates its implementation
{
    public function create(int $minorUnits, Currency $currency): Money;   // creates; computes nothing
}
```
Good VO candidates: `Money`, `EmailAddress`, `Sku`, `Quantity`, `DateRange`, `Percentage`, `OrderId`. They delete whole classes of validation and "stringly-typed" bugs.

### Entity — identity + lifecycle
Equality by **identity**, not attributes; it changes over time but stays the same thing. Wrap the id in a VO (`OrderId`) rather than passing raw `int`/`string`.

### Aggregate & Aggregate Root — the consistency boundary
An **aggregate** is a cluster of entities/VOs treated as one unit for changes; the **root** is the only entry point, and it enforces the aggregate's invariants. Outside code holds a reference only to the root, and references *other* aggregates **by id**, never by object.

```php
final class Order                       // aggregate root
{
    /** @var list<OrderLine> */
    private array $lines = [];
    private OrderStatus $status = OrderStatus::Draft;
    /** @var list<object> */
    private array $recordedEvents = [];

    public function __construct(                   // reached only through OrderFactoryInterface
        private readonly OrderId $id,
        private readonly CustomerId $customerId,   // reference another aggregate BY ID
    ) {}

    public function addLine(OrderLine $line): void  // the use case builds the line through OrderLineFactoryInterface
    {
        if ($this->status !== OrderStatus::Draft) {
            throw new OrderAlreadyPlaced($this->id);          // invariant enforced at the root
        }
        $this->lines[] = $line;
    }

    public function place(OrderEventFactoryInterface $events): void
    {
        if ($this->lines === []) {
            throw new CannotPlaceEmptyOrder($this->id);       // invariant: no empty orders
        }
        $this->status = OrderStatus::Placed;
        $this->recordedEvents[] = $events->placed($this->id); // the root decides, the factory creates
    }

    public function total(MoneyFactoryInterface $money): Money   // an order with lines; place() refuses one without
    {
        $total = $this->lines[0]->subtotal();
        foreach (\array_slice($this->lines, 1) as $line) {
            $total = $total->plus($line->subtotal(), $money);   // the rule on the value, the object from the factory
        }
        return $total;
    }

    /** @return list<object> */
    public function releaseEvents(): array
    {
        $events = $this->recordedEvents;
        $this->recordedEvents = [];
        return $events;
    }
}
```
Rules: **one repository per aggregate root**; keep aggregates small (favor referencing by id over deep object graphs); one transaction = one aggregate changed where you can manage it.

### Repository — collection illusion for aggregates
An in-memory-collection abstraction over persistence. The **interface lives with the domain** (a port); the implementation lives in infrastructure.

```php
namespace App\Sales\Domain;            // port — owned by the domain

interface OrderRepository
{
    public function nextIdentity(): OrderId;
    public function get(OrderId $id): Order;         // throws OrderNotFound
    public function save(Order $order): void;
}
```
Implementations: Doctrine (Symfony) / a Magento repository behind `Api/OrderRepositoryInterface`. See `symfony.md` and `magento2.md`.

### Domain Service — logic that belongs to no single entity
When a rule spans multiple aggregates or needs collaborators, and forcing it into one entity would be artificial, use a stateless **domain service** (named in the ubiquitous language). Distinct from an *application service* (below).

```php
namespace App\Pricing\Domain;

/** Pure domain policy — no framework, no persistence. */
final class DiscountPolicy
{
    public function priceFor(Order $order, CustomerTier $tier): Money
    {
        // business rule spanning order + customer tier
    }
}
```

### Domain Event — something the domain announces happened
Past tense, immutable, named in the language (`OrderPlaced`). The aggregate records them through the event factory it is handed (§*Creation lives in factories*); the application layer dispatches them after persistence. They let other contexts react without inbound coupling (a form of OHS).

```php
final readonly class OrderPlaced
{
    public function __construct(public OrderId $orderId) {}
}

interface OrderEventFactoryInterface          // domain port; the container generates its implementation
{
    public function placed(OrderId $id): OrderPlaced;
}
```

### Factory & Specification
- **Factory** — not a pattern kept for complex construction: every creation goes through one (§*Creation lives in factories*). A factory is an interface nobody implements by hand, so it costs a few lines; it is the seam, not ceremony.
- **Specification** (use when it earns it) — a reusable, composable predicate (`$spec->isSatisfiedBy($order)`) for selection/validation rules you compose (`->and()`, `->or()`). Skip it for one-off `if`s.

---

## Application service vs domain service
- **Application service (use case)** — orchestrates: loads aggregates via repositories, calls their methods, saves, dispatches events, manages the transaction. Thin; contains **no business rules**. Lives in the Use Cases layer.
- **Domain service** — a *piece of business logic* that doesn't fit one entity. No transactions, no repositories-as-orchestration. Lives in the Entities layer.

```php
final class PlaceOrder                  // application service (use case)
{
    public function __construct(
        private readonly OrderRepository $orders,
        private readonly OrderFactoryInterface $orderFactory,
        private readonly OrderLineFactoryInterface $orderLines,
        private readonly OrderEventFactoryInterface $orderEvents,
        private readonly DiscountPolicy $pricing,       // domain service
        private readonly DomainEventBus $events,
    ) {}

    public function handle(PlaceOrderCommand $cmd): OrderId
    {
        $order = $this->orderFactory->draft($this->orders->nextIdentity(), $cmd->customerId);
        foreach ($cmd->lines as $l) {
            $unitPrice = $this->pricing->unitPriceFor($l->sku, $cmd->tier);
            $order->addLine($this->orderLines->line($l->sku, $l->qty, $unitPrice));
        }
        $order->place($this->orderEvents);
        $this->orders->save($order);
        foreach ($order->releaseEvents() as $event) {
            $this->events->publish($event);
        }
        return $order->id();
    }
}
```

---

## Anemic vs rich model (the #1 review finding)
**Anemic** = entities are getter/setter bags and all rules live in `*Service`/`*Manager`/`*Helper`/Observers. It voids the point of a domain layer. **Rich** = the aggregate owns its invariants; you cannot reach an invalid state through its API. Move the rule to where the data lives.

```php
// ❌ Anemic — the rule is outside the thing it governs
$order->setStatus('placed');                 // anyone can set any status, any time
if ($order->getLines() === []) { /* caller must remember to check */ }

// ✅ Rich — the aggregate refuses illegal transitions itself
$order->place($this->orderEvents);           // throws CannotPlaceEmptyOrder / OrderAlreadyPlaced
```

---

## Magento 2 reality check — DDD-lite
Magento's models extend `\Magento\Framework\Model\AbstractModel` and are coupled to ResourceModels — genuinely rich, persistence-free aggregates are hard, and full tactical DDD is usually **overkill** for a typical module. Pragmatic path:
- Treat **Service Contracts** (`Api/` + `Api/Data/`) as your published language and use-case boundary; keep orchestration in service classes behind `Api/`.
- Concentrate business rules in **domain service classes**, not in Blocks, controllers, templates, or fat Observers.
- Use **Value Objects** freely for money, sku, quantities even inside a mostly-transaction-script module — they pay off immediately.
- Introduce a **pure domain layer mapped to/from persistence models via a repository** only for genuinely complex modules; otherwise it's ceremony. Details and pitfalls: `magento2.md`.

---

## DDD review checklist
- [ ] Names come from the ubiquitous language (real business verbs, not CRUD).
- [ ] Each bounded context = one module; the same term isn't force-shared across contexts.
- [ ] Cross-context access goes through published language (`Api/`) or an ACL — no reaching into internals.
- [ ] Invariants live **inside** aggregates; no anemic setter-driven state changes.
- [ ] Value objects replace stringly-typed money/ids/quantities and validate on construction.
- [ ] Nothing written by a person says `new` — factories are interfaces the container implements, their methods only create, no static named constructors; an aggregate receives the factories it needs as method arguments.
- [ ] One repository per aggregate root; aggregates reference each other **by id**.
- [ ] Application services orchestrate and stay rule-free; domain services hold cross-entity rules.
- [ ] Tactical machinery is applied where complexity earns it — not on CRUD.
