# Fact list — Acme Desk API reference, version 1.5

Reader: a customer's developer who calls the API with an access token. They reach the API only:
no server, no log, no admin screen of the team. An access token is created by the Acme support
team at the team admin's request (`CLAUDE.md`).

| Fact | Source | Who can use it |
|---|---|---|
| `GET /api/v1/requests`, query `status` (`open`, `answered`, `archived`), `page` (from 1, default 1), `per_page` (1 to 100, default 25) | `api/routes.php:9-16` | a token with `read:requests` |
| `GET /api/v1/requests/{id}` | `api/routes.php:17-19` | a token with `read:requests` |
| `POST /api/v1/requests/{id}/replies`, body `text` (1 to 10000 characters), header `Idempotency-Key` required from 1.5 | `api/routes.php:20-24`, `CHANGELOG.md` | a token with `write:replies` |
| `GET /api/v1/tickets`, deprecated since 1.3, removed in 2.0, use `GET /api/v1/requests` | `api/routes.php:25-28` | a token with `read:requests` |
| 60 calls a minute for a token | `api/limits.php:9` | — |
| A new reply can take up to 30 seconds to show in `GET /api/v1/requests` | `api/limits.php:10` | — |
| Errors: `401 token_missing`, `401 token_invalid`, `403 scope_missing`, `404 not_found`, `409 idempotency_key_missing`, `422 validation_failed`, `429 rate_limited` with `Retry-After`, `500 server_error` with `request_id` | `api/errors.php` | — |
| Scopes are set when the Acme support team creates the token; the team admin asks for them at support@acme.example | `CLAUDE.md` | the Acme support team |
| The screens of the product (**Inbox** > **Requests**) | — | the team's people, not this reader |
