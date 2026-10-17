# Implementation Plan — Free-shipping progress bar

## Context

Module `Acme_FreeShipping` (`app/code/Acme/FreeShipping`). On the product page, under the
add-to-cart button, a bar shows how far the shopper's cart is from free shipping — *"Add
125,00 kr. more for free shipping"* — and *"You have free shipping!"* once the threshold is
reached. Ubiquitous language: *threshold* (the configured free-shipping subtotal), *gap*
(threshold minus cart subtotal, never negative), *qualified* (the gap is zero).

## Decisions taken in this plan

- The threshold comes from `carriers/freeshipping/free_shipping_subtotal`, read by the ViewModel.
- The bar reads the cart subtotal from the page itself, so showing it costs no extra request.
- Two progress modes: `amount` (subtotal against the threshold) and `quantity` (item count
  against a minimum, for campaigns that grant free shipping from N items).
- The widget is TypeScript under `view/frontend/web/ts/`, compiled to
  `view/frontend/web/js/free-shipping-bar.js`.

## Task table

| # | Task | Depends on |
|---|------|------------|
| 1 | ViewModel `FreeShippingBar` | — |
| 2 | Template and layout | 1 |
| 3 | `free-shipping-gap.ts` — the gap calculation | — |
| 4 | `free-shipping-bar.ts` — the widget | 3 |
| 5 | Module wiring | — |
| 6 | Tests | 1–4 |

## Task 1 — ViewModel

`app/code/Acme/FreeShipping/ViewModel/FreeShippingBar.php` implements `ArgumentInterface`.
`getConfigJson(): string` returns JSON with:

- `thresholdMinor` — int, from `carriers/freeshipping/free_shipping_subtotal`, in minor units;
- `currency` — the store's currency code;
- `mode` — `amount` or `quantity`, from `acme_free_shipping/bar/mode`;
- `minimumItems` — int, from `acme_free_shipping/bar/minimum_items`;
- `subtotalMinor` and `itemCount` — the current quote's subtotal and item count, read from
  `Magento\Checkout\Model\Session`.

Unit and integration tests.

## Task 2 — template and layout

`view/frontend/layout/catalog_product_view.xml` adds block `acme.freeshipping.bar` to
`product.info.main` with template `Acme_FreeShipping::bar.phtml` and the ViewModel as the
`view_model` argument. The template:

```php
<?php $assetRenderer = $viewModels->require(\Hryvinskyi\ThemeAssets\Api\AssetRendererInterface::class); ?>
<div data-free-shipping-bar
     data-config="<?= $escaper->escapeHtmlAttr($block->getViewModel()->getConfigJson()) ?>">
    <div class="fsb__track"><div class="fsb__fill"></div></div>
    <p class="fsb__label"></p>
</div>
<?= $assetRenderer->renderStyle('Acme_FreeShipping::css/free-shipping-bar.css') ?>
<?= $assetRenderer->renderScript('Acme_FreeShipping::js/free-shipping-bar.js') ?>
```

The stylesheet (`view/frontend/web/css/free-shipping-bar.css`) is about 1 KB. The compiled
script is about 38 KB minified: it bundles the price formatting and the progress animation.

## Task 3 — the gap calculation

`view/frontend/web/ts/free-shipping-gap.ts`, a pure module:

```ts
export type FreeShippingGap = { gapMinor: number; qualified: boolean; progress: number };

export function freeShippingGap(subtotalMinor: number, thresholdMinor: number): FreeShippingGap
```

`gapMinor` is never negative; `progress` is clamped to 0–1; a threshold of 0 means everyone
qualifies. No DOM, no imports.

## Task 4 — the widget

`view/frontend/web/ts/free-shipping-bar.ts`, compiled by `npm run build`:

```ts
import { freeShippingGap } from './free-shipping-gap.ts';

type BarConfig = {
  thresholdMinor: number; currency: string; mode: 'amount' | 'quantity';
  minimumItems: number; subtotalMinor: number; itemCount: number;
};

const root = document.querySelector<HTMLElement>('[data-free-shipping-bar]');
const config = JSON.parse(root!.dataset.config!) as BarConfig;

switch (config.mode) {
  case 'amount': {
    const gap = freeShippingGap(config.subtotalMinor, config.thresholdMinor);
    render(gap.progress, gap.qualified
      ? 'You have free shipping!'
      : `Add ${format(gap.gapMinor, config.currency)} more for free shipping`);
    break;
  }
  case 'quantity': {
    const missing = Math.max(0, config.minimumItems - config.itemCount);
    render(config.itemCount / config.minimumItems, missing === 0
      ? 'You have free shipping!'
      : `Add ${missing} more items for free shipping`);
    break;
  }
}
```

`format()` formats minor units with `Intl.NumberFormat` in the page's locale
(`document.documentElement.lang`). `render()` sets the fill's width, the label's `textContent`,
and `data-qualified` on the root.

## Task 5 — module wiring

Add `Magento_Checkout` to the `<sequence>` in `etc/module.xml`, and `magento/module-checkout` to
the module's `composer.json` `require`, for the checkout session the ViewModel reads. Add
`etc/adminhtml/system.xml` and `etc/config.xml` for `acme_free_shipping/bar/mode` (default
`amount`) and `acme_free_shipping/bar/minimum_items` (default `3`).

## Task 6 — tests

- `Test/Unit/ViewModel/FreeShippingBarTest.php` — the config JSON in both modes.
- `Test/Js/free-shipping-gap.test.ts` — `node --test`: below, at and above the threshold, and a
  zero threshold.
- `Test/Unit/Template/BarTemplateTest.php` — reads `view/frontend/templates/bar.phtml` with
  `file_get_contents()` and asserts that it contains
  `renderScript('Acme_FreeShipping::js/free-shipping-bar.js')` and `data-free-shipping-bar`,
  so that a template edit cannot drop the widget.
