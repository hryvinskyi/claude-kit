# SOLID in JavaScript and TypeScript

The five principles are the module- and component-level mechanics that make the dependency rule (`clean-architecture.md`) and the domain model (`ddd.md`) hold. In JS a "class" is as often a module, a component or a hook as a `class`; the principles apply to all four. **DIP** is the load-bearing one. Diagnose in this order: DIP → SRP → OCP → ISP → LSP.

---

## SRP — one reason to change

> A module, component or hook answers to **one actor / one axis of change**.

The usual violations:
- **The fat component** — fetches, parses, validates, computes, formats, translates and renders. Five reasons to change, testable only through the DOM.
- **`utils.js` / `helpers.ts` / `common.js`** — the JS Helper class: unrelated exports (`formatPrice`, `debounce`, `isValidEmail`, `buildTree`) accreting in one file everything imports. A tree model must not also hold value validators and date formatting.
- **The god hook** — `useCheckout()` returning thirty values, owning the network, the form, the steps and the analytics.

```tsx
// ❌ Five reasons to change in one component
export function CouponBox() {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  async function submit() {
    if (!/^[A-Z0-9]{6,12}$/.test(code)) return setMsg('Invalid code');       // rule + wording
    const res = await fetch(`/api/cart/coupon`, { method: 'PUT', body: code }); // transport
    const data = await res.json();                                              // unparsed
    setMsg(data.discount > 0 ? `You saved ${(data.discount / 100).toFixed(2)} €` : 'No discount'); // formatting
  }
  return /* JSX */;
}

// ✅ One job each; the component binds them
// coupon/domain/coupon-code.ts   parseCouponCode(): Result<CouponCode, 'format'>   (rule)
// coupon/application/apply.ts    applyCoupon(gateway)(code)                        (orchestration)
// coupon/adapters/http.ts        httpCouponGateway — fetch + parse + error mapping  (transport)
// coupon/ui/CouponBox.tsx        state, wording via t(), Intl formatting            (presentation)
```

**Review cue:** describe the module in one sentence without "and". A file name like `utils`, `helpers`, `common`, `misc`, `lib/index` is a smell by itself — split by concern and name each file after its charter (`price-format.ts`, `expression-tree.ts`).

---

## OCP — add behavior by adding code, not by editing it

### The rule: no `switch` / `if`–`else` chain that selects behavior by a type

A `switch` or an `if`/`else if` ladder over `type`, `kind`, `method`, `status` or a CMS block's name that **does something different per arm** is the canonical OCP violation: every new variant edits the same file, re-tests it, and can never be contributed from another module. Replace it with one of two shapes:

- **An open set → a registry.** Variants other modules may add (payment methods, carriers, CMS block renderers, form-field types, validators, widgets): a `Map` or object of strategies with a `register()` function, resolved by key; an unknown key fails loudly or degrades explicitly.
- **A closed set → an exhaustive handler map.** Variants only this module defines (the states of its own machine, the events of its own reducer): a map typed over the union, so a missing variant is a **compile error** and each arm is a named function.

```ts
// ❌ Behavior selected by type; a new block type edits this file
function renderBlock(block: Block): HTMLElement {
  switch (block.type) {
    case 'hero':     return renderHero(block);
    case 'carousel': return renderCarousel(block);
    default:         throw new Error(`Unknown block ${block.type}`);
  }
}

// ✅ Open set — a registry other modules extend without touching this file
const renderers = new Map<string, (block: Block, root: HTMLElement) => void>();
export const registerBlockRenderer = (type: string, render: (block: Block, root: HTMLElement) => void) =>
  void renderers.set(type, render);
export function renderBlock(block: Block, root: HTMLElement): void {
  const render = renderers.get(block.type);
  if (!render) throw new UnknownBlockType(block.type);     // explicit, never a silent no-op
  render(block, root);
}

// ✅ Closed set — an exhaustive handler map; forgetting a variant does not compile, and no cast is needed
type CartEvents = {                                   // payload per event type
  itemAdded: { line: CartLine };
  itemRemoved: { sku: Sku };
  cleared: Record<never, never>;
};
type CartEvent<K extends keyof CartEvents = keyof CartEvents> =
  { [P in K]: { type: P } & CartEvents[P] }[K];     // the union, built from the map

const handlers: { [K in keyof CartEvents]: (s: Cart, e: CartEvent<K>) => Cart } = {
  itemAdded:   (s, e) => ({ ...s, lines: [...s.lines, e.line] }),
  itemRemoved: (s, e) => ({ ...s, lines: s.lines.filter((l) => l.sku !== e.sku) }),
  cleared:     (s) => ({ ...s, lines: [] }),
};

export function reduce<K extends keyof CartEvents>(s: Cart, e: CartEvent<K>): Cart {
  return handlers[e.type](s, e);                      // correlated union: type-checks since TS 4.6
}
```

In React the same rule reads: a component map (`const blockComponents = { hero: Hero, carousel: Carousel } satisfies Record<Block['type'], ComponentType<…>>`), not a `switch` in JSX; composition (`children`, slots) instead of a component that grows a boolean prop per variant. In Magento: a registry module or a `rendererList` the component iterates (the checkout's payment renderers are this pattern), never a new `else if` in someone else's widget. In Stimulus: one controller per behavior, chosen by the markup's `data-controller`.

**Value → value mapping is not the smell.** A lookup object (`const labels = { … } satisfies Record<Status, string>`) or a ternary choosing between two values is fine. **Guard clauses** with early returns are fine. The smell is dispatching *behavior* by type.

**Review cue:** search the blast radius for `switch`, `else if`, nested ternaries in JSX, and `instanceof` ladders; convert every behavioral one (mandatory in scope — `SKILL.md` Plan mode).

---

## LSP — substitutes keep the contract

> Anything implementing an interface, extending a class, or wrapping a component must be usable wherever the original is, without the caller knowing.

```ts
// ❌ An implementation that breaks the port's promise
class ReadOnlyCartGateway implements CartGateway {
  async addLine(): Promise<readonly CartLine[]> { throw new Error('not supported'); }
}

// ✅ Segregate the capability (ISP) — callers depend only on what they can rely on
interface CartReader { lines(signal?: AbortSignal): Promise<readonly CartLine[]> }
interface CartWriter { addLine(sku: Sku, qty: Quantity, signal?: AbortSignal): Promise<readonly CartLine[]> }
```

The JS-specific forms:
- A wrapper component that swallows props its base accepts — drops `className`, `ref`, `aria-*`, `onClick`, or `...rest` — breaks every caller that passes them.
- A port whose contract returns a promise, implemented by a plain (non-`async`) function that **throws before returning one**; callers that handle failure with `.catch()` never see it.
- A Magento RequireJS mixin or an overridden widget method that changes the return type or skips `this._super()` for some inputs — the JS `around` plugin with the same LSP risk.
- A mock in a test that accepts inputs the real adapter rejects: the test proves nothing about the real thing.

---

## ISP — no client depends on what it does not use

- **Narrow props.** A `PriceBadge` that takes the whole `Product` DTO re-renders on every product change and couples to fields it never reads; give it `price`, `specialPrice`, `currency`.
- **Split contexts by change frequency.** One `AppContext` holding user, cart, theme and feature flags re-renders everything on any change and makes every consumer depend on all of it.
- **Role interfaces for ports.** `CartReader` and `CartWriter`, not a twelve-method `CartService` that half the implementations stub.
- **Config objects that grow a flag per consumer** are fat interfaces too; the consumer-specific part belongs to the consumer.

---

## DIP — depend on abstractions the inner side owns

```ts
// ❌ Domain and use-case code reaching for concrete details
import { api } from '../../shared/api';                 // module-level singleton
export async function reorder(orderId: string) {
  const order = await api.get(`/orders/${orderId}`);    // transport
  localStorage.setItem('last-reorder', orderId);        // storage
  return { at: Date.now(), order };                     // clock
}

// ✅ The use case owns its ports; the composition root injects the real ones, tests inject fakes
export interface OrderReader { get(id: OrderId, signal?: AbortSignal): Promise<Order> }
export interface RecentActions { remember(action: 'reorder', id: OrderId): void }
export interface Clock { now(): Date }

export const reorder = (deps: { orders: OrderReader; recent: RecentActions; clock: Clock }) =>
  async (id: OrderId, signal?: AbortSignal) => {
    const order = await deps.orders.get(id, signal);
    deps.recent.remember('reorder', id);
    return { at: deps.clock.now(), order };
  };
```

The injection mechanism is the host's: function parameters and factories anywhere; a context provider in React; values, outlets and the controller's `connect()` in Stimulus; the config object passed to a Magento widget or uiComponent; the `mount(el, props)` call of an island. **The service locator is the anti-pattern** in every host: `window.app.get('cart')`, `registry.get('checkout.steps')` reached into from business code, `require()` at call time.

**Review cue:** any `fetch`, `XMLHttpRequest`, `$.ajax`, `axios`, `localStorage`, `document`, `window`, `process.env`, `Date.now()`, `new Date()`, `Math.random()` or framework import inside a domain or use-case module is a DIP violation.

---

## Detection recipes — candidates, not findings

Run these over the blast radius before the reading pass, in the diagnosis order above. Patterns are ripgrep (`rg -n`; `-P` where noted). Always add `-g '!**/node_modules/**' -g '!**/{dist,build,coverage,pub/static,public/build}/**'`, and `-g '!**/{tests,test,__tests__}/**' -g '!*.{test,spec}.*'` except for the test rows. Source globs: `-g '*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'`. Each hit is opened and judged; the right-hand column is what clears it.

| Principle | Search | Cleared when |
|---|---|---|
| DIP | `\bfetch\(\|axios\b\|XMLHttpRequest\|\$\.(ajax\|get\|post)\(\|localStorage\|sessionStorage\|indexedDB\|document\.\|window\.\|process\.env` in `**/{domain,model,entities,application,use-cases,core}/**` | never in those folders; move it behind a port |
| DIP | `Date\.now\(\)\|new Date\(\)\|Math\.random\(\)\|crypto\.randomUUID\(` in the same folders | the value is an argument's default at the edge; otherwise a `Clock`/`IdGenerator` port |
| DIP | `^import .* from ['"](react\|react-dom\|@hotwired/stimulus\|knockout\|jquery\|alpinejs)` in the same folders | never |
| DIP | `window\.\w+\s*=\|globalThis\.\w+\s*=\|window\[['"]` | the project's documented bridge between classic scripts (one namespaced object), written by an entry point — say so in the report |
| SRP | files named `utils?\|helpers?\|common\|misc\|functions` (`rg --files \| rg -i '/(utils?\|helpers?\|common\|misc)\.[cm]?[jt]sx?$'`) | the file has one charter its name states (`string-utils` holding only string functions is still a smell: name the concern) |
| SRP | `wc -l` over the radius, longest first; `rg -c 'useEffect\|useState' <file>` | above ~250 lines, or more than ~5 effects/states, read for a second reason to change |
| OCP | `\bswitch\s*\(\|\belse if\b\|instanceof` | the arms map value → value, or are guard clauses, or narrow a type for the compiler. It is the smell when each arm **does something different** for a type/kind/method |
| OCP | `\?[^:?]+:[^?]*\?` inside `*.tsx`/`*.jsx` (`-P`; nested ternary) | two values, not two behaviors |
| LSP | `throw new \w*Error\(['"][^'"]*(not (supported\|implemented)\|unsupported\|read.?only)` (`-i`) | the interface documents the throw; otherwise segregate the interface |
| LSP | wrapper components: `\.\.\.rest` absent where the base accepts arbitrary props — read, don't grep | the wrapper forwards what it claims to accept |
| ISP | `interface \w+Props` with more than ~8 members; `useContext\(\w*(App\|Global\|Main)\w*Context\)` | every consumer uses most of it |

A search that returns nothing clears only the spelling it looked for. SRP and LSP in particular are read, not grepped.

---

## SOLID review checklist
- [ ] **SRP** — every touched module, component and hook states its job without "and"; no `utils`/`helpers` grab-bags; no god components or hooks.
- [ ] **OCP** — no behavior selected by `switch`/`else if` on a type; open sets are registries, closed sets are exhaustive handler maps; lookups only for value → value.
- [ ] **LSP** — no implementation throws "unsupported", narrows input, swallows props, or throws synchronously from an async contract.
- [ ] **ISP** — props, contexts, config objects and ports are role-sized.
- [ ] **DIP** — inner code depends only on interfaces it owns; no `fetch`/storage/DOM/clock/framework reach from domain or use cases; the composition root wires each port; no service locator.
