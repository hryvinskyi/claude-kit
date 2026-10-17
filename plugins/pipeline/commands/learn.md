---
description: Extract reusable patterns from this session — cross-project ones become global skills, project-specific ones go to the project's knowledge vault
argument-hint: "[optional: which insight to extract]"
---

# /pipeline:learn — Extract Reusable Patterns

Analyze the current session and extract patterns worth keeping. Scope to `$ARGUMENTS` if given, otherwise the most valuable insight(s) of the session.

## What to extract

1. **Error-resolution patterns** — error → root cause → fix; reusable for similar errors?
2. **Debugging techniques** — non-obvious steps, tool combinations, diagnostic patterns
3. **Workarounds** — library quirks, API limitations, version-specific fixes
4. **Conventions discovered** — codebase patterns, integration patterns, architecture decisions

Don't extract trivia (typos, simple syntax errors) or one-time issues (a specific outage). One pattern per skill.

## Routing — where does each pattern belong?

- **Reusable across projects** → a global skill (format below). Check `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/` and the plugin skills this session lists first — extend an existing skill instead of duplicating.
- **Specific to this project** → NOT a global skill. Record it where the project keeps knowledge: its knowledge vault (`/decision` for choices, a module note for module facts) or its `CLAUDE.md`/`.claude/docs/`, per the project's conventions.

## Global skill format

Save as `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/<kebab-slug>/SKILL.md` (a user-scope skill; a plugin's own skills are edited in that plugin's source repository, never in an installed copy) — a skill only loads from a `SKILL.md` with frontmatter, and the `description` is what makes it discoverable, so include the trigger conditions in it:

```markdown
---
name: <kebab-slug>
description: <what it does + when to use it — include the concrete trigger words/situations>
---

# <Descriptive Pattern Name>

## Problem
<what this solves — be specific>

## Solution
<the pattern/technique/workaround>

## Example
<code example if applicable>

## When to use
<trigger conditions>
```

## Process

1. Review the session for extractable patterns
2. Identify the most valuable/reusable insight(s) and decide the routing for each
3. Draft the content
4. Show the user the draft + destination and confirm before saving
5. Save
