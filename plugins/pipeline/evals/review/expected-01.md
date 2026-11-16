# Answer key — review / fixture-01 (acme-desk, "a plan without a deadline, and an HTML export")

Five seeded defects, one of each kind the review exists to catch, and three decoys. Lines are those
of the changed tree (the checkout after `git apply`). Members are named as the workflow names them:
`lens-a`, `lens-b`, `lens-c`, `builtin` (or `builtin-session` when the session ran the built-in
pass itself), `mechanical`. Severities are the ones the fixture's `REVIEW.md` §What Important
means here gives.

## Expected class

**L.** Deciding path: `desk/export.py`, a new module that prints customer text (the subject, the
author and every message body) into an HTML page that the team mails, which is a security path
under the review's generic rule ("HTML or mail that prints user text"). `desk/ticket.py` decides it
too: the change gives `sla_hours == 0` a new meaning that other code reads, in the domain model.
A run that prints either path as deciding counts as right; a run that chose M or S is recorded as
such, and its lens C did not run.

## Seeded defects

| ID | Seeded defect | Where (a finding counts within these lines) | Member expected | Expected severity |
|----|---------------|---------------------------------------------|-----------------|-------------------|
| D1 | **A reader outside the diff keeps the old meaning.** The change makes `sla_hours == 0` mean "no deadline" (the `community` plan) and teaches `is_overdue()` about it, but `needs_escalation()`, in a file the change does not touch, still reads `due_at(ticket) - now <= 2`. `due_at()` of a no-deadline ticket is its opening hour, so every open community ticket pages the on-call team from the hour it opens, and keeps paging for as long as it is open. | `desk/escalation.py:11-13` (also counts at `desk/sla.py:8-10`, `due_at()`, when the finding names escalation as the reader that goes wrong) | `lens-a` | Important ("a ticket escalated in the wrong state") |
| D2 | **A docstring claims what no line enforces.** "A negative `sla_hours` is refused when the ticket is built." `Ticket` is a plain `@dataclass` with no `__post_init__`; neither the constructor nor `open_ticket()` checks the value, and `has_deadline()` (`desk/sla.py:15`) quietly reads a negative value as "no deadline". | `desk/ticket.py:28-29` (also counts at `desk/ticket.py:24-40` or `desk/sla.py:13-15` when it names the claim) | `lens-b` | Important ("a claim no code enforces") |
| D3 | **A test stays green when the behaviour it names breaks.** `test_a_ticket_without_a_deadline_is_never_overdue` checks `is_overdue()` at `now=10` on a ticket opened at 10. With the `has_deadline()` branch removed, the old rule gives `10 > 10 + 0`, which is false, so the test still passes. Only a `now` past the opening hour pins the new branch. | `tests/test_sla.py:27-29` | `lens-b` | Important ("a test that pins nothing") |
| D4 | **Escaping undone by a later transformation.** The message body is escaped and then passed through `tidy_entities()`, which is `html.unescape()`: `html.unescape(html.escape(x)) == x`. A body of `<script>…</script>` reaches the page, and the mail, as markup. The subject and the author are escaped correctly, and `test_the_subject_is_escaped` covers only the subject. | `desk/export.py:25` (also counts at `desk/markup.py:13-16` when it names the body's path to the page) | `lens-c` | Critical ("customer text reaches a page unescaped") |
| D5 | **A second rule beside an existing one.** `open_tickets()` decides "is it open" as `status != "closed"`, while `Ticket.is_open()` (`desk/ticket.py:42-44`) answers `status in {"new", "open"}`. A `resolved` ticket is not open for the ticket but is listed as open on the index. This also breaks the fixture's own rule "One question, one answer". | `desk/export.py:35-37` | `lens-a` | Important ("a ticket listed in the wrong state", and a rule of `CLAUDE.md` broken) |

Another member may raise the same defect too; `builtin` and `lens-b` are likely on D4, and `lens-b`
on D5 through the rule in `CLAUDE.md`. The result then holds one finding with the others under
`duplicates`, and it counts once. The member column is the one expected to raise it. A flaw raised
only by another member still counts as found; record which member raised it.

## Decoys

| ID | Where | Why it is not a defect | A finding there means |
|----|-------|------------------------|-----------------------|
| X1 | `desk/export.py:12-17`, read at `:22` | `STATUS_BADGES` is a switch-like table, but it maps a status to a value (a label and a CSS class) and chooses no behaviour. The fixture's `CLAUDE.md` names a value-to-value dict as fine. | The member matched "dispatch on a status" by its shape without reading what the table returns. |
| X2 | `desk/export.py:49-51` | `export_filename()` builds a file name from a string that looks like raw input. Its only caller, `export_command()` (`desk/cli.py:20-21`), refuses anything but `[1-9][0-9]{0,8}` with `fullmatch`, and `[0-9]` matches only ASCII digits. `tests/test_cli.py:21-24` shows `../../etc/passwd`, `07`, `-7` and a full-width digit refused. Nothing in the tree writes the file. | The member reported a path built from input without reading the caller or the test. A finding is real only if it names a caller that passes an unchecked value, and there is none. |
| X3 | `desk/export.py:10` | `"TODO: tickets waiting on the team"` is the index page's heading, a string the page prints for the team. It is user text, not a comment. The fixture's rule forbids TODO *comments* (deferred work), and this is neither. | The member, or a recipe, matched the word without reading that it is a string literal the page shows. |

## Real extras (not noise)

The fixture is imperfect on purpose. These are true, and finding them is no false positive:
- `STATUS_BADGES[ticket.status]` raises `KeyError` for a status outside the four, since `Ticket`
  does not check its status (Minor). This is about the lookup's input, not X1's shape, so it does
  not trip X1.
- No test of the index includes a `resolved` ticket. This is D5's test gap: it counts toward D5 when
  it names `resolved`, otherwise it is a real extra.
- `test_an_entity_pasted_from_a_mail_reads_as_typed` pins the double decoding that D4 is. A finding
  that names the unescape through this test counts as D4.
- `export_command()` exports any ticket by id and does not know who is asking. It is a staff
  command, and no customer-facing caller exists in the tree, so this is a judgement call: real if
  argued as a missing guard for a future caller, Minor at most.

Findings outside the seeded set, the decoys and these extras are judged one by one, real or
hallucinated. A finding that cites a file or line that does not exist is a defect of the run.

## Scoring — all of it from `eval-result.json`

`eval-result.json` is the workflow's own result, before triage (`review-workflow.json`, copied).
The score is what the workflow and its verifiers decided; what the session's triage made of it
afterwards is not scored here.

- **Found: N/5.** A flaw counts when `findings` holds it with `verdict` `confirmed` or `plausible`
  and its `file:line` within the key's *Where* lines, in any wording. A flaw held only in
  `unverified` is **found-unverified**; it is scored apart and named, with its `reason` (one whose
  reason is `member reviewed another tree: <member>` is also recorded under the another-tree rule,
  below). A flaw held only as another finding's `duplicates` entry counts with that finding.
- **Severity:** each found flaw's `severity` against the key (D4 Critical, the rest Important).
- **Decoys left alone: N/3.** A decoy is tripped when `findings` holds it. In `refuted` it is left
  alone (and a verifier save, below); in `unverified` it is neither tripped nor saved, and named;
  in a member's `cleared` list only (under `members`) it is left alone by that member, and named.
- **Verifier accuracy:**
  - each seeded flaw in `refuted` is a **verifier miss**, named with the member its `found_by`
    gives and the verdict (`refuted` or `not_in_tree`);
  - each decoy in `refuted` is a **verifier save**, named with its member;
  - a seeded flaw held only in `discarded` is a **loss to the another-tree rule**, named with the
    member and the discard's reason. Only a run's `not_in_tree` entries go there, so the verifier
    found no such file or line for it: record whether the citation or the verdict was wrong. The
    run's other findings wait in `unverified`, and each seeded flaw among them is named with the
    member that cited another tree.
- **Record from the run:**
  - the class it chose and the paths it printed;
  - `members` with each one's model, effort and status;
  - `budget.used` against `budget.max_agents`, with `over_by` and `batched`;
  - the wall time, from `run.json`;
  - the session's context before and after the Workflow call, from the transcript (README);
  - whether the built-in pass ran as the `builtin` member, was `unavailable`, or ran in the
    session as `builtin-session`. After an `unavailable` member, the session's own pass is added
    to the triaged result only, so `eval-result.json` does not hold it: the score stands without
    it, and the flaws it found are named from the report, apart;
  - the mechanical member's `gates` (the gate is expected to pass; a `fail` means the checkout was
    not set up as the README says).

Provisional bar until the first runs calibrate it: **PASS** = class L, at least 4/5 found with D4
among them, at least 2/3 decoys left alone, and no seeded flaw in `refuted`.

## Calibration

Nothing has run yet. No line in `runs.log`; the bar above is a first estimate, set before any
measurement. The first runs show what a workflow review finds on this fixture, which decoys its
members trip, and how often its verifiers save or lose a finding. Revise the bar from those runs,
and say so in the run line that does it, never to make a run pass.
