# React — components are adapters

React is a framework and a driver. Its components, hooks and context are the **interface-adapter** layer: they turn state into markup and user events into calls. The rules the product runs on live in plain TypeScript that never imports React — which is what lets them be tested in Node, reused by another island, and survive the next framework change. Read `javascript.md` and `typescript.md` first; this file is where each piece goes in React.

## 1. Where logic lives

| Piece | Layer | Rule |
|---|---|---|
| Types, value objects, rules, reducers, calculations | Domain — plain `.ts` beside the feature | Never imports `react` |
| `addToCart(ports)(input)`, `saveDraft(ports)(draft)` | Use case — plain `.ts` | Takes its ports as arguments; no hooks, no JSX |
| `useAddToCart()`, `useDraftAutosave()` | Adapter — a custom hook | **Binds** a use case to React: state, lifecycle, cancellation, the data library |
| `<AddToCartButton>` | Adapter — a component | Renders state, forwards events, chooses wording |
| `mountCart(el, props)`, `<App>` with providers | Composition root | Builds the ports, provides them, renders the root |

```tsx
// cart/application/add-to-cart.ts — plain TypeScript, tested in Node
export const addToCart = (cart: CartWriter) =>
  (sku: Sku, qty: Quantity, signal?: AbortSignal) => cart.addLine(sku, qty, signal);

// cart/ui/use-add-to-cart.ts — the hook binds the use case to React
export function useAddToCart() {
  const { cart } = usePorts();                                   // provided at the root, faked in tests
  const [state, setState] = useState<Remote<readonly CartLine[]>>({ status: 'idle' });
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);         // unmount cancels

  const add = useCallback(async (sku: Sku, qty: Quantity) => {
    inFlight.current?.abort();                                   // a newer click wins
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ status: 'loading' });
    try {
      setState({ status: 'loaded', data: await addToCart(cart)(sku, qty, controller.signal) });
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: 'failed', error: toLoadError(error) });
    }
  }, [cart]);

  return { state, add };
}

// cart/ui/AddToCartButton.tsx — renders and binds; wording through the i18n layer
export function AddToCartButton({ sku }: { sku: Sku }) {
  const { state, add } = useAddToCart();
  const t = useT();
  return (
    <button type="button" disabled={state.status === 'loading'} onClick={() => void add(sku, quantity(1))}>
      {state.status === 'failed' ? t('cart.add.retry') : t('cart.add')}
    </button>
  );
}
```

With a data library (TanStack Query, SWR, RTK Query) the hook is thinner — the library owns caching, retries and cancellation — but the split is the same: the library's `queryFn`/`mutationFn` calls the **use case or the port**, never `fetch` inline in a component.

## 2. The state taxonomy — put each kind where it belongs

| Kind | Home | Smell |
|---|---|---|
| **Server state** (cart, orders, products) | The data layer — a query library, or the project's typed client plus one store | Copied into a global store or `useState` and "kept in sync" |
| **URL state** (filters, tab, page, search) | The router's search params | Lost on reload or share; duplicated in state |
| **Form state** (drafts, touched, errors) | The form (controlled components or the project's form library) | Parsed and validated in five places |
| **UI state** (open, hovered, step) | `useState` in the nearest owner | Lifted to global for convenience |
| **Client-global state** (session UI, undo history of an editor) | One store with selectors (zustand, Redux) | A god store every component reads whole |

**Derive, don't sync.** A value computable from props and state is computed during render (with `useMemo` if measured to be expensive), not stored and updated by an effect. `useState(props.x)` freezes the first `x` — say so or key the component.

A store is a *client-side domain* when it holds rules (an editor, a canvas): keep its transitions as pure functions (`ddd.md` §5) that the store calls, so they are tested without React.

## 3. Effects synchronize with the outside world — nothing else

An effect is for **external systems**: a subscription, a non-React widget, a DOM API, the network *when no data layer does it*. It is not for:
- deriving state from state or props (compute it during render);
- responding to an event (do it in the event handler);
- chaining state updates (one handler computes the next state).

Every effect that starts something returns its cleanup (abort, unsubscribe, disconnect). A fetch in an effect needs an `AbortController` and a stale-response guard — or it belongs in the data layer. Silencing `react-hooks/exhaustive-deps` is a suppression (refused by `debt_guard.py`); a dependency list that "has to" be wrong means the effect is doing a handler's job.

## 4. Ports through context — DI without a container

Provide ports once, at the composition root; read them through a hook that fails loudly outside its provider:

```tsx
const PortsContext = createContext<Ports | null>(null);

export function PortsProvider({ ports, children }: { ports: Ports; children: ReactNode }) {
  return <PortsContext.Provider value={ports}>{children}</PortsContext.Provider>;
}

export function usePorts(): Ports {
  const ports = useContext(PortsContext);
  if (ports === null) throw new Error('usePorts() must be used inside <PortsProvider>');
  return ports;
}
```

Tests render the same tree with fake ports. A module-level `export const api = new ApiClient()` imported by hooks is the service locator: invisible to tests, impossible to vary per island.

## 5. Variants, extension and composition (OCP)

- **Variant rendering → a component map**, exhaustive over a closed union or a registry for an open one: `const blockComponents = { hero: Hero, carousel: Carousel } satisfies Record<Block['type'], ComponentType<BlockProps>>`. Not a `switch` in JSX; not a chain of `&&`s on `type`.
- **Composition over configuration.** `children`, slots and compound components (`<Tabs><Tabs.Panel/></Tabs>`) instead of a component that grows a boolean prop per consumer (`<Card compact bordered highlighted withImage>`).
- **Extension across packages → a published SDK**: one stable surface file other packages import (registries, the types they implement, the components they may compose), and generated or explicit registration — never a deep import into the host island's internals.

## 6. Narrow props and split contexts (ISP)

Pass what a component renders, not the DTO it came from. Split contexts by rate of change (ports rarely change; the current user sometimes; the editor selection constantly). Read stores through selectors so a component re-renders for its slice only.

## 7. Loading, empty and error are states

Render the union (`ddd.md` §5): `idle | loading | loaded | failed`, plus an explicit empty case. An error boundary per feature or island keeps one broken widget from blanking the page; Suspense boundaries sit where a loading state makes sense to the user. The message a person sees is chosen by the presentation layer from a mapped error — never `error.message`.

## 8. Forms

The form holds a **draft** (strings); submit parses it into a **command** (value objects) or field errors. Server-side validation errors come back mapped to fields by the adapter. A submit that moves money or creates something carries an idempotency key and is guarded against double submit (`integration-patterns.md` §4).

## 9. Wording

User-facing strings go through the project's i18n layer — per-feature dictionaries with a `useT()` hook, react-intl, i18next, Lingui — in components, keyed in the ubiquitous language. Pure modules return codes (`'format'`, `'out_of_stock'`), never English. Dictionaries are owned by the feature or island that uses them and exist for every locale the project ships.

## 10. Islands in a server-rendered page

In a server-rendered application, React usually runs as an **island**: a bundle mounted into one element of a page the server rendered.

- **The island's public surface is its mount function**: `mountX(el: HTMLElement, props: XProps): { unmount(): void }`. Nothing else is imported by the host.
- **Props are a DTO parsed at mount** — from the host controller's values or a JSON script tag — including everything environment-shaped: API base URL, CSRF token, locale, a `navigate(href)` callback. The island never reads `window` globals the host happens to define and never queries outside its root.
- **The host owns the lifecycle**: a page controller (or a small bootstrap) lazy-loads the bundle with `import()`, calls `mount` when it connects, and `unmount` when it disconnects — so client-side navigation, server re-renders and removed markup do not leak roots. The frontend stack skill names its framework's host.
- **One `createRoot` per mount point**; render after the locale dictionary is loaded, and guard that async gap against an unmount that arrives first.
- The island's bundle is built by the project's pipeline (esbuild, Vite, or the framework's own) and type-checked by `tsc --noEmit` — see `typescript.md` §9 and the frontend stack skill.

## 11. Next.js and server components (when the project uses them)

- A **server component** is an adapter that may call a use case directly on the server; it passes **serializable DTOs** to client components — the `'use client'` boundary is a serialization boundary.
- **Server actions** are humble delivery: parse the input, call the use case, map the result. Authorization happens inside, not in the calling component.
- Server-only modules (database clients, secrets) are guarded (`import 'server-only'`) so a client import fails the build.

## 12. Testing

- **Domain and use cases**: plain Node tests (Vitest, Jest, `node --test`), no React.
- **Hooks**: render them with fake ports (`renderHook` from Testing Library) and assert the state transitions, including abort and failure.
- **Components**: Testing Library by role and accessible name, the way a user finds them; network faked at the port or with a fake server (MSW). Snapshot tests are not a proof of behavior.
- **The island**: one test that calls `mount(el, props)` on real markup and `unmount()`, proving the public surface.
- **End-to-end** (Playwright) for the flows that cross the server.

## Detection recipes — candidates, not findings

ripgrep with `-g '*.{tsx,jsx,ts,js}'` plus the exclusions of `solid.md`.

| Smell | Search | Cleared when |
|---|---|---|
| Fetch in a component | `fetch\(\|axios\.` in `**/{components,ui,pages,routes}/**` | never — through the port or the data layer |
| Effect as a data layer | files with `useEffect\(` and `fetch\(\|\.get\(` | a subscription, or a fetch with abort and stale guard where no data layer exists |
| Derived state stored | `useState\(props\.\|useEffect\(\(\) => \{\s*set\w+\(` (`-P`, `-U`) | the state is a deliberate initial value, named `initial…` |
| Suppressed hook rules | `eslint-disable.*react-hooks` | never |
| Behavior switch in JSX | `switch\s*\(\|\.type === ['"]` in `*.tsx`/`*.jsx` | value → value |
| Index keys | `key=\{(i\|idx\|index)\}` | the list is static and never reordered |
| Raw HTML | `dangerouslySetInnerHTML` | server-sanitized HTML from the project's own endpoint, documented at the call |
| Singleton client | `export const \w+ = new \w*(Client\|Api\|Service)\(` imported by hooks | only the composition root imports it |
| Hard-coded wording | `>\s*[A-Z][a-z]+( [a-z]+)+\s*<\|(title\|placeholder\|aria-label)="[A-Z][a-z]+ ` (`-P`) in `*.tsx` | a proper noun or a code sample, not copy |
| God component | `wc -l` > ~250, or more than ~5 `useState`/`useEffect` | read for a second reason to change |

## React review checklist
- [ ] Components render and bind; hooks bind use cases; rules live in plain TS that never imports React.
- [ ] Each kind of state lives in its home; nothing derived is stored and synced by an effect.
- [ ] Effects only synchronize with external systems, always clean up, and are never silenced.
- [ ] Ports come through context from the composition root; no module-level singleton clients.
- [ ] Variants render through component maps or registries; composition over boolean props; extension through a published SDK surface.
- [ ] Props and contexts are narrow; stores are read through selectors.
- [ ] Loading, empty and error are explicit states; boundaries contain failures; people see mapped wording.
- [ ] Islands expose only `mount(el, props) → unmount`, parse props at mount, never reach outside their root, and are unmounted by the host.
- [ ] Domain, hooks, components and the mount are each tested at their own level.
