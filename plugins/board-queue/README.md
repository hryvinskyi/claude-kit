# board-queue

A durable queue and a single writer for shared GitHub Projects boards.

Sessions and scripts **file** work — set these fields on that issue, post this comment, close it — and a
worker drains the queue on a schedule. Nothing else writes to the boards. That is the whole idea: the boards
sit behind one hourly API allowance that every session on the account shares, and the only way to stay
inside it is for one process to spend it serially, read what each answer says is left, and stop early
rather than find out by being refused.

## Boards and the repositories they carry

The configuration lists the boards, and under each board the repositories whose issues are written to it:

```json
"boards": [
  { "owner": "example-org",  "number": 1, "ownerType": "organization",
    "repos": ["example-org/example-repo", "example-user/another-repo"] },
  { "owner": "example-user", "number": 2, "ownerType": "user",
    "repos": ["example-user/third-repo"] }
]
```

Every action is routed by its repository to the one board that names it; nothing compares an owner by
name. A repository belongs to exactly one board — one named twice, or a board listed twice, is refused when
the configuration is read, before anything is filed. A repository no board names is refused as it is
filed, with the list of the ones that are; work already in the queue for a repository that has since left
the configuration is blocked when the worker reaches it, with the same list.

Each board keeps its own field catalog (two boards' fields and options carry different ids, even where
their names agree), its own one-minute listing, and the credential of the account that owns it. The
allowance is not divided: it is one account's, so the pacing below is the same however many boards there
are. The older single-board shape (`"board": {…}` beside a flat `"repos"`) is no longer read; the refusal
names what is wrong.

## What it costs

A targeted GraphQL call — find an issue, add it to the board, set one field, read one row back — costs
about a point each, and the whole board read as one paginated walk costs three to five; a complete
set-fields is therefore about six points against an hourly allowance of five thousand. The expensive thing
was never the writing but the listing that preceded it: a command line `project item-list --limit 800`
costs upwards of thirteen hundred points per invocation, which is why an afternoon of them left every
session refused.

REST is a separate allowance (`core`, five thousand an hour of its own). The pacing policy watches the
GraphQL one only: comments and closes are cheap, they are billed elsewhere, and a policy that mixed the
two would stop the queue for an allowance it is not spending. What REST answers is recorded and shown in
`status`, and a refusal from either side pauses the queue.

## Membership is written, never read

Whether an issue is on the board is established by adding it — the add is idempotent and hands back the row
that is already there — or by looking for it in the board's own walk. It is never asked of the issue: an
issue's board items were measured answering *empty* for rows that are demonstrably on the board whenever
the repository's owner and the board's owner differ, which reads exactly like "not on the board" and would
make this system add a second row or refuse to write.

## The kinds

Five sorts of work, each a class with its own payload, its own merging rule and its own way of confirming
what it did. The repository is always written `owner/name` and must be one the configuration names; the
board written to is the one that carries it.

`board.set-fields` — set single-select fields on an issue's row.

```json
{ "kind": "board.set-fields",
  "payload": { "repo": "example-org/example-repo", "issue": 412,
               "fields": { "status": "In progress", "severity": "S2", "module": "Checkout" } } }
```

Wanted texts are matched against the board's live options: exactly, then ignoring case, then as a prefix
that fits one option only — so `S2` reaches `S2 · broken · no workaround`. A text that fits nothing, or
several, blocks the action and reports what the field accepts. Two of these waiting on the same issue merge
into one, the later values winning.

`"onlyIfStatusIn": ["In Progress", "Todo", ""]` makes the write conditional: the row is found on the board's
walk and read fresh before anything is written, and the write goes ahead only while its Status is one of the
listed texts (`""` is a row with no status; a listed text the board offers no option for is passed over).
Otherwise the action ends **skipped** — `status_not_owned`, or `not_on_board` for an issue with no row, which a
conditional write never adds — writing nothing and asking nobody for anything. It is the form for work that
copies another system's state onto the board, which arrives late as often as not and must never pull a row back
out of a column somebody else moved it to. A conditional request merges with nothing.

`board.verify` — read a row back and compare it with what you expect; writes nothing.

```json
{ "kind": "board.verify",
  "payload": { "repo": "example-org/example-repo", "issue": 412, "expect": { "status": "Done" } } }
```

Any status may be expected here, including one that writes refuse. `"onBoard": false` asserts the issue is
deliberately absent, and is the one form that needs no `expect` at all.

A comment body, and the comment an `issue.close` posts first, are capped at 65 536 characters — GitHub's
own limit. A longer one comes back as a 422, which reads as a fault of the moment and would be retried five
times before the action gave up, so the length is refused where it was typed.

`issue.comment` — post one comment, once.

```json
{ "kind": "issue.comment",
  "payload": { "repo": "example-org/example-repo", "issue": 412, "body": "verified on staging" } }
```

The comment carries an invisible marker naming the action, so a retry after a failure whose post had
already landed adopts that comment instead of posting a second one.

`issue.close` — close an issue, posting the evidence comment first when one is given.

```json
{ "kind": "issue.close",
  "payload": { "repo": "example-org/example-repo", "issue": 412, "reason": "completed",
               "comment": "shipped in 2.14.0" } }
```

Closing is also how a row reaches the board's final column: the board's own automation moves it. **This
queue never writes the status `Done` itself** — the same automation would close the issue in reaction, and
it would do so before the evidence comment exists. Enqueue refuses it, and execution refuses it again after
the prefix has been resolved.

`issue.assignees` — assign and unassign people, everybody else staying assigned.

```json
{ "kind": "issue.assignees",
  "payload": { "repo": "example-org/example-repo", "issue": 412, "add": ["alice"], "remove": ["bob"] } }
```

The issue is read back afterwards: a login GitHub would not assign — somebody without access to the
repository — blocks the action instead of reading as done. Two of these waiting on one issue merge, the later
request winning for a login both name.

A request piped in whole may carry `"dedupeKey"`: an action already filed under the same key is the answer,
and nothing new is filed. A request with a key never merges with another.

## The life of an action

```
              ┌──── release ────┐
   held ──────┘                 ↓
   enqueue ──────────────→ queued ──claim──→ running ──→ done
                             ↑  ↑               │
             backoff ────────┘  └── requeue ────┤   (a refusal that was not this action's fault)
                                                ├──→ blocked ──retry──→ queued
                                                ├──→ failed  ──retry──→ queued
                                                └──→ skipped   (a condition it carried did not hold)
   queued | held | blocked | failed ──cancel──→ cancelled
```

- Actions on the same issue run in the order they were filed, so a comment filed before a close is posted
  before the issue closes. No dependency has to be declared for that.
- A write is done only once reading it back agrees with it; a mismatch is a failure carrying both values.
- An action a run died holding — the machine went down, the process was killed — is put back at the start
  of the next run, with the attempt it was charged returned. Nothing else would free it: `cancel` and
  `retry` both refuse a running action, and no later action on the same issue may run while it sits there.
  Running it again is safe by design: a post looks for its own marker first, adding a board row hands back
  the row that is already there, and a close reads the issue's state before changing it.
- **Blocked** means a person has to change something outside this system — add the option to the board,
  restore a missing issue. Nothing retries a blocked action on its own; `retry` gives it its attempts back
  and keeps the error, which is the record of what was fixed. The one exception is an option that appears
  in a fresh catalog of its own board: the decision was made when somebody added it, and pressing the button again is not a
  second decision.
- `notBefore` pushes an action into the future, up to thirty days; beyond that it is refused, because work
  nothing will touch for a year is work nobody sees again. `status` and the session brief list what is
  waiting and when it comes round, so a delay is never silent.
- **Held** is for work that waits on something outside the queue — a move that is only true once a deploy
  is live. A held request never merges into a waiting one, because the merged values would run at the next
  tick with nothing saying so. `release` is what runs it.
- A transient failure (5xx, a network error) waits out a backoff and comes back, up to five attempts, then
  it is **failed**.
- Every write is guarded by the row's version: two writers, and the second one to arrive is told the row
  changed rather than overwriting a decision it never saw.

## One pass at a time

Everything a pass does — draining the queue, the mirror, the import, the forge jobs, the audit — runs under one
tick lock, a row in `queue.db`. Its holder writes down its process id, when that process started, the place the
id counts in (the machine and, on Linux, its pid namespace), a random lease, and the time; while it works it renews
that time every minute. Another pass takes the lock only when the lease has gone unrenewed for five minutes, or
when the holder counts its id in the same place and that id is gone or now belongs to a process that started at
another time — which is what a restarted container does with its first ids. A holder in another place, such as
inside a container seen from the machine around it, cannot be looked up, so its lease alone decides.

## The rate-limit policy

Every answer carries what is left of the allowance, and that is the only source trusted — the dedicated
rate-limit endpoint was measured answering stale numbers. The worker reads the headers on every call and:

- never starts an action while GraphQL remaining is below the floor (500 by default — the allowance is
  shared with every session on the account, and a worker that spends it to the last point leaves the people
  working alongside it unable to read a single issue);
- never runs more than the per-tick cap (40) and leaves at least 1500 ms between two mutations;
- treats a refusal with remaining 0 as exhaustion and pauses until the reset the header names;
- treats a refusal with remaining above 0 as the burst limiter and pauses for `retry-after`, or 120 s,
  doubling per consecutive refusal up to an hour. A tick that completed an action resets the doubling;
- counts a rate-limit refusal against the queue, never against the action: it goes back untouched, because
  spending an action's attempts on refusals it had no part in would give up on work that was never wrong.

A 2xx is a success whatever its remaining header says. The policy stops the *next* action instead.

## The audit

`board-queue audit` reads every board and says what does not add up; `--json` gives the same report as
data. Per configured repository it asks GitHub for the open issues, walks the board that carries it once,
and lists three
disagreements: an open issue with no board row, a row with one of the managed fields left blank (an empty
Status counts), and an issue closed in the last 14 days whose row never reached a status the board's own
automation sets. The pass files nothing, ever — which module an issue belongs to and how badly it hurts are
judgements it cannot make, and a guessed value routes triage wrongly while looking exactly like a chosen
one. Read it and decide.

The closed-issue window over-includes on purpose: the REST listing filters on when an issue was last
updated, not on when it was closed, so an issue closed months ago and commented on yesterday comes back
with the rest. It costs one row in a board walk that was happening anyway, and the finding is dropped as
soon as that row turns out to carry a finished status.

The worker runs the same pass by itself after a tick, at most every `worker.auditEveryHours` (6) and only
while the GraphQL allowance is above `worker.auditMinRemaining` (1000): the report is work nobody is
waiting for, and it must never compete with the queue. It runs under the same single lock the writing does
and never while the queue is waiting out a refusal — the report and the writes spend one allowance between
them. The last report is kept as `audit.json` in the state directory, one file, replaced each time;
`board-queue status` shows the counts and when it was taken. A pass a rate limit cuts short still writes
what it found, says so in the report, and leaves that summary alone so the next tick looks again. A pass
that fails outright stamps the attempt, so a report that cannot be written waits out the same six hours
rather than being asked for again every five minutes. `"audit": { "enabled": false }` in the configuration
switches the scheduled pass off (it is on by default); `board-queue audit` still runs it by hand.

## Keeping the boards in step with a coordination server

A [dibs](https://github.com/hryvinskyi/dibs) server knows who is working on what: people claim work items there,
and its event log records every claim. The `dibs` section of the configuration keeps a set of repositories in
step with one of its projects, in both directions:

```json
"dibs": {
  "server": "https://dibs.example.com",
  "project": "widgets",
  "tokenEnv": "DIBS_TOKEN",
  "mirrorOwner": "alice",
  "repos": ["example-org/example-repo"],
  "mirror": {
    "enabled": true,
    "status": { "claimed": "In Progress", "released": "Todo", "review": "In Review" },
    "assignees": true
  },
  "importer": { "enabled": true, "modules": { "Checkout": ["checkout"] } }
}
```

**Exactly one worker runs it.** Every person runs a worker, and a mirror in each would keep its own cursor
and file every move once per person. Both directions are off unless the configuration turns them on, and
each tick first asks whether this worker's login is `mirrorOwner` — on a person's machine the login its GitHub
command line tool is signed in as, in the service (*As a service*, below) the login of its GitHub App, `<slug>[bot]`,
read from GitHub with the App's key; on any other worker the tick declines, says why in `status`, and drains its
own queue as usual. `tokenEnv` names the
variable holding the token of the project's `importer` member, never the token; the variable is read only when
a call needs it.

**The mirror** (server → board) follows the event log from its cursor at the start of each tick, up to five
pages of 500, for as long as the cursor moves: the server leaves out of a page what this reader may not see while
its cursor moves past it, so a page that shows nothing is not the end of the log, and the cursor is saved after
every page. Per issue, the events of a page collapse to the state the last of them left, and two actions are
filed: a `board.set-fields` of the status the claim stands for (`claimed`, `released` — a release by an admin
too —, `takenOver` and `reviewEnded`, which default to `claimed`, and `review`), conditional on the row still
carrying one of the statuses the mirror writes or none; and an `issue.assignees` for the holder, mapped to a
GitHub login through the project's members (a login is kept once read, so a removed member is still unassigned).
A completed claim files nothing: the board's final columns are not the mirror's.

**It never replays the log.** On its first run, and when the log no longer keeps what came after the cursor, it
reads to the head of the log filing nothing, then files the state each live claim (`GET /v1/claims`) stands for
now; `status` says it started from the head, at which event, and why. A cursor note that is not a cursor is an
error in `status`, never read as the start of the log. The cursor and the last event filed for each item are
written in the same transaction as the actions, so a crash leaves all or none; a move no later than one already
filed for its item is not filed again however the pages fell, and the key each action carries
(`dibs:<server>:<project>:<event>:status|assignees`, or `head<event>:<item>` after a fresh start) is the store's
backstop against filing one state twice. Each item's reference is asked once and kept; an item whose reference
cannot be read is passed over, counted in `status`, and the page goes on. A server that cannot be reached is
recorded in `status` and the queue is drained regardless.

**The importer** (board → server) runs after the queue is drained, at most every `everyMinutes` (15) and only
while the GraphQL allowance is above `minRemaining` (1000). It walks each board that carries a repository kept
in step — a walk of its own, which also asks for each issue's title, state, dates and the summaries of what blocks
it at no extra cost per page, so that no write or read-back depends on those fields — and then, for an open issue whose summary says it
has blockers or sub-issues, the REST lists `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` and
`…/sub_issues`. Those are asked conditionally with the tag of the answer kept from the last run (an unchanged
list is answered 304, which the hourly allowance does not count), one a second, at most `maxRequestsPerTick`
(100) per run, oldest answer first; a burst refusal ends the asking and puts the queue to sleep. A parent is
blocked by its open sub-issues. Then `PUT /v1/items` in batches of 500: each issue with its title, its Status,
the areas its Module stands for (`modules`; a Module with no entry hints at nothing), the priority its Severity
stands for (`priorities`, `S1` → 0 … `S4` → 3 by default) and what blocks it; a blocker that is not on the
board is carried under its own reference as a blocker only, so it is never closed by the import. Only the last
batch, holding every open item, says it is complete — and only when every row of every board was read in that
run, and only when the open items did not fall to none or by more than half since the last complete import —
so an item that left the board is closed on the server, while a board that suddenly reads nearly empty closes
nothing and says why in `status`. It writes nothing to GitHub and files nothing in
the queue, and what it sends changes no claim, so it never sets off a move of the mirror.

**The forge jobs** (GitHub ↔ server) are for one service that runs under an identity of its own — a GitHub App
installed on the repositories kept in step, with Pull requests, Contents and Actions read and Commit statuses
read/write — not for a person's worker. They are off unless `forge.enabled` says otherwise, run behind the same
`mirrorOwner` check, and start only where every repository's calls go out under the App's credential: there the
App's credential is used with nothing to fall back to, so a call never quietly goes out as a person. A worker
whose calls would use a person's credential declines, and `status` says why, unless the configuration sets
`allowPersonalToken`:

```json
"forge": { "enabled": true, "paceMs": 1000, "overlapMinutes": 10, "minRemaining": 500,
           "maxStatusWritesPerPass": 20, "maxStatusWritesPerHour": 300, "maxPassMinutes": 4,
           "allowPersonalToken": false }
```

Each tick, after the queue is drained and under the same single lock, one pass reads the server first —
`GET /v1/me` (its repositories and the remote each is cloned from), `/v1/members`, `/v1/review-claims`,
`/v1/claims` and `/v1/slots` — and sends nothing when any of those fails. Then, for each repository in `repos`:

- **Pull requests.** `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc`, page 1 conditional on its
  tag, paged until a page reaches back past the repository's cursor less `overlapMinutes` (the listing has no
  "since", and GitHub's clock is not this machine's). What the window holds is handled oldest first: each merge
  or close the server was not told about is reported — `POST /v1/prs/merged { pr, base, head, merged_at, files }`
  or `POST /v1/prs/closed` — and the pull request is kept with the cursor moved up to it, in one transaction, the
  moment the server answers. A pass that stops on the way leaves the cursor at the last pull request it finished;
  the next carries on from there and sends nothing twice. The files come from `GET …/pulls/{n}/files`, a page per
  request (at most 3000; a rename counts both its paths); when they cannot be read the merge is sent without
  them, and `status` says so. A merge from a fork's branch names no `head`. A report the server refuses is
  recorded and not sent again by the listing. A first listing reads only what is open and starts its cursor at
  the time GitHub's answer carries.
- **The claims in review.** Every pull request a claim in review waits for is asked where it stands
  (`GET …/pulls/{n}`, conditional — nothing kept is taken on trust, a closed one may have been reopened) and
  reported once it ended, however long ago: that is how a pull request merged before its holder recorded it
  reaches the server at all.
- **Mergeability.** For each open pull request of a member with a GitHub login, and each one a claim waits for,
  `POST /v1/prs/state { pr, mergeable }` when what GitHub says changed since it was last told.
- **The PR status.** For each open pull request of a member with a GitHub login, `GET /v1/pr-status?repo=&base=`
  once per base, and `POST /repos/{o}/{r}/statuses/{sha}` only where the server says the repository wants one and
  only when the state or description differs from the last written for that commit and context. A status this
  worker wrote and no longer stands behind is taken back: when the repository stops wanting one, its context
  changes, or the author is no longer a member, a head whose last status here was a failure gets one success,
  "no longer checked by <context>", and the status is forgotten. Every write counts against GitHub's
  content-creation limit, which the queue's own writes spend too: a pass writes at most `maxStatusWritesPerPass`
  (at most 35), every pass together at most `maxStatusWritesPerHour`, and the rest wait for a later pass.
- **Footprints.** For each branch of a live claim in that repository, `GET …/compare/{base}...{branch}`
  (conditional; the base is that of the open pull request from the repository's own branch of that name, or the
  default branch) and `PUT /v1/items/{id}/footprint { repo, branch, base, base_sha, base_at, paths, truncated }`
  — `base_sha` the merge base, `base_at` its committer time, a rename by both its paths. An unchanged comparison
  sends the measure kept from the last one; a branch GitHub no longer has, and a comparison that names no files,
  send nothing. A claim a merge of this pass completed is not measured; one the server set aside, or put back to
  work, still is.
- **Holds until a run.** A hold names a commit, often by a short id, and no repository: the commit is resolved
  once with `GET …/commits/{sha}`, in the first repository that holds it, and kept. Its runs are then asked there
  only (`GET …/actions/runs?head_sha=`); once the latest run of the hold's own workflow for that commit completed,
  `POST /v1/slots/{name}/run-finished`. The workflow is matched by its file name or path first, and by its display
  name only when no file matches and exactly one workflow carries that name.

A repository the server does not list gets no status and no footprint, and `status` says so.

Requests to GitHub go one at a time, `paceMs` apart, and only while the REST allowance is above `minRemaining` and
the pass is younger than `maxPassMinutes` (4 by default, so a pass ends before the next tick is due, and at most
25). A burst refusal, an
exhausted allowance or a credential GitHub will not take ends the pass and puts the queue to sleep, as any refusal
does. GitHub not answering — a network failure, a timeout, a 5xx — three requests of one job in a row ends that
repository's jobs for the pass, says so in `status`, and the pass goes on with the next repository. GitHub refusing
one request (a 403, 404 or 422) is about that one pull request, branch or hold: it is counted and the job goes on.
The coordination server not answering ends the pass; it refusing one report is counted, and the pass goes on. The
lock is held for the whole pass, never released between repositories: a pass released half way would let the next
tick start a second pass while the first still runs, two passes spending one allowance and writing one set of
statuses. Statuses written more than thirty days ago on commits that are no open pull request's head, and pull
requests that ended thirty days ago and were reported, are forgotten at the end of a pass, 500 of each at most. It
files nothing in the queue. A project that lists no repository has one, `default`, which stands for the one
repository in `repos` when there is one.

`status` shows all three: the last run of each, the cursors, what an import cost to read, what the last forge
pass did in each repository, and why any of them stopped.

## From a session

The MCP server offers `board_enqueue`, `board_queue`, `board_status`, `board_release`, `board_cancel`,
`board_retry` and `board_show`. Every tool but the last reads or writes the database only and costs no
allowance; `board_show` reads the whole board that carries the repository in one walk and reuses it for a
minute, and is refused while the queue is waiting out a rate limit — it spends exactly what the queue is
waiting for.

The tool descriptions carry the rules a caller needs — which repositories are allowed and which board
carries each, why `Done` is refused, what `hold` is for, what a warning in the answer means. A session does
not need this file.

## From a shell

`board-queue` below is the command in `bin/`: on the search path of every session while the plugin is
enabled, and at `~/.local/bin/board-queue` once the kit's shims are installed (see *Installing*). A
script, a scheduled job or a hook calls it there, or by `$BOARD_QUEUE_CLI` when it is set, and never
by a path into the plugin cache, which moves on every plugin update.

```
board-queue enqueue --repo example-org/example-repo --issue 412 --status "In progress" --severity S2
echo '{"kind":"issue.comment","payload":{"repo":"example-org/example-repo","issue":412,"body":"…"}}' \
  | board-queue enqueue
board-queue list [--state queued,held] [--repo owner/name] [--issue N] [--kind K] [--json]
board-queue status [--json]
board-queue release <id> | cancel <id> | retry <id> | retry --blocked
board-queue show example-org/example-repo 412
board-queue tick            # refused unless BOARD_QUEUE_SCHEDULED=1 — the launcher sets it
board-queue service         # the worker as a long-running service (see As a service)
board-queue health [--json] # whether that service is doing its job; exits 1 when it is not
board-queue audit [--json]
board-queue brief --repo example-org/example-repo
board-queue install-launchd   # macOS
board-queue install-systemd   # Linux
board-queue help
```

The words build a `board.set-fields` request; any other kind is piped in as
`{"kind": …, "payload": {…}}`, optionally with `origin`, `hold` and `notBefore`. `--json` prints the same
answer as the values a script reads. An unknown command exits 2, a refusal exits 1 with one sentence on the
error stream and no stack.

`brief --repo` is what a session-start hook calls. It reads the database and nothing else, returns in a few
tens of milliseconds, and prints

```
[BOARD QUEUE] queued 3 · held 1 (oldest 6.2d) · blocked 1 · failed 0
[BOARD QUEUE] blocked example-org/example-repo#412 — Severity has no option matching "S9"; it accepts: …
```

— the second line only when something is blocked, and nothing at all when the repository has no
outstanding work. A repository this queue does not carry is silent, which is what lets one hook ask on
behalf of every project.

## Installing

The plugin carries the code and nothing `npm ci` installs, so it runs from a **clone** of the kit, added as a
local-directory marketplace (which Claude Code loads in place, `node_modules` included):

```sh
git clone https://github.com/hryvinskyi/claude-kit.git ~/src/claude-kit
claude plugin marketplace add ~/src/claude-kit
claude plugin install board-queue@claude-kit
npm ci --prefix ~/src/claude-kit/plugins/board-queue
~/src/claude-kit/bin/install-shims.sh ~/src/claude-kit      # ~/.local/bin/board-queue, board-queue-mcp, …
mkdir -p ~/.config/board-queue
cp ~/src/claude-kit/plugins/board-queue/config.example.json ~/.config/board-queue/config.json
                                                             # name the boards, their repositories, the fields
board-queue install-launchd                                  # macOS; install-systemd on Linux
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.board-queue.plist
launchctl kickstart -k gui/$(id -u)/com.user.board-queue
```

The plugin starts the MCP server itself (`.mcp.json`, as `plugin:board-queue:board-queue`; its tools are
`mcp__plugin_board-queue_board-queue__board_enqueue` and so on). Do not also register a user-scope
`board-queue` server with `claude mcp add`: the plugin's server replaces it, and a user-scope definition
outranks a plugin's, so a stale one would keep answering in its place. A copy of the plugin without its
dependencies — a marketplace added from GitHub is copied into the plugin cache — hands every call to
`~/.local/bin/board-queue` and `board-queue-mcp`, so the clone's installed copy answers; without one it
stops with the `npm ci` line that fixes it.

The configuration is read from `${XDG_CONFIG_HOME:-~/.config}/board-queue/config.json` (or
`$BOARD_QUEUE_CONFIG`). A configuration found only at its previous place, `~/.claude/tools/board-queue/
config.json`, is read from there once, copied to the current one, and a line on the error stream says it
moved and the old file can go.

`install-launchd` writes the job description and the small launcher it runs
(`board-queue-tick.sh` in the state directory); `install-systemd` writes a one-shot
`board-queue.service` and a `board-queue.timer` under `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` and the
same launcher, and prints `systemctl --user daemon-reload` and `systemctl --user enable --now
board-queue.timer`. Every path is absolute and baked in — a scheduled job starts with neither a checkout's
directory nor a person's search path — and the launcher runs the pass through `~/.local/bin/board-queue`,
so it keeps working when the plugin moves. Both commands refuse while that command is not installed, and
print what to run without running it. The launcher also sets `BOARD_QUEUE_SCHEDULED=1`,
and `tick` refuses to run without it: the per-pass cap only spreads the writes over five-minute windows
if nobody runs passes back to back, and a session that empties the queue by hand is spending the
allowance every other session shares. A person operating the schedule sets the variable by hand
(`BOARD_QUEUE_SCHEDULED=1 board-queue tick`); a session reads `status` and waits. Run it again whenever an
upgrade moves the Node binary; until then the launcher falls back to whichever `node` the job's own path
finds. The job runs every 300 seconds and appends to `launchd.log` in the state directory. `launchctl print
gui/$(id -u)/com.user.board-queue` shows what the system thinks of it; `launchctl bootout` removes it
(`systemctl --user status board-queue.timer` and `disable --now` on Linux).

### One queue per person

Each person runs their own queue and worker, with their own credential. The GraphQL allowance belongs to
an account, so one worker per person does not compete with anyone else's. A teammate needs no App: without
a credential file the queue uses the token their own `gh` login holds. An App's private key is never
copied to another person's machine.

This changes what "single writer" means. One worker is the only writer **of its person's actions**; with
several people, several workers write to the same board, each pacing against its own allowance. Every write
is still guarded by the row's version, so two of them meeting on one row is a refusal, never an overwrite.
Work that represents the whole team rather than one person — anything that copies another system's state
onto the board — belongs in exactly one person's worker; enabled in two, it is filed twice.

**The credential.** A scheduled pass (`board-queue tick`) and the MCP server source an environment file when
one exists: `$BOARD_QUEUE_ENV`, else `${XDG_CONFIG_HOME:-~/.config}/board-queue/board-queue.env`, else the
older `~/.claude/secrets/board-queue.env` (`chmod 600`, never tracked — a file any other account can read is
skipped with a line on the error stream). Every other command uses what the environment already holds. It
may set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` — and
`GITHUB_APP_INSTALLATION_ID` to skip the installation lookup — in which case the queue mints an
installation token and the board writes cost the App's allowance rather than the person's.

An installation belongs to one account, so the credential is chosen per board: each board, and the issues
of the repositories it carries, are reached with an installation token of the account that owns the board,
looked up under `/orgs/<owner>` or `/users/<owner>` as its `ownerType` says. Two boards of one account share
one cached token. `GITHUB_APP_INSTALLATION_ID` names a single installation and so is used only while every
configured board belongs to one account; with boards under several accounts each one looks its own
installation up.

`GITHUB_APP_PRIVATE_KEY_PATH` is the **path** to the App's PEM file, itself `chmod 600`. The key text
never belongs in an environment variable, where every child process inherits it and the first message that
mentions it copies it into a log. The older `GITHUB_APP_PRIVATE_KEY` is still read as a path, but a value
carrying a key rather than a path is refused by the variable's name, and no message here ever repeats what
either variable holds.

Without that file the queue falls back to the token the GitHub command line tool holds, and says so once in
the log — which allowance the writes are billed to is otherwise invisible for weeks. `gh auth status` must
then show the **`project`** scope: without it GitHub answers `INSUFFICIENT_SCOPES`, which this queue reads
as a credential that will never get in — it pauses the queue, and the log line names the permission the
answer asked for. The token is cached with a lifetime, fetched only when a gateway first needs one, dropped
and re-minted once on a 401, and never reaches a log line, an error message or the database.

## As a service

The worker that keeps the boards in step on everybody's behalf is better not a person's laptop, which sleeps
and leaves the board hours behind. `board-queue service` runs it as a long-running process — in a container,
from the `Dockerfile` beside this file — under a GitHub App of its own:

```sh
docker build -t board-queue:<version> plugins/board-queue
```

- **The schedule is its own.** A pass runs at start and then every five minutes, timed from the start of the
  last; a pass that runs past its slot delays the next rather than overlapping it. Each pass is
  `board-queue tick` as a process of its own, the way a person's scheduler runs it, with
  `BOARD_QUEUE_SCHEDULED=1` set by the service — the service is the schedule — and the tick lock, the pacing and
  the allowance rules unchanged. A pass gets twenty minutes, inside the half hour after which the lock is taken
  from a holder that looks dead, and is then stopped.
- **Stopping.** SIGTERM or SIGINT ends the wait at once. A running pass gets 25 seconds to finish; then it is
  sent SIGTERM, which ends it where it stands — `tick` has no handler for it, so this is a kill, not a request —
  and SIGKILL ten seconds later if it is somehow still there. Nothing it leaves half done is lost, because every
  action, cursor and report is written in the transaction that records it and the next pass puts back what a
  killed one held. Give the container a stop grace longer than 35 seconds. A pass that is still not reaped five
  seconds after SIGKILL stops the service with exit code 1, so whatever runs it starts it afresh.
- **Its identity is the App's.** Each pass is started with `BOARD_QUEUE_IDENTITY=app`, so it is judged by the
  App's login (`<slug>[bot]`, from `GET /app` signed with the App's key) rather than by a `gh` login, and
  `mirrorOwner` names that login. A person's worker leaves the variable unset and keeps the `gh` check, which
  never stands for an owner whose login ends in `[bot]`; a copied configuration, or the variable set on a machine
  without the App's key, starts nothing there.
- **A pass that declines the job fails.** On a person's machine a worker that is not the owner simply answers.
  In the service each such pass exits with a code of its own — 3 the App's login could not be read, 4 the App
  is not `mirrorOwner`, 5 the forge jobs would not run under the App's credential, 6 the App's key or the token
  was refused — and the heartbeat records which, without anything secret.
- **It refuses to start** without `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` naming a file of the
  service's own account, mode 0400 or 0600 exactly, that holds a private key, and the coordination server's
  token, or when the configuration keeps nothing in step. `GITHUB_APP_INSTALLATION_ID` may be set to skip the
  installation lookup. Every pass checks the key and the token again before it uses them; each file is opened
  once and checked on what was opened. No message repeats the key, its path or a token.
- **Secrets in files.** The token may be given as a file: when `<tokenEnv>_FILE` is set — `DIBS_TOKEN_FILE` for
  `DIBS_TOKEN` — the token is read from the file it names, which must be the account's own and readable by nobody
  else, and setting both is refused. Mount the key and the token as files in one directory rather than one by one:
  a file replaced in the directory by a rename is the one the next pass reads, so a rotated key or token takes
  effect without a restart, while a file mounted on its own stays the old file until the container is recreated.
- **Health.** After every pass it writes `service.json` in the state directory: when it started, the schedule
  it runs to, when the last pass started and ended, how it ended, and how many have failed in a row.
  `board-queue health` reads that file and nothing else, and exits 1 when nothing has happened for longer than a
  pass and the gap after it, when the last pass declined the job, when three passes in a row failed, or when the
  service stopped — which is what the image's `HEALTHCHECK` runs.
- **The report.** The six-hourly report over every board (*The audit*) is the people's to run; set
  `"audit": { "enabled": false }` in the service's configuration so its allowance goes to keeping in step.
- **The container.** The image runs as uid 10001 (a deployment may run it as another unprivileged user), keeps
  everything it writes under `/data` (`BOARD_QUEUE_STATE_DIR`, which the deployment mounts), reads its configuration from
  `/config/config.json` (`BOARD_QUEUE_CONFIG`), and so runs with a read-only root filesystem. Mount the key read-
  only, give the container no published port, and reach the coordination server over the network the two share.
- **The App** is installed on the account that owns the board, for the repositories kept in step only, with
  Issues and Organization projects read/write (the mirror's moves and assignees), Pull requests, Contents and
  Actions read and Commit statuses read/write (the forge jobs), and Metadata read. Its allowance is the App's,
  not a person's.

## Where things live

`~/.claude/state/board-queue/` — never tracked, created on demand, and the owner's alone (the directory is
`0700`, the files in it `0600`): between them they hold the text of every comment this system is about to
post and everything the API answered with.

| file | what it is |
|---|---|
| `queue.db` | the queue itself (SQLite, WAL), the cursor of the mirror, the dependency answers the importer keeps, and what the forge jobs keep: each repository's listing cursor, the pull requests seen and what the server was told of them, the statuses written and the writes of the last hour, each claimed branch's last measure, and the commits holds name |
| `queue.db.before-layout<N>.bak` | a whole copy taken once before the file was brought to layout `N`; delete it once the new version runs |

The file records two numbers. `schema_version` is the oldest generation of this code that can read it, and is
what every release checks; a change of layout that older releases still read leaves it alone, so going back to
an older release never stops the queue. `layout_revision` is the layout written, and only grows. A skipped action
is stored as cancelled, marked in a column older releases never read, so they list it as finished.
| `worker.log` | structured lines from the worker and the tools, credentials redacted |
| `audit.json` | the last report-only pass over every board |
| `service.json` | the heartbeat `board-queue service` writes after every pass, which `board-queue health` reads |
| `launchd.log` | whatever the scheduled job printed |

| `board-queue-tick.sh` | the launcher a scheduled job runs |

`$BOARD_QUEUE_STATE_DIR` moves all of it; `$BOARD_QUEUE_CONFIG` names another configuration file. Both are
what the tests use, and what a second installation would use. The configuration and the credential file
live under `${XDG_CONFIG_HOME:-~/.config}/board-queue/` (see *Installing*).

## Adding a kind

Write a class implementing `ActionKind` in `src/domain/kinds/` — a name, a zod schema for its payload, the
issue it is about, whether two of them merge, and what it does when it runs — and add it to `defaultKinds()`
in `src/domain/kinds/default-kinds.ts`. That is the whole registration: nothing dispatches on a kind's name
anywhere, so no other file learns about it. The MCP tool's description and the CLI's accepted kinds both
come from the registry.

## Working on it

TypeScript run directly by Node; there is no build step. `npm ci` installs the dependencies (the plugin
carries none), `npm test` runs the suite, `npm run typecheck` runs the compiler over everything. Tests use in-memory doubles for the gateways and a real temporary
SQLite database for the queue: what the queue promises is proved against the store it actually runs on.
