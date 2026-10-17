---
description: Record a project decision in the project's knowledge vault (<vault>/Decisions/)
argument-hint: "[what was decided — or leave empty to capture the current session's decision]"
---

Record a decision in the project's knowledge vault.

**Resolve the vault first**: run `find-vault` from the repo root (the shared rule: the `Knowledge-base directory:` line in `CLAUDE.md`/`AGENTS.md`, else a unique dir holding `To DO.md` + `Decisions/` at depth 1 or under `.claude/`). Exit 1 = none: ask the user for it and suggest recording the declaration line in `CLAUDE.md` so future runs are deterministic. Exit 2 = ambiguous: ask which one, then add the declaration. Below, `<vault>/` denotes that directory; follow the project's knowledge-base conventions where it documents them.

1. **Identify the decision.** Use `$ARGUMENTS` if given; otherwise extract the most consequential decision made in the current conversation (choice + alternatives + reasoning). If several independent decisions were made, write one record each.
2. **Check for a predecessor.** Grep `<vault>/Decisions/` for records covering the same area. If this decision replaces one, set the old record's `status: superseded by [[<new stem>]]` (that status line is the only edit history allows).
3. **Write the record** to `<vault>/Decisions/YYYY-MM-DD <short-slug>.md` (today's date). If the vault ships a decision template (e.g. `<vault>/Templates/Decision.md`), use it; otherwise write frontmatter (`type: decision`, `status: accepted`, `area:`) then **Context / Decision / Alternatives considered / Consequences / Links**. Ground every claim in what actually happened — link the touched module notes (`[[module]]`), related decisions, and commits/PRs when known. Terse, factual.
4. **Index it.** If the vault keeps a decisions index (e.g. `<vault>/Decisions/Decisions MOC.md`), add one line under the current year, newest first: `- YYYY-MM-DD — [[<stem>]] — <area>`. **Unless the index is generated**: a list between generated-block markers (e.g. `<!-- …:generated:start -->`) is rewritten by the project's sync, so leave it alone — the record's file name and frontmatter are what the sync lists.
5. Report the file path and a one-line summary. Do not commit if the vault is git-ignored.
