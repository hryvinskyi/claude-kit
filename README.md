# claude-kit

Project-agnostic [Claude Code](https://code.claude.com) plugins, published as one plugin marketplace.
Nothing in them is tied to one codebase: every command and agent discovers the repository's own
rules (`CLAUDE.md`/`AGENTS.md`, its gates, its layout) and follows them.

| Plugin | What it gives you | Invoked as |
|---|---|---|
| `architecture` | Clean Architecture, onion-at-module-altitude, SOLID and DDD rubrics, with review and plan formats, an implementer's cut and detection recipes, in words that name no framework | skills `architecture:clean-architecture-php` (PHP), `architecture:clean-architecture-js` (JavaScript, TypeScript, React, Node, and the browser code a server-rendered application ships) |
| stack plugins: `symfony`, `magento2` | The same rubrics in one framework's idiom: where each piece goes, how the container wires it, what its templates hand the browser, detection recipes in its spelling. Install the one your project runs on | skills `<stack>:<stack>-architecture-php` and `<stack>:<stack>-architecture-frontend`, loaded beside the core ones; see each plugin's README |
| `pipeline` | A feature pipeline that plans and verifies on the main model and delegates each task to an implementer, an adversarial plan reviewer, a bug-fix loop that starts from a failing test, and an eval harness that regression-tests the agents | commands `/pipeline:feature`, `/pipeline:bug-fix`, `/pipeline:explain`, `/pipeline:learn`, `/pipeline:update-codemaps`, `/pipeline:agent-evals`; agents `pipeline:devils-advocate`, `pipeline:feature-implementer`, `pipeline:feature-contract-writer` |
| `qa` | A browser bug hunt that proves what breaks, and a text tightener | skills `qa:bug-hunt`, `qa:tighten` |
| `guards` | Hooks that refuse catastrophic shell commands, PHP and JS/TS source or plans written before the architecture rubric is loaded, new deferral markers and suppressions, growing static-analysis baselines and hand edits inside generated regions, and lint each edited PHP file | hooks only: `PreToolUse` on `Edit\|Write` and `Bash`, `PostToolUse` on `Edit\|Write`; see [plugins/guards/README.md](plugins/guards/README.md) |
| `vault` | A project knowledge vault beside the code: a session-start brief, session-end capture into an inbox, a check that holds the notes to the code, a search index, git merge drivers for its busiest files | commands `/vault:decision`, `/vault:journal`, `/vault:todo`, `/vault:wiki-sync`; agent `vault:wiki-updater`; hooks on `SessionStart`, `SessionEnd`, `Stop`; `find-vault`, `vault-check`, `vault-capture`, `vault-search`, `vault-merge` on the Bash path |
| `board-queue` | A durable queue and paced single writer for shared GitHub Projects boards, with a scheduled worker per person | MCP server `plugin:board-queue:board-queue` (tools `board_enqueue`, `board_queue`, `board_status`, `board_release`, `board_cancel`, `board_retry`, `board_show`); `board-queue` on the Bash path. Needs `npm ci` in the clone; see its README |

`pipeline` depends on `architecture` (its agents load the rubric before they write code), and so
does each stack plugin. The dependency is declared in the manifests, so Claude Code installs and
enables `architecture` along with any of them. A stack plugin does not depend on `guards`: without
it, the stack's skills load but nothing is gated.

## Install

From a clone, in one step:

```sh
git clone https://github.com/hryvinskyi/claude-kit.git ~/.local/share/claude-kit
~/.local/share/claude-kit/install.sh --check   # what is missing; changes nothing
~/.local/share/claude-kit/install.sh           # does it
```

`install.sh` writes the command shims (below), runs `npm ci` in `plugins/board-queue` (skip it with
`--skip-npm`), adds the clone as a local-directory marketplace and installs and enables the plugins
at user scope (all of them, or `--plugins architecture,pipeline,…`), imports the engineering
standards into your user `CLAUDE.md`, and writes `${XDG_CONFIG_HOME:-~/.config}/claude-kit/policies.toml`
with every policy at its default when there is none. It needs `git`, `python3` 3.9 or newer, the
`claude` command, and Node 26 or newer with `npm` when `board-queue` is among the plugins. It is
idempotent: a second run changes nothing, and anything it did not write that stands in its way —
a file at a shim's path, a marketplace of the same name from another place, standards written into
your `CLAUDE.md` by hand — is refused and named, never overwritten. `--check` exits 1 when something
is missing and 2 when a step is refused. It works on the profile the `claude` command uses
(`CLAUDE_CONFIG_DIR` when that is set).

Or by hand, from GitHub:

```sh
claude plugin marketplace add hryvinskyi/claude-kit
claude plugin install architecture@claude-kit
claude plugin install pipeline@claude-kit
claude plugin install qa@claude-kit
claude plugin install guards@claude-kit
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
`vault-capture`, `vault-search`, `vault-merge` — each running the copy in the clone. It is idempotent,
re-points the shims when run from another clone, never replaces a file it did not write, and `--check`
reports without writing. Callers outside Claude Code use those paths; git's merge-driver
configuration names the `vault-merge` shim.

## Agent evals

Agent definitions are programs, so they have regression tests: a plugin's `evals/` holds fixtures
with seeded flaws, the prompt a caller would give, and an answer key kept outside the fixture. A
fixture that is a project of one stack ships with that stack's plugin (`plugins/<stack>/evals/`);
one that names no stack stays in `plugins/pipeline/evals/`. `/pipeline:agent-evals [agent]
[fixture] [model]`, with the fixture given as `<plugin>/<fixture-NN>`, runs an agent as registered
(for example `claude -p --agent pipeline:devils-advocate`) on a fresh copy of the fixture, scores it,
and appends the result to the `runs.log` beside the fixture. Run it after every edit to an agent
definition. See `plugins/pipeline/evals/README.md` for the rules.

Evals run from the source clone, and runs are recorded there, never in the plugin cache, which an
update replaces. The command finds the clone through `CLAUDE_KIT_ROOT` (the clone's root directory)
when that variable is set, and otherwise uses the git working tree that holds the plugin directory,
which is the clone for a local-directory marketplace and for `--plugin-dir`.

## What the plugins expect around them

- **A knowledge vault is optional.** `/pipeline:feature`, `/pipeline:bug-fix` and `/pipeline:explain`
  resolve a project's vault (decision records, journal, module notes, a TODO board) with a
  `find-vault` command on `PATH`, which the `vault` plugin provides.
- **The rubric gate.** The skills and agents refer to guard hooks by name (`plan_skill_gate.py`,
  which refuses a plan or source edit until the rubric is loaded, and `debt_guard.py`, which refuses
  suppressions and deferral markers). They ship in the `guards` plugin; without it the rubric is
  still loaded, because the agents are told to.
- **Engineering standards.** Where a command or skill cites §*Architecture and tech debt* or
  §*Tests run code*, it means `standards/CLAUDE.standards.md`, which your user `CLAUDE.md`
  imports (see below).
- `qa:bug-hunt` drives a real browser: Node with Playwright installed in the project, and the
  Playwright MCP server for the interactive walk.
- `qa:tighten` finishes with the `humanizer:humanizer` skill when it is installed.

## Engineering standards

`standards/CLAUDE.standards.md` is the bar the plugins hold code to, written as instructions:
text other people read never cites agent config, how a knowledge vault is used, architecture and
tech debt (with the rule against `new SomeClass`, which is PHP's), tests that run code, and PHP and
JavaScript/TypeScript static analysis. Make every session load it by importing it from your user
`CLAUDE.md`:

```sh
python3 standards/import_standards.py           # appends the import line once
python3 standards/import_standards.py --check   # reports; exits 1 when the import is missing
python3 standards/import_standards.py --stack symfony   # also imports the symfony plugin's standards file
```

The standards name no framework. A stack plugin ships what they mean on its stack in
`plugins/<stack>/standards/CLAUDE.standards.<stack>.md`; `--stack` (repeatable, or a comma-separated
list) imports it beside the standards, once, so it is loaded in every session as the standards are.

The import names the file in this clone (`@~/…` when the clone sits under your home directory,
an absolute path otherwise), never a copy in the plugin cache, whose path changes with every
plugin version. Claude Code expands an import in the user `CLAUDE.md` at launch without asking
for approval, so an edit here applies from the next session on, and a branch of this clone
without the file drops the standards from every session. The helper writes
`$CLAUDE_CONFIG_DIR/CLAUDE.md` when that variable is set, and writes through a symbolic link rather
than replacing it. It refuses to add the import when your `CLAUDE.md` already carries the standards'
sections inline (every rule would load twice) or imports a standards file from another path.

## Tests

```sh
python3 -m unittest discover -s tests       # the installer, in a fake home with stand-ins for claude, npm and node
python3 -m unittest discover -s bin/tests   # the command shims
plugins/vault/tests/tests.sh                # the vault plugin, its merge drivers and their wiring
plugins/guards/hooks/tests.sh               # the guard hooks
npm --prefix plugins/board-queue test       # the board queue (after npm ci)
```

## Licence

MIT, see [LICENSE](LICENSE).
