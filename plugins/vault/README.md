# vault

A project's knowledge vault — decision records, a work journal, a TODO board, notes on the code —
kept as Markdown beside the code, and the tools that keep it honest.

## What it does

| Part | When it runs | What it does |
|---|---|---|
| `hooks/session_brief.sh` | `SessionStart` (startup, clear) | Brings a vault that is its own repository up to date (fetch and fast-forward only), then prints a short brief: the board's `## Now` and `## Next`, the latest journal entry and decision, the vault check's findings, the inbox, conflict and backup lines, and the board queue's lines for this repository when a `board-queue` command is installed |
| `bin/session_capture.py` | `SessionEnd` | Hands off to a detached worker that files a session which committed work without a journal entry into the vault's inbox, refreshes the vault check, commits a vault that is a git repository of its own, rebases it onto its remote and pushes it, and refreshes the search index |
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
| `vault-merge <driver> %O %A %B %P` | `bin/vault_merge/`: the git merge drivers below |
| `vault-merge selfcheck FILE…` | reads each file as the `keyed` driver does and fails unless it writes back byte for byte; prints counts only |

Anything outside a Claude Code session — a scheduled job, a git hook, a project's own script — calls
them through the shims the kit's `bin/install-shims.sh` writes into `~/.local/bin`, which run the copy
in the kit clone and survive plugin updates.

## Merge drivers

A vault shared by several people collides in a few files: the TODO board, the inbox, lists of
records, the review stamps and the notes a tool regenerates. `vault-merge` gives git three drivers
for them (Python 3.9+, standard library only):

| Driver | For | What it does |
|---|---|---|
| `keyed` | line-item Markdown | Merges row by row. A row is a `- ` line at column 0 with its indented lines; its key is the first issue reference in its leading bold span with its repository (`example-org/example-repo#42` and `#42` are two rows), else that bold text, else its first 120 characters. An inbox entry keys by its `<!-- session:<id> -->` marker, a heading by its text, a `###` heading together with its body. Edits to different rows never conflict; a row moved to another section moves; a retitled row without an issue reference is still one row. A row changed differently on both sides (or added twice with different text) is kept twice, the second preceded by `<!-- vault-merge: two versions of this row; keep one -->` — delete the version you do not want and the line. The merge never stops on these; git prints how many rows have two versions |
| `stamps` | `.anchors.json` | Merges per note and cited file, and never drops an entry either side has (`vault-check` would stamp a missing one afresh, recording a review nobody made). Changed differently on both sides, the base stamp is kept; added differently on both, the older review — the stamp whose commit is an ancestor of the other's in the project the vault belongs to — else the current side's. Written by `vault-check`'s own writer |
| `generated` | notes with a region a tool writes | git's text merge; conflicts that all lie inside a generated region take the incoming side and the note's path is appended to `<git dir>/vault-regenerate` for the tool to rewrite. Any other conflict is left with git's markers |

Every rule is written in terms of the base, the current version (`%A`) and the incoming one (`%B`),
because `git pull --rebase` swaps which of them is yours. A driver that fails falls back to
`git merge-file`'s result and exit status, so a fault surfaces as an ordinary conflict; `%A` is only
ever replaced whole. Run `vault-merge selfcheck` on each keyed file before enabling the drivers.

Wiring, in the vault's clone (a clone without it falls back to git's text merge, which is safe).
`.gitattributes` patterns cannot hold a space, so it is written `[[:space:]]`:

```gitattributes
/To[[:space:]]DO.md merge=vault-keyed
/Inbox.md merge=vault-keyed
/.anchors.json merge=vault-stamps
/Modules/*.md merge=vault-generated
```

```sh
for d in keyed stamps generated; do
  git config merge.vault-$d.driver "$HOME/.local/bin/vault-merge $d %O %A %B %P"
done
git config vault-merge.generatedBegin '<!--\s*example:generated:start\s*-->'   # Python regular expressions
git config vault-merge.generatedEnd   '<!--\s*example:generated:end\s*-->'
git check-attr merge -- "To DO.md"                                                # vault-keyed
```

## Where things are written

A vault that is a git repository of its own, or that the project's repository ignores, keeps its
inbox and review stamps beside the notes. Every other vault's machine files go under
`~/.claude/state/vaults/<project>/` (`$CLAUDE_VAULT_STATE` moves it), so a project's tracked tree never
changes because a tool ran. A project's repository is never committed.

## A vault shared by several people

A vault that is a repository of its own can be cloned by a team. Then:

- **One lock per clone.** Every git operation the tools make on the vault — the session end's commit,
  rebase and push, the session start's fetch and fast-forward — runs under `vault-commit.lock` in the
  state directory, so several sessions on one machine never work on the clone at once.
- **Commit, then rebase, then push.** The session end commits what changed, rebases onto the remote
  (never stashing) and pushes; a refused push is fetched, rebased and retried, three attempts in all,
  with waits of one to four seconds.
- **Notes that do not rebase** are pushed to `conflict/<handle>/<UTC yyyymmdd-hhmm>`, and the clone is
  reset to the remote only once that push succeeded and nothing in the tree is uncommitted. The brief
  says `[VAULT CONFLICT] your notes from <time> are on branch <name> — merge them` until the branch
  is merged into the vault's branch or deleted on the remote.
- **The session start** fast-forwards only a clean clone without commits of its own, and otherwise
  says why it did not; it never merges or rebases.
- **Merge drivers' reports**: a `vault-regenerate` file in the clone's git directory lists notes whose
  generated facts a merge resolved by taking one side, and the brief prints `[VAULT] regenerate: …`;
  a line `<!-- vault-merge: two versions … -->` marks a row kept in both versions, and the brief
  counts them.
- **The inbox is per person.** Each entry records its author (`- by: <handle>`), and the brief counts
  only the reader's. An entry written before authors were recorded is the reader's when `git blame`
  says their commit wrote it.
- **The handle** is `git config vault.handle`, else `$VAULT_HANDLE`, else the git user name, reduced to
  lower-case letters, digits and hyphens.

Kill switches: `CLAUDE_NO_VAULT_TOOLS=1` for every tool, `CLAUDE_NO_JOURNAL_NUDGE=1` for the nudge.

## Tests

```sh
plugins/vault/tests/tests.sh        # the hooks and commands as Claude Code runs them, then the unit tests
                                    # (the merge drivers' among them, with real git repositories)
```

The board-queue cases of the brief run when the `board-queue` plugin beside this one has had `npm ci`.
