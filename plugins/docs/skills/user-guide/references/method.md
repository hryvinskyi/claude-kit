# User guide — method in depth

The depth behind `SKILL.md`. Load it before writing the first section; come back to a section here
when you write that part.

## Outline

The default outline of a user guide. It is a starting point for the outline you propose to the
user, not a form to fill: collapse what the product does not need, and never add a section with
nothing true to put in it.

| # | Section | Mode | Holds |
|---|---|---|---|
| 1 | Start here | orientation | What the product does for the reader (two sentences), who the guide is for, what they need before starting, and where each kind of reader goes next |
| 2 | Getting started | tutorial | One guaranteed path to the first visible success |
| 3 | How-to guides | how-to | One per goal, grouped by what the reader is trying to do |
| 4 | How it works | explanation | The ideas behind the behavior the reader sees; no steps |
| 5 | Screens and settings | reference | Every screen, setting, option and default the reader meets, in screen order |
| 6 | Troubleshooting and FAQ | how-to, by symptom | What the reader sees, why, and the fix; recurring questions; where to get help |
| 7 | Glossary | reference | Every term the guide defines |
| — | Document history | reference | The guide's own versions |
| — | Open questions | — | Assumptions and gaps, while the guide is a draft; empty or removed when it ships |

A one-screen product folds 4 into the how-tos, 5 into one table, and 6 into a short list. A product
with several kinds of readers (an admin and a customer) gets one how-to group per reader, each
named after the reader.

## Plain language

The reader is not technical and reads the guide, rather than running it. A sentence they cannot
follow blocks them as surely as a wrong step.

- **Purpose first.** Each section opens with what it is for; each how-to with what the reader gets.
- **Short sentences, everyday words.** Around 20 words on average; active voice; one idea per
  sentence; short paragraphs.
- **Define every term on first use**, then collect it in the glossary. Better still, rewrite so the
  term is not needed: "the setting applies to one store only" instead of "the setting has store
  view scope". A term the screen itself shows (a field label) is used as the screen shows it and
  explained once.
- **No technical vocabulary in the body.** No code, commands, file or directory paths,
  configuration codes, database, class, event or API names, no log file names. If the reader must
  hand something to a developer, say so in plain words and link the technical guide.
- **Words to avoid.** "Simply", "just", "easy", "obviously" (they blame the reader who struggles);
  "backend", "frontend", "instance", "entity", "payload", "trigger", "scope" without explanation;
  exclamation marks; emoji.
- **Judge by the reader, not by a score.** A readability score is a hint, not the gate. The gate is
  whether the reader can follow the guide.

## Exact labels and consistent terms

- Refer to every control by the **exact label** the product shows, in its own case, in bold:
  click **Save Config**, select **Yes** in **Enable Labels**.
- A menu path is the labels joined by ` > `, each in bold: **Stores** > **Settings** >
  **Configuration**.
- Values the reader types go in code style: in **Label Text**, enter `Sale`. Values they select are
  labels and go in bold.
- One name for one thing, everywhere. If the product calls it a "rule" on one screen and a "label"
  on another, say so once and then follow the screen the reader is on.
- Labels come from the product's translation source or the screen, not from memory or the code's
  variable names. When the guide is written in another language than the product's source, use the
  product's translation for that language, and the source label in brackets on first mention only
  when the reader may see the untranslated one.

## Steps

- Numbered, one action per step; split a step that needs "and then".
- Imperative, second person, present tense: "Click **Save**", not "The user should click Save".
- Where first: "In **Label Text**, enter `Sale`" — the place, then the action.
- A result line after a step whose result is not obvious: "The label appears in the grid."
- Prerequisites above the steps, never discovered at step 6.
- Optional steps say so at the start: "Optional: …".
- A step that branches by the reader's situation ("If you sell in several countries…") becomes two
  how-tos or a short table before the steps.

## Screenshots

The best guides combine both: the step names the control in words, and a screenshot shows where it
is. A reader who cannot see the image still has the words.

- One screenshot per screen the reader must find their way around, not one per step.
- Taken from a real instance with realistic but invented data. Never a screenshot holding real
  customer data, an e-mail address, an order of a real person, a key or a password: blur a key or a
  token the screen shows, and say so in the caption.
- **Mostly the whole screen**, at one window size for the whole guide (for example 1440 × 900), so
  the reader sees at a glance where the section sits: the menu, the page title, the tabs around it.
  Scroll the part the step needs into view rather than cropping to it. Crop only for a detail too
  small to read on a full screen, and then the caption says where on the page it is.
- The same theme and language as the guide. Hide what another module adds that the reader will not
  have (a button, a column of a module the product does not need); never hide or change anything
  the product itself shows.
- Each image has a caption that says what it shows ("The Product Labels settings, with Enable
  Labels set to Yes"), which is also its alternative text.
- Mark a control on the image only when the screen is crowded; the words still name it.
- Store images beside the guide (`images/`), named after the screen (`labels-settings.png`).
- After an update to the product, every screenshot of a changed screen is retaken. The update sweep
  includes images.

## Accessibility

- Name controls by their label; never by color or position alone.
- Link text names the destination ("see Troubleshooting"), never "click here".
- Headings nest in order, without skipped levels.
- A table has a header row and is not used for layout.
- Every image has a caption that stands in for it.

## Findability

- The start-here section routes every kind of reader in one screen of text.
- How-to titles are the reader's tasks, so the contents page reads as a list of things they can do.
- Troubleshooting entries are titled by the symptom, in the reader's words.
- Cross-links are predictable: a how-to links to the reference entries it uses, a reference entry to
  the how-to that uses it.

## Task-oriented minimalism

Lead with action. Anchor every section in a task the reader really has, and cut what does not serve
one. Mention edge cases where they bite, not up front. An error the reader may hit is a chance to
help them recover: give it a troubleshooting entry instead of a warning in every how-to.

## The update sweep

A guide goes stale the moment the product changes, and a stale guide is worse than none: the reader
trusts it and gets stuck.

1. **Scope the change unit**: a how-to, a reference entry, a getting-started step, a screenshot, a
   troubleshooting entry, a glossary term, an explanation.
2. **Sweep every part of the guide** for each changed, renamed or removed capability: steps,
   reference entries, screenshots and captions, troubleshooting, glossary, explanation, the start-here
   page. Search for the old label in every language the guide ships in.
3. **Re-check coherence**: the tutorial still runs; the modes are still apart; the reference still
   mirrors the screens; cross-links and glossary still resolve.
4. **Version and history**: bump the guide's own version, add a row (what, when, why).
5. **Mark** removed features with their replacement; give a renamed label's old name once.

## Language of the guide

Write in the language the user asks for; by default the language of the product's admin or of the
people who will read it. Keep the product's labels in the language the reader's screen shows. A
guide shipped in several languages is one source per language, each swept on every update.
