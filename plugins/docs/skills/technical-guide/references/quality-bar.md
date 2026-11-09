# Technical guide — the quality bar

One bar, used by the author for the self-check and by the reviewer in Review mode, numbered the
same in both. A condition **passes** unless there is a real, named deficiency that would block or
mislead the reader. Each is **proportional**: a small package legitimately collapses what it does
not need. These never collapse: 2 (verified first success), 7 (modes apart), 9 (accurate samples),
11 (nothing invented).

| # | Condition | Pass | Gap | Collapses when |
|---|---|---|---|---|
| 1 | **Goal-organized** | Framed by what the reader can do; recipes named by goal | A tour of classes or endpoints with no task in sight | never |
| 2 | **Verified first success** | Prerequisites (incl. where credentials come from, and a test mode where one exists) → install → configure → one real result → **verify** with the expected output; secrets from the environment | No verify step; not runnable; a hard-coded secret; a needlessly long path | never; a tool with no credentials skips that step |
| 3 | **Concepts before recipes** | The model precedes the recipes that rely on it | Concepts missing, or scattered through the recipes | light on a small package, still first |
| 4 | **Recipes cover the common goals** | One goal-named, runnable recipe per common goal in the fact list, linking into the reference | A common goal (one the code clearly supports) with no recipe | few recipes for a small surface |
| 5 | **Tutorial kept separate** | One guided build, separate from the lookup recipes | Tutorial and recipes fused into one narrative | a small package may omit the tutorial; never fuse |
| 6 | **Practices grounded** | The production concerns the software has, each with a recommended pattern and a sample | Missing for a concern the software has; an option list with no recommendation | concerns the software does not have |
| 7 | **Modes apart** | Each part is what it claims to be | Reference dumped into the tutorial; concepts smeared through recipes | never |
| 8 | **One home per fact** | The reference holds the catalog; guides link into it | A second, drifting copy of a table or option list inside a guide | a one-document package keeps the catalog in one chapter |
| 9 | **Samples and commands accurate and runnable** | Every command, signature, option and sample matches the code of the stated version; what was run is recorded; unverified items are flagged | Anything that does not exist in the code, or differs from it (always blocking) | never |
| 10 | **Versions stated** | Supported platform and language ranges; the version the guide targets; the version scheme, deprecation policy and changelog link; migration notes per breaking change | A versioned package with none of these | an unreleased or first-major package needs no migration notes |
| 11 | **Nothing invented** | Gaps are stated assumptions or open questions | A missing fact papered over with something plausible | never |
| 12 | **Update scoped, swept and versioned** | The change meets the bar where it touched; no changed, renamed or removed item is mentioned anywhere stale; history row; deprecated items marked | A stale sample or option survives elsewhere; no history; silent deletion | not applicable to a first version |
| 13 | **Troubleshooting path** | The frequent, knowable failures by symptom, with the exact message, cause and fix | A frequent failure with no way out; "check the logs" with no log named | a small package folds it into the first success |
| 14 | **Findable** | A first-time reader finds the start here and the section for their goal | No orientation, so a new reader cannot begin | a one-page guide passes trivially |

## Installation guides add

An installation guide is judged on conditions 2, 7, 9, 10, 11, 12, 13 and 14 as above, and on:

- **Requirements complete**: every version range, edition, service and package the code requires,
  with both ends of each range.
- **Uninstall honest**: what the removal leaves behind (tables, files, configuration, data in other
  systems) is listed, with how to remove it if wanted.
- **Operations covered**: every schedule, consumer, worker, cache and log the software relies on in
  production is named, with how to check it runs.

Report a gap in these as condition 4 (a goal of the installer not covered), naming which.

## Overlap guards

One defect, one finding, under the condition that owns it.

- A tour of endpoints → 1; concepts after recipes → 3; a missing start here → 14. Never all three
  for one defect.
- A sample calling something that does not exist → 9 (and 11 only if it hides a missing fact:
  report it once, under 9).
- A stale item after an update → 12.

## Review report

```
VERDICT: revise

1. [blocking] Condition 9 — Recipes, "Add a carrier": registers the class under `carriers` in the
   configuration; the code reads the list from `providers` (fact list: the pool's constructor).
   Fix: use `providers`.
2. [blocking] Condition 2 — First success ends at "the module is installed" with no check.
   Fix: add the command that lists the module and its expected output line.
3. [minor] Condition 13 — "Requests time out" says "check the logs". Fix: name the log file and the
   line to look for.
```

- The verdict line is exactly `VERDICT: approve` or `VERDICT: revise`, alone on its line.
- On `revise`: one finding per real gap, most blocking first, with the condition, the location and a
  concrete fix. On `approve`: optional notes that block nothing.
- **No false revise**: a small package's short guide that meets every applicable condition is
  approved. Do not invent conditions.
- **No false approve**: a blocking gap is a revise.
- **Judge, never author.**
- What the reviewer could not run is reported as unverified, not as wrong.
