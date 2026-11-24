# Answer key — user-guide fixture-04 (Write: a guide for another reader of the same product)

"Acme Desk" 1.5 has three kinds of people (`CLAUDE.md`). The team admin has a guide; the agent has
none. The task is the agent's guide, from the code. An agent opens **Inbox** > **Requests**,
**Inbox** > **Templates**, **Account** > **Access tokens** and **Account** > **Notifications**
(`app/access.php`); the team's and the staff's screens are not theirs, and one control they see
does nothing. `verify-04.py` scores the mechanical rows; the rows marked *read* are judged from the
guide, the fact list and the report.

| Id | The guide | Why |
|---|---|---|
| W1 | `docs/agent-guide.md` has a start here, a first lesson, how-tos, a reference, troubleshooting, a glossary and a document history | The parts of a guide |
| W2 | None of the team admin's screens or steps: inviting and removing colleagues, the security settings, the steps of the export. The request to the team admin may name what to ask for | `team_admin` only (`app/access.php`) |
| W3 | Nothing of the staff's: **Delete for good**, **Close team**, creating a token, the hidden two-step setting | `staff` only |
| W4 | **Email me a weekly summary** is not presented: it is not in the guide | The switch is stored and nothing reads it: `app/Mailer.php` sends two e-mails and neither is a summary, `app/jobs.php` runs no such job |
| W5 | The agent's goals in steps: **Archive**, **Bring back**, **Revoke**, **New template** | In reach |
| W6 | The limit of 50 is told in the how-to where the reader meets it and at most in the reference entry of its control; outside troubleshooting no third section tells it again | One fact, one place in each part |
| W7 | An archived request is deleted after 365 days: told | `requests.archive_note` |
| W8 | The request for an access token: the Acme support team, `support@acme.example` | `tokens.none` |
| W9 | No role code, permission code, route or file path | The reader's words |
| W10 | `docs/agent-guide.facts.md` exists, has a column for who can reach each fact, and marks the team admin's and the staff's facts out of reach and the weekly summary not available | The fact list carries reach |
| W11 | Troubleshooting quotes "You can archive up to 50 requests at a time. Select fewer and try again." and ends with who to turn to | The product's messages |
| W12 | No history, mechanism or defence of a design | The product as it is |
| W13 | Nothing under `app/` changed; `docs/user-guide.md` and `docs/operations.md` unchanged | The task is one new guide |
| W14 (*read*) | Every bold label is a label of `app/labels.en.php` (`verify-04.py` lists the ones that are not) | Exact labels |
| W15 (*read*) | The report gives the outline, the reader and their reach, the assumptions, the finding about the weekly summary, and the verdict of a fresh-context review or why none ran | The report |
| W16 (*read*) | Where an agent needs something only the team admin can do (the export), the guide gives the request or leaves it out; it never gives the team admin's steps | The request |

A run **passes** when W1–W13 hold.
