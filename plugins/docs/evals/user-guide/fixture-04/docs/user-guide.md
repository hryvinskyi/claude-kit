# Acme Desk — guide for team admins

For the admin of a team. Version 1.5

## Start here

Acme Desk is where your team answers your customers' requests. As the team admin you invite your
colleagues and decide how sign-in works for them.

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
accepted yet** until they accept.

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

The colleague can no longer sign in to your team.

### Set how long a sign-in lasts

You need the **Team admin** role.

1. Choose **Team** > **Security**.
2. In **Sign-in lasts (hours)**, enter a number from 1 to 72.
3. Click **Save security settings**.

You see **Security settings saved.**

### Get an access token

An access token lets another program read your team's requests. Access tokens are created by the
Acme support team.

1. Write to support@acme.example and say what the token is for.
2. The support team sends you the token once. Keep it where you keep your passwords.

Your tokens are listed under **Account** > **Access tokens**.

### Revoke an access token

1. Choose **Account** > **Access tokens**.
2. In the token's row, click **Revoke**.

You see **The token was revoked. It stops working at once.**

### Archive requests

Archive the requests you no longer need in your open list. An archived request is deleted 365 days
after it was archived.

1. Choose **Inbox** > **Requests**.
2. Select the requests. You can archive up to 50 at a time.
3. Click **Archive**.

You see how many requests were archived.

### Export archived requests

You need the **Team admin** role.

1. Choose **Inbox** > **Requests**.
2. In **Show**, select **Archived**.
3. Click **Export archived requests**.

You get an email with the file in a few minutes.

### Write a template

A template is an answer you write once and use in many requests. Formerly **Saved replies** (until
version 1.3).

1. Choose **Inbox** > **Templates**.
2. Click **New template**.
3. Enter a title and the text, and save.

## Screens and settings

### Team > Security

| Setting | What it does | Default |
|---|---|---|
| **Sign-in lasts (hours)** | After this many hours a member signs in again. From 1 to 72. | 12 |

### Account > Access tokens

The list shows each of your tokens: **Name**, **Created** and **Expires**, with **Revoke** in each
row.

### Inbox > Requests

The list of your team's requests. Click a request to open it.

### Inbox > Templates

The list of your team's templates, with **New template** above it.

### What each role can do

| Task | Agent | Team admin |
|---|---|---|
| Answer requests, use templates | Yes | Yes |
| Revoke their own access tokens | Yes | Yes |
| Invite and remove colleagues | No | Yes |
| Change the security settings | No | Yes |

## Troubleshooting

### "The invitation is no longer valid. Send a new one."

The invitation was already used, or it was sent more than seven days ago.

1. Choose **Team** > **Members**.
2. Send the invitation again.

### "A team needs at least one team admin."

You tried to remove the only team admin. Give another colleague the **Team admin** role first.

## Glossary

- **Access token**: a secret text another program sends to read your team's requests.
- **Template**: an answer you write once and use in many requests.

## Document history

| Version | Date | What changed |
|---|---|---|
| 1.5 | 2026-11-10 | Added archiving and exporting requests. |
| 1.4 | 2026-10-20 | Access tokens are created by the Acme support team. Saved replies are called templates. |
| 1.3 | 2026-09-01 | Added "Set how long a sign-in lasts". |
| 1.2 | 2026-07-14 | Added access tokens. |
| 1.0 | 2026-03-02 | First version. |
