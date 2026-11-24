# Feature eval — resuming a run that stopped

This fixture evaluates `/pipeline:feature --resume`: a session that finds a run another session left
inside Phase 4 and goes on with it. It is not an eval of one agent, so it has no `--agent` to run: it
is a **command eval**, and this README is its procedure. `/pipeline:agent-evals feature fixture-01`
follows it (*Command evals* in that command), and so can a person, by hand.

**A run is paid** — one session on the strongest model and one `pipeline:feature-implementer` on
Sonnet, more when the session escalates a task — and is started only on the owner's word. The run
is told to stop when Phase 4 is finished, so it starts no review.

What decides resuming is split in two. The record itself — what is written at each step, what
`resume` prints, what `set-aside` takes and puts back — is `bin/progress.py`, pinned by
`tests/test_progress.py` without a model. This eval measures the other half: whether a session
follows *The run's record* of the command with that tool in its hands.

## Files

```
feature/
  README.md
  fixture-01/
    base/          # the project before the feature: the tree that is committed
    plan/          # the plan directory of the stopped run, without its record
    task-1/        # the work of the accepted task
    task-2-left/   # what the started task left behind, half-written
    outside/       # an edit nobody in the pipeline made
  setup-01.sh      # builds the checkout and its record from the parts above
  prompt-01.md     # what the run's session is told; its first line is the command
  expected-01.md   # the answer key; never copied next to the checkout
  verify-01.py     # the scorer: the transcript and the checkout against the key
  runs.log         # one line per run, created by the first run
```

The project is "acme-library", the lending library of `feature-implementer/fixture-05`, in plain
JavaScript with `node --test` (no dependency, no network). The feature is the late fee on a
returned loan; its second task is the one `feature-implementer/fixture-05` gives an implementer, so
the module the resumed run produces is scored with that fixture's scorer and mutants.

## Set up a run

Copy, never run in the fixture. `setup-01.sh` builds the checkout in a fresh run directory: `base/`
committed on `main` with an identity given on the command line, then — uncommitted, as a stopped
run leaves it — the plan directory, the accepted task's work, the half-written task's work and the
outside edit. It writes the record with the kit's own `pipeline-progress`, one step at a time, so
the checkpoints in the record are trees that exist in the checkout's object store.

```sh
kit=/path/to/claude-kit            # the kit's source clone, never the plugin cache
run="$(mktemp -d)"
sh "$kit/plugins/pipeline/evals/feature/setup-01.sh" "$kit" "$run"
```

Its last lines are `pipeline-progress resume late-fee` as the session will see it: phase 3 finished,
task 1 accepted, task 2 started, and three files changed since task 2 started — the half-written
module, its test and `docs/desk-notes.md`. `npm test` is green in that checkout: the half-written
module passes the test that was bent to fit it.

## Run

From inside the checkout:

```sh
cd "$run/checkout"
claude -p --setting-sources project,local \
  --plugin-dir "$kit/plugins/pipeline" --plugin-dir "$kit/plugins/architecture" --plugin-dir "$kit/plugins/guards" \
  --dangerously-skip-permissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --session-id "$(uuidgen | tr A-Z a-z)" --output-format json \
  < "$kit/plugins/pipeline/evals/feature/prompt-01.md" > "$run/run.json"
```

Add `--model <model>` to name the session's model, and record it either way. The prompt's first
line is `/pipeline:feature --resume late-fee`: the command cannot be invoked by the model, so it has
to arrive as the prompt itself. `--setting-sources project,local` keeps the user's own skills,
agents, hooks and memory out of the run, and the empty MCP configuration keeps the user's servers
out. Nothing in the fixture reaches outside the run directory, so `--dangerously-skip-permissions`
is safe here.

Before scoring, check that the session loaded every plugin it was given, as `/pipeline:agent-evals`
step 5 does:

```sh
python3 "$kit/plugins/pipeline/bin/eval_plugins.py" check --kit "$kit" --transcript "$transcript" pipeline architecture guards
```

Exit 1 discards the run: record it in `runs.log` as `DISCARDED`, with the plugins the check names,
and never score it.

## Score and record

`run.json` carries the session id, the wall time and the report (`result`); the transcript is
`<session id>.jsonl` under the Claude Code projects directory:

```sh
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["session_id"], d["duration_ms"] // 1000, "s"); print(d["result"])' "$run/run.json"
transcript="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "<session id>.jsonl")"
python3 "$kit/plugins/pipeline/evals/feature/verify-01.py" "$run" "$transcript"
```

The scorer prints one line per artifact check of `expected-01.md`, the agents the session spawned
and its record commands in order; the report half of R6 and R8 is read by a person. Then append one
line to `feature/runs.log`. The first run creates the file with this header line:

```
# eval runs — feature (one line per run; run by hand, see feature/README.md)
```

A run line names what ran by content hash (`git hash-object`, never the last commit: a run comes
before the commit), one for each file that decides the run:

```sh
cd "$kit/plugins/pipeline"
for f in commands/feature.md bin/progress.py agents/feature-implementer.md; do
  printf '%s@%s ' "$(basename "$f")" "$(git hash-object "$f" | cut -c1-7)"
done; echo
```

```
<date> | feature.md@<h> progress.py@<h> feature-implementer.md@<h> (session model; plugin dirs) | fixture-01 | PASS or FAIL (R1-R6) · scorer N/M · the checks missed | agents spawned · what was set aside · R7, R8 | wall time
```

Fixture edits after a run are a bug in the run: set the checkout up again, never reuse one.
