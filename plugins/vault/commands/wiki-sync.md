---
description: Refresh & enrich the project's knowledge vault from the code
argument-hint: "[module/area, optional]"
---

Refresh and enrich the project's knowledge vault from the current code.

**Resolve the vault first**: run `find-vault` from the repo root (the shared rule: the `Knowledge-base directory:` line in `CLAUDE.md`/`AGENTS.md`, else a unique dir holding `To DO.md` + `Decisions/` at depth 1 or under `.claude/`). Exit 1 = no vault: ask the user where it is and suggest recording the declaration line in `CLAUDE.md` so future runs are deterministic. Exit 2 = ambiguous: ask which one, then add the declaration.

Then **spawn the wiki updater** — the project's own `wiki-updater` agent when the project defines one (`.claude/agents/wiki-updater.md`, which knows that vault's conventions), otherwise this plugin's `vault:wiki-updater` — with the scope: `$ARGUMENTS` if given, otherwise whatever changed since the vault was last updated (the agent scopes from recent git history). The agent runs the project's sync script when `CLAUDE.md`/`AGENTS.md` declares one, refreshes the factual sections by hand otherwise, writes prose only outside any generated block, and verifies with an idempotent re-run (a sync tool should report `0 created · 0 updated`).

Read its report and relay: notes refreshed, prose written, orphans surfaced (never deleted), and the re-run result. Do not commit.
