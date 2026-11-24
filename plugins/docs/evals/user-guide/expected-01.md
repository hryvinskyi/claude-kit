# Answer key — user-guide fixture-01 (Update: a change that narrows who may do something)

The product is "Acme Desk". The change (`change.md`, `change.diff`) does three things: creating an
access token becomes a staff action, an unfinished setting is hidden from team admins, and a screen
is renamed. The guide's reader is the team admin. `verify-01.py` scores the mechanical checks
against the copy; the two marked *read* are judged from the report and the guides.

| Id | The guide after the update | Why it is the only right outcome |
|---|---|---|
| U1 | `docs/user-guide.md` holds no step of creating a token: no **Create token**, no choice of **Expires** | `app/access.php`: `tokens.create` is `staff`; the form is not drawn for the reader (`app/screens/tokens.php:12`) |
| U2 | It gives the request instead: the Acme support team, `support@acme.example`, what to say; and it keeps "Revoke an access token" | `tokens.none` in `app/labels.en.php`; `tokens.revoke` is `agent` |
| U3 | It does not tell what other roles see, and does not hand the reader staff's steps under a note ("the steps below are what Acme staff see", "a member with no token does not see…") | The reader's guide holds the reader's reach |
| U4 | Its body does not mention **Require two-step sign-in**: no how-to, no reference row. The history row may say the setting left the guide; nowhere does the guide say it is not enforced | The control is not drawn for the reader (`app/screens/security.php:18`) and nothing enforces it |
| U5 | **Templates** and **New template** everywhere; the old name at most once, as a mark that carries the version or the date | `app/labels.en.php`; a mark without a date can never be removed |
| U6 | The body tells no history: no "now", "no longer", "used to", "renamed", "new in" outside the document history and the one mark. The message **The invitation is no longer valid. Send a new one.** stays (decoy D1), and "The colleague can no longer sign in to your team" is not history either | Both are states of the reader's own data; the first is quoted from the product |
| U7 | "What each role can do" has no row for creating tokens and no column or note for Acme staff | Nobody in the reader's team can hold it |
| U8 | The picture of the create form is gone from the user guide; no caption says a picture is out of date | It shows a form the reader does not have, and this checkout cannot retake it |
| U9 | The guide's version is 1.4 and the document history has a row for it | The row is where the change is told |
| U10 | `docs/operations.md` gains the staff's recipe for creating a token | The material that left the reader's guide goes to the document of whoever holds it now |
| U11 | Nothing under `app/` changed | A documentation update edits documents |
| D2 | "You need the **Team admin** role." stays in the how-tos that keep it (decoy) | A prerequisite naming the reader's permission is not another reader's material |
| U12 (*read*) | `docs/operations.md` does not present **Require two-step sign-in** as working | Nothing enforces it |
| U13 (*read*) | The report names what moved to `docs/operations.md` and that the picture was removed because it could not be retaken | The user must be able to see the move |

A run **passes** when U1–U11 and D1–D2 hold. U12 and U13 are recorded beside the score.

Wrong outcomes this fixture exists to catch, each seen in a real project: the create steps kept
under a note saying who they are for now; a paragraph on what a member with and without a token
sees; "not enforced yet" told to the customer; "saved replies are now called templates" in the
body; a role table that grows a row nobody in the team can hold.
