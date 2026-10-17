# SOLID in PHP (Symfony & Magento 2)

The five principles are the class-level mechanics that make the dependency rule (`clean-architecture.md`) and DDD (`ddd.md`) hold. **DIP** is the load-bearing one — it is how every boundary is crossed. Diagnose in this order when reviewing: DIP → SRP → OCP → ISP → LSP.

---

## SRP — Single Responsibility Principle

> A class has one reason to change — it answers to **one actor / one axis of change**.

The usual PHP violation is a service that validates *and* persists *and* notifies *and* formats — or, worse, a `*Helper`/`*Util`/`*Manager` that accretes whatever was convenient. This project bans Helper classes for exactly this reason.

```php
// ❌ Four reasons to change in one class
final class OrderService
{
    public function place(array $payload): array
    {
        // 1. validation rules change...
        if (!isset($payload['lines']) || $payload['lines'] === []) {
            throw new \InvalidArgumentException('empty order');
        }
        // 2. persistence changes...
        $row = $this->connection->insert('orders', [...]);
        // 3. notification policy changes... (and `new Email` is a DIP break of its own: §DIP)
        $this->mailer->send(new Email(/* ... */));
        // 4. response/serialization format changes...
        return ['id' => $row['id'], 'status' => 'placed'];
    }
}

// ✅ One responsibility each; the use case orchestrates collaborators it owns as ports
final class PlaceOrder
{
    public function __construct(
        private readonly OrderFactoryInterface $orderFactory, // creation — an interface the container implements
        private readonly OrderRepository $orders,     // persistence — its own reason to change
        private readonly OrderNotifier $notifier,     // notification — its own reason to change
    ) {}

    public function handle(PlaceOrderCommand $cmd): OrderId   // validation lives in the command/entity
    {
        $order = $this->orderFactory->placed($this->orders->nextIdentity(), $cmd->lines); // invariants in the entity
        $this->orders->save($order);
        $this->notifier->orderPlaced($order->id());
        return $order->id();
    }
}
```
**Review cue:** name the class in one sentence without "and". If you can't, split it. A `*Helper`/`*Util` name is a smell by itself.

---

## OCP — Open/Closed Principle

> Open for extension, closed for modification. **Add behavior by adding a class, not by editing an existing one.**

### The rule: no `switch`/`case`, no `elseif` for behavioral dispatch

A `switch`/`case` or `elseif` chain that selects *behavior* by a `type`/`kind`/`method` field is the canonical OCP violation: every new variant edits the same class, re-tests it, re-risks it — and a variant can never be contributed from another module. **Replace the conditional with polymorphism**: one small strategy object per variant, injected as a collection and resolved by a registry. The branches literally become **injected objects, each free to live in its own module**.

```php
// ❌ Anti-pattern: switch-on-type (also seen as an if/elseif ladder).
//    Each `new Money` is a second violation: values come from an injected factory (§DIP).
final class ShippingCostCalculator
{
    public function cost(Shipment $s): Money
    {
        switch ($s->method()) {                        // adding a method edits THIS class
            case 'flat':    return new Money(500, $s->currency());
            case 'weight':  return new Money($s->weightKg() * 100, $s->currency());
            case 'express': return new Money(1500, $s->currency());
            default:
                throw new \InvalidArgumentException("Unknown method {$s->method()}");
        }
    }
}
```

```php
// ✅ Replace Conditional with Polymorphism — one strategy per variant, injected
namespace Acme\Shipping\Api;               // the port is the extension point

interface ShippingRate
{
    public function supports(string $method): bool;
    public function cost(Shipment $shipment): Money;
}

// Each strategy is a focused object — and may be owned by a different module
final class FlatRate implements ShippingRate
{
    public function __construct(private readonly MoneyFactoryInterface $money) {}
    public function supports(string $method): bool { return $method === 'flat'; }
    public function cost(Shipment $s): Money { return $this->money->create(500, $s->currency()); }
}
final class WeightRate implements ShippingRate
{
    public function __construct(private readonly MoneyFactoryInterface $money) {}
    public function supports(string $method): bool { return $method === 'weight'; }
    public function cost(Shipment $s): Money { return $this->money->create($s->weightKg() * 100, $s->currency()); } // computes, then asks
}

// The resolver holds the INJECTED collection — no switch, no elseif, closed to modification
final class ShippingCostCalculator
{
    /** @param iterable<ShippingRate> $rates */
    public function __construct(private readonly iterable $rates) {}

    public function cost(Shipment $s): Money
    {
        foreach ($this->rates as $rate) {
            if ($rate->supports($s->method())) {
                return $rate->cost($s);          // guard-clause + early return is fine — no elseif
            }
        }
        throw new UnsupportedShippingMethod($s->method());
    }
}
```

**Wire the collection so new strategies register themselves (from any module):**

Symfony — tag the interface, inject a tagged iterator (`#[AutoconfigureTag]`):
```php
#[AutoconfigureTag('acme.shipping_rate')]
interface ShippingRate { /* ... */ }
```
```yaml
# services.yaml — a new module drops in a class implementing ShippingRate; it auto-joins the pool
services:
    _instanceof:
        Acme\Shipping\Api\ShippingRate:
            tags: ['acme.shipping_rate']
    Acme\Shipping\Model\ShippingCostCalculator:
        arguments: [!tagged_iterator acme.shipping_rate]
```

Magento 2 — inject a pool/array via `di.xml` (add an `<item>` to extend, no code edit to the resolver):
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

**For pure value→value mapping** (no behavior), a `match` or a lookup array is fine and preferred — it is not the anti-pattern:
```php
$symbol = match ($currency->code()) { 'USD' => '$', 'EUR' => '€', 'GBP' => '£' };
```
The smell is specifically **selecting behavior by type** through `switch`/`elseif`. Sequential validation reads best as **guard clauses** (`if (...) { throw; }` / early `return`) — never an `if/else if/else` ladder.

**Other OCP extension points:** Symfony compiler-pass/tagged services, event subscribers; Magento plugins & `events.xml` observers. Prefer adding a tagged strategy over an `around` plugin — plugins are powerful but obscure control flow (see `magento2.md`).

**Review cue:** grep the blast radius for `switch`, `elseif`, `else if`, and `instanceof` ladders. Each behavioral one is debt to convert to an injected strategy (mandatory in-scope — see `SKILL.md` Plan mode).

---

## LSP — Liskov Substitution Principle

> A subtype must be usable anywhere its supertype is expected, **without the caller knowing**. Don't strengthen preconditions or weaken postconditions; don't throw where the base contract promises to work.

```php
// ❌ Subtype breaks the contract callers rely on
interface ProductRepository
{
    public function get(ProductId $id): Product;
    public function save(Product $product): void;
}

final class ReadOnlyProductRepository implements ProductRepository
{
    public function get(ProductId $id): Product { /* ... */ }
    public function save(Product $product): void
    {
        throw new \LogicException('read-only'); // any code holding a ProductRepository can now blow up
    }
}
```

```php
// ✅ Segregate the capability — callers depend only on what they can rely on (ties into ISP)
interface ProductReader { public function get(ProductId $id): Product; }
interface ProductWriter { public function save(Product $product): void; }

final class CatalogCache implements ProductReader { /* only reads — honest */ }
```
**Review cue:** a subtype whose method throws "not supported", ignores an argument the base honors, or narrows accepted input, is an LSP break. The fix is usually ISP (below). Magento: a plugin that changes a public method's documented contract for some callers is an LSP hazard.

---

## ISP — Interface Segregation Principle

> No client should depend on methods it does not use. **Prefer several small role interfaces over one fat one.**

```php
// ❌ Fat contract — a read-only consumer is forced to depend on writes & bulk ops it never calls
interface OrderRepositoryInterface
{
    public function get(int $id): Order;
    public function save(Order $order): void;
    public function delete(Order $order): void;
    public function bulkImport(iterable $orders): void;
    public function rebuildSearchIndex(): void;
}

// ✅ Role interfaces; clients pick the seam they need
interface OrderReader { public function get(OrderId $id): Order; }
interface OrderStore  { public function save(Order $order): void; }
```
In a modular monolith, build tagged/pluggable systems by putting the **narrow** capability interface under `Api/` and tagging it — a consumer depends on exactly that role. Magento's Service Contracts are deliberately split (`OrderRepositoryInterface` vs `OrderManagementInterface`) for the same reason.

**Review cue:** an interface where implementations leave methods empty / throwing, or where most callers use one method, wants segregation.

---

## DIP — Dependency Inversion Principle

> Depend on **abstractions**, not concretions. High-level policy must not depend on low-level detail; both depend on an interface **owned by the policy**.

```php
// ❌ Use case reaches for a concrete framework detail
final class RegisterUser
{
    public function handle(string $email): void
    {
        $mailer = new SymfonyMailer(/* transport */);       // concrete, un-swappable, un-testable
        $mailer->send(/* welcome */);
    }
}

// ✅ Depend on a port owned by the application; infrastructure implements it, container injects it
namespace App\Application\User;
interface WelcomeMailer { public function welcome(EmailAddress $to): void; }

final class RegisterUser
{
    public function __construct(private readonly WelcomeMailer $mailer) {}
    public function handle(EmailAddress $email): void { /* ... */ $this->mailer->welcome($email); }
}
```
Wiring makes it real — Symfony `services.yaml` alias / autowire by interface; Magento `di.xml` `<preference>`. In tests you inject a fake `WelcomeMailer`; in prod, the real adapter. That swap is the proof DIP is satisfied. (Full boundary mechanics: `clean-architecture.md` §3, §5.)

**Review cue:** any `new` of an infrastructure class, a static call to a framework service, or an `ObjectManager::get()` inside domain/application code is a DIP violation. Inject an interface instead.

### No `new` — the container creates every object (DIP at every call site)

**Code never instantiates a class with `new`.** An object a class needs comes from the container, in
one of two shapes:
- **a service**, injected through its interface;
- **a factory**, an injected `…FactoryInterface`, when a genuinely new instance is needed (a message with
  parameters, an entity being created, a value built from runtime data).

**A factory is an interface; the container writes its implementation, never a person.** Magento
generates a `…Factory` for any class, and its `create()` asks the ObjectManager. Symfony ships no
generator: use the compile-time mechanism the project has, which its own docs name (`symfony.md` §10).
If the project has none, that is a plan decision, not a licence to hand-write `new`.
**A factory method only creates**: one object per method, from its arguments, no computation. Whatever
computes those arguments is a service or the value itself.
**Exempt:** `throw new …Exception`, attribute metadata (`#[Assert\All([new Assert\NotBlank()])]`),
**tests**, and the **composition root**: the one place that builds the container, before any exists
(`new Kernel(...)` in the front controller or `bin/console`, Magento's bootstrap). It is not wiring code in general.

A static named constructor that does `new self(...)` is still `new`: the caller is bound to the concrete
class, and nothing can be substituted for it. It is not the clean alternative.

```php
// ❌ The caller builds a concrete framework value from literals; the helper takes the concrete class
$this->flashErrors($errors, new TranslatableMessage('catalog.attribute_group.created', [], 'catalog'));

private function flashErrors(array $errors, TranslatableMessage $success): void   // concrete, not the contract
{
    if ($errors !== []) { $this->addFlash('error', $errors[0]); return; }         // free-string channel, mixed payload
    $this->addFlash('success', $success);
}

// ❌ Also wrong: a named constructor hides the same `new`
public static function groupCreated(): self { return new self('catalog.attribute_group.created'); }

// ❌ Also wrong: a hand-written factory moves the `new`, it does not remove it
public function groupCreated(): TranslatableInterface { return new TranslatableMessage('catalog.attribute_group.created', [], 'catalog'); }
```

```php
// ✅ The module's sentences have one owner: a service that holds each key and the domain once
//    and takes the object from an injected factory.
final class AttributeNotices implements AttributeNoticesInterface
{
    private const DOMAIN = 'catalog';

    public function __construct(private readonly TranslatableMessageFactoryInterface $messages) {}

    public function groupCreated(): TranslatableInterface
    {
        return $this->messages->create('catalog.attribute_group.created', [], self::DOMAIN);
    }

    public function codeTaken(string $code): TranslatableInterface
    {
        return $this->messages->create('catalog.attribute_group.code_taken', ['%code%' => $code], self::DOMAIN);
    }
}

// The factory is only this interface; the container generates its implementation.
interface TranslatableMessageFactoryInterface
{
    /** @param array<string, string> $parameters */
    public function create(string $message, array $parameters = [], ?string $domain = null): TranslatableInterface;
}

// Api of the module that renders notices: it owns the channel's port, typed, no `mixed`
interface NoticesInterface
{
    public function success(TranslatableInterface $sentence): void;
    public function error(TranslatableInterface $sentence): void;
}

// controller: translate the request, delegate, tell. No `new`, no literal, no concrete type.
$this->notices->success($this->attributeNotices->groupCreated());
```

The shape is the point: the vocabulary has one owner (a service, one method per sentence), and every
object comes from a factory interface whose implementation nobody writes.

Four smells, one fix:
- a `new` at the call site, the root one;
- a concrete type where the contract exists;
- a literal repeated at every call site;
- a side channel typed `(string, mixed)`.

**Review cue:** in any touched file, a `new` of a class is a finding, other than `throw new`, attribute
metadata, tests and the composition root. That includes a hand-written factory. A parameter typed on a concrete framework class is a finding too, and so is `addFlash(`/`->add('success'`.
Plan them out; don't copy them. The whole touched file is in scope.

---

## Detection recipes — candidates, not findings

Run these over the blast radius before the reading pass, in the diagnosis order above. Patterns are ripgrep (`rg -n`; `-P` where noted). Each hit is opened and judged — the right-hand column is what clears it. Pass a pattern in **single quotes**: double quotes let the shell rewrite its backslashes, and the sweep silently matches nothing. In a table cell `\|` is Markdown's escape for `|`; drop the backslash when you copy. Run a recipe on a file known to contain a hit first: a sweep that finds nothing proves nothing until it has found something.

| Principle | Search | Cleared when |
|---|---|---|
| DIP | `new \\?(\w+\\)*\w*(Client\|Mailer\|Filesystem\|Repository)\(\|new \\?PDO\(` outside `Infrastructure/`, `Repository/`, `DependencyInjection/` and tests | never in written code: the container builds such a client from its service definition (`services.yaml`, `di.xml`). (`Connection` is left out on purpose: it is as often the name of a value object as of a socket) |
| DIP | `::getInstance\(\)\|ObjectManager::\|\bglobal \$\|\$GLOBALS` | never in domain or application code |
| DIP | `(?<!throw )\bnew\s+(?!class\b)[\w\\]+\s*\(` over production code (`-P`, `-g '!**/tests/**'`) | the line is `throw new`, attribute metadata (`#[…(new …)]`), or the composition root: the one place that builds the container, before any exists (`new Kernel(...)` in the front controller or `bin/console`). The regex doesn't match `(object) []`, which is PHP's literal for an empty JSON object (`{}` in a schema or payload): it's acceptable for exactly that, never as a way around the rule for anything else. **Everything else is a finding**, a hand-written factory's `new` included: a `new` binds the caller to a concrete class, and so does a named constructor's `new self`/`new static`. Objects come from the container, as a service or from a factory interface it implements |
| DIP | `new \\?(\w+\\)*\w*(Message\|Response\|Email\|Envelope\|Notification\|Exception)\(\s*['"]` in `Controller/`, `Service/`, `Handler/` (`-P`) | never in written code. A framework value assembled from a string literal at a call site means the vocabulary (a translation key, a domain, a template id) has no owner and is repeated wherever it is used. The fix: one owner for the vocabulary, a service in the module with one method per value, which takes the object from an injected factory interface and returns the framework's *contract*. See §DIP *No `new` — the container creates every object* |
| DIP | `function \w+\([^)]*\b(TranslatableMessage\|Translator\|EventDispatcher\|Session\|RequestStack\|Filesystem\|HttpClient)\b\s+\$` and the same types after `private readonly` (`-P`) | the framework ships no contract for it. A parameter or property typed on a concrete class when an interface exists (`TranslatableInterface`, `TranslatorInterface`, `EventDispatcherInterface`, `HttpClientInterface`) is a DIP break *inside the same file*, however small |
| DIP | the same string literal as an argument at ≥3 call sites: `rg -o '\x27[a-z_]+\x27\)' <radius> \| sort \| uniq -c \| sort -rn` | a value→value map. A domain name, a channel name or a key prefix repeated across call sites is a concept with no owner. Give it one owner, and have the call sites ask that owner |
| DIP | a framework base-class side channel called with a free string: `->addFlash\(\|->add\('(success\|error\|warning\|info)'` in `Controller/` | the project publishes no port for that channel yet. Then plan the port (a typed tone plus a typed sentence, owned by the module that shows it) rather than repeat the pattern. A `mixed` message parameter is how an exception's text reaches a person |
| SRP | `class \w*(Helper\|Util\|Utils\|Manager\|Processor\|Handler)s?\b` | the name is the framework's (`MessageHandler`) and the class states one job without "and" |
| SRP | `wc -l` over the radius, longest first; `rg -c 'private readonly' <file>` for constructor width | length alone proves nothing — above ~300 lines or ~7 collaborators, read for a second reason to change |
| OCP | `\bswitch\s*\(\|\belse\s?if\b\|\belseif\b\|instanceof` | the branch maps value→value, is a guard clause with an early return, or narrows a type for the analyser. It is the smell only when each arm **does something different** for a `type`/`kind`/`method` |
| OCP | `match\s*\(` | value→value (the normal case). A `match` whose arms call different collaborators is a `switch` in disguise |
| LSP | `throw new \\?\w*Exception\(['"][^'"]*(not (supported\|implemented)\|read.only\|unsupported)` (`-i`) | the supertype's contract documents the throw; otherwise segregate the interface |
| ISP | `rg -c 'public function' -g '*Interface.php'`, then the ones above five | every client uses most of it. Check by counting callers per method, not by the number |

A search that returns nothing clears only the spelling it looked for. SRP and LSP in particular are read, not grepped.

---

## SOLID review checklist
- [ ] **SRP** — every touched class states its job without "and"; no `*Helper`/`*Util` god classes.
- [ ] **OCP** — no `switch`/`elseif` behavioral dispatch; variants are injected strategies from a tagged collection/registry; `match`/maps only for value mapping.
- [ ] **LSP** — no subtype throws "unsupported" or narrows a contract its supertype honors.
- [ ] **ISP** — interfaces are role-sized; no implementation leaves methods empty/throwing.
- [ ] **DIP** — inner code depends only on interfaces it owns; no `new`/static/`ObjectManager` reach for infrastructure; the container wires each port.
