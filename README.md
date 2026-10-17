# claude-kit

Project-agnostic [Claude Code](https://code.claude.com) plugins, published as one plugin marketplace.
Nothing in them is tied to one codebase: every command and agent discovers the repository's own
rules (`CLAUDE.md`/`AGENTS.md`, its gates, its layout) and follows them.

| Plugin | What it gives you | Invoked as |
|---|---|---|
| `architecture` | Clean Architecture, onion-at-module-altitude, SOLID and DDD rubrics, with review and plan formats, an implementer's cut and detection recipes | skills `architecture:clean-architecture-php` (PHP: Symfony, Magento 2), `architecture:clean-architecture-js` (JavaScript, TypeScript, React, Node, and the browser code Magento and Symfony ship) |
| `pipeline` | A feature pipeline that plans and verifies on the main model and delegates each task to an implementer, an adversarial plan reviewer, a bug-fix loop that starts from a failing test, and an eval harness that regression-tests the agents | commands `/pipeline:feature`, `/pipeline:bug-fix`, `/pipeline:explain`, `/pipeline:learn`, `/pipeline:update-codemaps`, `/pipeline:agent-evals`; agents `pipeline:devils-advocate`, `pipeline:feature-implementer`, `pipeline:feature-contract-writer` |
| `qa` | A browser bug hunt that proves what breaks, and a text tightener | skills `qa:bug-hunt`, `qa:tighten` |
| `vault` | A project knowledge vault beside the code: a session-start brief, session-end capture into an inbox, a check that holds the notes to the code, a search index | commands `/vault:decision`, `/vault:journal`, `/vault:todo`, `/vault:wiki-sync`; agent `vault:wiki-updater`; hooks on `SessionStart`, `SessionEnd`, `Stop`; `find-vault`, `vault-check`, `vault-capture`, `vault-search` on the Bash path |
| `board-queue` | A durable queue and paced single writer for shared GitHub Projects boards, with a scheduled worker per person | MCP server `plugin:board-queue:board-queue` (tools `board_enqueue`, `board_queue`, `board_status`, `board_release`, `board_cancel`, `board_retry`, `board_show`); `board-queue` on the Bash path. Needs `npm ci` in the clone; see its README |

`pipeline` depends on `architecture` (its agents load the rubric before they write code). The
dependency is declared in its manifest, so Claude Code installs and enables `architecture` along
with it.

## Install

From GitHub:

```sh
claude plugin marketplace add hryvinskyi/claude-kit
claude plugin install architecture@claude-kit
claude plugin install pipeline@claude-kit
claude plugin install qa@claude-kit
```

Or from a local clone, which is also how you work on the plugins:

```sh
git clone https://github.com/hryvinskyi/claude-kit.git
claude plugin marketplace add ./claude-kit
claude plugin install pipeline@claude-kit     # and the others
```

## Editing the plugins

A marketplace added from a local directory loads its plugins **in place** from the clone, so an edit
in `plugins/<name>/` takes effect at the next session start or after `/reload-plugins`, with no
reinstall and no version bump. To try a working copy without installing anything, load it for one
session:

```sh
claude --plugin-dir ./plugins/architecture --plugin-dir ./plugins/pipeline
```

Check the manifests before you commit:

```sh
claude plugin validate --strict .
for p in plugins/*/; do claude plugin validate --strict "$p"; done
```

A marketplace added from GitHub is copied into Claude Code's plugin cache instead;
`claude plugin marketplace update claude-kit` followed by `claude plugin update <plugin>@claude-kit`
picks up a new version.

## Commands outside a session

A scheduled job, a git hook or a project's script cannot see a plugin's `bin/`, and a path into the
plugin cache moves on every update. `bin/install-shims.sh [CLONE]` writes small shims into
`~/.local/bin` (or `$SHIM_DIR`) — `board-queue`, `board-queue-mcp`, `find-vault`, `vault-check`,
`vault-capture`, `vault-search` — each running the copy in the clone. It is idempotent, re-points the
shims when run from another clone, never replaces a file it did not write, and `--check` reports
without writing. Callers outside Claude Code use those paths.

## Agent evals

Agent definitions are programs, so they have regression tests: `plugins/pipeline/evals/` holds
fixtures with seeded flaws, the prompt a caller would give, and an answer key kept outside the
fixture. `/pipeline:agent-evals [agent] [fixture] [model]` runs an agent as registered (for example
`claude -p --agent pipeline:devils-advocate`) on a fresh copy of the fixture, scores it, and appends
the result to that agent's `runs.log`. Run it after every edit to an agent definition. See
`plugins/pipeline/evals/README.md` for the rules.

Runs are recorded in the source clone, never in the plugin cache, which an update replaces. The
command finds the clone through `CLAUDE_KIT_ROOT` (the clone's root directory) when that variable is
set, and otherwise uses the plugin directory itself when it is a git working tree, which is the case
for a local-directory marketplace and for `--plugin-dir`.

## What the plugins expect around them

- **A knowledge vault is optional.** `/pipeline:feature`, `/pipeline:bug-fix` and `/pipeline:explain`
  resolve a project's vault (decision records, journal, module notes, a TODO board) with a
  `find-vault` command on `PATH`, which the `vault` plugin provides.
- **The rubric gate.** The skills and agents refer to guard hooks by name (`plan_skill_gate.py`,
  which refuses a plan or source edit until the rubric is loaded, and `debt_guard.py`, which refuses
  suppressions and deferral markers). Those hooks are not part of these three plugins; without them
  the rubric is still loaded, because the agents are told to.
- **Engineering standards.** Where a command or skill cites §*Architecture and tech debt* or
  §*Tests run code*, it means the engineering standards your user `CLAUDE.md` carries.
- `qa:bug-hunt` drives a real browser: Node with Playwright installed in the project, and the
  Playwright MCP server for the interactive walk.
- `qa:tighten` finishes with the `humanizer:humanizer` skill when it is installed.

## Licence

MIT, see [LICENSE](LICENSE).
