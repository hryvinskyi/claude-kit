# TypeScript — types as the published language

TypeScript turns the contracts of `clean-architecture.md` into things the compiler checks: ports are interfaces, value objects are brands, states are unions, boundaries are parsers. It also offers a dozen ways to switch the checking off. This file is about keeping it on.

---

## 1. The compiler is the first reviewer

The floor for code you write or change:

```jsonc
{
  "compilerOptions": {
    "strict": true,                      // non-negotiable: noImplicitAny, strictNullChecks, useUnknownInCatchVariables…
    "noUncheckedIndexedAccess": true,    // arr[i] and record[key] may be undefined — because they may
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,  // where the project can afford it: `x?: T` ≠ `x: T | undefined`
    "isolatedModules": true,             // every file compilable alone — what esbuild, swc and Vite assume
    "verbatimModuleSyntax": true         // `import type` stays a type import
  }
}
```

- **Never loosen the config to make a change compile.** `strict: false`, a new `skipLibCheck` to hide your own `.d.ts` errors, an `exclude` for the file that fails, `checkJs: false` for the JS that fails — each is a baseline entry in disguise. A project that runs looser gets stricter settings *for new code* the way it supports that (a stricter `tsconfig` extending the base for the new directory, project references), never a looser one for yours.
- **The type-check gate is real only if something runs it.** Vite, esbuild, swc, Bun and Node's type stripping **erase types without checking them**. A project that builds with one of them needs `tsc --noEmit` (or `tsc -b`, `vue-tsc`) in its scripts and CI; discover it, run it on what you touch, and say so when there is none.

## 2. `unknown` at the edge, parsers inside it

Everything from outside the process is `unknown` until a parser says otherwise: `fetch` bodies, `JSON.parse`, `data-*` attributes, `<script type="application/json">`, storage, `postMessage`, URL params, `process.env`, a message from a worker. **Parse, don't validate**: the parser returns the domain type, so code behind it never re-checks.

Use the project's schema library when it has one (Zod, Valibot, ArkType, io-ts). Without one, a small hand-written parser is enough — and costs no bundle:

```ts
export class ContractError extends Error {
  readonly path: string;
  constructor(path: string, expected: string) {
    super(`${path}: expected ${expected}`);
    this.name = 'ContractError';
    this.path = path;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, path: string): string => {
  if (typeof v !== 'string') throw new ContractError(path, 'string');
  return v;
};
const int = (v: unknown, path: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ContractError(path, 'integer');
  return v;
};

export type CartDto = { readonly items: readonly { readonly sku: string; readonly qty: number }[] };

export function parseCartDto(raw: unknown): CartDto {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw new ContractError('$', 'object with items[]');
  return {
    items: raw.items.map((item: unknown, i: number) => {        // annotate: Array.isArray gives any[]
      if (!isRecord(item)) throw new ContractError(`$.items[${i}]`, 'object');
      return { sku: str(item.sku, `$.items[${i}].sku`), qty: int(item.qty, `$.items[${i}].qty`) };
    }),
  };
}
```

A `ContractError` is a bug in the contract between two systems: log it with the path, show the person a generic failure, and never let a half-parsed object into the UI.

## 3. `any`, `as`, `!` — three ways to lie to the compiler

- **`any`** switches checking off for everything it touches and spreads through inference. Banned in code you write (`@typescript-eslint/no-explicit-any` where the project lints). `unknown` plus narrowing is what `any` was trying to say.
- **`as`** is a claim the compiler cannot check. Acceptable in exactly three places: `as const`; inside a smart constructor or type guard, right after the runtime check that justifies it (`ddd.md` §3); and in tests building deliberately partial fakes. `as unknown as T` is always a lie. `(await res.json()) as Order` is the most common cast boundary in the ecosystem — `clean-architecture.md` §4.
- **`!`** (non-null assertion) claims a value cannot be `null`/`undefined`. Handle the absence instead: an early return, a thrown error with context, a default that is actually correct. `document.querySelector('.x')!` is a crash waiting for a template change.
- **`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`** in source are suppressions; the guard hook `debt_guard.py` refuses them (a type-level test may use `@ts-expect-error` to assert that something does *not* compile).

Prefer `satisfies` to annotations when you want both the check and the narrow type:

```ts
const statusLabels = {
  pending: 'order.status.pending',
  paid: 'order.status.paid',
  shipped: 'order.status.shipped',
} as const satisfies Record<OrderStatus, string>;   // a missing status fails; keys stay literal
```

## 4. Unions over flags, maps over switches

Model states as discriminated unions (`ddd.md` §5), and dispatch on them with an exhaustive handler map typed over the union (`solid.md` §OCP) — a missing variant is a compile error, no cast needed. Narrowing unknown input with `typeof`/`in` guard clauses is fine; the smell is a `switch` that selects behavior by a type.

## 5. Brands for value objects and ids

`type Sku = Brand<string, 'Sku'>` with a smart constructor makes an unvalidated string impossible to pass where a `Sku` is required, at zero runtime cost (`ddd.md` §3–4). Brand ids so an `OrderId` cannot stand in for a `CustomerId`.

## 6. Ports are interfaces the inner side owns

```ts
// application/ports.ts
export interface CartReader { lines(signal?: AbortSignal): Promise<readonly CartLine[]> }
export interface CartWriter { addLine(sku: Sku, qty: Quantity, signal?: AbortSignal): Promise<readonly CartLine[]> }
```

- `interface` for object contracts that are implemented and extended; `type` for unions, mapped and function types.
- Inputs are `readonly` (`readonly T[]`, `Readonly<T>`): a port that may mutate what it is given has a hidden output.
- Role-sized (`solid.md` §ISP); the implementation `implements` the interface, so a drift is a compile error at the adapter, not a runtime surprise in the use case.
- Generics earn their place by having more than one instantiation. A `Repository<T>` with one `T` is ceremony.

## 7. Syntax that erases cleanly

Node's type stripping (`node --test file.ts` on current Node) handles only **erasable** syntax — types it can delete without changing what the code does. esbuild, swc, Vite and Bun compile more (enums, namespaces), but one file at a time, without seeing other files' types (`isolatedModules`). TypeScript 5.8's `erasableSyntaxOnly` enforces the subset that runs everywhere. Write code that works under it even where it is not on:

- **No `enum`** → a string-literal union, or an `as const` object plus `typeof X[keyof typeof X]`.
- **No `namespace` / `module Foo {}`** → ES modules.
- **No `import x = require('…')`** → `import`.
- **No parameter properties** (`constructor(private readonly x: X)`) → declare the field, assign it in the constructor.
- **`import type`** for type-only imports (`verbatimModuleSyntax`); under Node's type stripping, relative imports spell the real `.ts` extension (`allowImportingTsExtensions` or `rewriteRelativeImportExtensions`, per the project).

## 8. Declaration files

- **Module-loader modules** (AMD and the like): a local `types/` folder with `declare module '<loader id>' { … }` for the few modules the TypeScript code imports — typed as narrowly as the code uses them.
- **Globals**: `declare global` only for globals the platform really provides (a `window.appConfig` the page prints), typed as `unknown` or as a parsed shape — never `any`.
- **Untyped packages**: a minimal module declaration beside the code, not `declare module '*'` and not a blanket `any` shim.
- `.d.ts` files describe; they never contain logic, and a hand-written one is reviewed like code.

## 9. TypeScript in the pipeline — discover which one the project runs

| Pipeline | What compiles `.ts` | What type-checks |
|---|---|---|
| Vite / esbuild / swc scripts | the bundler, types erased | only `tsc --noEmit` — add it to the gate if missing |
| A server framework's asset pipeline | the rows in the frontend stack skill | `tsc --noEmit` unless the stack skill names a checker |
| Node scripts and tests | Node's type stripping, or `tsx` | `tsc --noEmit` |

A compiled `.js` committed next to its `.ts` source with no build step in the project's tooling is a **fork**, not a build: the two drift, and the page runs whichever was edited last. Either wire the build (and a check that the committed output matches it), or delete one of them.

## 10. Types for JavaScript that stays JavaScript

Classic scripts and legacy modules that cannot enter a build still get checked: `// @ts-check` at the top and JSDoc types (`@param {Sku} sku`, `@typedef`, `@type {import('./cart').Cart}`), with `checkJs` for a directory. It is the migration path for a legacy file that enters the blast radius.

---

## Detection recipes — candidates, not findings

ripgrep with `-g '*.{ts,tsx,mts,cts}'` plus the exclusions of `solid.md`; `tsconfig*.json` for the config row.

| Smell | Search | Cleared when |
|---|---|---|
| `any` | `:\s*any\b\|<any>\|\bas any\b\|any\[\]` | a third-party type forces it at one adapter line, converted to `unknown` on the next — say so |
| Cast boundary | `\.json\(\)\)?\s*as\s\|JSON\.parse\([^)]*\)\s*as\s\|as unknown as` | never — parse |
| Other casts | `\bas [A-Z]\w*` | inside a guard or smart constructor right after its runtime check; in a test fake |
| Non-null assertions | `\w[\])]?!\.\|\w!\)\|querySelector\([^)]*\)!` (`-P`) | the value was checked on the line before and the compiler cannot see it — prefer restructuring |
| Suppressions | `@ts-(ignore\|expect-error\|nocheck)\|eslint-disable` | a type-level test asserting a compile error |
| Non-erasable syntax | `^\s*(export )?(const )?enum \|^\s*(export )?namespace \|^\s*module \w+ \{\|import \w+ = require\|constructor\([^)]*(private\|public\|protected\|readonly) ` (`-P`) | the project neither strips types nor plans to — still prefer the erasable form in new code |
| Loosened config | `"strict":\s*false\|"noImplicitAny":\s*false\|"checkJs":\s*false\|"skipLibCheck":\s*true` in `tsconfig*.json` changed by the diff | pre-existing and outside the change |
| Type-only import across layers | `import type .* from '(\.\./)+(adapters\|ui\|infrastructure)` in domain/application | never — types are dependencies too |

## TypeScript review checklist
- [ ] Touched code type-checks under `strict` (plus the project's stricter flags); nothing was loosened to get there; a type-check gate actually runs.
- [ ] Every untrusted input is `unknown` until a parser returns a domain type; no cast boundary.
- [ ] No new `any`, `as unknown as`, unjustified `as`, `!`, or `@ts-*`/`eslint-disable` suppressions.
- [ ] States are unions; dispatch is an exhaustive handler map or a registry; value→value maps use `satisfies`.
- [ ] Value objects and ids are branded, with smart constructors.
- [ ] Ports are role-sized interfaces owned by the inner side; inputs are `readonly`.
- [ ] Only erasable syntax in new code; `import type` for types.
- [ ] Declaration files are narrow; compiled output is produced by a build the project runs, never hand-maintained beside its source.
