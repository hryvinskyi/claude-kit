# Technical guide — method in depth

The depth behind `SKILL.md`. Load it before writing the first section.

## The reader and their reach

A technical document has one reader. Before the outline, write down who it is and what they can
reach, and record with every fact who can use it.

| Reader | Reaches | Their document |
|---|---|---|
| An integrator outside the team | The interface: calls, events, the client library, their own keys | Developer guide, reference |
| A developer who extends the software | The source, the extension points, a development copy | Developer guide, reference |
| An operator | The servers: configuration, commands, logs, deploys | Installation guide |
| The vendor's own staff, or an operator working by the screen | The screens and commands reserved for them | Administration guide |
| A person who uses the product | The product's own screens | The user guide (`docs:user-guide`), never a technical document |

### The contract, not what is behind it

An integrator sees requests and responses. Describe those.

| Written from the inside | Written as the contract |
|---|---|
| "The handler writes the row and a worker updates the search index from the queue." | "A new record can take up to 10 seconds to appear in search results. Read again before you report it missing." |
| "The token is checked against the cached key table." | "A revoked key is refused within one minute." |
| "The service returns the entity's status column." | "`status` is one of `open`, `closed`, `archived`." |

What is behind the interface belongs in the document of the reader who can reach it: the developer
who extends the software, the operator who runs it.

### A fix the reader cannot apply

When the cure for an error is on a screen or a server this reader does not have, the entry says who
has it and what to ask them for:

> `403 scope_missing` — the key may not read orders. Ask an administrator of the account to add
> **Read orders** to the key (**Settings** > **Access keys**), then call again with the same key.

Not "enable the scope in the settings", which the developer cannot do, and not the administrator's
steps in full: one line and the name of the setting.

### Material in the wrong document

- A screen an end user works in, found in a technical document: it goes to the user guide.
- A screen or a command reserved for an operator or the vendor's staff, found in the user guide: it
  comes here, into the administration guide. This is the usual direction after a change that
  restricts who may use something.
- An operator's procedure found in an integrator's guide, or the reverse: each to its own document.

Name every move in your report. A document that does not exist yet is proposed in the outline; the
material does not stay in the wrong place while it waits.

## Outlines

Starting points for the outline you propose, not forms to fill. Collapse what the software does not
need; never add a section with nothing true in it.

### Installation guide

| # | Section | Holds |
|---|---|---|
| 1 | Start here | What it is, who installs it, what this guide covers and what it leaves to other documents |
| 2 | Requirements | Platform, language and service versions with both ends of each range; editions; extensions; other packages it needs; permissions the installer needs |
| 3 | Install | The exact sequence for each supported method, then a **verify** step with the expected output |
| 4 | Configure | What must be set before first use, by the screen or by the command line; secrets and where they are kept |
| 5 | Run in production | Schedules, queue consumers, workers, cache behavior, file permissions, performance notes, what to monitor, where it logs |
| 6 | Upgrade | Per version line: the steps, data migrations, what to back up, how to roll back |
| 7 | Uninstall | The steps, and **what stays behind**: tables, files, configuration rows, data in other systems |
| 8 | Troubleshooting | Install and run failures by symptom |
| — | Document history | The guide's own versions |

### Administration guide

| # | Section | Holds |
|---|---|---|
| 1 | Start here | Who it is for (an operator, the vendor's staff), the access it assumes, what it leaves to the installation guide |
| 2 | Tasks | One recipe per task only this reader can do, named by the task ("Close a customer's account"): what you need (the role, the screen or the command), the steps, the result |
| 3 | What it means for the customer | For each task that touches a customer's space: what changes for them, what they see and are told, what is recorded and who can read the record, how to undo it |
| 4 | Screens and commands | Reference: every screen and command reserved for this reader |
| 5 | Troubleshooting | Failures by symptom |
| — | Document history | The guide's own versions |

It never repeats the user guide. Where a staff task ends in something the customer then does, link
the user guide's how-to.

### Developer guide

| # | Section | Holds |
|---|---|---|
| 1 | Start here | What it does, the problem it solves, who the guide is for, the path through it, where the reference lives |
| 2 | First verified success | Install → configure → one real call or run → verify with the expected output; the common first failures |
| 3 | Concepts | The model: main objects and relations, the lifecycle of a request or a run, environments, where state lives |
| 4 | Recipes | One per common goal, named by the goal; focused code; result; link into the reference |
| 5 | Tutorial | One small real thing built end to end |
| 6 | Practices | Production patterns, proportional to the software |
| 7 | Troubleshooting | Frequent failures by symptom; error-code table; what to send to support |
| 8 | Versioning and migration | Scheme, deprecation policy, changelog link, before/after per breaking change |
| — | Document history | The guide's own versions |

### Reference

One chapter per kind of item (settings, commands, endpoints, events, extension points, schema),
each ordered the way the software orders it (screen order, command name, route), each entry in the
fixed shape below.

## Archetypes

A piece of software is often several; the emphasis adds up.

- **Library or SDK.** First success per supported language; the client's lifecycle (create once,
  reuse); idiomatic error handling; thread or request safety; versions of the language supported.
- **Command-line tool.** Synopsis, arguments and options with defaults; **exit codes** and their
  meaning; what goes to standard output and what to standard error; non-interactive and scripted
  use; destructive commands and their confirmation; examples for the common tasks.
- **API (HTTP, RPC, GraphQL).** Authentication and where credentials come from; request and response
  shapes; errors with status codes and their bodies; pagination; rate limits; idempotency of
  writes; webhooks with signature verification; versioning of the API itself. A `curl` example and
  one in the reader's main language.
- **Framework module, plugin or extension.** Where it hooks in (events, interceptors, extension
  points, configuration it adds); what it changes in the host's behavior; what it stores; how to
  extend it without editing it; compatibility with the host's versions; install, upgrade and
  removal through the host's own tooling.
- **Operated service.** Deployment, configuration by environment, health checks, metrics and logs,
  scaling, backups and restore, incident hints.

## Reference entries

One entry per item, all entries of a kind in the same shape, so the reader learns the shape once.

| Kind | Fields |
|---|---|
| Setting | Label as shown · key or path · type and allowed values · default · where it applies (global, per site, per store…) · effect · since version · how to set it outside the screen (command, environment) |
| Command | Name · synopsis · what it does · arguments · options with defaults · exit codes · example · whether it changes data |
| Endpoint | Method and path · purpose · authentication and permission · parameters (name, in, type, required, default) · request example · response example · errors · rate limits · since version |
| Event or hook | Name · when it fires · what it carries · what a listener may change · since version |
| Extension point | The interface or contract · what to implement · how to register it · an example · stability promise |
| Table or file | Name · what it holds · who writes it · retention · removed on uninstall or not |

- Neutral and complete: describe, do not instruct; every item the software exposes, none it does not.
- Names exactly as in the code, in code style.
- A deprecated item stays, marked with the version and the replacement, until the version that
  removes it.

## Samples and commands

- **Runnable as shown**, on the version the guide names. Prefer samples copied from code that runs
  (the package's own tests or examples) over samples written for the page.
- **Self-contained**: imports and setup shown, or the recipe states what it builds on.
- **Focused**: only the lines that matter for the goal; elide the rest with a comment, not silently.
- **Copy-pasteable**: no prompt characters, one command per line, full option names, the working
  directory stated once in the block's title or the sentence before it.
- **Where it runs**: which machine or container, which directory, as which user, for every block
  or once for the page. A document uses one way of invoking a tool; where two exist (on the host,
  inside a container), it says once how to turn one into the other.
- **Placeholders** written `<like_this>`, each explained right after the block.
- **No secrets, no real hosts**: read secrets from the environment; use example domains. A key
  shown for its format is visibly not a key (`pk_live_<your key>`), never a full-length value, and
  never one that works on any system, a development one included.
- **Destructive commands** are announced before the block, with backup and undo.
- **Expected output** after any command whose output the reader must check.

## Practices, proportional

Cover only what the software has; each with the recommended pattern and a short sample.

- Secrets: environment or secret store, least privilege, separate test and live credentials.
- Errors: which are retryable and which are not; what to show a user, what to log.
- Retries: backoff with jitter, honor `Retry-After`, an idempotency key on writes.
- Pagination: the loop or iterator; the dropped-cursor mistake.
- Rate limits: the limits, the response, how to stay under.
- Webhooks and callbacks: signature verification, replays, ordering, retries.
- Resource use: reuse clients and connections, timeouts everywhere, memory on large data.
- Caching and performance: what is cached, what invalidates it, the cost of the slow paths.
- Security: what input is trusted, where output is escaped, which permissions the software checks.

## The software as it is

The guide describes the version it names. It is not the changelog.

- **No history outside the migration notes.** "In this release", "changed in this release", "now",
  "no longer", "used to", "previously" tell the reader about a version they may never have run, and
  "this release" is false after the next one. A box at the top of a reference that says what
  changed is a migration note in the wrong place.
- **Every change carries its version.** In the migration notes, each change sits under the version
  it arrived in, with before and after. A requirement that arrives with a release names the
  release: "from 3.2, send the `Origin` header", never "before you upgrade to a release that
  requires it".
- **A claim with a clock goes stale.** "Currently", "at the time of writing", "for now", "recently".
  Write the fact with the version it holds for, or the date and what was measured, or leave it out.
- **What is not built is not documented as there.** No planned endpoint, no option that does
  nothing yet, no "to be done". A gap the reader has to work round is written as the work-round,
  with the condition it applies under. An experimental item is marked with its stability.
- **When the model changes, the pages that explained the old one are rewritten.** A guide that
  still walks through a retired mechanism on one page and denies it on another is worse than
  either.

## Plain technical prose

Technical readers still read prose. Short sentences, purpose first, every abbreviation defined on
first use, no marketing words, no "simply" or "just". A sentence explains why when the why changes
what the reader does ("run it after every deploy, because the cache holds the old value").

## Sweeps

Run these over the guide before the self-check, in Write and in Update. A hit is a place to read,
not a defect by itself. Settle every hit: fix it, or know why it stands.

```bash
# Another reader: an end user's screen in an integrator's guide, a fix the reader cannot apply
rg -n -i 'click|open (the )?settings|in the admin|ask (your|an) admin|your (workspace|store|account) settings' <guide>

# History, and words with a clock
rg -n -i '(in|changed in|new in|before|since) this (release|version)|used to|no longer|previously|until now' <guide>
rg -n -i '\b(now|currently|recently|for now|at the time of writing)\b' <guide>
rg -n -i 'a (later|newer|future) (release|version)|before you upgrade|once .* (ships|lands)' <guide>   # a change with no version

# Not built
rg -n -i 'not yet|to be (done|decided|measured)|planned|coming|will be (added|supported)' <guide>

# Secrets, and hosts that are not examples
rg -n -e '(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_]{16,}' -e 'AKIA[0-9A-Z]{12}' -e '-----BEGIN' -e 'eyJ[A-Za-z0-9_-]{20,}\.' <guide>
rg -n -o -i '\b[a-z0-9-]+(\.[a-z0-9-]+)+\.(com|net|io|dev|app|org)\b' <guide> | sort -u    # each one: an example domain, or the product's public address?
```

Then two sweeps no pattern can do:

- **Where it runs.** For every block of commands, find the sentence that says on which machine, in
  which directory and as which user it runs. None: add it.
- **Two homes.** For each table, each limit and each default, search its distinctive words across
  the whole document set. Where a second copy stands, compare the two before you delete one: where
  they differ, the code decides which is right, and the wrong one was a defect a reader has already
  met. The copy becomes a link.

## The update sweep

1. **Scope** the change: steps, samples, reference entries, concepts, requirements, for which
   version.
2. **Edit in place.**
3. **Check reach**: who can use each changed thing now. What left this reader's reach goes to the
   document of the reader who holds it; a screen that became the staff's own comes out of the user
   guide and into the administration guide.
4. **Sweep every part** for each changed, renamed, deprecated or removed item: samples, recipes,
   concepts, first success, reference, troubleshooting, install and upgrade steps, the requirements
   table, the version stamps. Search for the old name across the whole document set.
5. **Re-check coherence**: the first success verifies; concepts precede the recipes; the tutorial
   runs; the reference matches the code.
6. **Version**: the guide's own version and history row; the version the guide targets.
7. **Mark** deprecated and removed items with version and replacement; add migration notes for a
   breaking change, under its version. Nothing else in the guide tells what changed.
8. **Run §Sweeps** over the whole guide, not only over the changed parts.
