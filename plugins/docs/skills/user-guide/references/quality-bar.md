# User guide — the quality bar

One bar, used twice: by the author for the self-check before review, and by the reviewer in Review
mode. Numbered the same in both places so the two never drift.

A condition **passes** unless there is a real, named deficiency that would block or mislead a real
reader. Wording you would have chosen differently is not a deficiency.

## The 16 conditions

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
  options. *Not a gap:* settings only a developer, an operator or the vendor's staff see; they
  belong to that reader's document, and their presence here is a gap of condition 13.

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
  cause and fix; recurring questions in the FAQ; a way to get more help that names a person or a
  channel the reader can find.
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
  explanation); what left the reader's reach left the guide; coherence holds; the guide's version
  and history are updated; a removed feature the reader may still look for carries its dated mark
  and its replacement.
- *Gap:* an old label surviving in another part of the guide (the most common update defect); an
  outdated screenshot, or one whose caption says it is outdated; no history row; a removed feature
  silently deleted; a mark of the past with no version or date, or older than its window.
- *Overlap guard:* steps kept for a thing that left the reader's reach, with a note on who they are
  for now, are condition 13. The change told in the body instead of in the history is condition 14.

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

**13. One reader, within their reach.**
- *Pass:* every how-to, step, reference entry, screenshot and troubleshooting fix is something the
  guide's stated reader can open, do or see; "you" is that reader throughout; where someone else
  must act, the guide gives the request: what to ask support for, what the reader sees when it is
  done.
- *Gap:* steps or a reference entry for a screen, a setting or an action the reader cannot reach
  (always blocking); a section addressed to another role, or "you" changing its owner inside a page;
  a telling of what other roles see or are told; "ask an administrator" or "ask whoever runs it"
  where the reader cannot tell who that is; a fix on a screen the reader cannot open, with no
  request; a permission, a role or a scope
  in the guide's list that nobody in the reader's place can hold; another person's procedure for
  acting in the reader's own space, or what is kept from the reader there.
- *Not a gap:* a prerequisite naming the permission the reader needs; one request; a second kind of
  reader with a group of how-tos of their own.
- *How to judge:* against the fact list's reach column; against the product when the list has none;
  reported as unverifiable when neither can be read. Never against what sounds plausible.

**14. The product as it is.**
- *Pass:* the body describes what the reader can use on the version the guide names, without
  history and without a clock; what changed is in the document history; a limit is told where the
  reader meets it, with the way round it.
- *Gap:* history in the body ("new in this release", "used to", "until now", "no longer" for a
  change of the product, a note on what was migrated); a word true only on the day of writing
  ("now", "currently", "recently"); anything not released, not switched on, not enforced, hidden or
  planned (blocking when the reader would rely on it); a setting described as working in one place
  and as not built in another; a list of what the product does not have; a weakness of the product
  stated with nothing the reader can do; a comparison with other products or their prices.
- *Not a gap:* a dated mark inside its window (condition 9); a state of the reader's own data ("the
  invitation is no longer valid"); a message quoted as the product shows it; a limit with its way
  round.

**15. From the reader's side, in one place.**
- *Pass:* the guide says what the reader sees and what happens for them; a reason is given where it
  changes what the reader does; each rule, limit and warning is stated once and linked from the
  other places; the reader and the product each have one name.
- *Gap:* how the product does it (a check, a job, a queue, a cache, where a thing is stored, a
  model, a protocol) where the reader needs the effect; a defence of a design ("this is deliberate",
  "on purpose", "rather than…"); an identifier the reader's screen never shows; the same rule retold
  outside its how-to, its reference entry and its troubleshooting entry, or two passages that
  disagree (the wrong one is condition 4 as well: report it
  once, there); another feature's manual inside this page; the reader called by two names, or the
  product by an old one; examples that are the vendor's demo system.
- *Overlap guard:* a word the reader does not know is condition 10. Steps packed into a paragraph
  are condition 5. This condition is about whose story the text tells, and how many times.

**16. Roles the reader cannot hold stay unnamed.**
- *Pass:* no role the reader cannot hold (the vendor's or host's operator, staff or super-user
  accounts) is named or hinted at, and neither is a screen, setting, permission or step only those
  roles see; where the reader needs what only they can do, the guide says to contact support for
  the outcome; every screenshot shows only what the reader's own role sees.
- *Gap:* "only staff see this", "settings not switched on yet", "no role can be given this";
  who does the work, where, or why the reader cannot; a screenshot taken as a super-user, with a
  menu item, tab or setting the reader does not have (always blocking when it shows one).
- *Not a gap:* "contact support" with the outcome wanted; a prerequisite naming a permission the
  reader's own organization can hold.
- *Overlap guard:* steps or a reference entry for such a screen are condition 13; this condition is
  the hint, the name and the picture. A screenshot of a control the reader lacks is reported here
  once, not under 13.

## Proportionality

The bar scales with the product. A small product's guide may collapse sections, have nothing to
define, no images and a single page, and still pass. The floor at every size: every goal the
product supports for this reader has a how-to (condition 1), nothing is invented (condition 4), and
nothing is outside the reader's reach (condition 13), and no hidden role is named (condition 16).

## Severity

- **Blocking**: the reader cannot finish a task, is sent to a place or a person they cannot reach,
  or would rely on something that is not so (a wrong step, a wrong label on a control they must
  find, a setting that does not do what the guide says).
- **Minor**: the reader still gets there. The text is longer, rougher or harder to find than it
  should be.

A finding is blocking for what it does to the reader, not for the number of its condition.

## Overlap guards

One defect, one finding, under the condition that owns it.

- Jargon or readability → 10, not 7.
- Navigation → 12, not 1 or 2.
- An invented feature → 4 (and its how-to is the orphan of 1: report it once, under 4).
- Another reader's material → 13, not 7 and not 10, however technical it also is. A whole section
  for another reader is one finding with its line range, not one per sentence.
- The past, the future and the clock → 14. A label that changed and still stands in a step → 9.
- Mechanism, a defended design, a repeat → 15. An unknown term → 10.
- A hint at, or the name of, a role or screen the reader cannot hold, or a screenshot showing one →
  16. Steps for it → 13.

## Review report

```
VERDICT: revise

1. [blocking] Condition 4 — "Show a label on sale products", step 3: says "click Save"; the
   button reads "Save Config" (fact list: the settings screen). Fix: name the button as shown.
2. [blocking] Condition 1 — the product lets an admin schedule a label (fact list: Active From and
   Active To fields) but no how-to covers it. Fix: add "Show a label only for a sale period".
3. [blocking] Condition 13 — "Remove a label for good", steps 1–4: the action is offered to the
   vendor's support staff only (fact list: the list's actions); a store admin never sees it. Fix:
   remove the how-to and its reference row; if the reader needs the result, give the request to the
   support team; hand the steps to the operations guide.
4. [minor] Condition 14 — "Product Labels" settings: "New in this release: labels can be
   scheduled." Fix: describe the setting as it is; the change goes into the document history.
5. [minor] Condition 10 — Start here: "store view scope" is not explained. Fix: "can be set
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
