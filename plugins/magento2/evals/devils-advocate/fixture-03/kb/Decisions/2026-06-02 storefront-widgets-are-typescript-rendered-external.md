# Storefront widgets are TypeScript, rendered external and deferred

Status: Accepted · 2026-06-02

## Context

The product page's LCP regressed by about 400 ms after three widgets were inlined into the cached
HTML. Every page view re-sent roughly 90 KB of script the browser could otherwise have cached, and
the Varnish objects for catalog pages grew by the same amount.

## Decision

- Storefront widgets are TypeScript under `view/frontend/web/ts/`, compiled by
  `build/esbuild.mjs` into `view/frontend/web/js/`.
- Templates render them through theme-assets with `RENDER_EXTERNAL` and `LOAD_DEFER`.
  `RENDER_INLINE` is kept for files of 2 KB or less.
- `PRELOAD_ENABLED` is used only for a resource the LCP element needs.

## Consequences

A new widget costs one cacheable request instead of HTML weight on every view. A widget whose
entry is missing from `build/esbuild.mjs` has no compiled file, so its fileId renders nothing.
