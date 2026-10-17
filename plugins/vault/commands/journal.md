---
description: Write a work-journal entry for this session into the project's knowledge vault (<vault>/Journal/)
argument-hint: "[optional focus — defaults to everything significant this session]"
---

Write a journal entry for the current session into the project's knowledge vault.

**Resolve the vault first**: run `find-vault` from the repo root (the shared rule: the `Knowledge-base directory:` line in `CLAUDE.md`/`AGENTS.md`, else a unique dir holding `To DO.md` + `Decisions/` at depth 1 or under `.claude/`). Exit 1 = none: ask the user for it and suggest recording the declaration line in `CLAUDE.md` so future runs are deterministic. Exit 2 = ambiguous: ask which one, then add the declaration. Below, `<vault>/` denotes that directory; follow the project's knowledge-base conventions where it documents them.

1. **Scope**: `$ARGUMENTS` if given, otherwise everything significant done this session (features, fixes, refactors, investigations, incidents — skip trivia).
2. **Write** `<vault>/Journal/YYYY-MM-DD <short-slug>.md` (today's date; if an entry for today covering the same work exists, extend it instead of duplicating). Use the vault's journal template if it ships one (e.g. `<vault>/Templates/Journal.md`):
   - **What changed** — with `[[module]]` links and key file paths
   - **Why** — the trigger/goal in one or two sentences
   - **Decisions** — link records in `<vault>/Decisions/` (create missing ones via the `/vault:decision` flow first if a real decision went unrecorded)
   - **Gotchas hit** — anything a future session would otherwise rediscover the hard way
   - **Follow-ups** — actionable leftovers
3. **Mirror follow-ups** into the vault's TODO board if it keeps one (e.g. `<vault>/To DO.md`, `## Next` or `## Later`, with today's date), and move anything completed this session to its `## Done`.
4. **Clear the inbox.** If the session brief showed an `[INBOX]` line, open the file it names (`<vault>/Inbox.md` for a vault that is its own repository, otherwise under `~/.claude/state/vaults/<project>/`) and delete the `<!-- session:<id> -->` entries this journal entry covers — writing the entry is what promotes them.
5. Report the file path and the follow-ups added. Do not commit if the vault is git-ignored.
