# guards

Hooks that turn a few engineering rules into gates. Each one is a small Python 3 script with no
dependencies outside the standard library (Python 3.9 or later). Every guard fails open: an
internal error, an unreadable transcript or a malformed input lets the tool call through, because a
hook must never wedge a session.

| Event | Matcher | Hook | Refuses |
|---|---|---|---|
| `PreToolUse` | `Edit\|Write` | `guard_generated_regions.py` | an edit inside a `<!-- …generated:start --> … <!-- …generated:end -->` block, or a full-file `Write` over a file that has one (code files are exempt) |
| `PreToolUse` | `Edit\|Write` | `plan_skill_gate.py` | a plan under `.claude/plans/`, or PHP or JS/TS source, written before the session loaded the rubric it needs from the `architecture` plugin (`architecture:clean-architecture-php`, `architecture:clean-architecture-js`) and the references the target calls for |
| `PreToolUse` | `Edit\|Write` | `debt_guard.py` | a new deferral marker (`TODO`, `FIXME`, `@todo` …) or static-analysis suppression in a source file, and a static-analysis baseline that grows |
| `PreToolUse` | `Bash` | `bash_guard.py` | catastrophic commands (recursive force-delete of `/` or the home directory, force-push to a protected branch, destructive SQL, uploads to external hosts, regenerating an existing baseline), `gh` commands that bill the GraphQL allowance while the `github_rest_only` policy is on, and files written through the shell that the two guards above would refuse |
| `PostToolUse` | `Edit\|Write` | `php_lint.py` | nothing; it runs `php -l` on each edited PHP file and reports a syntax error at once |

A refusal exits 2, so its message goes back to the model, which fixes the cause and retries.

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
| `github_rest_only` | `false` | `bash_guard.py` refuses the `gh` commands that run on GitHub's GraphQL API, whose rate-limit allowance the whole account shares: `gh issue`, `gh pr`, `gh project` and `gh search` (any action), `gh repo view`, `gh release list` and `gh api graphql`, also when reached as `command gh`, `env … gh`, an absolute path, after `&&`/`;`/`|` or inside `$(…)`, and with `-R`/`--repo`/`--hostname` before the subcommand. The refusal names the REST form (`gh api --method POST repos/OWNER/REPO/issues …`) or, for `gh project`, the board queue. `gh api repos/…`, `gh auth`, `gh run`, `gh repo clone` and `gh release create` are never refused |

A missing file, an unreadable one, a value that is not a boolean, or a key inside a `[table]`
leaves the policy at its default.

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
reads policies from a temporary `XDG_CONFIG_HOME`, never from yours.
