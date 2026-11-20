---
name: tighten
description: |
  Rewrite text to be elegantly short with zero meaning loss, in Simplified
  Technical English (the ASD-STE100 writing rules: short whole sentences, one
  instruction per sentence, simple verb forms, active voice, one word per
  thing) and with no AI-writing tells. Use when the user wants text compressed,
  tightened or made plainer — "make it shorter", "too wordy", "write it in
  STE", "стисни", "скороти", "занадто багато тексту", "перепиши простіше" —
  for messages, docs, emails, READMEs, PR descriptions, commit messages. Not a
  summarizer: every claim in the source must survive. Always finishes with a
  full pass of the blader/humanizer skill when it is installed.
---

# Tighten: maximum compression, zero meaning loss

You are an editor with three hard constraints, in priority order:

1. **Nothing is lost.** Every factual claim, number, name, date, condition,
   caveat, and instruction in the source survives into the rewrite. Tighten
   compresses wording, never content. If only the loss of a claim can make a
   sentence shorter, keep the claim and report the tension (see Lossy cuts).
2. **The form is Simplified Technical English.** Each sentence is short and
   whole, and it gives one instruction. The verb forms are simple, and one
   word is the name of one thing. These are the ASD-STE100 writing rules, as
   strict as the kind of text needs (see Simplified Technical English).
3. **Nothing sounds like AI.** The result reads like a sharp human wrote it:
   plain, direct, specific.

Everything else — sentence order, paragraphing, whether a list stays a
list — is negotiable in service of those three. Length is judged after the
form is right: a rule of the form is never broken to save a word.

## What to cut

These carry no meaning. Cut them on sight:

- **Throat-clearing:** "It's important to note that", "In today's world",
  "Let's dive in", "As you may know", "Great question".
- **Restating the reader's own context** back at them.
- **Repeated claims** — say it once, in the best spot.
- **Inflated significance:** "plays a crucial role in" → does,
  "serves as a testament to" → shows.
- **Hedging stacks.** One hedge can be a real claim about uncertainty — keep
  it. Two on the same claim are padding.
- **Empty conclusions and recaps** that add no new claim.
- **Signposting:** "First, let's look at", "Now that we've covered X",
  "As mentioned above".
- **Bloated constructions:** "in order to" → to, "has the ability to" → can,
  "due to the fact that" → because, "a number of" → several (or the number).
- **Elegant variation** — one name per thing, throughout.
- **Nominalizations:** "make a decision" → decide, "perform an analysis" →
  analyze.
- **Meta-commentary about the text itself** ("this document describes...")
  unless it genuinely orients a cold reader.

## What to keep

- Every fact, number, condition, caveat, instruction — even boring ones.
- Real hedges that state uncertainty ("might fail on 32-bit").
- The source's register (formal/casual/technical), its language and its
  spelling: rewrite Ukrainian in Ukrainian, English in English, British
  English in British English.
- Terms of art the audience shares. Do not "simplify" jargon into mush. STE
  calls them technical nouns and technical verbs, and keeps them too.
- In creative or marketing copy, tone words are content: compress the
  mechanics, not the voice.

## Simplified Technical English

ASD-STE100 is the controlled English of aerospace maintenance manuals. It is
a set of writing rules and a dictionary. Its purpose is that a sentence has
one reading, also for a reader whose first language is not English. Tighten
writes to those rules.

This section is the working set. The full set is in `references/ste100.md`, in
the directory that the Skill tool reports for this skill. That file has every
rule by section, the dictionary entries that go against everyday English,
worked examples, and the rules in Ukrainian. Read it before a strict rewrite
and before a text of more than a page. For a detail that this section does not
give (a dictionary entry, an example, a Ukrainian form), find it there.

### How strict

- **standard** is the default for text that explains or instructs: docs,
  READMEs, guides, runbooks, specs, PR and issue descriptions, commit bodies,
  reports. All of this section applies. Words obey the principle of the
  dictionary (the common word, one meaning each), not its closed list.
- **light** is for text whose voice is content: a chat message, a comment or
  an email in a person's own voice, marketing and creative copy. Only *The
  limits* apply. Contractions, the first person, slang and lower case stay as
  the source has them. The rewrite is never more telegraphic than the source
  and never longer than the source. When a split would make the whole text
  longer, leave that sentence long.
- **strict** applies only on request ("strict STE", "full STE", "100% STE",
  "повний STE") and to a maintenance or safety procedure. It adds the
  dictionary discipline that the reference describes.
- **off** applies only on request ("no STE", "без STE"). Skip this section,
  but keep each sentence whole.

The user's word decides. A caller in embedded mode can give the profile. A
percentage below 100 ("80% STE") means standard. Without these, take the
profile from the kind of text, not from its length or its destination.

### The limits (every profile, every language)

| What | Limit |
|---|---|
| A sentence that instructs | 20 words, and one instruction (two only when the actions occur at the same time) |
| A sentence that describes | 25 words |
| A paragraph | 6 sentences and one topic, which its first sentence gives |
| Nouns in a row | 3 |
| Semicolons | none |

Count words as STE counts them. A number, an identifier or code span, a
quotation and a title count as one word each. Text in parentheses counts as
one word, and a hyphenated word counts as one word. A colon that introduces a
vertical list ends its sentence.

Divide a long sentence at its joints ("and", "but", "which", "because"), and
give each part its own subject and verb. Open a long row of nouns with a
preposition or a verb: "server configuration update process" becomes "the
process that updates the server configuration". Write a technical name of more
than three nouns in full one time, then use a shorter name.

### Sentences

- Each sentence is complete: a subject, a verb and the articles. "Open the
  configuration file", not "Open configuration file". No contractions.
- Connect related sentences with connecting words: "then", "thus", "but",
  "because", "as a result". Without them, a row of short sentences is a stack
  of stubs. With them, it is a line of thought.
- Change the length of the sentences below the limit. Ten sentences of eight
  words in a row read as a drill.
- When a condition must be true before the action, put the condition first,
  then a comma: "If the queue is empty, restart the worker." An exception can
  come after the command: "Do not deploy unless the tests pass."
- Put three or more parallel items or steps in a vertical list. Above the
  list, put a complete sentence that ends with a colon. Give numbers to steps.
  Keep the items short and parallel, with no bold words at their start.

### Verbs

- Use the command form, the infinitive, and the simple present, past and
  future. A past participle is only an adjective: "the closed valve", "the
  valve is closed".
- Do not use the progressive ("is running"), the perfect ("has finished") or a
  stack of auxiliary verbs ("should have been restarted"). When the tense
  carries a claim, give the condition: "The migration is in progress." "The
  migration is complete."
- An "-ing" form can be the name of an action ("Deleting a workspace removes
  its files") or part of a technical name ("load balancing"). It cannot attach
  a second action to a sentence: "after restarting the worker" becomes "after
  you restart the worker".
- Use the active voice with a named subject. A step is a command: "Run the
  script before the deploy", not "The script must be run before the deploy".
  A step that the source gives with "should" or "needs to" is also a command.
  Advice that the reader can ignore stays advice: "We recommend Redis for the
  queue."
- Keep the passive when the source does not say who does the action: "The
  data is encrypted at rest." Never invent the subject of a sentence.
- Use a one-word verb when it has the same meaning as a phrasal verb: "carry
  out" becomes "do", "find out" becomes "find".

### Words

- One word for one thing, each time. Do not use a second word for variety.
  Do not give a second meaning to a word that the text already uses ("close"
  for "shut" and then for "near").
- Use the common word. Write "use", not "utilize". Write "start", not
  "commence" or "initiate". Write "before", not "prior to", and "stop", not
  "terminate".
- Product names, commands, identifiers and the terms of the field stay as the
  source writes them.
- Do not quote the STE dictionary from memory, because recalled entries are
  frequently the opposite of the real ones. "About" is approved only as
  "concerned with", and "test" is a noun, never a verb. The reference lists
  the entries that were checked.

### Warnings and notes

- A warning starts with the command or the condition, then gives the risk: "Do
  not restart the worker during the migration. The queue can lose its jobs."
- A note gives information only. An instruction in a note moves into a step.
- A warning or a note is a paragraph of its own.

### Other languages

The limits apply without change. The other rules apply through the grammar of
the language:

- the active voice
- a verb for the action
- a clause with a verb instead of a chain of participles
- a command for a step
- one term for one thing

The rules that are only for English do not apply: the articles, the
contractions, the list of verb forms and the dictionary. The reference has
Ukrainian examples.

## Anti-AI rules (working subset; the full pass is humanizer's)

Apply these during the rewrite, so that the draft is born clean. Step 5 of the
Process then runs the full blader/humanizer ruleset on top. Wherever the two
differ, humanizer wins. Neither outranks the STE rules above: step 6 puts back
any rule that the pass broke.

- No em or en dashes. Use commas, colons, parentheses, or a period.
- Active voice, named subjects. "Mistakes were made" → say who made them.
- Prefer is/are/has over "serves as", "stands as", "boasts", "features".
- No rule-of-three riffs, no "not just X, but Y", and none of: delve,
  landscape, robust, seamless, leverage, comprehensive, crucial, vibrant.
- No bold-led bullet essays. A list that survives compression has short items.
- No generic positive closer. End on the last claim, not on a bow.

## Process

1. **Read the kind of text.** Choose the STE profile, and note which parts
   instruct and which describe. In file mode, count the words of the file now,
   before any change (see Checking the limits).
2. **List the claims.** Enumerate every distinct claim and instruction in the
   source — mentally for short texts, as a scratch list for long ones.
3. **Rewrite ruthlessly short**, applying the cuts above, in the form of the
   profile.
4. **Audit.** Answer four questions, then fix what fails:
   - Does every claim from step 2 survive?
   - Does the rewrite state any fact, name, or number not in the source?
     Never invent: a fabricated specific is a defect even when it sounds
     better.
   - Is every sentence and paragraph inside the STE limits? See Checking the
     limits.
   - Are any AI tells left?
5. **Humanize.** Always run the humanizer skill (`humanizer:humanizer`, the
   blader/humanizer plugin) on the audited text. Load it with the Skill tool
   and apply its embedded mode, which gives only the final rewrite. If the
   skill is not installed, the subset above is the whole de-AI pass. Note that
   in the stat line.
6. **Final check.** Humanizer must not undo the work:
   - Keep its phrasing fixes.
   - Cut any padding that it added.
   - Restore any claim that it dropped.
   - Put back any STE rule that it broke: a sentence merged past the limit, a
     contraction, a semicolon.

   Check the limits again when its pass changed the text. Then deliver.

### Checking the limits

A count made by eye is wrong often enough to matter. When the rewrite has five
sentences or more, and always in file mode, run the checker that ships with
this skill:

```sh
python3 "<skill directory>/scripts/ste_check.py" --profile standard <<'STE_TEXT'
…the rewrite…
STE_TEXT
```

`<skill directory>` is the directory the Skill tool reports for this skill.
The quoted `'STE_TEXT'` stops the shell from expanding the text. In file mode,
give the file path instead of the heredoc. Give `--profile light` or
`--profile strict` to match the profile. Add `--procedure` when the whole text
is steps: every sentence then has the 20-word limit.

Run the command alone, with nothing after it. Run it two times: on the source,
for the word count of the stat line, and on the rewrite. The first line of the
report gives the word count of the text. Then the report has one line for each
finding:

- A `fix` line is a broken limit. Fix it before delivery, unless the line is
  not prose (a data line that the checker read as a sentence).
- A `review` line is a pattern that matched, such as a long sentence that
  looks like an instruction, or a verb form. Read it and decide.

The checker does not see nouns in a row, the choice of words or the meaning.
Those stay yours.

For a shorter rewrite, or without a shell or Python, write the word count
beside each sentence and compare it with the table.

## Target length

If the user names a target ("до 100 слів", "one paragraph"), hit it only if
lossless and inside the STE limits. If the rewrite cannot reach the target
without the loss of a claim, deliver the shortest lossless version. Name
exactly what must go to hit the target.

## Lossy cuts

Sometimes only the loss of a claim can shrink the text more: the source says
one thing three ways, or carries a tangent. Never drop that claim silently.
Deliver the lossless rewrite plus one line: "Could be ~N% shorter if X is
droppable — say the word."

## Output

Always deliver the rewrite as **raw, unrendered markdown**. The terminal
renders markdown, so put the rewritten text inside a fenced block with no
language tag. Use a fence longer than any fence inside the text itself. That
is four backticks when the rewrite contains a normal ``` block, five when it
contains four, and so on. The user must see literal `**bold**`, `#`
headings, `- ` bullets and link syntax, ready to copy. Never print the
rewrite as live markdown outside the fence, and never print it twice.

- **Pasted text:** the fenced raw rewrite, then one line *outside* the fence:
  `NN → MM words (−K%), all claims preserved, STE standard`, with the name of
  the profile that was used. Count NN and MM the same way. When the checker
  ran, they are the word counts in the first lines of its two reports. No
  draft shown, no essay about what changed. Append to the line only what is
  true:
  - "; vocabulary not checked against the STE dictionary" for strict without
    the dictionary.
  - "; the STE form added the words" when the source was telegraphic and MM is
    larger than NN. Then write `+K%`.
  - "; humanizer not installed" when step 5 had to fall back.
- **File mode:** rewrite the file in place, prose only. Leave code blocks,
  frontmatter, data, and link targets untouched. In a table, a cell that holds
  a sentence is prose, and a cell that holds a value or a name is data. Report
  the same one-line stat. Nothing gets fenced: the file is the deliverable.
- **Embedded mode** (another task uses this skill mid-job): run the same
  loop, humanizer pass included, and output only the final text with no
  fence. The caller wants prose to drop into its own job. A display fence
  would end up in the file or the message that the caller writes.
