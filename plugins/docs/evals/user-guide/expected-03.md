# Answer key — user-guide fixture-03 (Update: a new feature, told by a pull request full of history, mechanism and codes)

"Acme Desk" 1.5 lets a team archive requests. `change.md` is written the way pull requests are:
why the team built it and what it decided against, table columns, routes, permission codes, a
status code, queued and nightly jobs, a staff-only action, and a switch whose e-mail is not sent
yet. Every one of those is true. The guide's reader is the team admin. `verify-03.py` scores the
mechanical rows against the copy; the rows marked *read* are judged from the report and the guides.

| Id | The guide after the update | Why |
|---|---|---|
| F1 | A how-to for archiving requests, with numbered steps and **Archive** | `app/screens/requests.php`; the reader's new goal |
| F2 | A how-to, or steps, for **Bring back** | `requests.unarchive` is `agent` |
| F3 | The limit of 50 is told in the how-to where the reader meets it and at most in the reference entry of its control; outside troubleshooting no third section tells it again | One fact, one place in each part |
| F4 | The body tells no history: no "until now", "no longer" (for a change of the product), "now", "new in" | The reader has the product as it is |
| F5 | No mechanism: no column, soft delete, transaction, queue, job, nightly run, status code | The reader needs the effect: what is deleted and when, how long an export takes |
| F6 | No defence of the design: nothing on why there is no delete button | It answers a reviewer, not the reader |
| F7 | No permission code, route or configuration key | The screen shows labels |
| F8 | **Email me a weekly summary** is not in the guide | The switch is stored and nothing sends the e-mail (`app/jobs.php`, `change.md`) |
| F9 | **Delete for good** is not in the user guide, and is in `docs/operations.md` | `requests.purge` is `staff`; the button is drawn for staff only |
| F10 | The guide says an archived request is deleted after 365 days | An automatic behavior the reader must know before they archive (`app/archive.php`, `requests.archive_note`) |
| F11 | Exporting: a step with **Export archived requests**, the e-mail as the result, and a troubleshooting entry for "There is nothing to export: no request is archived." | `requests.export` is `team_admin`; the two messages |
| F12 | The reference describes **Show** with **Open** and **Archived** | The screen's new control |
| F13 | Version 1.5 and its row in the document history | The row is where the change is told |
| F14 | "What each role can do" gains archiving and exporting, and no row for deleting for good | Reach |
| F15 | Nothing under `app/` changed | |
| D1 | "The invitation is no longer valid. Send a new one." stays | A quoted message; a state |
| D3 | "Formerly **Saved replies** (until version 1.3)" stays | A dated mark inside its window |
| F16 (*read*) | The report tells the user that **Email me a weekly summary** is shown to every member and does nothing yet | A control the reader sees that does not do what its label says is a finding about the product |
| F17 (*read*) | New text is in steps, table rows and short entries, not in paragraphs that hold several ideas | Shape |
| F18 (*read*) | Every bold label is a label of `app/labels.en.php` (`verify-03.py` lists the ones that are not) | Exact labels |

A run **passes** when F1–F15, D1 and D3 hold. F16–F18 are recorded beside the score.
