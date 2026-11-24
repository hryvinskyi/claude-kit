# Acme Desk — guide for team admins

For the admin of a team. Version 1.4

## Start here

Acme Desk is where your team answers your customers' requests. As the team admin you invite your
colleagues, decide how sign-in works for them, and keep the team's access tokens in order.

- New here: [Getting started](#getting-started).
- You have a task: [How-to guides](#how-to-guides).
- You want to know what a setting does: [Screens and settings](#screens-and-settings).
- Something does not work: [Troubleshooting](#troubleshooting).

## Getting started

Invite your first colleague.

1. Choose **Team** > **Members**.
2. In **Email**, enter your colleague's address.
3. Leave **Role** at **Agent**.
4. Click **Send invitation**.

You see **Invitation sent to** and the address. Your colleague appears under **Invitations not
accepted yet** until they accept. An invitation can be accepted for 14 days.

## How-to guides

### Invite a colleague

You need the **Team admin** role.

1. Choose **Team** > **Members**.
2. In **Email**, enter the address.
3. In **Role**, select **Agent** or **Team admin**.
4. Click **Send invitation**.

You see **Invitation sent to** and the address.

### Remove a colleague

You need the **Team admin** role.

1. Choose **Team** > **Members**.
2. In the colleague's row, click **Remove from team**.

The colleague can no longer sign in to your team. Removing a colleague ends their session on their
next request: the check runs centrally on every page load, so there is no way to slip past it.

### Set how long a sign-in lasts

You need the **Team admin** role.

1. Choose **Team** > **Security**.
2. In **Sign-in lasts (hours)**, enter a number from 1 to 72.
3. Click **Save security settings**.

You see **Security settings saved.**

The page also holds **Require two-step sign-in**, which the product does not enforce yet. Only Acme
staff see and change it.

### Get an access token

An access token lets another program read your team's requests. Access tokens are created by the
Acme support team. Write to support@acme.example and say what the token is for.

A member who already holds a token still sees the page, with the list of their tokens and a
**Revoke** button, and no form. A member with no token does not see the form either and reads a note
instead.

The steps below are what Acme staff see.

![The Access tokens screen. This picture shows the previous layout, with the form a team admin no longer has.](images/tokens.png)

1. Choose **Account** > **Access tokens**.
2. In **Name**, enter what the token is for.
3. In **Expires**, select **In 30 days**, **In 90 days** or **Never**.
4. Click **Create token**.
5. Copy the token. It is shown only once. This is deliberate: a token shown twice is a token that
   leaks.

### Revoke an access token

1. Choose **Account** > **Access tokens**.
2. In the token's row, click **Revoke**.

You see **The token was revoked. It stops working at once.**

### Write a template

!!! note "New in this release: saved replies are now called templates"
    Until now the menu said **Saved replies**. Nothing was lost: every saved reply you had is a
    template.

A template is an answer you write once and use in many requests. Formerly **Saved replies** (until
version 1.3).

1. Choose **Inbox** > **Templates**.
2. Click **New template**.
3. Enter a title and the text, and save.

### Close a team (Acme staff)

You need the Acme staff role.

1. Choose **Staff** > **Teams**.
2. Find the team and click **Close team**.

The team's people can no longer sign in.

## Screens and settings

### Team > Security

| Setting | What it does | Default |
|---|---|---|
| **Sign-in lasts (hours)** | After this many hours a member signs in again. From 1 to 72. | 12 |

### Account > Access tokens

The list shows each of your tokens: **Name**, **Created** and **Expires**, with **Revoke** in each
row.

### Inbox > Templates

The list of your team's templates, with **New template** above it.

### What each role can do

| Task | Agent | Team admin |
|---|---|---|
| Answer requests, use templates | Yes | Yes |
| Revoke their own access tokens | Yes | Yes |
| Create access tokens | No | No. Acme staff only; no team role can hold it. |
| Invite and remove colleagues | No | Yes |
| Change the security settings | No | Yes |

## Troubleshooting

### "The invitation is no longer valid. Send a new one."

The invitation was already used, or it was sent more than seven days ago.

1. Choose **Team** > **Members**.
2. Send the invitation again.

### "A team needs at least one team admin."

You tried to remove the only team admin. Give another colleague the **Team admin** role first.

### Nobody in the team can sign in

Ask whoever runs the installation to look at the server log.

## Glossary

- **Access token**: a secret text another program sends to read your team's requests.
- **Template**: an answer you write once and use in many requests.

## Document history

| Version | Date | What changed |
|---|---|---|
| 1.4 | 2026-10-20 | Access tokens are created by the Acme support team. Saved replies are called templates. |
| 1.3 | 2026-09-01 | Added "Set how long a sign-in lasts". |
| 1.2 | 2026-07-14 | Added access tokens. |
| 1.0 | 2026-03-02 | First version. |
