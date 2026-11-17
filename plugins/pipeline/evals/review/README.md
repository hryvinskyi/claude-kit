# Review eval — the review command as a whole

This fixture evaluates `/pipeline:review`, the command and the workflow it starts: the wave of
reviewer passes, the verifier of every finding, de-duplication and ranking. It is not an eval of
one agent, so it has no `--agent` to run: it is a **command eval**, and this README is its procedure.
`/pipeline:agent-evals review fixture-01` follows it (*Command evals* in that command), and so can a
person, by hand.

**A run is paid** — a class-L review may spawn up to 24 agents, most of them on Opus — and is started
only on the owner's word. It needs a Claude Code build that offers the Workflow tool: without it the
review falls back to the Agent tool, and the run measures the fallback, not the workflow (record it
as such).

## Files

```
review/
  README.md
  fixture-01/
    base/          # the project before the change: the tree that is committed
    change.patch   # the change, applied to the working tree and left uncommitted
  prompt-01.md     # what the run's session is told
  expected-01.md   # the answer key; never copied next to the checkout
  runs.log         # one line per run, created by the first run
```

The project is "acme-desk", a small help-desk library in plain Python 3.9+ with `unittest` (no
dependency, no network). The change adds a plan without a reply deadline, an HTML export of a
ticket and of the open tickets, and a staff command that exports one ticket. The key lists what is
seeded in it.

## Set up a run

Copy the fixture, never run in it. `base/` becomes a fresh repository whose default branch is
`main` (the review resolves its base as the branch's upstream, else `origin/main`, else `main`, so a
repository on `master` has no base), committed with an identity given on the command line (a
machine with no git identity can run it), then the patch is applied to the working tree and left
uncommitted. The patch stays outside the checkout, where it would otherwise be an untracked file of
the change.

```sh
kit=/path/to/claude-kit            # the kit's source clone, never the plugin cache
run="$(mktemp -d)"
cp -R "$kit/plugins/pipeline/evals/review/fixture-01" "$run/fixture"
cp -R "$run/fixture/base" "$run/checkout"
cd "$run/checkout"
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m base
git apply "$run/fixture/change.patch"
```

A Claude Code session with the `guards` plugin cannot run this block as one command. Its shell
guard refuses a `git apply` whose patch path depends on a variable set on the same line, because it
cannot read that patch. Run `git apply` as a command of its own, with the patch's path written out.

The project's gate passes on the base and on the changed tree alike: the seeded defects are not
caught by its own tests. To see it, run `python3 -m unittest discover -s tests -t .` in the
checkout before and after `git apply`. The tests write nothing in the tree but Python's bytecode
cache, and `.gitignore` leaves `__pycache__/` out of the change.

## Run

From inside the checkout:

```sh
cd "$run/checkout"
claude -p --setting-sources project,local \
  --plugin-dir "$kit/plugins/pipeline" --plugin-dir "$kit/plugins/architecture" --plugin-dir "$kit/plugins/guards" \
  --dangerously-skip-permissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --output-format json \
  < "$kit/plugins/pipeline/evals/review/prompt-01.md" > "$run/run.json"
```

Add `--model <model>` to name the session's model, and record it either way, and
`--session-id "$(uuidgen)"` so the transcript can be found by name. `--setting-sources
project,local` keeps the user's own skills, agents, hooks and memory out of the run, and the empty
MCP configuration keeps the user's servers out. Nothing in the fixture reaches outside the copy, so
`--dangerously-skip-permissions` is safe here.

Before scoring, check that the session loaded every plugin it was given, as `/pipeline:agent-evals`
step 5 does:

```sh
python3 "$kit/plugins/pipeline/bin/eval_plugins.py" check --kit "$kit" --transcript "$transcript" pipeline architecture guards
```

with `$transcript` found as in *Wall time and context use* below. Exit 1 discards the run: record it
in `runs.log` as `DISCARDED`, with the plugins the check names, and never score it.

When it ends, the checkout holds `eval-result.json`, a copy of the review's `review-workflow.json`:
the workflow's own result as the run returned it, before triage. Every score is computed from that
file. The review's `review-result.json` is not scored: triage edits it even under `--no-fix`
(settling plausible and unverified findings), so it measures the session as well as the workflow.
When the review fell back to the Agent tool, `review-workflow.json` is the fallback's result before
triage, and its first `not_checked` line says the workflow did not run.

## Wall time and context use

`run.json` carries the session id and the wall time:

```sh
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["session_id"], d["duration_ms"] // 1000, "s")' "$run/run.json"
```

The session's transcript is `<session id>.jsonl` under the Claude Code projects directory, in the
folder named after the checkout's path:

```sh
transcript="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "<session id>.jsonl")"
```

Each assistant turn records the context it was sent with (`input_tokens`,
`cache_creation_input_tokens` and `cache_read_input_tokens` of its `usage`). This prints the
context of the turn that started the workflow and of the turn after its result, which is how much
the workflow's result added to the session:

```sh
python3 - "$transcript" <<'EOF'
import json, sys
rows = []
for line in open(sys.argv[1], encoding="utf-8"):
    entry = json.loads(line)
    if entry.get("type") != "assistant" or entry.get("isSidechain"):
        continue
    usage = entry["message"].get("usage") or {}
    context = sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    tools = [c.get("name") for c in entry["message"].get("content", []) if c.get("type") == "tool_use"]
    rows.append((context, tools))
calls = [i for i, (_, tools) in enumerate(rows) if "Workflow" in tools]
if not calls:
    print("no Workflow call in this transcript")
for i in calls:
    after = rows[i + 1][0] if i + 1 < len(rows) else "none (the session ended)"
    print(f"Workflow call: context {rows[i][0]} tokens before, {after} after")
print(f"last turn {rows[-1][0]} tokens, peak {max(c for c, _ in rows)}")
EOF
```

"no Workflow call" means the review took its fallback; the report says why.

## Score and record

Score `eval-result.json` against `expected-01.md` as its *Scoring* section says, then append one
line to `review/runs.log`. The first run creates the file with this header line:

```
# eval runs — review (one line per run; run by hand, see review/README.md)
```

A run line names what ran by content hash (`git hash-object`, never the last commit: a run comes
before the commit), one for each file that decides the run:

```sh
cd "$kit/plugins/pipeline"
for f in commands/review.md workflows/review.js agents/code-reviewer.md agents/finding-verifier.md; do
  printf '%s@%s ' "$(basename "$f")" "$(git hash-object "$f" | cut -c1-7)"
done; echo
```

```
<date> | review.md@<h> review.js@<h> code-reviewer.md@<h> finding-verifier.md@<h> (session model; plugin dirs) | fixture-01 | found N/5 (+ found-unverified) · decoys left alone N/3 · verifier misses · saves · lost to the another-tree rule | class · members and status · agents used/max · built-in member: ran, unavailable or builtin-session | wall time · context before → after
```

Fixture edits after a run are a bug in the run: copy the fixture again, never reuse a checkout.
