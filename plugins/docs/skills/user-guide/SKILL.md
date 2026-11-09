---
name: user-guide
description: |
  Write, update or review an end-user guide: the help a non-technical person (a store admin,
  a merchant, an office user, a customer) reads to get things done with a product. A
  getting-started lesson, one how-to per goal, the ideas explained, every setting the user
  sees, troubleshooting by symptom, a glossary. Use for "user guide", "user manual", "help
  article", "how do I…" pages, "інструкція для користувача", "посібник для адміністратора",
  "мануал для користувачів", or when a guide "reads too technical". Steps, labels and
  messages come from the product itself, never invented; a fresh-context review checks the
  guide before it ships. Not for developer, installation or API documentation
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

## Load with

- **The stack skill**, when a stack plugin covers the project: that plugin's docs skill
  (`magento2:magento2-docs` on Magento 2). It says where the framework keeps the screens, labels,
  settings, permissions and messages, which wording the platform's own documentation uses, and the
  front matter of a guide. Without one, apply this skill in the stack's idiom and say so.
- `references/method.md` before the first section is written: the default outline, plain language,
  exact labels, screenshots, accessibility, findability, and the update sweep in depth.
- `references/quality-bar.md` before the self-check and in Review mode: the 12 conditions, their
  pass and gap signals, the overlap guards and the review report.

## Three modes

| Mode | When | Output |
|---|---|---|
| **Write** | No guide exists, or the user asks for a new one | The guide, its fact list, a review verdict, a rendered copy when a renderer is declared |
| **Update** | A guide exists and the product changed, or the user reports a wrong or missing part | A scoped edit with a full staleness sweep and a revision-history row, never a rewrite |
| **Review** | A finished guide is to be judged | `VERDICT: approve` or `VERDICT: revise` with findings; the reviewer never edits the guide |

## Write

### 1. Frame the guide

Settle four things before reading the code in depth. Take each from the request and the project
when they answer it; ask the user only what neither does, and state the rest as assumptions.

- **Reader.** Who opens this guide, what they already know, what they do not (a store admin knows
  the admin; a customer knows only the storefront).
- **Goals.** What the reader wants to get done, in their words, not the product's feature names.
- **Scope.** What is in, and what is deliberately out (installation, other modules, developer work).
- **Document.** One guide, or a set (a getting-started page plus how-tos); its language and the
  version of the product it describes.

### 2. Collect the facts from the product

The guide is derived, never imagined. Before writing, build a **fact list**: every screen, menu
entry, setting, option, default, button, message, permission and automatic behavior the reader
meets, each with **the source it came from** (the file and line, the admin screen, the translation
file) and its **exact label** as the product shows it. The stack skill says where each kind of fact
lives. Read existing documentation for tone and terminology; do not copy it, and do not trust it
over the code.

When a running instance is available, open every screen the guide describes: confirm each label,
note the order of fields as the reader sees them, and take the screenshots the guide will use
(`references/method.md` §Screenshots). A fact the code shows but the screen does not (a hidden
field, a setting shown only in one scope) is written as the reader will meet it.

A fact you cannot find is an **assumption**, listed as such, never a step.

### 3. List the goals — one how-to per goal

Turn the facts into the reader's goals ("show a label on sale products", "let a colleague manage
labels", "find out why a label does not show"). Every goal gets exactly one how-to; every how-to
traces to a goal. A screen or setting that serves no goal goes to the reference, not to a how-to of
its own.

### 4. Propose the outline and wait

Show the user the outline before writing the body: the contents with one line per section, the
goal list, the assumptions, and what is out of scope. Wait for their approval, unless they already
told you to go ahead or to work unattended; then record the outline in your report instead. The
default outline is in `references/method.md` §Outline; collapse what a small product does not need.

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
- **Reference.** Every screen and setting the reader meets, in the order the screen shows them:
  label, what it does in terms of the result, the options, the default, where it applies (for
  example per store view). It describes; it does not instruct.
- **Troubleshooting and FAQ.** Organized by what the reader **sees** ("The label does not appear on
  the product page"), never by the internal cause. Each entry: symptom, likely cause, fix as
  numbered steps, the exact message where there is one. Built from the product's real messages and
  failure paths. End with how to get more help.
- **Glossary.** Every term the guide had to define, in one place.
- **Document history.** The guide's own version and what changed in it, distinct from the
  product's version.

### 6. Hold the language to the reader

Plain language is the core of this skill; `references/method.md` §Plain language has the detail.

- Purpose first, short sentences, everyday words.
- Every term and abbreviation the reader may not know is explained where it first appears and
  collected in the glossary. Prefer rewriting the sentence so no term is needed.
- Name controls by their label, never by color or position alone ("the green button", "on the
  right").
- Link text says where it goes; headings nest in order.
- No code, no file paths, no configuration codes, no class or table names in the body.

### 7. Check, then review in a fresh context

1. Run the 12 conditions of `references/quality-bar.md` against the guide yourself and fix every
   miss.
2. Hand the guide to a **fresh agent** that did not write it: a general-purpose subagent with the
   guide, the fact list and the instruction to load this skill in **Review mode** (and the stack
   skill). The author's context believes its own conclusions; the reviewer's does not.
3. Fix every confirmed finding, and answer the wrong ones with the fact that shows it. One review
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
2. **Sweep for staleness** across every part of the guide: for each changed, renamed or removed
   label, setting, screen or behavior, find every place that mentions it (steps, reference,
   screenshots and their captions, troubleshooting, glossary, explanation) and make each match the
   product now. A step that still describes a removed or renamed thing is the worst defect a guide
   can have.
3. **Re-check coherence**: the tutorial still runs end to end; the reference still mirrors the
   screens; links and glossary still hold.
4. **Version**: bump the guide's own version and add a history row (what changed, when, why).
5. **Mark** a removed feature's how-to as removed with its replacement; give a renamed setting's
   old name once, for readers who search for it.

Then review the changed parts in a fresh context, as in Write step 7.

## Review

Run in a context that did not write the guide. Judge, never edit.

1. Read the whole guide as its reader would, then the fact list (or the product itself when no
   fact list came with it).
2. Judge each of the 12 conditions of `references/quality-bar.md`: pass, or a named gap that would
   block or mislead a real reader.
3. Emit one line, `VERDICT: approve` or `VERDICT: revise`, then the findings, most blocking first,
   each with the condition number, the location, and a concrete fix. The report format and the
   calibration rules (no false revise, no false approve, one finding per defect) are in the
   reference.

## Rules

- **Derive, don't invent.** Every step, label, option and message traces to the fact list. A
  missing fact is an assumption in the guide's open questions, never a plausible step.
- **One how-to per goal, no orphans.**
- **The four modes stay apart.** No how-to written as an explanation, no tutorial with branches,
  no reference that instructs.
- **Exact labels, the same way everywhere.** A step that says "click Save" when the button reads
  "Save Config" stops a non-technical reader.
- **The reader's words.** No unexplained term, no technical material in the body.
- **Proportional.** A small product gets a small guide that still covers every goal. Do not pad.
- **Updates are scoped, swept and versioned**, never a silent rewrite.
- **The author never approves their own guide.** The review runs in a fresh context.
