# Fact list — Acme Desk guide for team admins, version 1.4

Reader: the **team admin** of one customer's team (role `team_admin`, which includes `agent`).
Other readers: an agent (covered by this guide where their tasks are the same); Acme staff (role
`staff`), whose document is `docs/operations.md`.

| Fact | Label | Source | Who can reach it | For this reader |
|---|---|---|---|---|
| Members screen | **Team** > **Members** | `app/access.php:16`, `app/screens/members.php` | `team_admin` | in reach |
| Invite a colleague | **Email**, **Role** (**Agent**, **Team admin**), **Send invitation** | `app/screens/members.php:13-23`, `app/access.php:22` | `team_admin` | in reach |
| Invitation result | **Invitation sent to %email%.** | `app/labels.en.php` `members.invited` | `team_admin` | in reach |
| An invitation can be accepted for 7 days | — | `app/invitations.php:9` | — | in reach (as the cause of a message) |
| Expired invitation | **The invitation is no longer valid. Send a new one.** | `app/labels.en.php` `members.invitation_expired` | `team_admin` | in reach |
| Remove a colleague | **Remove from team** | `app/screens/members.php:34`, `app/access.php:23` | `team_admin` | in reach |
| Last admin refusal | **A team needs at least one team admin.** | `app/labels.en.php` `members.last_admin` | `team_admin` | in reach |
| Security screen | **Team** > **Security** | `app/access.php:17`, `app/screens/security.php` | `team_admin` | in reach |
| Session length | **Sign-in lasts (hours)**, 1 to 72, default 12; **Save security settings**; **Security settings saved.** | `app/screens/security.php:13-16` | `team_admin` | in reach |
| Two-step sign-in | **Require two-step sign-in** | `app/screens/security.php:18-21`, `app/access.php:27` | `staff` only; nothing enforces it | not available |
| Access tokens screen | **Account** > **Access tokens** | `app/access.php:18`, `app/screens/tokens.php` | `agent` | in reach |
| Create a token | **Name**, **Expires**, **Create token** | `app/screens/tokens.php:12-24`, `app/access.php:24` | `staff` only | out of reach: the reader sees no form; `docs/operations.md` |
| No tokens yet | **You have no access tokens. The Acme support team creates them: write to support@acme.example and say what the token is for.** | `app/labels.en.php` `tokens.none`, `app/screens/tokens.php:40-42` | `agent` with no token | in reach (the request) |
| Revoke a token | **Revoke**; **The token was revoked. It stops working at once.** | `app/screens/tokens.php:34`, `app/access.php:25` | `agent`, own tokens | in reach |
| Templates screen | **Inbox** > **Templates**, **New template**; until version 1.3 **Saved replies** | `app/screens/replies.php`, `app/labels.en.php` | `agent` | in reach |
| Teams screen | **Staff** > **Teams**, **Close team** | `app/access.php:19`, `app/screens/staff_teams.php` | `staff` only | out of reach: not in the reader's menu; `docs/operations.md` |
| The product's name | Acme Desk | `CLAUDE.md` | — | — |
