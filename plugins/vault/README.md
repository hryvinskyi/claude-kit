# vault

A project's knowledge vault — decision records, a work journal, a TODO board, notes on the code —
kept as Markdown beside the code, and the tools that keep it honest.

## What it does

| Part | When it runs | What it does |
|---|---|---|
| `hooks/session_brief.sh` | `SessionStart` (startup, clear) | Prints a short brief: the board's `## Now` and `## Next`, the latest journal entry and decision, the vault check's findings, the inbox and backup lines, and the board queue's lines for this repository when a `board-queue` command is installed |
| `bin/session_capture.py` | `SessionEnd` | Hands off to a detached worker that files a session which committed work without a journal entry into the vault's inbox, refreshes the vault check, commits and pushes a vault that is a git repository of its own, and refreshes the search index |
| `hooks/journal_nudge.py` | `Stop` | Once per session, after real work in a vault project with no journal entry for today, asks the model to offer `/vault:journal` |
| `/vault:decision`, `/vault:journal`, `/vault:todo`, `/vault:wiki-sync` | on request | Write a decision record, a journal entry, work the TODO board, refresh the notes from the code |
| `vault:wiki-updater` | spawned by `/vault:wiki-sync` | Runs the project's sync tooling and writes the prose a script cannot. A project that defines its own `wiki-updater` agent gets that one instead |

A project whose own `.claude/settings.json` declares a `SessionStart` or `SessionEnd` hook is left to
its own tooling for that event: the brief and the capture exit without doing anything there.

## Finding the vault

One rule, in `bin/find-vault.sh`: a `Knowledge-base directory: \`<dir>/\`` line in the project's
`CLAUDE.md` or `AGENTS.md`, otherwise a unique directory holding `To DO.md` and `Decisions/`, at
depth 1 or under `.claude/`. Exit 0 found, 1 none, 2 ambiguous.

## Commands

The plugin's `bin/` is on the Bash tool's search path while the plugin is enabled:

| Command | Runs |
|---|---|
| `find-vault [root]` | the resolver |
| `vault-check [--check \| --quiet \| --brief \| --stamp NOTE…]` | `bin/vault_check.py`: holds the notes to the code — a cited class or path that exists nowhere, or a broken link, is a hard finding; a cited file that changed since its paragraph was stamped is a soft one |
| `vault-capture [--brief]` | `bin/session_capture.py` |
| `vault-search ensure \| refresh` | `bin/vault_search.py`: a `qmd` search index of the vault in `<project>/.qmd/` |

Anything outside a Claude Code session — a scheduled job, a git hook, a project's own script — calls
them through the shims the kit's `bin/install-shims.sh` writes into `~/.local/bin`, which run the copy
in the kit clone and survive plugin updates.

## Where things are written

A vault that is a git repository of its own, or that the project's repository ignores, keeps its
inbox and review stamps beside the notes. Every other vault's machine files go under
`~/.claude/state/vaults/<project>/` (`$CLAUDE_VAULT_STATE` moves it), so a project's tracked tree never
changes because a tool ran. A project's repository is never committed.

Kill switches: `CLAUDE_NO_VAULT_TOOLS=1` for every tool, `CLAUDE_NO_JOURNAL_NUDGE=1` for the nudge.

## Tests

```sh
plugins/vault/tests/tests.sh        # the hooks and commands as Claude Code runs them, then the unit tests
```

The board-queue cases of the brief run when the `board-queue` plugin beside this one has had `npm ci`.
