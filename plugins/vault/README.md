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

A vault is a directory strictly inside the project. A declaration that is empty, names the project
root (`./`), is absolute, has a `..` component, or leads out of the project through a symbolic link
is refused (exit 1, and no fallback search); the tools check it again before they write anything. A
vault counts as a repository of its own only when it is the top of a work tree whose repository is
not the project's — a clone, a submodule or a linked work tree of a vault repository, never a work
tree of the project's own repository.

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
| `vault-merge wire \| unwire` | registers the drivers in a vault clone's git configuration, or removes them (below) |

Anything outside a Claude Code session — a scheduled job, a git hook, a project's own script — calls
them through the shims the kit's `bin/install-shims.sh` writes into `~/.local/bin`, which run the copy
in the kit clone and survive plugin updates.

## Package layouts for `vault-check`

A note under `Modules/`, `Bridges/`, `Plugins/`, `Kernel/`, `Packages/` or `Services/` is named for a
package, and a relative path its prose cites may start inside that package: `packages/<note>/`,
`plugins/<note>/` or `vendor/*/<note>/`. A project laid out another way adds a **note-base rule**, one
line `<regex> <path template>`: the regex matches the note's file name without `.md` in full, and the
template names the package's directory with `{1}`, `{2}`… for the regex's groups.

```
# ${XDG_CONFIG_HOME:-~/.config}/claude-kit/vault-check.conf — one rule per line
([A-Z][A-Za-z0-9]*)_([A-Z][A-Za-z0-9]*) modules/{1}/{2}/
```

The rule file applies to every vault of the user. For one vault only, set the multi-valued git key
`vault-check.noteBase` there: `git -C <vault> config --add vault-check.noteBase '<regex> <template>'`.
Both sources apply. A rule that does not parse is named once per run, on the `vault-check` output
and the session brief, and skipped; the check itself runs on.

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
The vault carries a `.gitattributes` that gives files to the drivers; its patterns cannot hold a
space, so it is written `[[:space:]]`:

```gitattributes
/To[[:space:]]DO.md merge=vault-keyed
/Inbox.md merge=vault-keyed
/.anchors.json merge=vault-stamps
/Modules/*.md merge=vault-generated
```

Each clone registers the drivers in its own configuration, which git never shares:

```sh
vault-merge wire --check --vault <clone> --generated-begin '<!--\s*example:generated:start\s*-->' \
                                         --generated-end   '<!--\s*example:generated:end\s*-->'
vault-merge wire --vault <clone> ...            # the same options, applied
vault-merge unwire --vault <clone>              # removes the drivers' configuration
```

`wire` registers `merge.vault-<driver>.name` and `.driver` for the three drivers, running the
`vault-merge` shim (`--command` names another), and the two region markers (Python regular
expressions). It first reads back every tracked file the attributes give to the keyed driver and
refuses when one would not survive, and it refuses a clone in the middle of a merge or rebase.
`--attributes FILE` names the `.gitattributes` the vault should carry: an identical one is left
alone, a missing one is written and committed with `--commit` (nothing is pushed) and otherwise
reported, a different one is refused with the lines to fold in. `--expect PATH=DRIVER` checks what
`git check-attr merge` answers for a path afterwards. `--check` writes nothing; the exit status is 0
when nothing is left to do, 1 when a check found work, 2 when the run refused.

## Where things are written

A vault that is a git repository of its own, or that the project's repository ignores, keeps its
inbox and review stamps beside the notes. Every other vault's machine files go under
`~/.claude/state/vaults/<project>/` (`$CLAUDE_VAULT_STATE` moves it), so a project's tracked tree never
changes because a tool ran. A project's repository is never committed.

`<project>` is the project's path made readable, followed by a hash of the full path, so two projects
whose paths differ only in punctuation (`shop.dk`, `shop-dk`) never share one. A directory named the
older way, without the hash, is adopted by the first project it fits that no other project claimed;
the `project` file inside a state directory names the project it belongs to.

The locks are `flock(2)` locks, so the tools run on macOS and Linux: a lock is free the moment the
process holding it exits, however it exits, and no process takes over a lock another one holds.

## A vault shared by several people

A vault that is a repository of its own can be cloned by a team. Then:

- **One lock per clone.** Every git operation the tools make on the vault — the session end's commit,
  rebase and push, the session start's fetch and fast-forward — runs under `vault-commit.lock` in the
  state directory, so several sessions on one machine never work on the clone at once.
- **Commit, then rebase, then push.** The session end commits what changed, rebases onto the remote
  (never stashing) and pushes; a refused push is fetched, rebased and retried, three attempts in all,
  with waits of one to four seconds. Fetch and push never wait on a prompt: they run the ssh command
  git would run (`$GIT_SSH_COMMAND`, `core.sshCommand`, `$GIT_SSH`, else `ssh`), and when that is
  OpenSSH they add `-o BatchMode=yes -o ConnectTimeout=N` after its own options.
- **A clone git is not done with** — a merge, rebase, cherry-pick or revert waiting for a person,
  unmerged files, a detached head — is neither committed nor pushed, and the brief says
  `[VAULT] not committed or pushed: …` with the way out until a session end finds it put right.
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
