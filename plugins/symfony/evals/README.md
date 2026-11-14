# Agent evals on a Symfony project

Fixtures for the `pipeline` plugin's agents whose project is a Symfony application. The harness,
its layout and its rules are the pipeline plugin's (`plugins/pipeline/evals/README.md`); `<evals>`
in an answer key or a scorer here means this directory. Run one from the kit's source clone:

```
/pipeline:agent-evals devils-advocate symfony/fixture-01
```

The runner loads this plugin beside `architecture`, `pipeline` and `guards`, so the gate demands
the core skill and this plugin's skill before the agent's first plan write.

A run must also load the kit's engineering standards (`standards/CLAUDE.standards.md`) and this
plugin's `standards/CLAUDE.standards.symfony.md` as memory, as the 2026-10-18 runs did through
`--add-dir`: fixture-02's R4 (PHPStan level 10 for written code) is a rule of the standards
alone, and neither the fixture nor the skills state it. A run without them is recorded as such
and its R4 is not scored.

## Current fixtures

- `devils-advocate/fixture-01` + `expected-01.md` — Symfony-ish modular monolith
  ("acme-billing"), plan "credit-notes" with **7 seeded flaws** (F1–F7): missing task
  dependency, unwired tagged services, nonexistent repository method, switch-on-type
  dispatch, entity change without migration, missing locale, and a plan step that
  contradicts an accepted decision record.
- `devils-advocate/fixture-02` + `expected-02.md` — the precision case: the same project and
  feature planned **without fixture-01's seeded flaws** (and with every real Critical a run
  reported since corrected), with **7 decoys** (D1–D7) that
  look like F1–F7 until the file the plan points at is read, and **5 rubric breaks** (R1–R5:
  named constructors, no factory generator task, `Money`'s `new self` left as in-scope debt, no
  PHPStan level 10, a use case naming the `EntityManager` for its transaction). Expected: R1–R5
  found and applied, 0 manufactured Critical, no decoy tripped, no `[APPLIED]` edit that rests
  on nothing; a run that finds nothing fails. fixture-01 scores recall on the project's checks;
  this one scores the rubric's checks and what a reviewer that edits plans does to the parts
  that were right.
