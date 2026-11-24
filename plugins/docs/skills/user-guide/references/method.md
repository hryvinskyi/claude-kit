# User guide — method in depth

The depth behind `SKILL.md`. Load it before writing the first section; come back to a section here
when you write that part.

## The reader and their reach

A product has several kinds of people around it, and each can reach a different part of it. The
guide is written for one of them. Everything else in this file assumes you know which one, and
what they can reach.

### The fact list carries reach

Every fact is recorded with who can reach it and what that means for this guide's reader:

| Fact | Label | Source | Who can reach it | For this reader |
|---|---|---|---|---|
| The labels list | **Product Labels** | the menu definition, line 12 | a role with **Manage labels** | in reach |
| Remove a label for good | **Delete forever** | the list's actions | the vendor's support staff only | out of reach: the reader sees no such action; the operations guide |
| Show a label for a period | **Active From**, **Active To** | the label form | every role; nothing reads the dates yet | not available: reported to the user |

"Who can reach it" comes from the product, never from a guess: the access rule on the screen, the
permission behind the menu entry, the condition that shows the control. The stack skill says where
each is written. When a running instance is available, sign in as the reader and look.

### The other readers and their documents

| Reader | Typical document |
|---|---|
| The vendor's own staff (support, platform administrators) | The operations part of the technical documentation, or a staff guide |
| An operator who installs and runs the product | The installation guide |
| A developer who integrates with or extends it | The developer guide and the reference |
| An administrator with more access than the reader | An administrator's guide beside the member's guide, or their own group of how-tos |

When you find material for a reader who has no document, the outline says so and proposes one. It
does not go into this guide to wait.

### The request

When the reader needs something only another person can do, the reader's task is to ask for it:

> **Get an access token**
>
> Access tokens are created by the Acme support team.
>
> 1. Choose **Help** > **Contact support** and say which data the token must read.
> 2. The support team sends you the token once. Keep it where you keep your passwords.
>
> Your tokens are listed under **Account** > **Access tokens**. You can revoke one there at any
> time.

A request has: who to ask, by a name the reader can find (a team, a role in their own
organization, a channel); what to ask for; what to have ready; what the reader sees when it is
done; what stays the reader's to do. It has none of the other person's screen, steps, menu path or
permission.

"Ask your administrator" is enough only when the reader's organization has such a person and the
product shows who it is. "Ask whoever runs the installation" names nobody. Find out who this reader
really turns to (the user knows) and name the channel.

### Several kinds of reader in one guide

A guide may serve an administrator and the members of their team. Then:

- One group of how-tos per reader, each named after the reader. Inside a group, "you" is that
  reader.
- A how-to names the permission it needs in its prerequisites, by the label the product shows.
- Neither reader's screen is described to the other. Not "a member without the permission sees the
  list with no button": the member's how-to says what the member does, the administrator's says
  what the administrator does.

### What other people can do in the reader's own space

The vendor's staff may be able to open a customer's account; an administrator may read their team's
work. Whether the guide tells the reader, and in which words, is the product owner's decision. It
is never a by-product of documenting the other person's screen.

- When the owner wants it said: once, as a plain statement of what the reader can expect, in the
  reader's words ("The Acme support team can open your account to help you.").
- Never as the other person's procedure, and never as a description of what is kept from the reader.
- When you meet such material while collecting facts, mark it out of reach and raise it with the
  user. Do not decide it yourself.

### Cases

| What you found | What the guide holds |
|---|---|
| A screen only the vendor's staff can open | Nothing; or the request, when the reader needs its result |
| A setting the reader sees and cannot change | A reference entry saying what it shows, and the request to whoever changes it |
| A menu entry shown only to another role | Nothing: the reader never sees it |
| One step of the reader's task that another person does | The request, in one sentence, inside the reader's how-to |
| A permission the reader can give a colleague | A how-to for the reader ("Let a colleague manage labels") naming the permission by its label |
| A permission or a scope nobody in the reader's organization can hold | Nothing; it is not in the guide's list of permissions |
| A control the reader sees that does nothing yet (the value is stored and nothing reads it) | Reported to the user; never a how-to, never presented as working |
| A product message that tells the reader to do what they cannot | Reported to the user as a finding about the product; the troubleshooting entry gives the request |
| The fix for a failure is on a screen the reader cannot open | The troubleshooting entry gives the request and what to tell the other person |

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
| 5 | Screens and settings | reference | Every screen, setting, option and default the reader can open, in screen order |
| 6 | Troubleshooting and FAQ | how-to, by symptom | What the reader sees, why, and the fix; recurring questions; where to get help |
| 7 | Glossary | reference | Every term the guide defines |
| — | Document history | reference | The guide's own versions; the only place that tells what changed |
| — | Open questions | — | Assumptions and gaps, while the guide is a draft; empty or removed when it ships |

A one-screen product folds 4 into the how-tos, 5 into one table, and 6 into a short list. A product
with several kinds of readers (an admin and a customer) gets one how-to group per reader, each
named after the reader.

A guide published as a site keeps the same parts as pages. A page is one thing: one how-to, one
screen's reference, one idea explained. A page that holds a lesson, the reference, the settings and
the troubleshooting of a whole feature is a guide in one file, and its reader cannot find the task.

## Plain language

The reader is not technical and reads the guide, rather than running it. A sentence they cannot
follow blocks them as surely as a wrong step.

- **Purpose first.** Each section opens with what it is for; each how-to with what the reader gets.
- **Short sentences, everyday words.** Around 20 words on average; active voice; one idea per
  sentence; short paragraphs.
- **Small units.** A bullet holds one idea. A table cell holds a phrase or one sentence. A
  paragraph of more than about 100 words is split, or becomes a list or a table.
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

## The product as it is

The guide describes one state of the product: the one its reader has in front of them, on the
version the guide names. It is not a changelog, a roadmap or a record of how the product was
designed.

- **No history in the body.** "Used to", "no longer", "previously", "until now", "was moved",
  "new in this release", "before this release". A reader who never saw the old screen learns
  nothing from them. A reader who did needs one pointer, not a story. "New in this release" is false
  from the next release on, and nobody comes back to delete it.
- **Where the change is told.** In the document history, as a dated row. In the product's release
  notes, when it has them. In the body, only as one of the two dated marks of §The update, step 6.
- **Words that go stale.** "Now", "new", "newly", "recently", "currently", "at present", "for the
  time being", "this release", "this version", "today", "soon". Write the fact without the clock:
  "The list has two groups", not "The list now has two groups".
- **No future.** Not released, planned, "not yet", "coming": none of it is something the reader can
  do. Write it when it ships.
- **A limit is told where the reader meets it, with the way round it.** "You can add up to 25
  recipients at once. For more, run it again." A list of what the product does not have ("There is
  no editor for…", "It cannot…") is not guide content.
- **A weakness with nothing to do about it is a finding, not a paragraph.** A sentence that only
  says the product is less safe or less reliable than it looks, where the reader can do nothing,
  goes to the user as a finding about the product. When the reader can do something (delete a copy
  by hand, check a figure in another place), the guide gives that step.
- **A state of the reader's own data is not history.** "The invitation is no longer valid" is a
  state the reader sees. "Invitations no longer expire" is history. A message the product shows is
  quoted as shown, whatever its words.
- **A guide does not sell.** No comparison with other products, no other vendor's prices, no
  benchmark claims. They are not the reader's task, they go stale, and nothing in the product keeps
  them true.

## From the reader's side

The guide says what the reader sees and what happens for them. How the product does it, and why
its makers chose that, is another document's subject.

| Written from the inside | Written from the reader's side |
|---|---|
| "The block is enforced centrally for every member, so there is no way to slip past it." | "Nobody in the team can sign in until you switch the account back on." |
| "The export runs as a background job and its result is cached for an hour." | "The export takes a few minutes. You get an e-mail with the file." |
| "The address is refused." | "You see **You do not have access to this page**." |
| "This is deliberate: two switches for one decision would end up disagreeing." | Nothing. The reader did not ask. |

- **Effect, not mechanism.** No check, job, queue, cache, storage, protocol or model. If a delay,
  a limit or an order of events matters to the reader, say the delay, the limit or the order.
- **A reason only when it changes what the reader does.** "Switching it off deletes nothing, so you
  can switch it back on later" earns its place. "We built it this way because…" does not.
- **No defence of the design.** "This is deliberate", "on purpose", "by design", "this is not a
  limitation", "rather than…" answer a reviewer, not the reader. The record of why a thing was built
  so belongs with the code's history and the team's notes.
- **Identifiers only as the screen shows them.** A code the reader's screen shows beside a label
  may follow the label once. A code the screen never shows is not in the guide.
- **One name for the reader, one for the product.** Not "operator" on one page and "member" on the
  next. The product is called by its current name everywhere; a renamed product is swept like a
  renamed label.
- **Examples are the reader's own.** Example names, shops and addresses are invented and neutral,
  or the reader's ("your site"). Never the vendor's demo system, which the reader does not have.
- **One fact, one place in each part.** A limit, a rule or a warning is told in the how-to where
  the reader meets it, listed with its control in the reference, and named in troubleshooting under
  its message. Nowhere else: a second how-to, the start-here page and the explanation link to it. A
  fact retold in five paragraphs is five places to update, and after the first update four of them
  disagree.

## Exact labels and consistent terms

- Refer to every control by the **exact label** the product shows, in its own case, in bold:
  click **Save Config**, select **Yes** in **Enable Labels**.
- A menu path is the labels joined by ` > `, each in bold: **Stores** > **Settings** >
  **Configuration**.
- The way to a screen is its menu path. An address is given only when the reader has to type,
  paste or share it, and then in full.
- Values the reader types go in code style: in **Label Text**, enter `Sale`. Values they select are
  labels and go in bold.
- One name for one thing, everywhere. If the product calls it a "rule" on one screen and a "label"
  on another, say so once and then follow the screen the reader is on.
- Labels come from the product's translation source or the screen, not from memory or the code's
  variable names. When the guide is written in another language than the product's source, use the
  product's translation for that language, and the source label in brackets on first mention only
  when the reader may see the untranslated one.
- A permission, a role or a plan is named by the label the product shows where the reader grants
  or sees it, never by its code alone.

## Steps

- Numbered, one action per step; split a step that needs "and then".
- Imperative, second person, present tense: "Click **Save**", not "The user should click Save".
- Where first: "In **Label Text**, enter `Sale`" — the place, then the action.
- A result line after a step whose result is not obvious: "The label appears in the grid."
- Prerequisites above the steps, never discovered at step 6.
- Optional steps say so at the start: "Optional: …".
- A step that branches by the reader's situation ("If you sell in several countries…") becomes two
  how-tos or a short table before the steps.
- Every step is the reader's to take. A step another person takes is the request (§The request),
  not a step of theirs written out.

## Screenshots

The best guides combine both: the step names the control in words, and a screenshot shows where it
is. A reader who cannot see the image still has the words.

- One screenshot per screen the reader must find their way around, not one per step.
- **Taken signed in as the guide's reader**, with the role and permissions the guide states, never
  with an account that has more access. An administrator's screenshot in a member's guide shows
  menu entries, buttons and panels the reader does not have. When no such account exists, create
  one, or ask the user for one.
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
  includes images. A picture that cannot be retaken in this update is removed until it can. A
  caption or a note never says that the picture shows an earlier layout.

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

## Sweeps

Run the sweep over the guide before the self-check, in Write and in Update:

```bash
python3 "<skill directory>/scripts/guide_sweep.py" <guide> [<guide> …] --other-reader "<role>" [--other-reader "<role>" …]
```

`<skill directory>` is the directory the Skill tool reports for this skill. Give `--other-reader`
once for every role of the fact list that is not the guide's reader. The sweep lists, with line
numbers: another reader, what other people see, history, words with a clock, what is not available,
a design defended, the inside view, identifiers, pictures the page itself distrusts, and
paragraphs, list items and table cells that hold too much. It leaves out fenced code and the
document history.

A place it lists is a place to read, not a defect by itself: "administrator" is right when the
guide's reader is one, and "no longer" is right in a state of the reader's own data. Settle every
place: fix it, or know why it stands.

Without Python, the same searches by hand:

```bash
# Another reader: put in every role of the fact list that is not the guide's reader
rg -n -i 'administrator|operator|support (team|staff)|developer|whoever (runs|administers|installed)' <guide>
rg -n -i '(does not|cannot|never|only .* can) see|is (told|shown|asked)|everyone else|sees? (the|a) .* instead' <guide>

# History, and words that go stale
rg -n -i 'used to|no longer|previously|formerly|until now|was (moved|renamed|removed)|has been (moved|renamed|removed)' <guide>
rg -n -i '(this|the last|the next) (release|version)|new in|\b(now|newly|recently|currently|at present|for now)\b' <guide>

# Not available
rg -n -i 'not yet|coming|planned|still cannot|not (enforced|switched on|released|supported) yet|there is no .* (for|to)' <guide>

# The inside view, and a design defended
rg -n -i 'deliberate|on purpose|by design|rather than|not a limitation' <guide>
rg -n -i 'server|log file|queue|cache|background job|worker|database|stored in|enforced|is refused|returns' <guide>

# Pictures the page itself distrusts
rg -n -i 'previous layout|predates|out of date|older version of the screen' <guide>
```

Then two sweeps no pattern can do:

- **Reach.** Walk the fact list's rows marked out of reach and not available, and search the guide
  for each one's label. Any hit is a defect, except a request.
- **Repeats.** For each limit, warning and rule the guide states, search for its key words. More
  than one place states it: keep the one where the reader needs it, link from the others.

## The update

A guide goes stale the moment the product changes, and a stale guide is worse than none: the reader
trusts it and gets stuck.

1. **Scope the change unit**: a how-to, a reference entry, a getting-started step, a screenshot, a
   troubleshooting entry, a glossary term, an explanation.
2. **Check reach first**: for each thing the change touches, who can reach it now. What left the
   reader's reach leaves the guide (how-to, reference entry, screenshot, troubleshooting, every
   mention), and what the reader still meets stays as the request. What entered their reach gets its
   goal, how-to and reference entry. Add the changed rows to the fact list with their new reach.
   The most common wrong update is to keep the old steps and write above them who they are for now.
3. **Sweep every part of the guide** for each changed, renamed or removed capability: steps,
   reference entries, screenshots and captions, troubleshooting, glossary, explanation, the start-here
   page. Search for the old label in every language the guide ships in.
4. **Re-check coherence**: the tutorial still runs; the modes are still apart; the reference still
   mirrors the screens; cross-links and glossary still resolve.
5. **Version and history**: bump the guide's own version, add a row (what, when, why). The row tells
   the change; the body tells the product.
6. **Mark, with a date, and only these two**:
   - a renamed label: "Formerly **Old name** (until version 2.3)", once, at the new place, where
     2.3 is the last version that showed the old name;
   - a removed feature the reader may still look for: one line with its replacement, dated the same
     way.

   A mark without a version or a date cannot be removed by anyone later, so it is not written. On
   every update, delete the marks older than the window the user states, or older than one major
   version when none is stated.
7. **Run §Sweeps** over the whole guide, not only over the changed parts: an update is when old
   history, another reader's section and a stale picture are found.

## Language of the guide

Write in the language the user asks for; by default the language of the product's admin or of the
people who will read it. Keep the product's labels in the language the reader's screen shows. A
guide shipped in several languages is one source per language, each swept on every update.
