# Answer key — user-guide fixture-02 (Review: a guide written for the wrong reader)

`docs/user-guide.md` is what a careless update of fixture-01 leaves behind, with further seeded
flaws. The fact list `docs/user-guide.facts.md` is correct and carries reach. Expected verdict:
`VERDICT: revise`.

| Id | Seeded flaw | Where | Condition | Severity |
|---|---|---|---|---|
| R1 | Steps for creating a token, kept under "The steps below are what Acme staff see" | "Get an access token", the numbered steps | 13 | blocking |
| R2 | Tells what other people see: "A member who already holds a token still sees the page… A member with no token does not see the form either" | "Get an access token", second paragraph | 13 | |
| R3 | A row nobody in the team can hold: "Create access tokens — No — No. Acme staff only; no team role can hold it." | "What each role can do" | 13 | |
| R4 | A how-to for a staff screen, "you" being Acme staff | "Close a team (Acme staff)" | 13 | blocking |
| R5 | "Ask whoever runs the installation to look at the server log": nobody the reader can find, and a log they cannot read | "Nobody in the team can sign in" | 13 (6 or 15 accepted) | |
| R6 | A setting the reader cannot see, told as "does not enforce yet. Only Acme staff see and change it" | "Set how long a sign-in lasts", last paragraph | 14 (13 accepted) | blocking |
| R7 | A release note in the body: "New in this release: saved replies are now called templates… Until now…" | "Write a template", the note | 14 | |
| R8 | Mechanism: "the check runs centrally on every page load, so there is no way to slip past it" | "Remove a colleague" | 15 | |
| R9 | A design defended: "This is deliberate: a token shown twice is a token that leaks." | "Get an access token", step 5 | 15 (falls with R1) | |
| R10 | Two places disagree: an invitation "can be accepted for 14 days" and "more than seven days ago"; the code says 7 | "Getting started" against "Troubleshooting" | 4 or 15 | blocking |
| R11 | A caption that says its picture is out of date, on a picture of a form the reader does not have | "Get an access token", the image | 9 or 13 | |

Decoys — a finding on any of these is a false positive:

| Id | Text | Why it stands |
|---|---|---|
| D1 | "The invitation is no longer valid. Send a new one." | A message quoted from the product; a state of the reader's own data |
| D2 | "You need the **Team admin** role." | A prerequisite naming the reader's permission |
| D3 | "Formerly **Saved replies** (until version 1.3)." | A dated mark inside its window |
| D4 | "Access tokens are created by the Acme support team. Write to support@acme.example and say what the token is for." | The request |
| D5 | The 1.4 row of the document history | The place where a change is told |

Real and not seeded — reporting one is correct and is not counted as noise: the last step of
"Write a template" names fields and a save the code does not show; "already used" as a cause of the
expired invitation has no source; "Give another colleague the **Team admin** role" has no control
on the Members screen; the reference has no entry for **Team** > **Members**; troubleshooting does
not end with how to get more help.

Score = seeded flaws found / 11, plus the condition named (the family in the table counts), the
verdict, and the number of decoys reported. A finding that covers two ids (R9 inside R1's steps)
counts for both when it names both defects.
