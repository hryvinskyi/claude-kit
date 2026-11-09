# docs

Documentation skills that write from the product, not from memory. Each skill frames the reader
and their goals, collects a fact list from the code (and the running product, when there is one),
proposes an outline before writing, holds the guide to its own quality bar, and has it reviewed by
a fresh agent that did not write it. An update is a scoped edit with a staleness sweep across the
whole guide, never a rewrite.

| Skill | Reader | Writes |
|---|---|---|
| `docs:user-guide` | A non-technical person who uses the product: a store admin, a merchant, an office user, a customer | Start here, a getting-started lesson, one how-to per goal, how it works, every screen and setting, troubleshooting by symptom, a glossary — in plain language, with exact screen labels and screenshots, and nothing technical in the body |
| `docs:technical-guide` | A developer or operator who installs, configures, integrates, extends or runs the software | An installation guide, a developer guide, a reference, migration notes — with a verified first success, concepts before recipes, goal-named recipes, runnable samples, honest uninstall notes |

Each skill has three modes — **Write**, **Update** and **Review** — and its bar lives in
`references/quality-bar.md`, used by the author for the self-check and by the reviewer, numbered the
same in both.

## Stacks

The skills name no framework. A stack plugin adds a docs skill that says where its framework keeps
the facts (screens, settings, permissions, messages, commands, endpoints), which document each
belongs in, how the platform's own documentation words things, and the front matter of a guide:

| Stack plugin | Docs skill |
|---|---|
| `magento2` | `magento2:magento2-docs` |

## Rendering

The Markdown file is the deliverable. To also get PDF, DOCX or a site, declare a renderer in your
`CLAUDE.md` or the project's:

```
Docs renderer: <command>
```

Point the declaration at the renderer's documentation of its front matter and markup, if
`<command> --help` does not cover them. The skills read it, write the guide in that markup, render
the finished guide and check the output. They never install a renderer themselves.

## Install

```sh
claude plugin install docs@claude-kit
```

The stack plugins that ship a docs skill depend on this plugin, so installing one of them installs
it too.
