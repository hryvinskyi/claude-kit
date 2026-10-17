---
description: Run the agent eval harness — run an agent as registered on a seeded-flaw fixture and score it against the answer key
argument-hint: "[agent] [fixture] [model] — defaults: devils-advocate symfony/fixture-01, the agent's own model"
---

Run a regression eval for an agent definition. Default target: `devils-advocate` on
`symfony/fixture-01`. See `${CLAUDE_PLUGIN_ROOT}/evals/README.md` for the harness rules.

**Evals run from the kit's source clone, never from the plugin cache.** The clone is
`$CLAUDE_KIT_ROOT` when the variable is set; otherwise the git working tree that holds
`${CLAUDE_PLUGIN_ROOT}` (a local-directory marketplace and `--plugin-dir` load the plugin in place,
so that tree is the clone); otherwise the git working tree of the current directory when it holds
`.claude-plugin/marketplace.json` and `plugins/pipeline/`. A `${CLAUDE_PLUGIN_ROOT}` under a
`plugins/cache/` directory is a copy, not the clone. When none of these is a clone, say so and stop.
Below, `<kit>` is that clone.

`<fixture>` is `<plugin>/<fixture-NN>` — the fixture `fixture-NN` of the plugin `<plugin>` — or a
bare `fixture-NN`, which means `pipeline/fixture-NN`. A fixture that is a project of one stack ships
with that stack's plugin (`symfony/fixture-01`, `magento2/fixture-03`). Its **evals directory** is
`<kit>/plugins/<plugin>/evals/`, and the agent's files sit in `<agent>/` below it.

`<agent>` is the agent's bare name, which is also its directory in the evals directory. Its
**registered name** — the one Claude Code knows it by — is `pipeline:<agent>` when
`${CLAUDE_PLUGIN_ROOT}/agents/<agent>.md` exists, `<plugin>:<agent>` for an agent another plugin
ships, and the bare name for a user-scope or project agent. Its **definition file** is the `.md`
that registered name loads.

1. **Resolve**, beside each other in `<evals dir>/<agent>/`: the fixture `fixture-<NN>/`, its prompt
   `prompt-<NN>.md`, its answer key `expected-<NN>.md`, and its scorer `verify-<NN>.*` when the key
   names one. Do NOT read the answer key into the agent's prompt — it is for scoring only.
2. **Copy the fixture** into the session scratchpad (fresh copy every run — agents edit
   files; never run on the original, never reuse a dirty copy).
3. **Run the agent AS REGISTERED**, headless, from inside the copy:
   ```
   cd <copy> && CLAUDE_NO_JOURNAL_NUDGE=1 claude -p --agent <registered name> \
     --dangerously-skip-permissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
     < <evals dir>/<agent>/prompt-<NN>.md > <copy>/../<agent>-report.md
   ```
   `--agent` loads the definition file as it is on disk right now, with its own `tools:` and
   `model:`. A plugin agent is found only while its plugin is enabled in the nested session: it is
   when the plugin is installed at user scope; to evaluate a working copy that is not installed,
   add `--plugin-dir <kit>/plugins/<name>` for that plugin, for every plugin it depends on (the
   pipeline agents load `architecture`'s skills), for `guards`, and for the fixture's own plugin
   when that is a stack plugin. A stack fixture scores the gate's demand for both the core skill
   and the stack skill, so a run without `guards` or without the stack plugin measures something
   else. When a model is given, add `--model <model>` — an agent its caller
   spawns on more than one model (`feature-implementer` runs on Opus and Sonnet under
   `/pipeline:feature`) is evaluated on each of them, and a pass on one says nothing about the other. Pasting the definition into a general subagent's prompt does not
   honor either (an early run recorded exactly that mismatch), so it is only the fallback:
   if `--agent` is unavailable in this build, spawn a subagent whose prompt is the definition
   verbatim plus "Project root: `<copy>` — resolve every relative path against it", and say
   so in the run record. Details of the invocation: the prompt goes through stdin because
   `--mcp-config` is variadic and would swallow a positional prompt; the empty MCP config
   skips server start-up (fixtures never need MCP); the journal nudge is silenced so the
   nested session's Stop hook cannot pollute the report. Permissions are skipped because the
   run is confined to the scratch copy; fixtures must never reach outside it. Independent
   evals can run in parallel (background Bash).
4. **Score** when it returns: read the report and the produced artifacts (for
   devils-advocate: `.claude/plans/*/_devils_advocate.md` in the copy plus its plan edits;
   for an implementer: `diff -rq` of the fixture against the copy) and compare against the
   answer key. `<evals>` in the key or a scorer is the fixture's evals directory. When the key
   names a scorer, run it against the copy — `FIXTURE_ROOT=<copy> node --test <scorer>` for a
   `.mts` one — and count its result as the artifact check the key describes:
   - seeded flaws found / missed (quote the agent's wording per hit)
   - severity accuracy per the key
   - apply-check: Critical/Important findings actually `[APPLIED]` to the plan files
   - noise: findings outside the seeded set — judge real vs hallucinated
5. **Report the scorecard**: `N/M found`, misses by id with the plan line that should have
   triggered them, severity deltas, false-positive count. On regressions (a previously
   caught flaw now missed), say so explicitly against the last recorded run.
6. **Record the run**: append one line — date, the definition file's content hash
   (`git hash-object <definition file> | cut -c1-7`; it identifies the exact text that was
   tested even before it is committed), fixture, score, misses — to
   `<kit>/plugins/<plugin>/evals/<agent>/runs.log`, the log beside the fixture (create it if
   absent, with the header line the other logs carry), and name the model the run used. A copy
   under a `plugins/cache/` directory is never written: an update replaces it.

Never edit the fixture, the prompt, or the answer key to make a run pass. Improve the agent
definition instead, commit it, and re-run.
