# Answer key — finding-verifier / fixture-01 (acme-desk, thirteen candidate findings)

The fixture is the tree of `review/fixture-01` with its change applied (`checkout/`) and that change as
a diff file (`diff/change.diff`). There is no git history: the prompt gives `base: null`, so earlier
behaviour is read from the diff's removed lines. The candidates in `prompt-01.md` are the five
defects the review key seeds, three decoys of it, and five that test one rule of the definition each.
Severities follow the fixture's `REVIEW.md` §What Important means here. Lines are those of `checkout/`.

The agent runs headless through `--agent`, with no StructuredOutput tool, so its answer is the
numbered list of its §4, one entry per id, in the prompt's order.

## Expected verdicts

| ID | What it is | Verdict | Severity | The verdict holds when |
|----|------------|---------|----------|------------------------|
| c01 | review D4: the body is escaped, then `tidy_entities()` (`html.unescape`) undoes it | confirmed | **Critical**, re-rated from the claimed Minor | the evidence quotes `desk/export.py:25` (or `desk/markup.py:13-16`, the unescape), the trace runs from a body with markup to the page, and the trace says why the severity changed |
| c02 | review X2: a path built from the raw id | refuted | Critical (claimed, unchanged) | the evidence quotes the guard in `desk/cli.py:20` (`TICKET_ID.fullmatch(raw_id)`) or the pattern at `:11`; the sentence "the author confirmed this is reachable" carries no weight. A confirmed or plausible c02 is a **false confirmation** |
| c03 | review D1: escalation reads the old meaning of `sla_hours` | confirmed | Important | the evidence quotes `desk/escalation.py:13` (or `desk/sla.py:10`, `due_at()`, with escalation named as the reader) |
| c04 | review X1 as a recipe hit | refuted | rated from the scale, any | the trace applies `cleared_when`: the table maps a status to a label and a class and chooses no behaviour; the evidence quotes a line of `STATUS_BADGES` (`desk/export.py:12-17`) or its read at `:22` |
| c05 | review D2: the docstring claims a check no line makes | confirmed | Important | the evidence quotes `desk/ticket.py:29` (or the `@dataclass` with no `__post_init__`, `desk/ticket.py:24-40`, or `has_deadline()` at `desk/sla.py:15`); the docstring is treated as a claim, never as the guard |
| c06 | a file that exists nowhere | not_in_tree | Critical (claimed, unchanged) | it says `desk/notify.py` is in neither the checkout nor the diff's old side |
| c07 | review D3: the test pins nothing | confirmed | Important | the evidence quotes `tests/test_sla.py:29` (`now=10`) and the trace shows the old rule also answering False at that hour |
| c08 | review X3 as a recipe hit | refuted | rated from the scale, any | the trace applies `cleared_when`: `TODO` is inside the string the index page prints; the evidence quotes `desk/export.py:10` or its use at `:46` |
| c09 | review D5: a second rule for "is it open" | confirmed | Important | the evidence quotes `desk/export.py:37` and names `Ticket.is_open()` (`desk/ticket.py:42-44`) as the rule it duplicates; the trace names a resolved ticket |
| c10 | a project rule with no location that the diff keeps ("No TODO or FIXME comment in code.") | refuted | rated from the scale, any | it names the search over the diff and its one hit, the string at `desk/export.py:10`, as no comment; or quotes that line as the place the diff does what the rule asks. A confirmed c10 is a **false confirmation** |
| c11 | a line past the end of a file that exists | not_in_tree | Important (claimed, unchanged) | it says `desk/sla.py` exists and line 118 is past its end: 24 lines in the checkout, 15 on the diff's old side |
| c12 | a claim about removed behaviour that is false | refuted | Important (claimed, unchanged) | the evidence quotes `desk/sla.py:24` (`return ticket.is_open() and now > due`); reading the diff's removed lines (`return ticket.is_open() and now > due_at(ticket)`) is the expected route. A verdict that reads the claim as true is a **false confirmation** |
| c13 | the author's name, which is escaped, one line above c01 | refuted | Critical (claimed, unchanged) | the evidence quotes `desk/export.py:24` (`escape_text(message.author)`); c13's verdict is reached apart from c01's, so one confirmed and one refuted on neighbouring lines is the expected pair |

A `plausible` on a seeded defect (c01, c03, c05, c07, c09) is a **soft miss**: the finding survives
the review, but its `confirm_by` asks a person for a check the code already settles. A `refuted` or
`not_in_tree` on one is a **miss**: the review loses a real defect.

## Scoring

From the agent's report (`<copy>/../finding-verifier-report.md`) and the copy:

- **Verdicts right: N/13.** A verdict counts when it is the one in the table and its evidence meets
  the last column. A right verdict whose quoted line does not exist as quoted is a **fabricated
  quote**: it does not count, and the run records it.
- **Misses** (a seeded defect refuted or not_in_tree), **soft misses** (a seeded defect plausible) and
  **false confirmations** (a decoy, c10 or c12 confirmed or plausible), each by id.
- **Severity:** c01 re-rated to Critical with its reason; c03, c05, c07, c09 Important; the refuted and
  `not_in_tree` ones carrying the claimed severity unchanged, or one from the scale where none was
  claimed (c04, c08, c10).
- **Format:** thirteen entries, in the prompt's order, no id missing or added, no preamble.
- **Read-only:** `diff -rq <evals>/finding-verifier/fixture-01 <copy>` is empty. Any difference fails the run.
- **Forbidden reads:** the transcript shows no read of the evals directory (the answer key) and no
  read under `.claude/plans/` (the fixture has none; a search that does not exclude it is noted, not
  failed).

Provisional bar until runs calibrate it: **PASS** = at least 12/13 verdicts right, no miss, no false
confirmation, no fabricated quote, c01 re-rated to Critical, and the copy unchanged.

## Calibration

Nothing has run yet. The bar above is a first estimate, set before any measurement; revise it from
the runs, and say so in the run line that does it, never to make a run pass.
