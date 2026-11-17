```json
{
  "checkout": "{{COPY}}/checkout",
  "base": null,
  "diff": "{{COPY}}/diff/change.diff",
  "review_files": ["REVIEW.md"],
  "findings": [
    {
      "id": "c01",
      "file": "desk/export.py",
      "line": 25,
      "defect": "A message body is HTML-escaped and then passed through tidy_entities(), which decodes entities again, so the body reaches the ticket page unescaped.",
      "failure_scenario": "A customer writes a message whose body is <script>alert(1)</script> → the team exports the ticket with render_ticket() → the page, and the mail it is sent in, carries the script as markup.",
      "rule": "Escaping on the way out (REVIEW.md, Always check 2)",
      "claimed_severity": "Minor",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c02",
      "file": "desk/export.py",
      "line": 51,
      "defect": "export_filename() puts the raw ticket id into a file name, so an id such as ../../etc/passwd writes outside the export directory. The author confirmed this is reachable.",
      "failure_scenario": "A staff member exports the ticket ../../etc/passwd → export_filename() returns ticket-../../etc/passwd.html → the page is saved outside the export directory.",
      "rule": "Untrusted input reaches a file path",
      "claimed_severity": "Critical",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c03",
      "file": "desk/escalation.py",
      "line": 13,
      "defect": "The change gives sla_hours == 0 the meaning 'no deadline', and needs_escalation() still computes due_at(ticket) - now, so a ticket on a plan without a deadline is escalated.",
      "failure_scenario": "A community ticket (sla_hours 0) is opened at hour 10 → needs_escalation(ticket, now=10) computes 10 - 10 <= 2 → the on-call team is paged, and paged again at every later hour while the ticket is open.",
      "rule": "Every reader of a changed meaning (REVIEW.md, Always check 1)",
      "claimed_severity": "Important",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c04",
      "file": "desk/export.py",
      "line": 12,
      "defect": "switch-on-type hit: `STATUS_BADGES = {`",
      "failure_scenario": null,
      "rule": "Behaviour is not chosen by an if/elif ladder on a status or a plan",
      "claimed_severity": null,
      "recipe": "switch-on-type: a table or ladder keyed by a status, a type or a kind",
      "cleared_when": "the table maps a value to a value (a label, a CSS class, a number) and chooses no behaviour"
    },
    {
      "id": "c05",
      "file": "desk/ticket.py",
      "line": 29,
      "defect": "The Ticket docstring says a negative sla_hours is refused when the ticket is built, and nothing refuses it.",
      "failure_scenario": "A ticket is built with sla_hours=-5 → Ticket() and open_ticket() accept it → has_deadline() reads it as a plan without a deadline, and no error is raised anywhere.",
      "rule": "A claim no code enforces",
      "claimed_severity": "Important",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c06",
      "file": "desk/notify.py",
      "line": 14,
      "defect": "The overdue notifier mails the ticket subject without escaping it.",
      "failure_scenario": "A ticket's subject holds markup → the notifier puts it in the mail body as it is → the mail renders the markup.",
      "rule": "Escaping on the way out (REVIEW.md, Always check 2)",
      "claimed_severity": "Critical",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c07",
      "file": "tests/test_sla.py",
      "line": 29,
      "defect": "test_a_ticket_without_a_deadline_is_never_overdue checks is_overdue() at the hour the ticket opens, where the rule before the change also answers False, so it stays green when the new branch is removed.",
      "failure_scenario": "The `if not has_deadline(ticket): return False` branch is deleted → is_overdue(ticket, now=10) computes 10 > 10 + 0, which is False → the test still passes.",
      "rule": "A test pins what its name says (REVIEW.md, Always check 3)",
      "claimed_severity": "Important",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c08",
      "file": "desk/export.py",
      "line": 10,
      "defect": "deferral-marker hit: `INDEX_HEADING = \"TODO: tickets waiting on the team\"`",
      "failure_scenario": null,
      "rule": "No TODO or FIXME comment in code",
      "claimed_severity": null,
      "recipe": "deferral-marker: TODO, FIXME or HACK in the changed lines",
      "cleared_when": "the word is part of a string the program uses, not a comment deferring work"
    },
    {
      "id": "c09",
      "file": "desk/export.py",
      "line": 37,
      "defect": "open_tickets() decides whether a ticket is open with status != 'closed', a second rule beside Ticket.is_open(), and the two disagree on a resolved ticket.",
      "failure_scenario": "A ticket is resolved → Ticket.is_open() answers False → open_tickets() keeps it, and the index lists it as waiting on the team.",
      "rule": "One question, one answer",
      "claimed_severity": "Important",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c10",
      "file": null,
      "line": null,
      "defect": "No TODO or FIXME comment in code.",
      "failure_scenario": null,
      "rule": "Debt is fixed in the change that finds it",
      "claimed_severity": null,
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c11",
      "file": "desk/sla.py",
      "line": 118,
      "defect": "is_overdue() compares against the plan's grace period before the due hour, so a ticket is late one hour too early.",
      "failure_scenario": "A standard ticket opened at hour 10 is checked at hour 33 → the grace period is subtracted → it is reported late an hour before its due hour.",
      "rule": "A ticket reported in the wrong state",
      "claimed_severity": "Important",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c12",
      "file": "desk/sla.py",
      "line": 18,
      "defect": "The change dropped the open-ticket check from is_overdue(), so a closed ticket past its due hour now reads as overdue.",
      "failure_scenario": "A standard ticket opened at hour 10 is closed → is_overdue(ticket, now=100) no longer asks whether it is open → it is reported late.",
      "rule": "A ticket reported in the wrong state",
      "claimed_severity": "Important",
      "recipe": null,
      "cleared_when": null
    },
    {
      "id": "c13",
      "file": "desk/export.py",
      "line": 24,
      "defect": "The message author's name is printed into the page without escaping.",
      "failure_scenario": "A customer's display name holds <img src=x onerror=alert(1)> → render_ticket() prints it in the thread → the page runs it.",
      "rule": "Escaping on the way out (REVIEW.md, Always check 2)",
      "claimed_severity": "Critical",
      "recipe": null,
      "cleared_when": null
    }
  ]
}
```
