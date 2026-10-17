# Domain-Driven Design in JavaScript and TypeScript

DDD supplies the *content* of the inner circles `clean-architecture.md` keeps pure. On the client most of the model is the server's, so the useful parts are the strategic ones — language, boundaries, the anti-corruption layer — and a handful of tactical ones that TypeScript expresses well: value objects, identities, and unions that make illegal states unrepresentable. Aggregates stay on the server.

---

## 1. Ubiquitous language

The words domain experts use are the names in the code: `applyCoupon`, `reserveSlot`, `CouponForm`, `cart:item-added` — not `handleClick2`, `processData`, `Form3`, `update-event`. It holds for components, hooks, controllers, event names, file names and the keys of translation dictionaries. A review that finds CRUD verbs where the business has real ones (`setStatus('placed')` where the business says *place the order*) is finding a language leak.

## 2. Features are bounded contexts — and the API is a foreign model

The same word means different things in different features: the *product* of a listing (name, image, price range) is not the *line* of a cart (sku, qty, row total) nor the *item* of a wishlist. **Do not share one `Product` type across features.** Each feature parses the API into its own model.

The backend's DTO is another context's published language. Consume it through an **anti-corruption layer** — the parser/mapper in the feature's adapter — so its field names, nullability, string-typed numbers and legacy quirks never reach a component:

```ts
// cart/adapters/cart-dto.ts — the ONLY file that knows the wire format
const CartDto = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number().int(), row_total: z.string(), currency: z.string() })),
});

export function toCart(raw: unknown): Cart {
  const dto = CartDto.parse(raw);                       // throws a typed error on a broken contract
  return {
    lines: dto.items.map((i) => ({
      sku: sku(i.sku),
      quantity: quantity(i.qty),
      rowTotal: money.fromDecimalString(i.row_total, i.currency),   // "12.30" → 1230 minor units
    })),
  };
}
```

When the backend is the project's own Symfony or Magento code, the published language is still the endpoint's contract (the PHP skill's `Api/Data/` DTOs, the API resource) — not the entity behind it, and not the component's wishes.

## 3. Value objects — valid by construction

No identity; equal by value; **impossible to hold in an invalid state**. Two shapes in TypeScript, chosen by where the value travels:

**Branded primitives + smart constructors** — the default. They survive JSON, `structuredClone`, `postMessage`, storage and React props unchanged.

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Sku = Brand<string, 'Sku'>;
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function parseSku(input: string): Result<Sku, 'empty' | 'format'> {
  const value = input.trim().toUpperCase();
  if (value === '') return { ok: false, error: 'empty' };
  if (!/^[A-Z0-9-]{3,64}$/.test(value)) return { ok: false, error: 'format' };
  return { ok: true, value: value as Sku };            // the one cast: inside the check that justifies it
}
```

**Small immutable classes** — when behavior travels with the value *inside one module* and never crosses a serialization boundary (a class instance comes back from JSON as a plain object without its methods):

```ts
export class Money {
  readonly minor: number;
  readonly currency: CurrencyCode;

  private constructor(minor: number, currency: CurrencyCode) {
    if (!Number.isSafeInteger(minor)) throw new RangeError('Money is an integer number of minor units');
    this.minor = minor;
    this.currency = currency;
  }

  static of(minor: number, currency: CurrencyCode): Money { return new Money(minor, currency); }

  add(other: Money): Money {
    if (other.currency !== this.currency) throw new CurrencyMismatch(this.currency, other.currency);
    return new Money(this.minor + other.minor, this.currency);
  }

  equals(other: Money): boolean { return this.minor === other.minor && this.currency === other.currency; }
}
```

Money is integer minor units plus a currency — never a float, never a pre-formatted string. Formatting (`Intl.NumberFormat`) happens in the adapter, with the locale and currency the page gives it.

Good candidates: `Sku`, `Quantity`, `Money`, `EmailAddress`, `CouponCode`, `PostalCode` per country, `DateRange`, ids.

## 4. Entities and identity

Things with a lifecycle are identified by an id, not by their fields. Brand the id (`type OrderId = Brand<string, 'OrderId'>`) so an `OrderId` cannot be passed where a `CustomerId` is expected. Reference other entities **by id**, not by nesting the whole object: a cart line holds a `Sku`, not a `Product`.

## 5. Make illegal states unrepresentable

The client's own invariants are mostly about **state**, and TypeScript's unions express them exactly.

```ts
// ❌ Boolean soup: 16 combinations, most of them nonsense (loading AND failed AND has data?)
type State = { isLoading: boolean; isError: boolean; error?: string; data?: Cart };

// ✅ Four states, each carrying exactly what it has
type Remote<T, E = LoadError> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: T }
  | { status: 'failed'; error: E };
```

Multi-step flows (checkout, a wizard, an upload) are **state machines**: name the states and the events, and write the transitions as a table or an exhaustive handler map (`solid.md` §OCP), so an impossible transition is a missing entry rather than a forgotten `if`. A form has two models: the **draft** (strings, possibly invalid, what the inputs hold) and the **command** (parsed value objects, only constructible when valid). The submit handler turns one into the other.

A reducer written as a pure `(state, event) => state` function is domain code: test it in Node with no framework.

## 6. What the client decides, mirrors, and displays

| The client… | Examples | Rule |
|---|---|---|
| **Decides** | UI state, navigation, which step is shown, optimistic presentation | Its own model; test it as domain code |
| **Mirrors** | Required fields, formats, max quantities, password rules | For feedback only; the server re-checks. The rule's parameters come from the server, not a copy in JS |
| **Displays** | Prices, tax, discounts, stock, permissions, shipping cost | Never computed as the source of truth. When a derived display value is needed (gap to free shipping), one pure function over server-supplied inputs, with tests |

A rule that exists only in JS is not a rule — it is a suggestion to anyone with DevTools. A rule duplicated in JS with its own constants drifts from the server's.

## 7. Domain events on the client

Independently loaded parts of a page — Magento widgets rendered by different templates, Stimulus controllers from different packages, React islands — should not reach into each other. They announce what happened, in the past tense, through a **typed event contract owned by the publisher**:

```ts
// cart/events.ts — the published language; the listener imports only this file
export type CartUpdated = { readonly itemCount: number; readonly subtotalMinor: number; readonly currency: string };

declare global {
  interface DocumentEventMap { 'cart:updated': CustomEvent<CartUpdated> }
}

export const publishCartUpdated = (detail: CartUpdated): void => {
  document.dispatchEvent(new CustomEvent('cart:updated', { detail }));
};

// mini-cart/ui/badge.ts — a listener in another module; typed without a cast
document.addEventListener('cart:updated', (e) => render(e.detail.itemCount), { signal });
```

Name the event after the fact (`cart:updated`, `slot:reserved`), namespace it by the owning module, keep the detail a plain serializable DTO, and document it as the module's public surface. In Stimulus the idiom is `this.dispatch('updated', { detail })` (prefixed with the controller identifier); in Magento the customer-data sections and their invalidation are the platform's own version of this seam.

## 8. Pragmatism

Most frontend code is presentation over server state. Tactical DDD in the browser means **language, the anti-corruption layer, value objects, ids and unions** — not repositories of aggregates, not a domain layer for a component that shows a list. Introduce a real client-side domain module when there are rules the client genuinely owns (a configurator, an editor, an offline-capable form, a canvas) or when the same derived value is computed in more than one place.

---

## DDD review checklist
- [ ] Names come from the ubiquitous language — components, functions, events, files, translation keys.
- [ ] Each feature parses the API into its own model through an anti-corruption layer; no backend DTO is the UI model; no one `Product` type is shared across features.
- [ ] Value objects replace stringly-typed money, ids, quantities and codes, and are valid by construction; money is integer minor units plus currency.
- [ ] Ids are branded; other entities are referenced by id.
- [ ] State is a union or a state machine, not a set of booleans; forms separate draft from command.
- [ ] The client decides only what it owns; mirrored rules take their parameters from the server; displayed values are not recomputed as the source of truth.
- [ ] Cross-module communication in the page goes through typed, publisher-owned events, not reaches into another module's internals.
