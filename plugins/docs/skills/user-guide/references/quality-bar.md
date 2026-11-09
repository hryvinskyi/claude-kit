# User guide — the quality bar

One bar, used twice: by the author for the self-check before review, and by the reviewer in Review
mode. Numbered the same in both places so the two never drift.

A condition **passes** unless there is a real, named deficiency that would block or mislead a real
reader. Wording you would have chosen differently is not a deficiency.

## The 12 conditions

**1. Goal coverage — one how-to per goal, no orphans.**
- *Pass:* every goal the product supports for this reader has exactly one how-to; every how-to
  traces to a goal in the fact list.
- *Gap:* a goal with no how-to; a how-to whose goal the product does not support (often an
  invented feature — check condition 4 as well).

**2. The four modes present and kept apart.**
- *Pass:* the tutorial is one guaranteed path; how-tos are numbered steps; the explanation has no
  steps; the reference describes without instructing. Each section is read for what it is, not for
  its title.
- *Gap:* a how-to that is paragraphs of background; a tutorial with choices or a failure path; an
  explanation hiding steps; a reference that tells the reader what to do.

**3. The reference is complete.**
- *Pass:* every screen, setting, option and default the reader meets is described, in the order the
  screen shows it, with where it applies.
- *Gap:* a setting or screen the reader meets is missing, or listed with the wrong default or
  options. *Not a gap:* settings only a developer sees; they belong to the technical guide.

**4. Steps match the product, with exact labels.**
- *Pass:* every step matches the product's real behavior; every control is named by its exact
  label; nothing is invented.
- *Gap:* a step the product does not support (fabrication: always blocking); a wrong label
  ("Save" for **Save Config**); a wrong menu path; a default that differs from the product.

**5. Procedures are sound.**
- *Pass:* numbered steps, one action each, imperative, second person, present tense; task titles;
  prerequisites before the steps; a result line where the result is not obvious.
- *Gap:* steps as a paragraph; several actions in one step; a prerequisite discovered mid-task;
  a feature name as the title of a task.

**6. Troubleshooting covers the known failures.**
- *Pass:* every failure the product signals to this reader (an error or warning message, a result
  that does not appear, a permission refusal) has an entry titled by what the reader sees, with
  cause and fix; recurring questions in the FAQ; a way to get more help.
- *Gap:* a known message or failure with no entry; entries titled by internal cause.

**7. Usable by the reader.**
- *Pass:* a reader of the stated kind can reach every goal from the guide alone; prerequisites
  stated; the screens they need to find their way around are shown or described.
- *Gap:* an ambiguous step, a missing prerequisite, or a step that needs knowledge the reader does
  not have (a developer task taught to a store admin).
- *Overlap guard:* jargon and readability are condition 10, not this one.

**8. Assumptions are visible.**
- *Pass:* every fact the author could not confirm is an assumption or an open question the reader
  of the draft can challenge.
- *Gap:* a missing fact papered over with a plausible step.

**9. An update is scoped, swept and versioned.** (Not applicable to a first version.)
- *Pass:* the change meets the bar where it touched; no changed, renamed or removed capability is
  still mentioned anywhere (steps, reference, screenshots and captions, troubleshooting, glossary,
  explanation); coherence holds; the guide's version and history are updated; removed features are
  marked with their replacement.
- *Gap:* an old label surviving in another part of the guide (the most common update defect); an
  outdated screenshot; no history row; a removed feature silently deleted.

**10. Plain language.**
- *Pass:* a non-technical reader can follow it: purpose first, short sentences, every term defined
  on first use and collected in the glossary, no technical material in the body.
- *Gap:* an unexplained term or abbreviation that stops the reader; code, a file path, a
  configuration code or a command in the body.
- *Judged by the reader*, never by a readability score.

**11. Accessible.** (Proportional: not applicable where there are no links, images or visual cues.)
- *Pass:* meaningful link text; headings nest in order; no instruction by color or position alone;
  every image has a caption that stands in for it.
- *Gap:* "click here"; "the green button"; an image the guide relies on with no caption.
- *Out of scope:* contrast, fonts and layout of the rendered document.

**12. Findable.**
- *Pass:* a first-time reader finds the start here and the section for their goal without knowing
  the product.
- *Gap:* no orientation, so a reader cannot tell where to begin or which section answers them.
- *Overlap guard:* this is navigation; a missing goal is condition 1, a mixed mode is condition 2.
  A one-page guide passes trivially.

## Proportionality

The bar scales with the product. A small product's guide may collapse sections, have nothing to
define, no images and a single page, and still pass. The only floor at every size: every goal the
product supports for this reader has a how-to (condition 1), and nothing is invented (condition 4).

## Overlap guards

One defect, one finding, under the condition that owns it.

- Jargon or readability → 10, not 7.
- Navigation → 12, not 1 or 2.
- An invented feature → 4 (and its how-to is the orphan of 1: report it once, under 4).

## Review report

```
VERDICT: revise

1. [blocking] Condition 4 — "Show a label on sale products", step 3: says "click Save"; the
   button reads "Save Config" (fact list: the settings screen). Fix: name the button as shown.
2. [blocking] Condition 1 — the product lets an admin schedule a label (fact list: Active From and
   Active To fields) but no how-to covers it. Fix: add "Show a label only for a sale period".
3. [minor] Condition 10 — Start here: "store view scope" is not explained. Fix: "can be set
   differently for each store view", and add "store view" to the glossary.
```

- The verdict line is exactly `VERDICT: approve` or `VERDICT: revise`, alone on its line.
- On `revise`: one finding per real gap, most blocking first, each with the condition, the
  location and a concrete fix. On `approve`: optional notes that block nothing.
- **No false revise.** A guide that meets every applicable condition is approved, even a small one.
  Do not invent conditions (a video, a marketing introduction, a reading-grade target).
- **No false approve.** A blocking gap is a revise, however good the rest is.
- **Judge, never author.** Name the fix; do not rewrite the guide.
- A fact the reviewer cannot check (no instance, no fact list entry) is reported as unverifiable,
  not as wrong.
