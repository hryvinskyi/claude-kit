# Acme Desk API

Reference for developers. Version 1.5

> **Changed in this release:** a reply now needs an `Idempotency-Key` header. Send the header
> before you upgrade to a release that requires it.

## Calls

| Call | Scope | What it does |
|---|---|---|
| `GET /api/v1/requests` | `read:requests` | Lists the team's requests. |
| `GET /api/v1/requests/{id}` | `read:requests` | One request with its replies. |
| `POST /api/v1/requests/{id}/replies` | `write:replies` | Adds a reply. |
| `GET /api/v1/tickets` | `read:requests` | Deprecated since 1.3, removed in 2.0. Use `GET /api/v1/requests`. |

### List requests

`GET /api/v1/requests`

| Parameter | In | Type | Default | Meaning |
|---|---|---|---|---|
| `status` | query | `open`, `answered` or `archived` | all | Only requests in this status. |
| `page` | query | integer, from 1 | 1 | The page. |
| `per_page` | query | integer, 1 to 100 | 25 | Requests on a page. |

The list is served from a Redis cache with a 30 second TTL. When a reply is added, the handler
writes it to the `replies` table and a worker pushes the request to the reindex queue, so the list
catches up after the worker has run.

Filtering by date is not supported yet; it is planned for 1.6. TODO: document webhooks.

### Add a reply

`POST /api/v1/requests/{id}/replies`

| Field | In | Type | Meaning |
|---|---|---|---|
| `Idempotency-Key` | header | string | A value of your own for this reply. A repeated key answers with the first reply. |
| `text` | body | string, 1 to 10000 characters | The reply. |

To reply from the screen instead, choose **Inbox** > **Requests**, open the request, write the
answer and click **Send**.

## Limits

A token may make 60 calls a minute. Above that the API answers `429 rate_limited`; the
`Retry-After` header gives the seconds to wait.

## Errors

| Status | Code | Meaning | What to do |
|---|---|---|---|
| 401 | `token_missing` | The `Authorization` header is missing. | Send `Authorization: Bearer <your token>`. |
| 401 | `token_invalid` | The token is unknown or was revoked. | Ask a team admin of the account to get a new token from the Acme support team. |
| 403 | `scope_missing` | The token may not make this call. | Open **Account** > **Access tokens** and tick the scope. |
| 404 | `not_found` | No such request in this team. | Check the id. |
| 409 | `idempotency_key_missing` | A reply needs an `Idempotency-Key` header. | Send the header. |
| 422 | `validation_failed` | A parameter or the body is not valid. | The answer names the field. |
| 429 | `rate_limited` | More than 120 calls a minute. | Wait for the seconds in `Retry-After`. |
| 500 | `server_error` | Something failed on our side. | Check the logs. |

## Example

```bash
curl -H "Authorization: Bearer adk_live_9f2c41d07ab35e68c0d4417f2b9a6e13" \
  "https://desk.acme.example/api/v1/requests?state=open"
```

## Document history

| Version | Date | What changed |
|---|---|---|
| 1.5 | 2026-11-10 | Replies need an `Idempotency-Key`. |
| 1.4 | 2026-09-02 | `status` on the list. |
| 1.3 | 2026-06-18 | `GET /api/v1/tickets` deprecated. |
