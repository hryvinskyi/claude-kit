# Implementation Plan — Free-shipping gap

## Context

Module `Acme_FreeShipping`. The product page will show how far the cart is from free shipping.
This plan builds the calculation first, as a pure TypeScript module the widget (a later plan)
imports. Ubiquitous language: *threshold* (the configured free-shipping subtotal), *gap*
(threshold minus subtotal), *qualified* (the gap is zero), *progress* (how much of the threshold
the subtotal covers).

## Invariants

1. `gapMinor` is never negative.
2. `progress` is `subtotalMinor / thresholdMinor`, clamped to the range 0–1.
3. A threshold of 0 means every cart qualifies: gap 0, progress 1, qualified.
4. Amounts are integer minor units and never negative. A fractional or negative amount is a
   contract error the caller sees — never a silently rounded or clamped value.

## Task table

| # | Task | Depends on |
|---|------|------------|
| 1 | Config paths for the threshold (PHP) | — |
| 2 | ViewModel exposing the threshold (PHP) | 1 |
| 3 | `free-shipping-gap.ts` — the gap calculation | — |

## Task 1 — config paths

`etc/config.xml` and `etc/adminhtml/system.xml` for `acme_free_shipping/bar/enabled`.
Integration test.

## Task 2 — ViewModel

`ViewModel/FreeShippingThreshold.php` returns the threshold in minor units from
`carriers/freeshipping/free_shipping_subtotal`. Unit and integration tests.

## Task 3 — the gap calculation

Create `app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts`, a pure module
exporting the type `FreeShippingGap = { gapMinor: number; qualified: boolean; progress: number }`
and the function `freeShippingGap(subtotalMinor: number, thresholdMinor: number): FreeShippingGap`.
It must honour invariants 1–4. Add its tests in
`app/code/Acme/FreeShipping/Test/Js/free-shipping-gap.test.ts`; they run with `npm run test:js`.
Do not touch any other file.
