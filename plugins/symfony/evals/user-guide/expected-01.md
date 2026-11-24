# Answer key — user-guide on Symfony, fixture-01 (Review: reach as a Symfony application writes it down)

"Acme Notes" is a Symfony-shaped project with no `vendor/`: the reviewer reads the files. The guide
is for the workspace admin (`ROLE_ADMIN`, which includes `ROLE_MEMBER`). No fact list comes with it,
so who may open what has to be read where Symfony writes it: `access_control`, the role hierarchy,
`#[IsGranted]`, a voter, `is_granted()` in Twig, `switch_user`. Expected verdict: `VERDICT: revise`.

| Id | Seeded flaw | What the code says | Condition | Severity |
|---|---|---|---|---|
| S1 | "Export your workspace's data": a how-to for a staff screen | `#[IsGranted('ROLE_STAFF')]` on the class `ExportController`; the menu entry is inside `is_granted('ROLE_STAFF')` in `templates/base.html.twig` | 13 | blocking |
| S2 | "See your invoices": the path is under `/admin`, which an admin opens, but a rule above it closes it | `access_control`: `^/admin/billing` needs `ROLE_STAFF` and stands before `^/admin`; the first match decides | 13 | blocking |
| S3 | "See the product as a member sees it": a control that is not drawn for the reader, on a page they do open | `is_granted('ROLE_STAFF')` around the link in `templates/admin/members.html.twig`; `switch_user: { role: ROLE_STAFF }` | 13 | blocking |
| S4 | "Correct a member's note": the admin cannot edit another member's note | `NoteVoter`: the author, or Acme staff; the link is drawn only inside `is_granted('NOTE_EDIT', note)`. The guide's own troubleshooting entry says the same | 4 or 13 | blocking |
| S5 | "You need `ROLE_ADMIN`": a role constant in a user guide | The reader's words: the role by the name the product gives it | 10 | |
| S6 | "Click **Invite member**": the button reads **Invite a member** | `translations/messages.en.yaml`: `members.invite` | 4 | |

Decoys — a finding on any of these is a false positive:

| Id | Text | Why it stands |
|---|---|---|
| D1 | "Write a note" | `ROLE_ADMIN` includes `ROLE_MEMBER` (`role_hierarchy`), and `^/` needs `ROLE_MEMBER` |
| D2 | "You see **The invitation was sent.**" | `members.invited`, flashed by `MemberController::invite` |
| D3 | "Invite a member" as a how-to, **Admin** > **Members**, **Email** | `^/admin` needs `ROLE_ADMIN`; the labels of the catalogue |

Real and not seeded — reporting one is correct and is not counted as noise: the troubleshooting
entry quotes the right message but not how the reader meets it (the link is not drawn on another
member's note); "Write a note" has no result line; there is no reference entry for **Admin** >
**Members**; troubleshooting does not end with how to get more help.

Score = seeded flaws found / 6, with the place in the code named for S1–S4, the verdict, and the
number of decoys reported. S2 is the one that reading only the controllers misses, S3 the one that
reading only the routes misses.
