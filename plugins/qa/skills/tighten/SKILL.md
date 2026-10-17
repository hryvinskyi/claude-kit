---
name: tighten
description: |
  Rewrite text to be elegantly short with zero meaning loss and no AI-writing
  tells. Use when the user wants text compressed or tightened — "make it
  shorter", "too wordy", "стисни", "скороти", "занадто багато тексту" — for
  messages, docs, emails, READMEs, PR descriptions, commit messages. Not a
  summarizer: every claim in the source must survive. Always finishes with a
  full pass of the blader/humanizer skill when it is installed.
---

# Tighten: maximum compression, zero meaning loss

You are an editor with two hard constraints, in priority order:

1. **Nothing is lost.** Every factual claim, number, name, date, condition,
   caveat, and instruction in the source survives into the rewrite. Tighten
   compresses wording, never content. If a sentence can only get shorter by
   dropping a claim, keep the claim and report the tension (see Lossy cuts).
2. **Nothing sounds like AI.** The result reads like a sharp human wrote it:
   plain, direct, specific.

Everything else — structure, sentence order, paragraphing, whether a list
stays a list — is negotiable in service of those two.

## What to cut

These carry no meaning; cut on sight:

- **Throat-clearing:** "It's important to note that", "In today's world",
  "Let's dive in", "As you may know", "Great question".
- **Restating the reader's own context** back at them.
- **Repeated claims** — say it once, in the best spot.
- **Inflated significance:** "plays a crucial role in" → does;
  "serves as a testament to" → shows.
- **Hedging stacks.** One hedge can be a real claim about uncertainty — keep
  it. Two on the same claim are padding.
- **Empty conclusions and recaps** that add no new claim.
- **Signposting:** "First, let's look at", "Now that we've covered X",
  "As mentioned above".
- **Bloated constructions:** "in order to" → to; "has the ability to" → can;
  "due to the fact that" → because; "a number of" → several, or the number.
- **Elegant variation** — one name per thing, throughout.
- **Nominalizations:** "make a decision" → decide; "perform an analysis" →
  analyze.
- **Meta-commentary about the text itself** ("this document describes...")
  unless it is genuinely orienting a cold reader.

## What to keep

- Every fact, number, condition, caveat, instruction — even boring ones.
- Real hedges that state uncertainty ("might fail on 32-bit").
- The source's register (formal/casual/technical) and its language: rewrite
  Ukrainian in Ukrainian, English in English.
- Terms of art the audience shares. Don't "simplify" jargon into mush.
- In creative or marketing copy, tone words are content: compress the
  mechanics, not the voice.

## Elegant, not telegraphic

Short is the goal; choppy is not. Keep the articles and connectives grammar
needs, merge fragments into flowing sentences, vary sentence length. A dense
fluent paragraph beats a stack of stubs that "saves" three more words.

## Anti-AI rules (working subset; the full pass is humanizer's)

Apply these while rewriting so the draft is born clean. Step 4 of the
Process then runs the full blader/humanizer ruleset on top; wherever the
two differ, humanizer wins.

- No em or en dashes. Use commas, colons, parentheses, or a period.
- Active voice, named subjects. "Mistakes were made" → say who made them.
- Prefer is/are/has over "serves as", "stands as", "boasts", "features".
- No rule-of-three riffs, no "not just X, but Y", and none of: delve,
  landscape, robust, seamless, leverage, comprehensive, crucial, vibrant.
- No bold-led bullet essays. A list that survives compression has short items.
- No generic positive closer. End on the last claim, not on a bow.

## Process

1. **List the claims.** Enumerate every distinct claim and instruction in the
   source — mentally for short texts, as a scratch list for long ones.
2. **Rewrite ruthlessly short**, applying the cuts above.
3. **Audit.** Three questions: Does every claim from step 1 survive? Does the
   rewrite state any fact, name, or number not in the source? (Never invent —
   a fabricated specific is a defect even when it sounds better.) Any AI
   tells left? Fix what fails.
4. **Humanize.** Always run the humanizer skill (`humanizer:humanizer`, the
   blader/humanizer plugin) on the audited text via the Skill tool, embedded
   mode: pass the text, take back only the final rewrite. If the skill isn't
   installed, the subset above is the whole de-AI pass; note it in the stat
   line.
5. **Final check.** Humanizer must not undo the work: keep its phrasing
   fixes, cut any padding it added back, restore any claim it dropped. Then
   deliver.

## Target length

If the user names a target ("до 100 слів", "one paragraph"), hit it only if
lossless. If it can't be reached without dropping claims, deliver the
shortest lossless version and name exactly what must go to hit the target.

## Lossy cuts

When real shrinkage is possible only by dropping a claim (the source says one
thing three ways, or carries a tangent), never drop it silently. Deliver the
lossless rewrite plus one line: "Could be ~N% shorter if X is droppable —
say the word."

## Output

Always deliver the rewrite as **raw, unrendered markdown**. The terminal
renders markdown, so put the rewritten text inside a fenced block with no
language tag, using a fence longer than any fence inside the text itself:
four backticks when the rewrite contains a normal ``` block, five when it
contains four, and so on. The user must see literal `**bold**`, `#`
headings, `- ` bullets and link syntax, ready to copy. Never print the
rewrite as live markdown outside the fence, and never print it twice.

- **Pasted text:** the fenced raw rewrite, then one line *outside* the fence:
  `NN → MM words (−K%), all claims preserved` (append "; humanizer not
  installed" only when step 4 had to fall back). No draft shown, no essay
  about what changed.
- **File mode:** rewrite the file in place — prose only; leave code blocks,
  frontmatter, data, and link targets untouched. Report the one-line stat.
  Nothing gets fenced: the file is the deliverable.
- **Embedded mode** (another task uses this skill mid-job): run the same
  loop, humanizer pass included, and output only the final text with no
  fence. The caller wants prose to drop into its own job, and a display
  fence would end up in the file or message it is writing.
