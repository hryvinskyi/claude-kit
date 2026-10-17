---
description: Regenerate token-lean codemaps (architecture / backend / frontend / data) from the current codebase
argument-hint: "[optional area to refresh]"
---

# Update Codemaps

Analyze the codebase structure and update the architecture documentation in `codemaps/`.

**One knowledge system per project.** If the project keeps a knowledge vault with
structural maps (declared in `CLAUDE.md`/`AGENTS.md`; e.g. `<vault>/Maps/`), update those
via the vault's own tooling (`/wiki-sync`) instead of creating a parallel `codemaps/` —
two independently rotting systems are worse than one. Only proceed below when the project
has no vault-based maps.

1. **Detect the stack first** (`composer.json`, `package.json`, `go.mod`, `pyproject.toml`, …) and analyze with what fits it — do not assume any particular language or runtime.
2. Scan source files for modules/packages, entry points, and dependency edges (imports, exports, namespaces, DI wiring).
3. Generate **token-lean** codemaps — high-level structure, not implementation details:
   - `codemaps/architecture.md` — overall architecture (always)
   - `codemaps/backend.md`, `codemaps/frontend.md`, `codemaps/data.md` — only the ones that match what the project actually has (skip a frontend map for an API-only repo)
4. Calculate the diff against the previous version; if more than ~30% changed, show the diff summary and get user approval before overwriting.
5. Add a freshness timestamp to each codemap and save the diff report to `.reports/codemap-diff.txt`.

Scope to `$ARGUMENTS` if given.
