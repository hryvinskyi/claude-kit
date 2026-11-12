# guards

Hooks that turn a few engineering rules into gates. Each one is a small Python 3 script with no
dependencies outside the standard library (Python 3.9 or later). The guards fail open on what they
cannot prove: an unreadable transcript or a malformed input lets the tool call through, because a hook
must never wedge a session. An internal error while `bash_guard.py` reads a command is the exception:
it asks the person to confirm the command (`permissionDecision: "ask"`), because a command the guard
failed on is one nobody checked.

| Event | Matcher | Hook | Refuses |
|---|---|---|---|
| `PreToolUse` | `Edit\|Write` | `guard_generated_regions.py` | an edit inside a `<!-- …generated:start --> … <!-- …generated:end -->` block, or a full-file `Write` over a file that has one (code files are exempt) |
| `PreToolUse` | `Edit\|Write` | `plan_skill_gate.py` | a plan under `.claude/plans/`, or PHP or JS/TS source, written before the session loaded the rubric it needs from the `architecture` plugin (`architecture:clean-architecture-php`, `architecture:clean-architecture-js`) and the references the target calls for, plus the skills of each stack plugin whose stack the project runs on (see *Stack plugins*) |
| `PreToolUse` | `Edit\|Write` | `debt_guard.py` | a new deferral marker (`TODO`, `FIXME`, `@todo` …) or static-analysis suppression in a source file, and a static-analysis baseline that grows |
| `PreToolUse` | `Bash` | `bash_guard.py` | catastrophic commands (recursive force-delete of `/` or the home directory, force-push to a protected branch, destructive SQL, uploads to external hosts, regenerating an existing baseline), a pass of the board queue (`board-queue tick`) started from a session, `gh` commands that bill the GraphQL allowance while the `github_rest_only` policy is on, and files written through the shell that the two guards above would refuse |
| `PostToolUse` | `Edit\|Write` | `php_lint.py` | nothing; it runs `php -l` on each edited PHP file and reports a syntax error at once |

A refusal exits 2, so its message goes back to the model, which fixes the cause and retries.

## What the shell guard reads

`bash_guard.py` reads a command line the way the shell does and judges every simple command it
runs, not the first word of the line:

- quotes, backslash escapes and a backslash-newline continuation (the lines are joined); `#` starts a
  comment only where a word starts, so `${#files[@]}` or a URL's `#fragment` hides nothing after it;
- reserved words and grouping in front of a command (`if … then`, `for … do`, `while`, `case`, `!`,
  `{ …; }`, a function body) and wrappers with their options (`sudo`, `env`, `nice`, `nohup`, `time`,
  `timeout`/`gtimeout`, `xargs`, `stdbuf`, `caffeinate`, `noglob`, `flock`, …) are taken off;
- every command line a command runs is judged by every rule, down to four lines deep: `$(…)`,
  backticks and `<(…)` (bare, inside double quotes, inside `${…}`, `$((…))` or `$[…]`, in an
  assignment such as `N="$(…)"`, or in an unquoted here-document), `sh|bash|zsh|dash -c '…'`,
  `eval …`, `ddev exec …`, `ssh <host> '…'` (with ssh's options before or after the host), `docker
  exec …`, `kubectl exec … -- …`, the command of `find … -exec|-execdir|-ok|-okdir … ;|+`, and the script a
  program reads from its stdin. A command that
  nests a command line more than four deep is refused, since the innermost cannot be read;
- a `<<` inside `(( … ))`, `$(( … ))` or `$[ … ]` is a shift, not a here-document. `$((` is
  arithmetic only when the parenthesis closing its inner group is followed at once by another, as
  the shell reads it; `$((cmd) )` is a substitution running a subshell, and its command is judged;
- a here-document body is taken out of the command before anything else is read, and judged only
  as what it is fed to. A here-document, a here-string or what a pipe feeds (`cat <<'EOF' | bash`,
  `printf '…' | sh`) is SQL to a database client (`psql <<'SQL'`, `mysql <<< "…"`) and commands to
  a program that reads its script from stdin: a shell with no script operand, `-`, `-s` or
  `/dev/stdin` (`bash <<'EOF'`, `sh -s <<EOF`, `bash /dev/stdin <<EOF`), `source /dev/stdin` and
  `. /dev/stdin`, `ssh <host>` with no remote command (`ssh -tt <host> <<'EOF'`), `ddev ssh`, and the
  shell that `ssh <host> bash -s`, `docker exec -i <container> sh`, `kubectl exec -i <pod> -- sh` or
  `ddev exec bash` starts. A script read from stdin is not also the stdin of the commands in it. Fed
  to anything else (`cat > notes.md`, `git commit -F -`, `gh api … -F body=@-`) it is text, whatever
  commands it names; written to a file it is held to the shell-write rules.

## What counts as a shell write

A file written through the shell gets the checks `plan_skill_gate.py` and `debt_guard.py` apply to
`Edit`/`Write`: the rubric before PHP or JS/TS source or a plan, no new deferral marker or suppression
in source, and a static-analysis baseline that only shrinks. A write is:

- a `>`/`>>` redirect target, and `tee` (`-a` appends);
- `sed -i`/`-I`, also inside a group (`-Ei ''`, `-ri`, `-ni.bak`), and `perl -i`; a word after a bare `-i`
  that is no sed script (`sed -i bak 's/…/' f`) is read both as BSD's backup suffix and as GNU's script
  (`a\text`, `3s/a/b/` are scripts); under `xargs` it also writes the files xargs hands it;
- the destination of `cp`, `mv`, `install`, `rsync` and `git mv`: the file, or each source's name inside a
  destination directory (`-t`, a trailing `/`, an existing directory, several sources), and every file of a
  copied tree; a temporary file (`t=$(mktemp)`) moved or copied onto it brings content the guard does not
  read;
- each file a patch changes, for `git apply` and `patch`, read from the patch file, a `<` file, a
  here-document or a piped `cat`, each hunk by the line counts of its `@@` header; `git apply --check` and `patch --dry-run` write nothing;
- `dd of=…`, `curl -o`/`--output` (and `-O`, by the URL's name), `wget -O` where it is named (or the URL's
  name, under `-P`);
- `git checkout [<commit>] [--] <pathspec>` and `git restore [--source=…] <pathspec>` of a baseline, or of
  `.`, a directory or a glob covering one, with content the guard cannot read; `git restore --staged`
  without `--worktree` writes only the index.

A writer that cannot read its own command line (an option value it does not understand) counts as a write
of a file it does not spell out, with content it cannot read.

A target the command does not spell out — `{}` under `find -exec` or `xargs`, a variable the guard cannot
read (`while read f`, a loop over `$(…)`, `"$1"`), a patch it cannot read — stands for every file the guards
care about that the command involves: the files and globs it names, and the files under the directories it
names (under its own directory when it names only a basename glob such as `'*.php'`). So
`grep -rl foo src | xargs sed -i …` is a write of the source under `src/`, and
`for f in docs/*.md; do sed -i … "$f"; done` is a write of markdown only. A loop over literal words or
globs, a variable assigned a literal value, `${NAME:-default}` and brace groups (`src/A.{php,txt}`) are read
as written; `tmp=$(mktemp)` names a temporary file. A glob is read under the same budget of 20,000 directory
entries as a directory search, each directory listed once; past it, the glob is unread. A target that cannot
be one of those files is no write the guards look at, however much of it is unread: one under `/dev/`, a
process substitution, one whose literal directory lies in no project (`> "/tmp/review.$$"`) or where no own
source lives (the project's `var/`), one whose literal text after its last variable or substitution ends in
another extension (`> "$OUT/hits.txt"`, `> "$DIR/$(basename "$f").log"`), or passes through an output
directory (`"$(git rev-parse --show-toplevel)/var/log/x"`).

Where a command puts its output — a redirect, `tee`, the destination of a copy or a download — a target the
guard cannot read writes no source unless the word says it may: its tail ends in a source extension
(`"$X/Gen.php"`) or its literal directory holds own source (`src/A.$(echo php)`). So `composer test 2>
"$ERR"`, `make test | tee "$LOGFILE"` and `cp README "$DEST"` pass.

An in-place edit of files it does not spell out (`git ls-files | xargs sed -i …`, `sed -i … "$1"`), or a
write whose word says it may be source, stands for the source it may be where the command runs when it
involves no file at all: PHP source in a PHP project, JavaScript in a JavaScript project, so the rubric
applies and its text (the `sed` replacement, the echoed text) may carry no deferral marker or suppression. A
search through a directory the command names that finds no source (`grep -rl foo docs | xargs sed -i …`)
says the write lands in none. A patch the guard cannot read (piped from another command, written earlier on
the same line, missing) is refused: write it to a file in a command of its own, then apply it.

The debt check reads what a copy or move brings in. Content is new unless the source is a project's own
source (not `vendor/`, `var/`, tests or build output) that already lies in the destination's repository, or
is moved inside the destination's own project; a copy out of every project (a backup, a scratch directory)
brings none. So `cp notes.txt src/A.php` and `cp vendor/acme/src/Foo.php src/Foo.php` are read, and `mv
packages/a/src/X.php packages/b/src/X.php` is not. A copied tree is read in every directory, `vendor/` and
`var/` included, up to 64 files and 2 MB. New content the guard cannot read — a missing source, a file an
earlier command of the same line writes, a `sed -f` script of that kind, a copied tree past 64 files that
brings new content — is refused onto the project's own source (not tests, dependencies, build output or
served copies) and onto any other file the guards care about. Renaming a large source directory inside the
repository, or backing one up out of every project, brings none and passes.

Onto an existing baseline (`phpstan-baseline.neon`, `psalm-baseline.xml`, `eslint-suppressions.json` …) an
append, a longer replacement, raised ESLint counts, and a patch that adds more lines than it removes are
refused, and so is any write whose result the guard cannot read (a download, an unreadable copy, any
in-place `sed`, a restore from git). A `sed` that only deletes lines is refused too: deleting one line of an
entry (its `path:`, its `count:`, an ESLint file key) widens what the entry ignores. Remove a fixed entry
whole with the `Edit` tool.

Scripted writes (a Python, PHP or Node one-liner) are not seen; the engineering standards still bind them.

## The board queue's passes

A pass of the board queue is run by its schedule, never by a session. `bash_guard.py` refuses `board-queue
tick` started from a session in every form: by name, by any path, as `"$BOARD_QUEUE_CLI"` or through a
variable assigned on the line (`BQ=board-queue; $BQ tick`), its entry point run by `node`, `tsx`, `bun`,
`deno`, `npx`, `bunx` or a shell, `npm|pnpm|yarn exec|dlx [-p|--package board-queue] board-queue … tick`,
`npx -c` / `npm exec -c|--call` with a command line running it, the package's `cli` script run by `npm`,
`pnpm` or `yarn` (`yarn workspace <name> run cli tick`, options before or after the script), `tick` handed
to it by `xargs` (also as `{}`), and the launcher the schedule runs
(`board-queue-tick.sh`) — whatever variables are set or exported first, the schedule's own
`BOARD_QUEUE_SCHEDULED=1` included, and inside a loop, `timeout`, `env`, `bash -c` or a substitution. A
program the guard cannot name (`"$(command -v board-queue)"`, a variable it cannot read) handed `tick` is
refused as well. A syntax check (`bash -n`, `node --check`) runs nothing and passes. The refusal points at
`board_status`.

## Stack plugins

The rubric gate names no framework. A stack plugin teaches it one: it ships a `stack.json` and a
`SessionStart` hook that copies the file into a per-session registry,
`<state>/sessions/<session id>/stacks/<stack>.json`, where `<state>` is `$CLAUDE_KIT_STATE_DIR` or
`${XDG_STATE_HOME:-~/.local/state}/claude-kit`. The gate reads the registry of the session the
transcript belongs to, so only the plugins enabled in that session count, and a subagent sees the
registry of the session that spawned it. The same evaluation serves `Edit`/`Write` and files written
through the shell, so a heredoc or `sed -i` is held to the stack's skills as well.

A declaration says how to recognise the stack (a composer `type` prefix, required package names, paths
at the project root), which words make a PHP plan order browser work, which directories hold domain
code, and which stack skill each target needs: PHP source, JS/TS source, the PHP half of a plan and
its JS half. The format is in the docstring of `plan_skill_gate.py`. A declaration only adds
requirements; the exclusions (tests, build output, served copies, tool configs) stay in the gate.

Detection walks the `composer.json` files above the target nearest first; the first one any declaration
matches decides, and only when none does are the root paths of the project tried. When one file or one
root matches two declarations, both apply. A stack's browser words and domain directories apply on every
project of a session that registered it.

| Setup | What the gate asks for |
|---|---|
| `guards` and the stack plugin for your project | the core skill and its references, plus the stack's skills |
| `guards` and no stack plugin | the core rules only. A PHP project whose `package.json` depends on React is then treated as a React host: its JS needs `react.md` |
| a stack plugin without `guards` | nothing; the stack's skills load when asked for |
| neither | nothing |

A missing, unreadable or malformed declaration is skipped and the core rules run. When a stack
plugin cannot register, its hook says so once at session start.

## Kill switches

Set in the environment of the session, or in a project's `.claude/settings.json` `env` block:

| Variable | Turns off |
|---|---|
| `CLAUDE_NO_PLAN_SKILL_GATE=1` | the rubric gate, in `Edit`/`Write` and in shell writes |
| `CLAUDE_NO_DEBT_GUARD=1` | the debt guard, in `Edit`/`Write` and in shell writes |
| `CLAUDE_PHP_BIN=<path>` | not a switch: the `php` binary `php_lint.py` runs instead of the one on `PATH` |

## Policies

Preferences that are one person's, not a rule for everyone, are off by default and read from
`${XDG_CONFIG_HOME:-~/.config}/claude-kit/policies.toml`. Each policy is a top-level boolean:

```toml
# ~/.config/claude-kit/policies.toml
forbid_assistant_commit_trailers = true
```

| Policy | Default | When `true` |
|---|---|---|
| `forbid_assistant_commit_trailers` | `false` | `bash_guard.py` refuses a `git commit` whose message carries a `Co-Authored-By:` or `Claude-Session:` trailer, wherever the message comes from: `-m`, `-F`/`--file`, `--trailer` or a heredoc. It matches every `Co-Authored-By:` line, a human co-author's included |
| `github_rest_only` | `false` | `bash_guard.py` refuses the `gh` commands that run on GitHub's GraphQL API, whose rate-limit allowance the whole account shares: `gh issue`, `gh pr`, `gh project` and `gh search` (any action), `gh repo view`, `gh release list` and `gh api graphql`, also when reached as `command gh`, `env … gh`, an absolute path, after `&&`/`;`/`|`, inside `$(…)` or backticks (in an assignment or a double-quoted word too) or in a command line handed to a shell, and with `-R`/`--repo`/`--hostname` before the subcommand. The refusal names the REST form (`gh api --method POST repos/OWNER/REPO/issues …`) or, for `gh project`, the board queue. `gh api repos/…`, `gh auth`, `gh run`, `gh repo clone` and `gh release create` are never refused |

The file is read line by line, the same way on every Python: each top-level `name = true` or
`name = false` line (a trailing `# comment` allowed) sets that policy, a `[table]` header ends the
top level, and any other line is ignored — so one malformed line does not switch off a policy that
another line turns on. A missing file, an unreadable one, a value that is not a boolean, or a key
inside a `[table]` leaves the policy at its default.

The environment overrides the file: `CLAUDE_KIT_<POLICY NAME IN CAPITALS>` (`1` or `true` for on,
`0` or `false` for off, any case; any other value is ignored and the file decides). That is how a
project switches a policy on for itself without a machine-wide setting. `github_rest_only` is meant
for a project that spends one account's GraphQL allowance on a board: it sets
`"env": { "CLAUDE_KIT_GITHUB_REST_ONLY": "1" }` in its `.claude/settings.json`, and every other
project keeps using `gh pr create` as usual. To see what the hooks read:

```sh
python3 plugins/guards/hooks/policies.py
```

## Where the guard leaves files alone

`debt_guard.py` never refuses a write under the Claude config directory (`$CLAUDE_CONFIG_DIR`, or
`~/.claude`), under this plugin, or, when the plugin sits in a marketplace clone
(`<clone>/plugins/guards` beside `<clone>/.claude-plugin/marketplace.json`), anywhere in that clone.
Hooks, their tests and eval fixtures name or seed the very markers the guard refuses.

## Tests

```sh
plugins/guards/hooks/tests.sh
```

Run it before committing any change to a hook. It builds its fixtures in a temporary directory and
reads policies from a temporary `XDG_CONFIG_HOME` and stack declarations from a temporary
`CLAUDE_KIT_STATE_DIR`, never from yours. It needs no stack plugin: the stack cases use synthetic
declarations. Each stack plugin tests its own declaration against this gate in its `tests/tests.sh`.
