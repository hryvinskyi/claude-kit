---
name: user-guide
description: |
  Load BEFORE writing or editing any documentation that a product's users read: a user guide,
  a help page or article, an admin guide for the customer's own administrators, a page of a
  documentation site. That includes "update the documentation" after a code change: a page
  added or edited as part of a feature, a fix, or a change of who may open or do something.
  Write, update or review an end-user guide: the help a non-technical person (a store admin,
  a merchant, an office user, a customer) reads to get things done with a product. A
  getting-started lesson, one how-to per goal, the ideas explained, every setting the user
  sees, troubleshooting by symptom, a glossary. Also for "user manual", "how do I…" pages,
  "інструкція для користувача", "посібник для адміністратора", "мануал для користувачів",
  "онови документацію", and a guide that "reads too technical". The guide has one reader and
  holds only what that reader can open and do, as the product is today. Steps, labels and
  messages come from the product itself, never invented; a fresh-context review checks the
  guide before it ships. Not for developer, installation, operations or API documentation
  (docs:technical-guide).
---

# User guide

A user guide answers one question: **can a real, non-technical user reach every goal the product
supports from this guide alone, with steps that match the screens and words they understand?**
Every rule below serves that question. Completeness of a template, word count and polish do not.

The reader is the person who **uses** the product, not the person who builds, installs or runs it.
Installation, commands, configuration codes, class names, file paths and APIs belong to
`docs:technical-guide`. A user guide that needs a developer for a step says so in one sentence and
points to the technical guide; it never teaches the step itself.

## One reader, within their reach

A guide is written for **one reader**, and it holds only what that reader can **reach**: the
screens they can open, the settings they can change, the actions they can take, on the product as
they have it today. This decides what goes in before any sentence is written.

- **What the reader cannot open is not in their guide.** A screen, a setting or an action that
  belongs to someone with more access (the vendor's own staff, an operator, an administrator the
  reader is not) is documented in that person's document. Being true and being in the code do not
  make it this reader's.
- **Where someone else must act, the reader's part is the request.** The guide says what to ask
  for, to the vendor's support, and what the reader sees when it is done. It never gives the other
  person's steps, and it never tells what other people see.
- **Roles the reader cannot hold stay unnamed.** The vendor's or host's operator, staff and
  super-user accounts, and the screens, settings, permissions and steps only they see, are not
  named or hinted at: no "only staff see this", no "not switched on yet", no "no role can be given
  this". The guide describes what the reader can see and do. Where the reader needs what only such
  a role can do, it says to contact support for the outcome, without saying who does it, where or
  why the reader cannot. Those roles and screens are documented in the operator's own technical
  guide.
- **What does not work for the reader yet does not exist for the guide**: not released, not
  switched on, hidden, planned, or a control that does nothing yet.
- **A change in who can reach something is a change in what the guide holds.** When the product
  takes a thing out of the reader's reach, the update takes it out of the guide. It does not
  annotate it.

`references/method.md` §The reader and their reach has the fact-list columns, the request pattern
and the cases in depth.

## Load with

- **The stack skill**, when a stack plugin covers the project: that plugin's docs skill
  (`magento2:magento2-docs` on Magento 2, `symfony:symfony-docs` on Symfony). It says where the
  framework keeps the screens, labels, settings, permissions and messages, where it writes down
  who may open each of them, which wording the platform's own documentation uses, and the front
  matter of a guide. Without one, apply this skill in the stack's idiom and say so.
- **The project's own documentation rules**, when its instructions (`CLAUDE.md`, `AGENTS.md`) name
  them: which reader each document has, where it lives, how it is checked. They are followed. Where
  one of them works against this skill (it sends a screen to a guide whose reader cannot open it,
  it has the screenshots taken with a staff account), do not pick a side in silence: name the
  conflict to the user before you write, and in your report.
- `references/method.md` before the first section is written: the reader and their reach, the
  default outline, plain language, the product as it is, exact labels, screenshots, accessibility,
  findability, the sweeps, and the update in depth.
- `references/quality-bar.md` before the self-check and in Review mode: the 16 conditions, their
  pass and gap signals, the overlap guards and the review report.

## Three modes

| Mode | When | Output |
|---|---|---|
| **Write** | No guide exists, or the user asks for a new one | The guide, its fact list, a review verdict, a rendered copy when a renderer is declared |
| **Update** | A guide exists and the product changed, or the user reports a wrong or missing part | A scoped edit with a reach check, a full staleness sweep and a revision-history row, never a rewrite |
| **Review** | A finished guide is to be judged | `VERDICT: approve` or `VERDICT: revise` with findings; the reviewer never edits the guide |

A help page edited as part of a code change is an **Update**, however small. It gets the reach
check and the sweeps, and its changed parts are reviewed in a fresh context.

## Write

### 1. Frame the guide

Settle five things before reading the code in depth. Take each from the request and the project
when they answer it; ask the user only what neither does, and state the rest as assumptions.

- **Reader.** Who opens this guide, what they already know, what they do not (a store admin knows
  the admin; a customer knows only the storefront), and **what they can reach**: the role or
  permission they hold and the screens it opens. A guide with two kinds of reader (an administrator
  and a member of their team) names both and says which one "you" is by default.
- **Other readers.** Who else works with the product (the vendor's staff, an operator, a developer,
  a role with more access than the reader) and which document is theirs. What only they can do goes
  there. When that document does not exist, say so and propose it; do not keep their material in
  this guide until it does.
- **Goals.** What the reader wants to get done, in their words, not the product's feature names.
- **Scope.** What is in, and what is deliberately out (installation, other modules, developer work,
  other readers' screens).
- **Document.** One guide, or a set (a getting-started page plus how-tos); its language and the
  version of the product it describes.

### 2. Collect the facts from the product

The guide is derived, never imagined. Before writing, build a **fact list**: every screen, menu
entry, setting, option, default, button, message, permission and automatic behavior the reader
meets, each with **the source it came from** (the file and line, the admin screen, the translation
file), its **exact label** as the product shows it, and **who can reach it** (the role, permission
or plan that opens the screen or shows the control, with the place the rule is written). The stack
skill says where each kind of fact lives. Read existing documentation for tone and terminology; do
not copy it, and do not trust it over the code.

Collect the facts as the guide's reader: sign in with their role, and take no fact from a screen
only a role with more access sees (reading its code to learn what it does is fine; it stays out of
the guide). Mark each fact against the guide's reader:

- **In reach**: the reader can open it or do it. It is material for the guide.
- **Out of reach**: only someone else can. It stays in the list, with what the reader meets in its
  place (nothing at all, a control that is switched off, a message, a person who does it for them),
  and with the document it belongs in.
- **Not available**: not released, not switched on for this reader, hidden, or shown but without
  effect yet. It is not material for any how-to. A control the reader sees that does not yet do
  what its label says is reported to the user as a finding about the product before the guide
  ships; the guide never presents it as working, and how the guide words it is the user's decision.

When a running instance is available, open every screen the guide describes **signed in as the
guide's reader**, never with an account that has more access: confirm each label, note the order
of fields as the reader sees them, and take the screenshots the guide will use
(`references/method.md` §Screenshots). A fact the code shows but the screen does not (a hidden
field, a setting shown only in one scope) is written as the reader will meet it.

**For every setting and switch, find what reads it.** A screen that stores a value proves only
that the value is stored. Search the code for where the value is read and what it changes: the
check that enforces it, the e-mail or the job it starts. A value nothing reads has no effect, and
its control is **not available**, however complete the screen looks.

A fact you cannot find is an **assumption**, listed as such, never a step. The same holds for
reach: when you cannot tell who can open a screen, ask, or list it as an assumption.

### 3. List the goals — one how-to per goal

Turn the facts in reach into the reader's goals ("show a label on sale products", "let a colleague
manage labels", "find out why a label does not show"). Every goal gets exactly one how-to; every
how-to traces to a goal. A screen or setting that serves no goal goes to the reference, not to a
how-to of its own.

A goal is something this reader can finish themselves. Where a step belongs to someone else, the
reader's goal is **the request**: what to ask support for, what to have ready, and what the
reader sees when it is done. It is one short how-to, or one sentence in the how-to it belongs to.
The other person's steps go to their document.

### 4. Propose the outline and wait

Show the user the outline before writing the body: the contents with one line per section, the
reader and their reach, the goal list, the assumptions, what is out of scope, and what was found
out of reach with the document it goes to. Wait for their approval, unless they already told you to
go ahead or to work unattended; then record the outline in your report instead. The default outline
is in `references/method.md` §Outline; collapse what a small product does not need.

### 5. Write each part in its mode

The four kinds of documentation (tutorial, how-to, explanation, reference) are kept apart. Mixing
them is the most common reason a guide confuses its reader.

- **Start here.** The first page tells each reader where to go: a new user to the tutorial, someone
  with a task to the how-tos, someone looking a setting up to the reference, someone stuck to
  troubleshooting. It also says, in two sentences, what the product does for the reader.
- **Getting started (tutorial).** One path to the first visible success, with no choices and no
  branches. Every step shows a result. Failures go to troubleshooting, explanations to the
  explanation section. Pick the smallest real win a new user can reach.
- **How-to guides.** One per goal, titled as the task ("Show a label on sale products"). Before
  the steps: what the reader needs first (a permission, a setting turned on). Then numbered steps,
  one action each, second person, present tense, imperative. Each control is named by its exact
  label. The last line says what the reader sees when it worked.
- **Explanation.** The ideas the reader needs to make sense of the product: what a scope is, why a
  change takes a while to appear, how two settings interact. No steps; link to the how-to that acts
  on the idea.
- **Reference.** Every screen and setting the reader can open, in the order the screen shows them:
  label, what it does in terms of the result, the options, the default, where it applies (for
  example per store view). It describes; it does not instruct. It holds nothing the reader cannot
  open.
- **Troubleshooting and FAQ.** Organized by what the reader **sees** ("The label does not appear on
  the product page"), never by the internal cause. Each entry: symptom, likely cause, fix as
  numbered steps, the exact message where there is one. Built from the product's real messages and
  failure paths. A fix that is not the reader's to make gives the request: what to ask support for. End
  with how to get more help: a person or a channel the reader can find.
- **Glossary.** Every term the guide had to define, in one place.
- **Document history.** The guide's own version and what changed in it, distinct from the
  product's version. It is the only place that tells what changed.

### 6. Hold the text to the reader

Plain language is the core of this skill; `references/method.md` has the detail of each line.

- Purpose first, short sentences, everyday words.
- Every term and abbreviation the reader may not know is explained where it first appears and
  collected in the glossary. Prefer rewriting the sentence so no term is needed.
- Name controls by their label, never by color or position alone ("the green button", "on the
  right").
- Link text says where it goes; headings nest in order.
- No code, no file paths, no configuration codes, no class or table names in the body.
- **"You" is the reader, and always the same one.** No sentence addresses another role as "you",
  and none tells what other roles see or are told, unless the reader has to act on it.
- **The product as it is today.** No history in the body ("used to", "no longer", "until now",
  "new in this release", "was moved"), no future ("not yet", "planned", "coming"), and no word that
  is true only on the day of writing ("now", "new", "recently", "currently").
- **What the reader sees, not how it is done.** No mechanism (a check, a job, a queue, a cache,
  where a thing is stored) and no defence of a design ("this is deliberate", "on purpose"). A reason
  is given only when it changes what the reader does.
- **One fact, one place in each part.** A limit, a rule or a warning is told in the how-to where
  the reader meets it, listed with its control in the reference, and named in troubleshooting under
  its message. It is not retold in a second how-to, on the start-here page or in several
  paragraphs of one section: those link to it.

### 7. Check, then review in a fresh context

1. Run the sweep and settle every place it lists (`references/method.md` §Sweeps says how to
   read them):

   ```bash
   python3 "<skill directory>/scripts/guide_sweep.py" <guide> --other-reader "<a role that is not the reader>"
   ```
2. Run the 16 conditions of `references/quality-bar.md` against the guide yourself and fix every
   miss.
3. Hand the guide to a **fresh agent** that did not write it: a general-purpose subagent with the
   guide, the fact list and the instruction to load this skill in **Review mode** (and the stack
   skill). The author's context believes its own conclusions; the reviewer's does not.
4. Fix every confirmed finding, and answer the wrong ones with the fact that shows it. One review
   round, then one check of the fixes; anything new outside them is reported, not looped on.

### 8. Render

When the project's or the user's instructions declare a renderer (a line such as
`Docs renderer: <command>` in `CLAUDE.md` or `AGENTS.md`), read what the declaration points to for
its front matter and markup (or `<command> --help` when it points nowhere), follow it, render the
guide, and look at the result: page count, the contents page, every table and image, no raw markup
left. Without a declared renderer the Markdown file is the deliverable. Never install a renderer on
your own.

## Update

A guide is updated when the product changes or a reader reports a gap. Edit, never regenerate:

1. **Scope** the change: which how-tos, reference entries, screenshots, troubleshooting entries,
   glossary terms or explanations it touches.
2. **Check reach first.** For each thing the change touches, ask who can reach it now.
   - It **left** the reader's reach (it became a staff screen, a permission was withdrawn, it was
     switched off or hidden for them): take it out of this guide. Its how-to, its reference entry,
     its screenshot, its troubleshooting entries and every mention go. What stays is what the
     reader still meets: the request for the outcome, when there is one. Hand what you took
     out to the document of the reader who holds it now, and name that document in your report, or
     say that there is none.
   - It **entered** the reader's reach: it gets its goal, its how-to and its reference entry.
   - Never annotate in place of removing. "Now for administrators only", "the steps below are what
     an administrator sees", "a member without this permission does not see the page" keep another
     reader's material in this guide and tell this reader about screens they cannot open.
3. **Sweep for staleness** across every part of the guide: for each changed, renamed or removed
   label, setting, screen or behavior, find every place that mentions it (steps, reference,
   screenshots and their captions, troubleshooting, glossary, explanation) and make each match the
   product now. A step that still describes a removed or renamed thing is the worst defect a guide
   can have. A screenshot of a changed screen is retaken; one that cannot be retaken in this update
   is removed. A caption never says that its picture is out of date.
4. **Re-check coherence**: the tutorial still runs end to end; the reference still mirrors the
   screens; links and glossary still hold.
5. **Version**: bump the guide's own version and add a history row (what changed, when, why). The
   row is where the change is told. The body says how the product is, not how it came to be so.
6. **Mark, with a date, and only these two.** A renamed label's old name is given once, at its new
   place: "Formerly **Old name** (until version 2.3)", where 2.3 is the last version that showed
   the old name. A removed feature the reader may still look
   for gets one line with its replacement, dated the same way. Each mark carries the version or the
   date of the change, and the sweep deletes a mark that is older than the window the user states
   (one major version when none is stated). No other trace of the past stays in the body.
7. **Sweep.** Run `python3 "<skill directory>/scripts/guide_sweep.py" <guide> --other-reader
   "<role>"` over the whole guide, not only over what you changed, and settle every place it lists.
   An update is when old history, another reader's section and a stale picture are found.
8. **Check.** Run the 16 conditions of `references/quality-bar.md` over the changed parts.
9. **Review in a fresh context**, as in Write step 7: a subagent that did not write the change
   gets the changed guide, the fact rows of the change with their reach, and the instruction to
   load this skill in Review mode. This step is part of the update, not an option. A small change
   and an unattended run are not reasons to skip it: unattended, nobody else reads the page before
   its reader does. Only a session that has no tool to start a subagent leaves it out, and its
   report says which tool it lacks.

An update that stops after step 6 is unfinished work, not a finished update with a caveat.

## Review

Run in a context that did not write the guide. Judge, never edit.

1. Read the whole guide as its reader would, then the fact list (or the product itself when no
   fact list came with it).
2. **Check reach before anything else** (condition 13): for each how-to, reference entry and
   screenshot, can the guide's stated reader open it? Take it from the fact list's reach column;
   from the product when the list has none (the stack skill says where the rule is written); and
   report it as unverifiable when neither can be read.
3. Judge each of the 16 conditions of `references/quality-bar.md`: pass, or a named gap that would
   block or mislead a real reader.
4. Emit one line, `VERDICT: approve` or `VERDICT: revise`, then the findings, most blocking first,
   each with the condition number, the location, and a concrete fix. The report format and the
   calibration rules (no false revise, no false approve, one finding per defect) are in the
   reference.

## The report

Write and Update end with a report the user can check without reading the whole guide:

- **Reader and reach**: who the guide is for, and the role or permission that was taken as theirs.
- **Moved**: what left the reader's reach and which document it went to, or that it has none; what
  entered their reach.
- **Findings about the product**: a control the reader sees that does nothing yet, a message that
  tells the reader to do what they cannot, a place where the product and its own texts disagree.
  They are the user's to decide; the guide does not paper over them.
- **Sweep**: how many places it listed, and what they were settled as.
- **Self-check**: the conditions that needed a fix.
- **Review**: the verdict of the fresh-context review and what it changed.
- **Not done here**: a screenshot that could not be retaken, a fact left as an assumption, a
  conflict with the project's own documentation rules.

## Rules

- **Derive, don't invent.** Every step, label, option and message traces to the fact list. A
  missing fact is an assumption in the guide's open questions, never a plausible step.
- **One reader, within their reach.** Nothing the reader cannot open or do; the request where
  someone else must act; nothing that does not work for them yet.
- **True is not enough.** A sentence earns its place when this reader can act on it or needs it to
  understand what they see. Whether the code confirms it is the second question, not the first.
- **One how-to per goal, no orphans.**
- **The four modes stay apart.** No how-to written as an explanation, no tutorial with branches,
  no reference that instructs.
- **Exact labels, the same way everywhere.** A step that says "click Save" when the button reads
  "Save Config" stops a non-technical reader.
- **The reader's words.** No unexplained term, no technical material in the body.
- **The product as it is.** No history, no future and no inside story in the body; what changed
  lives in the document history.
- **Proportional.** A small product gets a small guide that still covers every goal. Do not pad.
- **Updates are scoped, checked for reach, swept and versioned**, never a silent rewrite and never
  an annotation over what should have been removed.
- **The author never approves their own guide.** The review runs in a fresh context.
