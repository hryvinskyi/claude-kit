# Technical guide — method in depth

The depth behind `SKILL.md`. Load it before writing the first section.

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
- **Placeholders** written `<like_this>`, each explained right after the block.
- **No secrets, no real hosts**: read secrets from the environment; use example domains.
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

## Plain technical prose

Technical readers still read prose. Short sentences, purpose first, every abbreviation defined on
first use, no marketing words, no "simply" or "just". A sentence explains why when the why changes
what the reader does ("run it after every deploy, because the cache holds the old value").

## The update sweep

1. **Scope** the change: steps, samples, reference entries, concepts, requirements, for which
   version.
2. **Edit in place.**
3. **Sweep every part** for each changed, renamed, deprecated or removed item: samples, recipes,
   concepts, first success, reference, troubleshooting, install and upgrade steps, the requirements
   table, the version stamps. Search for the old name across the whole document set.
4. **Re-check coherence**: the first success verifies; concepts precede the recipes; the tutorial
   runs; the reference matches the code.
5. **Version**: the guide's own version and history row; the version the guide targets.
6. **Mark** deprecated and removed items with version and replacement; add migration notes for a
   breaking change.
