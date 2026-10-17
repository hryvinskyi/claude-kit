# Agent evals on a Symfony project

Fixtures for the `pipeline` plugin's agents whose project is a Symfony application. The harness,
its layout and its rules are the pipeline plugin's (`plugins/pipeline/evals/README.md`); `<evals>`
in an answer key or a scorer here means this directory. Run one from the kit's source clone:

```
/pipeline:agent-evals devils-advocate symfony/fixture-01
```

The runner loads this plugin beside `architecture`, `pipeline` and `guards`, so the gate demands
the core skill and this plugin's skill before the agent's first plan write.

## Current fixtures

- `devils-advocate/fixture-01` + `expected-01.md` — Symfony-ish modular monolith
  ("acme-billing"), plan "credit-notes" with **7 seeded flaws** (F1–F7): missing task
  dependency, unwired tagged services, nonexistent repository method, switch-on-type
  dispatch, entity change without migration, missing locale, and a plan step that
  contradicts an accepted decision record.
- `devils-advocate/fixture-02` + `expected-02.md` — the precision case: the same project and
  feature planned **correctly**, with **7 decoys** (D1–D7) that look like F1–F7 until the
  file the plan points at is read. Expected: 0 Critical, no decoy tripped, no `[APPLIED]`
  edit that rests on nothing. fixture-01 scores recall; this one scores what a reviewer
  that edits plans does to a plan that was right.
