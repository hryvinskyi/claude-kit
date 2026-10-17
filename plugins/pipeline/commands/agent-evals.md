---
description: Run the agent eval harness — run an agent as registered on a seeded-flaw fixture and score it against the answer key
argument-hint: "[agent] [fixture] [model] — defaults: devils-advocate fixture-01, the agent's own model"
---

Run a regression eval for an agent definition. Default target: `devils-advocate` on
`fixture-01`. See `${CLAUDE_PLUGIN_ROOT}/evals/README.md` for the harness rules.

`<agent>` is the agent's bare name, which is also its directory under
`${CLAUDE_PLUGIN_ROOT}/evals/`. Its **registered name** — the one Claude Code knows it by — is
`pipeline:<agent>` when `${CLAUDE_PLUGIN_ROOT}/agents/<agent>.md` exists, `<plugin>:<agent>` for an
agent another plugin ships, and the bare name for a user-scope or project agent. Its **definition
file** is the `.md` that registered name loads.

1. **Resolve** the fixture `${CLAUDE_PLUGIN_ROOT}/evals/<agent>/<fixture>/`, its prompt
   `${CLAUDE_PLUGIN_ROOT}/evals/<agent>/prompt-<NN>.md`, and its answer key
   `${CLAUDE_PLUGIN_ROOT}/evals/<agent>/expected-<NN>.md`. Do NOT read the answer key into the agent's
   prompt — it is for scoring only.
2. **Copy the fixture** into the session scratchpad (fresh copy every run — agents edit
   files; never run on the original, never reuse a dirty copy).
3. **Run the agent AS REGISTERED**, headless, from inside the copy:
   ```
   cd <copy> && CLAUDE_NO_JOURNAL_NUDGE=1 claude -p --agent <registered name> \
     --dangerously-skip-permissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
     < ${CLAUDE_PLUGIN_ROOT}/evals/<agent>/prompt-<NN>.md > <copy>/../<agent>-report.md
   ```
   `--agent` loads the definition file as it is on disk right now, with its own `tools:` and
   `model:`. A plugin agent is found only while its plugin is enabled in the nested session: it is
   when the plugin is installed at user scope; to evaluate a working copy that is not installed,
   add `--plugin-dir <plugin directory>` for that plugin and for every plugin it depends on (the
   pipeline agents load `architecture`'s skills). When a model is given, add `--model <model>` — an agent its caller
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
   answer key. When the key names a scorer (`${CLAUDE_PLUGIN_ROOT}/evals/<agent>/verify-<NN>.*`), run it
   against the copy — `FIXTURE_ROOT=<copy> node --test <scorer>` for a `.mts` one — and count
   its result as the artifact check the key describes:
   - seeded flaws found / missed (quote the agent's wording per hit)
   - severity accuracy per the key
   - apply-check: Critical/Important findings actually `[APPLIED]` to the plan files
   - noise: findings outside the seeded set — judge real vs hallucinated
5. **Report the scorecard**: `N/M found`, misses by id with the plan line that should have
   triggered them, severity deltas, false-positive count. On regressions (a previously
   caught flaw now missed), say so explicitly against the last recorded run.
6. **Record the run**: append one line — date, the definition file's content hash
   (`git hash-object <definition file> | cut -c1-7`; it identifies the exact text that was
   tested even before it is committed), fixture, score, misses — to `<agent>/runs.log` under
   the evals directory of the **kit's source clone** (create it if absent), and name the model
   the run used. That directory is `$CLAUDE_KIT_ROOT/plugins/pipeline/evals/` when the variable
   is set, otherwise `${CLAUDE_PLUGIN_ROOT}/evals/` when that directory is inside a git working
   tree (a local-directory marketplace and `--plugin-dir` load the plugin in place, so this is
   the clone). A copy under a `plugins/cache/` directory is never written: an update replaces
   it. When neither applies, print the line and say the run was not recorded.

Never edit the fixture, the prompt, or the answer key to make a run pass. Improve the agent
definition instead, commit it, and re-run.
