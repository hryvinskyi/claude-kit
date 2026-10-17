---
description: Work with the project's knowledge-vault TODO board (<vault>/To DO.md) — show, add, complete, or groom
argument-hint: "[show | add <task> | done <task> | groom]"
---

Operate on the project's TODO board (the vault's TODO file, e.g. `<vault>/To DO.md`).

**Resolve the vault first**: run `find-vault` from the repo root (the shared rule: the `Knowledge-base directory:` line in `CLAUDE.md`/`AGENTS.md`, else a unique dir holding `To DO.md` + `Decisions/` at depth 1 or under `.claude/`). Exit 1 = none: ask the user for it and suggest recording the declaration line in `CLAUDE.md` so future runs are deterministic. Exit 2 = ambiguous: ask which one, then add the declaration. Below, `<vault>/` denotes that directory; follow the project's knowledge-base conventions where it documents them. The board sections are `## Now` / `## Next` / `## Later` / `## Done`.

Interpret `$ARGUMENTS`:

- **empty or `show`** — read the board and summarize: what's in Now/Next (with context links), anything stale (in Now for a long time), and the total per section.
- **`add <task>`** — append `- [ ] <imperative title> — <one-line context, [[module]] links> (added YYYY-MM-DD)` to the section that fits (`Next` by default; `Now` if the user says they're starting it; `Later` for ideas). Deduplicate against existing items first.
- **`done <task>`** — find the matching item, check it off, move it to the top of `## Done` with `(done YYYY-MM-DD)`.
- **`groom`** — reconcile the board with reality: cross-check `Now`/`Next` items against the code and recent git history (already shipped? → Done), flag items that lost relevance (ask before deleting anything the user wrote), prune `## Done` entries older than ~a month, and re-order `Next` by apparent priority. Report every change made.

Never delete items the user added except during an explicitly confirmed groom. Do not commit if the vault is git-ignored.
