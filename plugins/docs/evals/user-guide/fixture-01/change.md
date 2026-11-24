# Tokens and two-step sign-in are for Acme staff; saved replies become templates

Version 1.4.

## What changes

- **Creating an access token is for Acme staff only.** A team's people still see their own tokens
  and revoke them. Someone with no token is told to write to the support team.
- **"Require two-step sign-in" is hidden from team admins.** Nothing enforces the setting yet, so
  it is shown to Acme staff only until it does.
- **"Saved replies" are renamed "Templates"**: the menu entry, the screen title and the button.

## Checks

- Unit tests: green.
