# Acme Desk — the API

Acme Desk is a hosted help desk. A customer's team answers its own customers' requests in it. A
customer's developer can read and answer requests from their own program through the API.

## People

- **A customer's developer**: calls the API with an access token. Has no access to Acme's servers,
  code or logs, and no admin role in the customer's team.
- **A team admin**: the customer's own administrator. Cannot create access tokens.
- **The Acme support team**: creates an access token for a team, with the scopes the team admin
  asks for, at support@acme.example.

## Code

- `api/routes.php`: every call, its parameters and the scope it needs.
- `api/limits.php`: limits.
- `api/errors.php`: every error the API answers with.
- `CHANGELOG.md`: what changed in each version.

## Documentation

- `docs/api.md`: the reference a customer's developer reads. Version 1.5.
- `docs/api.facts.md`: the fact list it was written from.
- Ground every statement in the code.
