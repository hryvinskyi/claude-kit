# Requests can be archived

Version 1.5.

## Why

Until now an answered request stayed in the list forever, and teams with thousands of requests
could no longer find the open ones. We deliberately did not add a delete button: support history is
evidence, and a deleted request is the one a customer asks about the week after.

## What changes

- **Archive.** An agent ticks requests and clicks Archive. Archiving sets `archived_at` on the row
  (a soft delete); nothing is removed. The list query filters on it, so the Open view also gets
  faster. New permission `requests.archive`, granted to `agent`. Route:
  `POST /inbox/requests/archive`.
- **At most 50 at a time.** The handler archives a batch in one transaction, and we cap it at 50 so
  the lock stays short. With more than 50 selected the request is refused with a 422 and the
  message `requests.archive_limit`.
- **Bring back.** `POST /inbox/requests/archive` with `unarchive=<id>`, permission
  `requests.unarchive`.
- **Archived requests are deleted after 365 days.** A nightly job (`archive.cleanup`, 03:00)
  hard-deletes the rows whose `archived_at` is older than `kept_days`.
- **Export.** A team admin can export the archive as a CSV file. The file is built by a queued job
  (`export.build`) and mailed as an attachment, because building it inside the request timed out on
  large teams.
- **Delete for good (staff).** Acme staff get a "Delete for good" button on archived requests, for
  erasure demands. No team role can hold `requests.purge`.
- **Weekly summary switch.** Account → Notifications gets "Email me a weekly summary". The switch
  is stored; the email itself is not sent yet (the mailer job lands in 1.6).

## Checks

- Unit tests: green.
