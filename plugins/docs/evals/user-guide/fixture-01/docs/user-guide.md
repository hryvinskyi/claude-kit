# Acme Desk — guide for team admins

For the admin of a team. Version 1.3

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

### Require two-step sign-in

You need the **Team admin** role.

1. Choose **Team** > **Security**.
2. Select **Require two-step sign-in**.
3. Click **Save security settings**.

Every member confirms each sign-in with a code from their phone.

### Create an access token

An access token lets another program read your team's requests. You need the **Team admin** role.

![The Access tokens screen, with the form to create a token.](images/tokens.png)

1. Choose **Account** > **Access tokens**.
2. In **Name**, enter what the token is for.
3. In **Expires**, select **In 30 days**, **In 90 days** or **Never**.
4. Click **Create token**.
5. Copy the token. It is shown only once.

The token appears in the list.

### Revoke an access token

1. Choose **Account** > **Access tokens**.
2. In the token's row, click **Revoke**.

You see **The token was revoked. It stops working at once.**

### Write a saved reply

A saved reply is an answer you write once and use in many requests.

1. Choose **Inbox** > **Saved replies**.
2. Click **New saved reply**.
3. Enter a title and the text, and save.

## Screens and settings

### Team > Security

| Setting | What it does | Default |
|---|---|---|
| **Sign-in lasts (hours)** | After this many hours a member signs in again. From 1 to 72. | 12 |
| **Require two-step sign-in** | Every member confirms each sign-in with a code from their phone. | Off |

### Account > Access tokens

The form at the top creates a token: **Name**, **Expires** (**In 30 days**, **In 90 days**,
**Never**; the default is **In 90 days**) and **Create token**. The list under it shows each token's
**Name**, **Created** and **Expires**, with **Revoke** in each row.

### Inbox > Saved replies

The list of your team's saved replies, with **New saved reply** above it.

### What each role can do

| Task | Agent | Team admin |
|---|---|---|
| Answer requests, use saved replies | Yes | Yes |
| Revoke their own access tokens | Yes | Yes |
| Create access tokens | No | Yes |
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
- **Saved reply**: an answer you write once and use in many requests.

## Document history

| Version | Date | What changed |
|---|---|---|
| 1.3 | 2026-09-01 | Added "Set how long a sign-in lasts". |
| 1.2 | 2026-07-14 | Added access tokens. |
| 1.0 | 2026-03-02 | First version. |
