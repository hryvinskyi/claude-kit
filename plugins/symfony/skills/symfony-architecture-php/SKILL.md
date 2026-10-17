---
name: symfony-architecture-php
description: Symfony's idiom for the architecture:clean-architecture-php rubric — where each layer goes in Symfony 7/8, API Platform, Doctrine and Messenger; services.yaml wiring, tagged iterators and compiler passes, generated factories and native lazy services, humble controllers, the outbox and retries on Messenger, decorators and caches, and detection recipes in Symfony's spelling. Use together with architecture:clean-architecture-php whenever PHP in a Symfony project is reviewed, planned or written; the browser half (Stimulus, Turbo, Live and Twig Components, AssetMapper, React islands) is symfony:symfony-architecture-frontend.
---

Load this skill together with `architecture:clean-architecture-php`. A file named without a skill
(`clean-architecture.md`, `solid.md`, `ddd.md`, `onion-modules.md`, `integration-patterns.md`,
`SKILL.md`) is that core skill's.

# Clean Architecture in Symfony

How the layers, SOLID, and DDD map onto Symfony 7/8, API Platform, Doctrine, and Messenger. Read `clean-architecture.md` and `ddd.md` first; this skill is the framework-specific "where does it go".

## 1. Structure — two viable layouts

**A. Layered-per-context** (classic clean architecture), when a context is complex:
```
src/Ordering/
  Domain/          # entities, VOs, aggregates, domain services, repository INTERFACES, events
  Application/     # use cases (handlers), command/query DTOs, port interfaces
  Infrastructure/  # Doctrine repos, HTTP clients, Messenger, framework glue
  UI/              # controllers, API Platform resources, CLI commands
```

**B. Modular-monolith package**, one Composer package per bounded context:
```
packages/{module}/src/
  Api/             # PUBLIC contracts: service interfaces + VOs other modules may use
  Entity/          # Doctrine entities (public — other modules may read them)
  Event/           # public domain events
  Service/         # private application/domain logic (never imported cross-module)
  Repository/      # private Doctrine repositories
  Controller/  Resources/config/services.yaml  Migrations/
```
Here the **package boundary is the architectural boundary**: cross-module access is allowed *only* through `Api/`, `Event/`, `Entity/`, enforced by Deptrac. Pick layout A inside a package when its domain justifies a dedicated `Domain/`; otherwise the module's own folders are enough. Don't impose four folders on a CRUD module.

## 2. Keeping the domain framework-free (Doctrine)

The domain must not depend on Doctrine. Three mapping options, purest first:

- **XML/PHP mapping in Infrastructure** — the entity is plain PHP; mapping lives in `config/doctrine/Order.orm.xml`. Purest, most boilerplate.
- **Attributes on the entity** — the pragmatic middle ground (`#[ORM\Entity]` on `Entity/` classes). Doctrine attributes are metadata, not runtime calls; the tradeoff (a framework annotation touching the domain class) is usually worth the ergonomics. Keep *behavior* framework-free even if mapping attributes live on the class.
- Avoid: entities extending a Doctrine base class, or calling the EntityManager from inside themselves.

**Repository interface in the domain, implementation in infrastructure:**
```php
// packages/sales/src/Api/OrderRepositoryInterface.php  (or Domain/ in layout A) — the PORT
namespace Acme\Sales\Api;

interface OrderRepositoryInterface
{
    public function nextIdentity(): OrderId;
    public function get(OrderId $id): Order;          // throws OrderNotFound
    public function save(Order $order): void;
}

// packages/sales/src/Repository/DoctrineOrderRepository.php — the ADAPTER
namespace Acme\Sales\Repository;

final class DoctrineOrderRepository implements OrderRepositoryInterface
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly OrderIdGeneratorInterface $ids,   // not a static `OrderId::generate()`
    ) {}

    public function get(OrderId $id): Order
    {
        return $this->em->find(Order::class, (string) $id)
            ?? throw new OrderNotFound($id);
    }
    public function save(Order $order): void { $this->em->persist($order); $this->em->flush(); }
    public function nextIdentity(): OrderId { return $this->ids->next(); }
}
```

## 3. Application layer — handlers & transactions

Use Messenger for command/query handlers, or plain invokable services. Keep them thin (orchestrate, don't decide).

```php
#[AsMessageHandler]
final class PlaceOrderHandler
{
    public function __construct(
        private readonly OrderRepositoryInterface $orders,   // port
        private readonly OrderFactoryInterface $orderFactory,        // creation: factories, never `new`
        private readonly OrderLineFactoryInterface $orderLines,      // or a static named constructor
        private readonly OrderEventFactoryInterface $orderEvents,    // (ddd.md §Creation lives in factories)
        private readonly MessageBusInterface $eventBus,      // for domain events
    ) {}

    public function __invoke(PlaceOrder $command): void
    {
        $order = $this->orderFactory->draft($this->orders->nextIdentity(), $command->customerId);
        foreach ($command->lines as $l) { $order->addLine($this->orderLines->line($l->sku, $l->qty, $l->unitPrice)); }
        $order->place($this->orderEvents);
        $this->orders->save($order);
        foreach ($order->releaseEvents() as $event) { $this->eventBus->dispatch($event); }
    }
}
```
Wrap multi-step writes in a transaction at this layer (`$em->wrapInTransaction(...)` or a middleware) — the domain shouldn't know about transactions.

## 4. DIP wiring — `services.yaml`

Bind each port to its adapter; autowiring resolves the rest by type-hint. In a modular monolith, alias each `Api/` interface to its concrete implementation:
```yaml
services:
    _defaults: { autowire: true, autoconfigure: true }

    # port → adapter (DIP made real)
    Acme\Sales\Api\OrderRepositoryInterface:
        alias: Acme\Sales\Repository\DoctrineOrderRepository
```

**OCP strategy pools (no switch/elseif) — tagged collection.** Tag the `Api/` interface, inject a `!tagged_iterator`; a new strategy — even from another module — joins automatically (see `solid.md` §OCP):
```php
#[AutoconfigureTag('acme.shipping_rate')]
interface ShippingRate { /* supports()/cost() */ }
```
```yaml
services:
    _instanceof:
        Acme\Shipping\Api\ShippingRate: { tags: ['acme.shipping_rate'] }
    Acme\Shipping\Service\ShippingCostCalculator:
        arguments: [!tagged_iterator acme.shipping_rate]
```
> Gotcha: for a tagged **`Api/` interface** to be discovered, ensure `Api/` is included in the package's `services.yaml` resource glob — otherwise the tag never registers and the pool is silently empty.

## 5. Delivery — humble controllers & API Platform

Controllers translate and delegate only (`clean-architecture.md` §6). With API Platform, **don't expose Doctrine entities as the API contract** — use a DTO resource plus a State Provider/Processor so the persistence model and the public model evolve independently:

```php
#[ApiResource(shortName: 'Order')]
#[Post(processor: PlaceOrderProcessor::class)]      // operation declared as an attribute, not `new Post(...)`
final class OrderResource                         // the public contract (DTO), not the entity
{
    public string $id;
    public string $customerId;
    /** @var list<OrderLineInput> */
    public array $lines = [];
}

final class PlaceOrderProcessor implements ProcessorInterface
{
    public function __construct(
        private readonly MessageBusInterface $bus,
        private readonly OrderCommandFactoryInterface $commands,   // creates the message; no `new`, no static `fromResource()`
    ) {}

    public function process(mixed $data, Operation $op, array $uriVariables = [], array $context = []): OrderResource
    {
        $this->bus->dispatch($this->commands->placeOrder($data->customerId, $data->lines));   // translate, delegate
        // map result back into the resource DTO
    }
}
```
For simple read models, exposing an entity is a pragmatic shortcut — but the moment the API and schema need to diverge, introduce the DTO. Never leak lazy-loaded associations through serialization.

**The browser half** — Stimulus controllers, Turbo, the JS side of Live and Twig Components, React islands, TypeScript under AssetMapper or Encore — is reviewed with `architecture:clean-architecture-js` and `symfony:symfony-architecture-frontend`. This skill owns the seam: the endpoint a controller calls is a humble delivery mechanism like any other, the Twig template passes translated wording and config as Stimulus values, and a Live Component's PHP class delegates to services.

## 6. Events — domain vs framework

- **Domain events** (`Event/`, past tense, named in the language) are dispatched *after* persistence by the application layer. Other modules subscribe via their `Api/`-facing listeners — a clean OHS seam.
- **Symfony's `EventDispatcher`/kernel events** are a *framework* mechanism; keep them in adapters. Don't make the domain depend on `Symfony\Contracts\EventDispatcher`.
- Prefer dispatching integration events on the Messenger bus so cross-module reactions are async and decoupled.

## 7. Boundary enforcement

- **Deptrac** (`composer deptrac`) — declare module/layer boundaries; the build fails on any inner→outer or illegal cross-module dependency. This is what forces a leak to become an `Api/` interface. Zero violations expected.
- The **`Api/`/`Event/`/`Entity/`-only** cross-module rule is the Published-Language/OHS discipline from `ddd.md`, mechanically enforced.

## 8. Testing the layers

- **Domain unit tests** — pure PHPUnit, no kernel; construct aggregates/VOs and assert invariants (`$order->place($events)` throws on empty). Tests may write `new`; production code may not. Fast, the bulk of tests.
- **Application tests** — exercise handlers against in-memory fake ports (a fake `OrderRepositoryInterface`); no DB needed to prove orchestration.
- **Integration tests** — boot a real kernel + Postgres, exercise the adapter and wiring end-to-end; **do not mock the DB** (project rule). Run the suite with the parallel runner.

```php
// In-memory adapter makes application tests trivial and proves DIP
final class InMemoryOrderRepository implements OrderRepositoryInterface
{
    /** @var array<string, Order> */ private array $store = [];
    public function __construct(private readonly OrderIdGeneratorInterface $ids) {}
    public function nextIdentity(): OrderId { return $this->ids->next(); }
    public function get(OrderId $id): Order { return $this->store[(string) $id] ?? throw new OrderNotFound($id); }
    public function save(Order $order): void { $this->store[(string) $order->id()] = $order; }
}
```

## 9. Detection recipes — where to look first

A review that starts from memory finds what the reviewer expects. These searches list the **candidates**; each hit is then opened and judged. A hit is never a finding by itself — the last column says what makes it innocent. Patterns are ripgrep (`rg -n`, the Grep tool takes them as-is), passed in **single quotes** (double quotes let the shell rewrite backslashes, and the sweep silently matches nothing); in a table cell `\|` is Markdown's escape for `|`, dropped when you copy. Run a recipe on a file known to contain a hit first: a sweep that finds nothing proves nothing until it has found something. Globs cover both layouts from §1, drop the half that does not apply. Add `-g '!**/tests/**'` to every row except the one about tests — `**/Controller/**` also matches `tests/Integration/Controller/`, and on a real monolith that alone tripled the hit count.

| Smell | Search | Glob | Innocent when |
|---|---|---|---|
| Framework leaking inward | `^use (Doctrine\\(ORM\\EntityManager\|DBAL\\Connection)\|Symfony\\Component\\(HttpFoundation\|HttpKernel\|Form)\|Symfony\\Bundle)` | `**/{Domain,Application,Entity,Api}/**/*.php` | mapping metadata is not a runtime dependency: `Doctrine\ORM\Mapping`, `Doctrine\DBAL\Types\Types`, `Doctrine\Common\Collections` (§2). A `Request` in an `Api/` contract is a hit worth reading: the contract now belongs to HTTP |
| Transactions or flushing inside the model | `beginTransaction\|wrapInTransaction\|->flush\(` | `**/{Domain,Entity}/**/*.php` | never — this belongs to the application layer (§3) |
| Service locator | `ContainerInterface\|ServiceLocator\|container->get\(` | `**/src/**/*.php` | a compiler pass, a `ServiceSubscriberInterface` with a typed locator, the kernel |
| Persistence or rules in a controller | `EntityManagerInterface\|createQueryBuilder\|->findBy\(\|->findOneBy\(\|->persist\(` | `**/{Controller,UI}/**/*.php` | never for writes; a read-only grid may go through a repository port, not the EntityManager |
| Entity as the public API | `#\[ApiResource` | `**/Entity/**/*.php` | a read-only model the schema is allowed to dictate (§5) — say so in the report |
| Reaching into a neighbour's private folders | none — run the project's boundary tool (`composer deptrac`) | — | a grep cannot tell a package's own `Service\` import from a neighbour's, and returns every import in the codebase |
| Tagged `Api/` interface that never registers | `#\[AutoconfigureTag` in `**/Api/**/*.php`, then read the package's `services.yaml` `resource`/`exclude` | — | `Api/` is inside the resource glob (§4 gotcha). An integration test that counts the pool is the proof |
| Mutable state on a shared service | `^\s+(private\|protected) (?!readonly\|const\|function\|static)[^(]*;` (`rg -P`) | `**/{Service,Repository,EventListener,Handler}/**/*.php` | the class implements `ResetInterface`, or it is not a service. In a long-running worker (Messenger consumer, FrankenPHP, RoadRunner) the property outlives the request |
| Mocked database in an integration test | `createMock\((EntityManager\|Connection\|\w*Repository)` | `**/tests/Integration/**/*.php` | never — that test belongs under `Unit/`, and the integration test is still owed |
| Internal detail shown to a user | `getMessage\(\)` | `**/{Controller,Form,Twig}/**/*.php` | the value goes to a logger, not into a response, flash or form error |
| A user-facing literal in the delivery layer | `addFlash\([^,]+,\s*['"]\|addFlash\([^,]+,\s*\$e->\|new TranslatableMessage\(\s*['"]` | `**/Controller/**/*.php` | never. An English literal or an exception's text in a flash is a user-facing-text breach. A `TranslatableMessage` built from a literal in a controller is vocabulary without an owner (`solid.md` §DIP *No `new` — the container creates every object*). Run this row over **every touched controller file, not only the changed lines**: a sibling call left in a file you edited is in-scope debt |
| A controller writing a framework side channel directly | `->addFlash\(\|getFlashBag\(\)->add\(` | `**/Controller/**/*.php` | the project has no typed port for the channel *and* the change is not touching the file. In a touched file, route through (or plan) the port: a typed tone plus a `TranslatableInterface` sentence, owned by the module that renders it |

Two rules for reading the results:
- **Read the hit before grading it.** `switch`, `getMessage()`, `private $x` are words, not defects. A finding quotes the line *and* says which rule of this rubric it breaks; if no rule fits, it is not a finding.
- **Zero hits is not a pass.** The searches cover the smells that have a spelling. Anemic models, a wrong aggregate boundary, a port that protects nothing — those are found by reading (`ddd.md`, `SKILL.md` §Pragmatism).

## 10. Factories are generated; heavy dependencies are lazy

**A factory's implementation is written by the container build, never by hand.** The module declares
a typed interface per concept, one method per object it creates. Symfony ships no generator for it:
**discover the project's mechanism** (its docs name it; typically a compiler pass that writes the
implementing class and registers it as the service behind the interface). If the project has none,
that is a plan decision, not a licence to hand-write `new`. When a project builds one, what makes it
hold up:
- **Discovery through the packages' own scan.** Symfony's resource loader registers every scanned
  interface as an abstract `.abstract.<FQCN>` definition tagged `container.excluded`. A pass reading
  those finds the factory interfaces of the enabled packages without naming a module. An interface in
  an excluded directory is never seen.
- **Wiring by mirroring.** The generated constructor copies the created class's constructor parameters
  that nothing supplies (name, type, the `#[Autowire]`-family attributes, defaults), so `AutowirePass`
  wires them exactly as it would the created class. Do not re-implement autowiring.
- **Checked before unused services are removed.** `AutowirePass` records a failure on the definition
  rather than throwing, and `RemoveUnusedDefinitionsPass` deletes an unused errored service before
  `DefinitionErrorExceptionPass` looks. A check at `PassConfig::TYPE_BEFORE_REMOVING` is the one point
  that sees every factory's wiring, used or not.
- **Files named by their content, never rewritten** (production opcache does not revalidate), written
  into the build directory and loaded by the dumped container through `Definition::setFile()`, not by
  the autoloader.
- **A factory resolves its dependencies once.** So a non-shared service or an `#[Autowire(expression:)]`
  handed to every created object is a defect. Refuse it at build time.
- **A factory method only creates.** Computation lives on the value or on a service.

**Heavy or rarely used dependencies are lazy through PHP's native lazy objects (8.4+)**, never a
hand-written proxy and never a service locator:
- `#[Lazy]` (or `#[Autowire(lazy: true)]`) on the parameter, or `lazy: true` on the service. Symfony
  dumps a native ghost (`newLazyGhost`) or proxy (`newLazyProxy`).
- **Trap: a lazy service whose class is loaded only through `Definition::setFile()`.** The dumped
  container builds the ghost with `new \ReflectionClass(Class)` *before* it includes the file. It passes
  in the process that compiled the container and fails in the next one ("class does not exist"). Put
  such a service behind an **interface proxy** (`#[Lazy(SomeInterface::class)]`, or the `proxy` tag
  with `interface:`). The container dumps that proxy class into its own files.
- **A proxy is not free.** Every call is forwarded to the real instance. Measured on PHP 8.5: about
  34 ns a call through the proxy against 13 ns direct. Use laziness where it defers real work (a
  client, a connection, a heavy graph), not by default. In a long-running worker a lazy shared service
  initialises once per worker, so it saves little there.
- **A created object may be lazy too.** `ReflectionClass::newLazyGhost()` defers its constructor until a
  property is first read. It is for objects that are often created and seldom used. A class that
  extends an internal class (`\ArrayObject`, …) cannot be made lazy.

## Symfony review checklist
- [ ] Domain has no `use Doctrine\`, `use Symfony\...\HttpFoundation`, or EntityManager calls inside entities.
- [ ] Repository interfaces are owned by the domain/`Api/`; Doctrine impls live in infrastructure and are aliased in `services.yaml`.
- [ ] Handlers/use cases are thin; transactions are managed at the application layer, not the domain.
- [ ] Strategy pools use tagged `Api/` interfaces + `!tagged_iterator` — no `switch`/`elseif` dispatch.
- [ ] API contract is a DTO resource with a provider/processor; Doctrine entities aren't serialized as the public API.
- [ ] Cross-module refs go only through `Api/`, `Event/`, `Entity/`; `composer deptrac` is clean.
- [ ] Tests exist at unit (domain), application (fake ports), and integration (real Postgres) levels.
- [ ] No hand-written `new` or hand-written factory class: factory implementations are generated (§10); heavy dependencies are lazy through native lazy objects, not proxies or locators.

## 11. The core lenses in Symfony's idiom

The core skill states each rule in plain PHP. This section is where those rules meet Symfony's names.

### Layers

| Layer | In Symfony |
|-------|------------|
| **Entities** | Plain PHP under `Domain/` (framework-free) |
| **Use Cases** | Command/query handlers, application services |
| **Interface Adapters** | Controllers, API Platform state providers/processors, Doctrine repository *implementations*, DTOs |
| **Frameworks & Drivers** | The Symfony kernel, Doctrine, the Messenger transport, the HTTP client, MySQL, `services.yaml` glue |

- **Litmus:** swapping Doctrine for Eloquent, MySQL for an API, or HTTP for CLI must not touch a use case or an entity.
- **What the inner layers never import:** no Doctrine, no `Symfony\*`, no `Request`. In review, grep domain and application code for `Doctrine` and `Symfony\Component\HttpFoundation` (the framework-leak recipe of §9 is the full form). Doctrine or Symfony base classes, `Request`, and a container reached from domain or use-case code are the framework leaking inward.
- **The ORM entity as the contract:** `$this->doctrine->find(OrderEntity::class, $id)` returned straight as a `JsonResponse` is the Doctrine spelling of the leak in `clean-architecture.md` §4; §5 above is the fix.
- **Plan mode in Symfony's terms:** adapters are Doctrine repositories, HTTP clients and the Messenger bus; delivery is a controller, an API Platform resource with its provider/processor, a console command or a Messenger handler; the wiring is a `services.yaml` alias or autowiring by type, plus tags (§4).

### Wiring the inversion

The container's binding is an alias of the port to its adapter, or autowiring by type:
```yaml
# config/services.yaml
services:
    App\Application\Order\OrderRepository:
        alias: App\Infrastructure\Doctrine\DoctrineOrderRepository
```

### The humble controller, in Symfony's spelling

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
Each object has a named source: the command is mapped by the framework (`#[MapRequestPayload]`), the presenter holds one request's state and so comes from its factory rather than being a shared service, and the response comes from the framework's own helper (`AbstractController::json()`). A project that keeps controllers off the base class injects a responder service from the container instead, and the responder takes its `JsonResponse` from a generated factory (§10).

### Screaming structure and the module boundary

- Opening `src/` should tell you the app is about *ordering* and *billing*, not that it is "a Symfony app". In layout A (§1) `Infrastructure/` holds Doctrine, HTTP and CLI.
- **A modular-monolith Symfony project** takes the same stance: one Composer package per bounded context under `packages/{module}/`, each exposing only `Api/`, `Event/`, `Entity/` to the outside (§1 B). One bounded context ≈ one such package. That package boundary is the clean-architecture boundary, and Deptrac enforces it (§7).

### Extension points

- **Strategy pools (OCP):** tag the `Api/` interface with `#[AutoconfigureTag]` and inject a `!tagged_iterator` (§4). Other OCP extension points: compiler passes and tagged services, event subscribers.
- **Outer rings contributing to an inner module (onion):** `#[AutoconfigureTag]` on an inner `Api/` interface + `!tagged_iterator` (or a locator) in the inner service; per-package discovery passes that collect each package's own `config-schema.yaml`, routes, translations.
- In the onion parable (`onion-modules.md` §3) the extension point is spelled `#[AutoconfigureTag('llm.feature')]` on `LlmFeatureInterface`.

### No `new`, in Symfony's vocabulary

- **Factories:** Symfony ships no generator; use the compile-time mechanism the project's docs name (§10). If the project has none, that is a plan decision, not a licence to hand-write `new`.
- **The composition root** is `new Kernel(...)` in the front controller or in `bin/console`.
- **The names in the core's example** (`solid.md` §DIP *No `new`*): `TranslatableText` is `Symfony\Component\Translation\TranslatableMessage`, `TranslatableTextInterface` is `Symfony\Contracts\Translation\TranslatableInterface`, `TranslatableTextFactoryInterface` is a `TranslatableMessageFactoryInterface`, and `flash()` is `AbstractController::addFlash()` (or `getFlashBag()->add()`). The typical offender is a controller building `new TranslatableMessage('catalog.x.saved', [], 'catalog')`, typing a helper on `TranslatableMessage`, and writing the `addFlash` side channel. In any touched file, `addFlash(`/`->add('success'` is a finding.
- **Contracts to type on:** `TranslatableInterface` (not `TranslatableMessage`), `TranslatorInterface`, `EventDispatcherInterface`, `HttpClientInterface`.
- **The clock:** `ClockInterface` (PSR-20); Symfony's extends it.

### Detection recipes the core leaves to the stack

Same conventions as `solid.md`'s recipes. A client a recipe finds is built by the container from its definition in `services.yaml`.

| Principle / smell | Search | Cleared when |
|---|---|---|
| DIP — typed on a concrete class | `function \w+\([^)]*\b(TranslatableMessage\|Translator\|EventDispatcher\|Session\|RequestStack\|Filesystem\|HttpClient)\b\s+\$` and the same types after `private readonly` (`-P`) | the framework ships no contract for it. A parameter or property typed on a concrete class when an interface exists (`TranslatableInterface`, `TranslatorInterface`, `EventDispatcherInterface`, `HttpClientInterface`) is a DIP break *inside the same file*, however small |
| DIP — free-string side channel | `->addFlash\(\|->add\('(success\|error\|warning\|info)'` in `Controller/` | the project publishes no port for that channel yet. Then plan the port (a typed tone plus a typed sentence, owned by the module that shows it) rather than repeat the pattern |
| DIP — the composition root | `new Kernel\(` | the front controller or `bin/console` |
| Dual write | `->dispatch\(\|->publish\(` in `**/{Service,Handler,Messenger,Application,UseCase}/**/*.php` | the transport for that message class in `messenger.yaml` routing: the Doctrine transport on the state change's connection, or a network broker? |
| Network call inside a transaction | files matching both `wrapInTransaction\|beginTransaction` and `HttpClientInterface\|->request\(\|curl_exec` — `rg -l A \| xargs grep -lE B` | whether the call is inside the closure |
| Consumer with no idempotency | `#\[AsMessageHandler\|implements MessageHandlerInterface` | a claim on a unique key in the same transaction, or a naturally idempotent effect |
| Outbound call with no timeout | `HttpClientInterface` | `timeout` / `max_duration` on the scoped client or the request options |
| Retry in the wrong layer | the core row's search | move to a decorator or Messenger's `retry_strategy` |
| No failure transport | `retry_strategy` present in `messenger.yaml` without `failure_transport` | where a message goes after the last retry |
| Cache in a use case | `TagAwareCacheInterface`, with the core row's interfaces | whether the class is a decorator of a port (fine) or a use case (move it) |

### Integration patterns on Symfony

- **The transaction port** is `EntityManagerInterface::wrapInTransaction()` (or a middleware, §3): the core's `$this->transactions->run(...)` is written `$this->em->wrapInTransaction(...)` here.
- **Outbox:** a Messenger **Doctrine transport on the same connection** *is* an outbox — dispatching inside the transaction writes the envelope row in the same commit, and `messenger:consume` is the relay. It stops being one the moment the transport is AMQP/Redis/SQS: then either route through a Doctrine transport first and forward, or use `DispatchAfterCurrentBusStamp` knowing it narrows the window without closing it.
- **Decorators** around an adapter, for resilience or a cache, are wired with `decorates:`:
  ```yaml
  Acme\Billing\Infrastructure\RetryingPaymentGateway:
      decorates: Acme\Billing\Infrastructure\HttpPaymentGateway
  ```
- **Symfony ships most of it:** `RetryableHttpClient` and `timeout`/`max_duration` on `framework.http_client` scoped clients; Messenger's `retry_strategy` (`max_retries`, `delay`, `multiplier`, `jitter`) and `failure_transport`; `RateLimiter`; `Lock` and `Semaphore` for bulkheads. Reach for those before writing a class.
- **A hot miss:** Symfony's `CacheInterface::get($key, $callback, beta: …)` recomputes early and locks; use it instead of `getItem`/`save` pairs.
- **Never cache a managed Doctrine entity** — it comes back detached, with lazy associations that fail later.
- **Per-process memo caches** on a service in a long-running worker are reset through `ResetInterface`.

### The browser half

The JavaScript a Symfony module ships — Stimulus controllers, Live and Twig Components' browser half, React islands, TypeScript — is reviewed with `architecture:clean-architecture-js` and `symfony:symfony-architecture-frontend`; a change that touches JS/TS loads both. A Stimulus component fusing rules, wording and transport is the PHP rubric's pitfall 10 on this stack. The seam on the PHP side is §5.

### References

- Symfony Messenger (transports, retries, failure transport) — https://symfony.com/doc/current/messenger.html · HttpClient (timeouts, `RetryableHttpClient`) — https://symfony.com/doc/current/http_client.html · Cache (`get()` with early expiration) — https://symfony.com/doc/current/components/cache.html

## Implementer checklist on this stack

Read with the core skill's `references/implementer-checklist.md`.

- Inner code names no Doctrine class, no `Symfony\Component\HttpFoundation` `Request`/`Response`, and no container.
- Wiring is a `services.yaml` alias or autowiring by type, plus tags. A class that is built but never wired ships nothing: check the registration exists and is exercised by a test that resolves it through the real container.
- Factories: Symfony ships no generator; find the project's compile-time one in its docs (§10). If the project has none, stop and return the question. The composition root is `new Kernel(...)` in the front controller or `bin/console`.
- Type on the contract: `TranslatableInterface`, not `TranslatableMessage`; `TranslatorInterface`; `EventDispatcherInterface` — including a private helper in a controller.
- `addFlash()` / `getFlashBag()->add()` is the free-string side channel; reach it through the project's typed port, or stop and return the question.
- Minimum self-check for a Symfony controller you touched:
  `rg -nP '(?<!throw )\bnew\s+(?!class\b)[\w\\]+\s*\(|::of\(|addFlash\(|getMessage\(\)|function \w+\([^)]*\b(TranslatableMessage|Translator|EventDispatcher)\b\s+\$' <non-test files>`.
- JS/TS source a module ships is written against `architecture:clean-architecture-js` and `symfony:symfony-architecture-frontend`.
