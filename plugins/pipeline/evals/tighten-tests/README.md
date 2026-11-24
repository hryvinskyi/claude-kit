# Tighten-tests eval — the command as a whole

This eval measures `/pipeline:tighten-tests`: the census, the judges it spawns, the defenders, the
proofs by a run, the edits and the gates. It is not an eval of one agent, so it has no `--agent` to
run: it is a **command eval**, and this README is its procedure. `/pipeline:agent-evals
tighten-tests fixture-01` follows it (*Command evals* in that command), and so can a person, by hand.

The judge alone is measured by `test-judge/` — cheaply, and with a baseline. Run that first: a judge
that fails there fails here at ten times the price.

**A run is paid** and is started only on the owner's word. On the fixture the command spawns four
judges and two defenders (`pipeline:test-judge`, on Opus unless `--model` names another) and proves
about twenty removals by a run of its own; the judge's runs cost 1.25 to 1.30 dollars each and the
defender's 0.85 to 0.90 when they were measured, so count ten to fifteen dollars and twenty to thirty
minutes.

## Files

```
tighten-tests/
  README.md
  prompt-01.md     # what the run's session is told
  expected-01.md   # the answer key; never copied next to the checkout
  runs.log         # one line per run, created by the first run
```

The project is `../test-judge/fixture-01/checkout` ("acme-parcel", plain JavaScript on Node 22 or
newer, `node --test`, no dependency). The fixture has no copy here: one project, one key, one set of
mutants, scored two ways. `../test-judge/verify-01.py prove <that checkout>` must print `the key
holds` before a run is scored.

## Set up a run

Copy the checkout, never run in it. The command needs a repository with a clean tree: it applies a
change to the product for each proof and takes it back, and it reads `git status` to know that it
did.

```sh
kit=/path/to/claude-kit            # the kit's source clone, never the plugin cache
run="$(mktemp -d)"
cp -R "$kit/plugins/pipeline/evals/test-judge/fixture-01/checkout" "$run/checkout"
cd "$run/checkout"
printf '.tighten/\njunit.xml\n' > .gitignore
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m base
```

`.tighten/` is where the prompt tells the run to keep its working files; it is ignored so that the
command's own check of a clean tree holds.

## Run

From inside the checkout:

```sh
cd "$run/checkout"
claude -p --setting-sources project,local \
  --plugin-dir "$kit/plugins/architecture" --plugin-dir "$kit/plugins/pipeline" --plugin-dir "$kit/plugins/guards" \
  --dangerously-skip-permissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --output-format json \
  < "$kit/plugins/pipeline/evals/tighten-tests/prompt-01.md" > "$run/run.json"
```

Add `--model <model>` to name the session's model, and record it either way, and
`--session-id "$(uuidgen)"` so the transcript can be found by name. The plugin directories are the
closure of `pipeline` and `guards` (`bin/eval_plugins.py closure --kit "$kit" pipeline guards`).
`--setting-sources project,local` keeps the user's own skills, agents, hooks and memory out of the
run. Nothing in the fixture reaches outside the copy, so `--dangerously-skip-permissions` is safe
here. The engineering standards reach the run as in an agent eval: a memory directory holding
`$kit/standards/CLAUDE.standards.md` as `CLAUDE.md`, passed with `--add-dir` under
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

Before scoring, check that the session loaded every plugin it was given:

```sh
python3 "$kit/plugins/pipeline/bin/eval_plugins.py" check --kit "$kit" --transcript "$transcript" pipeline guards
```

Exit 1 discards the run: record it in `runs.log` as `DISCARDED`, with the plugins the check names,
and never score it. Then check from the transcript that the judges and the defenders were
`pipeline:test-judge` agents (the Agent tool's `subagent_type`), and how many of each ran: a session
that judged the tests itself measured something else, and its line says so.

## Score and record

Score as `expected-01.md` says, then append one line to `tighten-tests/runs.log`. The first run
creates the file with this header line:

```
# eval runs — tighten-tests (one line per run; run by hand, see tighten-tests/README.md)
```

A run line names what ran by content hash (`git hash-object`, never the last commit), one for each
file that decides the run:

```sh
cd "$kit/plugins/pipeline"
for f in commands/tighten-tests.md agents/test-judge.md skills/test-value/SKILL.md bin/suite.py; do
  printf '%s@%s ' "$(basename "$f")" "$(git hash-object "$f" | cut -c1-7)"
done; echo
```

```
<date> | tighten-tests.md@<h> test-judge.md@<h> SKILL.md@<h> suite.py@<h> (session model; judges' model) | fixture-01 | PASS or FAIL — T1 to T12 by id · cases 71 → N, integration 24 → N · seeded gone N/20 · holes closed N/2 · decoys lost · defects lost | judges and defenders that ran · objections · removals a run refuted | wall time · cost
```

Fixture edits after a run are a bug in the run: copy the checkout again, never reuse one.
