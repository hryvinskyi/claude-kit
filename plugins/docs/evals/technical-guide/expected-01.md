# Answer key — technical-guide fixture-01 (Review: an API reference written from the inside)

`docs/api.md` is the reference a customer's developer reads. That reader reaches the API only: no
server, no log, no admin screen (`CLAUDE.md`, the fact list). Expected verdict: `VERDICT: revise`.

| Id | Seeded flaw | Where | Condition | Severity |
|---|---|---|---|---|
| T1 | A change told at the top of the reference: "Changed in this release: a reply now needs…" | the box under the title | 16 | |
| T2 | A requirement with no version: "before you upgrade to a release that requires it" (the changelog says 1.5) | the same box | 16 (10 accepted) | |
| T3 | The inside of the interface: the Redis cache, the `replies` table, the worker and the reindex queue, where the contract is "a new reply can take up to 30 seconds to show in the list" | "List requests", the paragraph under the table | 15 | |
| T4 | Not built, told as planned, and a TODO: "not supported yet; it is planned for 1.6. TODO: document webhooks" | "List requests" | 16 | |
| T5 | An end user's how-to in the reference: "To reply from the screen instead, choose **Inbox** > **Requests**…" | "Add a reply" | 15 | |
| T6 | A fix on a screen the reader does not have, with nobody to ask: "Open **Account** > **Access tokens** and tick the scope" | Errors, `403 scope_missing` | 15 | blocking |
| T7 | Two places disagree: 60 calls a minute in Limits, 120 in Errors; the code says 60 | Limits against Errors `429` | 8 (9 accepted) | blocking |
| T8 | "Check the logs": the reader has no log; the answer's `request_id` and the support address are the way | Errors, `500` | 13 or 15 | |
| T9 | A sample that does not match the code: `?state=open`; the parameter is `status` | Example | 9 | blocking |
| T10 | A full-length key in a sample (the value is made up for this fixture and works nowhere) | Example | 16 (9 or 2 accepted) | |
| T11 | No verified first success: the one call is at the end, with no expected answer, and nothing says where a token comes from | the whole page | 2 | blocking |

Decoys — a finding on any of these is a false positive:

| Id | Text | Why it stands |
|---|---|---|
| D1 | "`GET /api/v1/tickets` … Deprecated since 1.3, removed in 2.0. Use `GET /api/v1/requests`." | A deprecation marked with its version and its replacement |
| D2 | "Ask a team admin of the account to get a new token from the Acme support team." | A fix the reader cannot apply, told as the request |
| D3 | "Above that the API answers `429 rate_limited`; the `Retry-After` header gives the seconds to wait." | The contract |
| D4 | `Authorization: Bearer <your token>` | A placeholder |
| D5 | The rows of the document history | The place where a change is told |

Score = seeded flaws found / 11, with the condition named (the family in the table counts), the
verdict, and the number of decoys reported.
