# Acme Desk

A small hosted help desk. A customer (a company) gets a **team**. The team's people answer the
requests of their own customers.

## People

- **Agent**: a member of a customer's team. Answers requests. Role `agent`.
- **Team admin**: the customer's own administrator. Invites agents and sets the team up. Role
  `team_admin`.
- **Acme staff**: Acme's own support people. Role `staff`. They can open every team. A customer's
  people never hold this role.

## Code

- `app/access.php`: which role opens which screen and takes which action.
- `app/Viewer.php`: the signed-in person and what they may do.
- `app/Session.php`: when a sign-in runs out.
- `app/Mailer.php`: every e-mail the product sends.
- `app/screens/`: one template per screen.
- `app/labels.en.php`: every label and message, by key.
- `app/archive.php`: the limits of the archive.
- `app/jobs.php`: what runs without a person, and when.

## Documentation

- `docs/user-guide.md`: the guide a team admin reads inside the product (the **Help** menu).
- There is no guide for agents yet. An agent opens **Help** and finds the team admin's guide.
- `docs/operations.md`: for Acme staff only. Customers cannot open it.
- `docs/images/`: screenshots. This checkout has no running instance, so no new screenshot can be
  taken here.
- Ground every statement in the code. After a change that affects a screen, update the
  documentation in the same change.
