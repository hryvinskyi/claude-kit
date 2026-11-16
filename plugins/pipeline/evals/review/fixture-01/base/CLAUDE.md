# Acme Desk — repo law

A small help-desk library: tickets, their reply deadlines, escalation to the on-call team, and the
HTML pages the team prints or mails. Plain Python 3.9 or newer, standard library only; the package
is `desk/`, its tests are under `tests/`.

## Gate

`python3 -m unittest discover -s tests -t .` from the repository root, green before a push. There
is no linter and no other gate.

## Rules

- **One question, one answer.** A question about a ticket (is it open, when is its first reply
  due, is it late) is answered by one function, and every other module calls that function:
  `Ticket.is_open()` and `desk.sla`. A second rule for the same question is a defect even while it
  agrees with the first.
- **Behaviour is not chosen by an `if`/`elif` ladder on a status or a plan.** A dict that maps a
  value to a value (a label, a CSS class, a number of hours) is a lookup, not behaviour, and is fine.
- **Debt is fixed in the change that finds it.** No TODO or FIXME comment in code.

Before a review, read `REVIEW.md` and apply its items.
