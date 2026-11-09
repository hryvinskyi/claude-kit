---
name: technical-guide
description: |
  Write, update or review technical documentation for the people who install, configure,
  integrate, extend or operate software: a developer guide, an installation and upgrade
  guide, a configuration, CLI or API reference, migration notes, a module's or package's
  README-level docs. Use for "developer guide", "installation guide", "technical docs",
  "API reference", "технічна документація", "інструкція для розробника", "як встановити",
  or when a guide must cover requirements, install, configuration codes, commands,
  endpoints, events or extension points. Every command, path, signature and sample comes
  from the code and is run where it can be; a fresh-context review checks the guide before
  it ships. Not for non-technical end-user help (docs:user-guide).
---

# Technical guide

A technical guide answers one question: **can a developer or an operator install the software,
understand how it works, do what they came to do, and recover from the common failures from this
guide alone, with every command and sample working on the version it names?**

Its readers are technical but busy and new to *this* software. They want the shortest path to a
verified result, then the model behind it, then recipes, then the reference. They never want
marketing, and they stop trusting a guide after the first command that fails.

## Load with

- **The stack skill**, when a stack plugin covers the project: that plugin's docs skill
  (`magento2:magento2-docs` on Magento 2). It says where the framework keeps requirements,
  configuration, commands, endpoints, events and extension points, the platform's install and
  deploy sequence, and the front matter of a guide. Without one, apply this skill in the stack's
  idiom and say so.
- `references/method.md` before the first section: the kinds of technical document and their
  outlines, archetypes, sample and command rules, the reference conventions, the update sweep.
- `references/quality-bar.md` before the self-check and in Review mode: the 14 conditions, the
  overlap guards and the review report.

## Kinds of technical document

| Kind | Reader | Answers |
|---|---|---|
| **Installation guide** | whoever installs, upgrades, operates or removes the software | Requirements, install, verify, configure for production, upgrade, uninstall, operate (schedules, queues, logs, caches) |
| **Developer guide** | a developer integrating with or extending the software | First verified success, concepts, recipes, an end-to-end tutorial, practices, troubleshooting, versioning |
| **Reference** | anyone looking one thing up | Every setting, command, endpoint, event, extension point: complete, neutral, one entry each |
| **Migration notes** | someone moving between major versions | Each breaking change with before and after, in the order to apply them |

A small package may ship them as chapters of one document. Each fact still lives in exactly one
place: the reference holds the catalog, and the guides link into it instead of copying it.

## Three modes

| Mode | When | Output |
|---|---|---|
| **Write** | No guide exists, or a new kind is asked for | The guide, its fact list, the record of what was run, a review verdict, a rendered copy when a renderer is declared |
| **Update** | The software changed (a release, a rename, a removal) or a reader reports a wrong part | A scoped edit with a full staleness sweep and a history row, never a rewrite |
| **Review** | A finished guide is to be judged | `VERDICT: approve` or `VERDICT: revise` with findings; the reviewer never edits the guide |

## Write

### 1. Frame the guide

Settle from the request and the project, asking the user only what neither answers:

- **Reader and kind** (the table above): one reader per document.
- **Version** the guide describes, and the platform and language versions it supports.
- **Goals**: what the reader came to do (install it, call it from their code, add a variant through
  an extension point, run it in production).
- **Scope**: what is in, what is out, what lives in another document.

### 2. Collect the facts from the code

Build a **fact list** before writing: requirements and their versions, every install and deploy
step, every setting (name, path or key, type, default, where it applies, effect), every command
with its arguments and options, every endpoint or public interface with its inputs, outputs and
errors, every event and extension point, every schedule, queue and log, every table or file the
software creates, every error message, each with **its source** (file and line, `--help` output,
the manifest). The stack skill says where each kind of fact lives. Read the existing README and
changelog for tone and history; trust the code over them.

**Run what can be run.** On an environment the project allows you to use: each command's `--help`,
the install sequence on a scratch instance, each sample against the version the guide names.
Record what was run and its output. A command or sample you could not run is marked as unverified
in your report, and a fact you could not find is an **assumption**, never a guessed signature.

### 3. Find the archetype

A library or SDK, a command-line tool, an API, a framework module or plugin, a service someone
operates: often several at once. The archetype sets the emphasis (`references/method.md`
§Archetypes): a CLI needs exit codes and the output contract, an API its authentication and
errors, a module its extension points and its install and removal.

### 4. Propose the outline and wait

Show the user the outline before writing the body: contents with one line per section, the reader,
the goals, the version, the assumptions, what is out of scope. Wait for approval unless they told
you to go ahead or to work unattended. The default outlines are in `references/method.md`.

### 5. Write each part in its mode

- **Start here.** What the software does and the problem it solves (two sentences), who the guide
  is for, prerequisites, and the path through the guide for each kind of reader. Say plainly where
  the reference lives.
- **First verified success.** The shortest complete path from nothing to one real result: install,
  configure, one real call or run, then a **verify** step with the literal expected output. Not a
  hello-world: a result that shows what the software is for. Credentials and secrets come from the
  environment or the configuration, never written into a sample; say where they are obtained and
  steer through a test or sandbox mode where there is one. Close with the two or three most common
  first-run failures.
- **Concepts, before the recipes.** The mental model: the main objects and how they relate, what
  happens on a request or a run, synchronous and asynchronous parts, environments, where state
  lives. Explanation, no steps.
- **Recipes (how-to guides).** One per common goal, named by the goal ("Add a carrier", not
  "CarrierPoolInterface"). Each: what it needs, the focused code or commands, the result, and a link
  into the reference for the full option set. Independently followable.
- **End-to-end tutorial.** Build one small real thing from start to finish, kept separate from the
  recipes. Optional for a small package, never fused with the recipes.
- **Practices.** What production use needs, proportional to the software: secrets and permissions,
  errors that are retryable and errors that are not, retries with backoff and idempotency for
  writes, pagination, rate limits, webhooks and their signatures, timeouts, resource reuse,
  performance and cache behavior. A recommended pattern and a short sample each, not an option dump.
- **Reference.** Complete and neutral, one entry per item in a fixed shape
  (`references/method.md` §Reference entries), ordered as the software orders it.
- **Troubleshooting.** The frequent, knowable failures by symptom: the exact message or output,
  the cause, the fix; an error-code table where the software has codes; how to collect what support
  needs. Never "check the logs" without saying which log and what to look for.
- **Versioning and migration.** The version scheme, what a major, minor and patch release means,
  the deprecation policy, a link to the changelog, and before-and-after notes for each breaking
  change.
- **Document history.** The guide's own version and changes.

### 6. Hold samples and commands to a working standard

- Copy-pasteable: no shell prompt, one command per line, full option names, placeholders written
  `<like_this>` and explained right after.
- Every sample states or inherits the version it targets, and uses only what the fact list shows.
- No secret, token, password or real hostname in a sample; read them from the environment or name
  where they are set.
- Commands that change data or are destructive say so before the block, with how to undo or back up.
- Production-only and development-only steps are marked as such.
- Technical prose is still plain prose: short sentences, every abbreviation defined on first use.

### 7. Check, then review in a fresh context

1. Run the 14 conditions of `references/quality-bar.md` yourself and fix every miss.
2. Hand the guide, the fact list and the record of what was run to a **fresh agent** that did not
   write it, with the instruction to load this skill in **Review mode** (and the stack skill).
3. Fix every confirmed finding; answer the wrong ones with the fact that shows it. One round, then
   one check of the fixes.

### 8. Render

When the project's or the user's instructions declare a renderer (a line such as
`Docs renderer: <command>` in `CLAUDE.md` or `AGENTS.md`), read what the declaration points to for
its front matter and markup (or `<command> --help` when it points nowhere), follow it, render the
guide, and look at the result: page count, the contents page, every table, code block and image, no
raw markup left. Without a declared renderer the Markdown file is the deliverable. Never install a
renderer on your own.

## Update

Technical guides go stale fastest: their subject ships every release.

1. **Scope** the change: which steps, samples, reference entries, concepts and requirements it
   touches, for which version.
2. **Edit in place**; never regenerate the guide, which loses still-correct material and history.
3. **Sweep for staleness**: for each changed, renamed, deprecated or removed setting, command,
   signature, endpoint, event or requirement, find every place the guide mentions it (samples,
   recipes, concepts, first success, reference, troubleshooting, install steps, requirements table)
   and make each match the current version. A sample that still calls something removed is the
   worst defect a technical guide can have.
4. **Re-check coherence**: the first success still verifies; concepts still precede the recipes
   that use them; the tutorial still runs.
5. **Version**: bump the guide's own version and add a history row; update the version the guide
   targets.
6. **Mark** deprecated and removed items with the version and the replacement, so a reader still on
   the old version finds their way.

Then review the changed parts in a fresh context.

## Review

Run in a context that did not write the guide. Judge, never edit.

1. Read the guide as its reader would, then the fact list and the record of what was run (or the
   code itself when they did not come with the guide).
2. Spot-check every load-bearing command, signature and sample against the code; run what the
   environment allows.
3. Judge each of the 14 conditions of `references/quality-bar.md`, and emit one line,
   `VERDICT: approve` or `VERDICT: revise`, then the findings, most blocking first, each with the
   condition number, the location and a concrete fix.

## Rules

- **Never fabricate.** No invented command, option, setting, signature, endpoint, event or error
  message. A missing fact is a stated assumption.
- **Run what can be run**, and say what was not.
- **First success is verified**, with the expected output shown.
- **Concepts before recipes; recipes named by goal; the tutorial separate.**
- **One home per fact**: the reference holds the catalog, the guides link into it.
- **No secrets in samples.** Read them from the environment or configuration.
- **Proportional**: a small package gets a short guide that still installs, verifies and recovers.
- **Updates are scoped, swept and versioned**; deprecated and removed items are marked, not
  silently deleted.
- **The author never approves their own guide.** The review runs in a fresh context.
