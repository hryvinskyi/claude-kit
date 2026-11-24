# Skill evals — docs

The documentation skills are programs a model runs, so they get regression tests like the agents
(`plugins/pipeline/evals/README.md` has the harness rules; they hold here: run on a copy, the answer
key outside the fixture, seeded flaws that a written rule or the fixture's code decides, never edit
a fixture, a prompt or a key to make a run pass).

A skill is not an agent, so a run starts a headless session with a prompt that names the skill, and
the session loads it through the Skill tool.

## When to run

- After any edit to `skills/user-guide/` or `skills/technical-guide/`, before committing it.
- After a model change.

## Layout

```
evals/
  README.md
  user-guide/
    fixture-01/        # Update: a product after a change that narrows who may do something
    prompt-01.md       # the invocation, naming the skill
    prompt-01b.md      # the same task with no skill named: does the description make the session load it?
    expected-01.md     # the answer key
    verify-01.py       # scorer for the mechanical rows of the key
    fixture-02/        # Review: a guide written for the wrong reader, with its fact list
    prompt-02.md
    expected-02.md
    fixture-03/        # Update: a new feature, told by a pull request full of history, mechanism and codes
    prompt-03.md, expected-03.md, verify-03.py
    fixture-04/        # Write: a guide for another reader of the same product
    prompt-04.md, expected-04.md, verify-04.py
    runs.log           # one line per run
  technical-guide/
    fixture-01/        # Review: an API reference written from the inside
    prompt-01.md, expected-01.md
    runs.log
```

A fixture that is a project of one stack ships with that stack's plugin and is run with that
plugin and its dependencies passed as well: `plugins/symfony/evals/user-guide/fixture-01`.

## Run

`<kit>` is the kit's source clone, `<copy>` a fresh copy of the fixture in a scratch directory,
`<uuid>` a fresh `uuidgen`.

```sh
cp -R <kit>/plugins/docs/evals/user-guide/fixture-NN <scratch>/copy
cp <kit>/plugins/docs/evals/user-guide/prompt-NN.md <scratch>/prompt.md
cd <scratch>/copy && CLAUDE_NO_JOURNAL_NUDGE=1 claude -p --setting-sources project,local \
  --session-id <uuid> --plugin-dir <kit>/plugins/docs \
  --dangerously-skip-permissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --model <model> < <scratch>/prompt.md > <scratch>/report.md
```

`--setting-sources project,local` keeps the runner's own skills, agents, hooks and memory out, so
the run measures the clone. The fixtures name no stack, so no stack plugin is passed. Permissions
are skipped because the run is confined to the copy; a fixture never reaches outside it.

Check that the session listed the plugin's skills before scoring; a run where it did not is
recorded as `DISCARDED`:

```sh
python3 <kit>/plugins/pipeline/bin/eval_plugins.py check --kit <kit> --copy <scratch>/copy --session <uuid> docs
```

A run that starts its review subagent may park itself on a scheduled wake-up of ten or twenty
minutes while it waits. Its edits are on disk by then: score the copy once the files have stopped
changing, read the report when the session returns, and say in the run line which of the two the
score was taken from.

## Score and record

- `fixture-01`: `python3 <kit>/plugins/docs/evals/user-guide/verify-01.py <kit>/plugins/docs/evals/user-guide/fixture-01 <scratch>/copy`,
  then the two *read* rows of the key from the report and the guides.
- `fixture-02`: read the report against `expected-02.md`: flaws found, the condition named for
  each, the verdict, decoys reported.
- `fixture-03`: `verify-03.py`, then the *read* rows of `expected-03.md`.
- `fixture-04`: `verify-04.py`, then the *read* rows of `expected-04.md`.
- `technical-guide/fixture-01`: read the report against its `expected-01.md`.
- `prompt-01b` is scored as `fixture-01`, and the run line says whether the session loaded
  `docs:user-guide` without being told to (look for the Skill call in its transcript).

Append one line to `runs.log`: the date, the content hash of the skill's three files
(`cat skills/user-guide/SKILL.md skills/user-guide/references/*.md | git hash-object --stdin | cut -c1-7`),
the model, the fixture and prompt, the score, the misses.

## Current fixtures

- `user-guide/fixture-01` — "Acme Desk", a small help desk in plain PHP, after a change that makes
  creating an access token a staff action, hides an unfinished setting from team admins and renames
  a screen. The guide is for the team admin. Tests: what left the reader's reach leaves the guide
  and goes to the staff's document; the request stays; nothing about the unfinished setting; the
  rename without history in the body; a history row; the picture that cannot be retaken is removed;
  the code is untouched.
- `user-guide/fixture-02` — the same product with the guide a careless update leaves behind:
  eleven seeded flaws (staff steps under a note, what other people see, a row nobody can hold, a
  staff how-to, a dead-end remedy, an unenforced setting, a release note in the body, mechanism, a
  defended design, two places that disagree, a caption that says its picture is old) and five
  decoys (a quoted message, a prerequisite, a dated mark, the request, the history row).

- `user-guide/fixture-03` — the same product one version on: requests can be archived. The pull
  request text tells why the team built it and what it decided against, names columns, routes,
  permission codes, a status code, a queued and a nightly job, a staff-only action, and a switch
  whose e-mail nothing sends yet. All of it is true, and almost none of it is the reader's. Tests:
  the new how-tos in steps with exact labels; the limit and the automatic deletion told as effects;
  no history, mechanism, defended design or code; the dead switch left out and raised as a finding;
  the staff action in the staff's document; a history row.
- `user-guide/fixture-04` — the same product, and a guide to write from nothing for its other
  reader, the agent. Tests: the parts of a guide; nothing of the team admin's or the staff's
  screens; the dead switch found by looking for what reads it; a fact list that carries reach; the
  request where someone else must act; exact labels.
- `technical-guide/fixture-01` — the product's API reference for a customer's developer, with
  eleven seeded flaws (a change told at the top of the reference, a requirement with no version,
  the inside of the interface, a plan and a TODO, an end user's how-to, a fix on a screen the
  reader does not have, two limits that disagree, "check the logs", a sample that does not match
  the code, a full-length key, no first success) and five decoys.

## Backlog

- `technical-guide/fixture-02` — an Update: an environment variable renamed, a worker added and a
  command's option removed, over an installation guide and an administration guide. Tests: both
  documents swept, the change under its version in the migration notes, where each command runs,
  a verify step, no value copied from the environment.
- A fixture where the project's own documentation rules send a staff screen to the user guide and
  have the screenshots taken with a staff account: the conflict is named, not followed in silence.
- A guide of several pages with one rule told in five of them and a banner of a past release.
