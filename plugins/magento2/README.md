# magento2

A stack plugin: the rubrics of the `architecture` plugin in Magento 2's idiom. The core skills state
every rule without naming a framework; this plugin says where each piece goes in a Magento module,
how `di.xml` wires it, and which spellings the detection recipes search for.

| Skill | Load it with | What it holds |
|---|---|---|
| `magento2:magento2-architecture-php` | `architecture:clean-architecture-php` | Service Contracts (`Api/`, `Api/Data/`), `di.xml` preferences, virtual types and pools, plugins and observers, ViewModels, a module layout, DDD-lite, the template side of the browser seam (theme-assets from the PHP side), the core lenses in Magento's names, the stack lines of the implementer checklist |
| `magento2:magento2-architecture-frontend` | `architecture:clean-architecture-js` | The three delivery mechanisms (RequireJS/Knockout, `hryvinskyi/magento2-theme-assets`, Hyvä/Alpine), render modes, load strategies and preload, config and wording from templates, the full-page cache and private data, script-rewriting optimizers, mixins, TypeScript builds, testing, detection recipes, the stack lines of the implementer checklist |

## Install

```sh
claude plugin install magento2@claude-kit
```

The manifest declares a dependency on `architecture`, so Claude Code installs and enables it with
this plugin. A session on a Magento project loads the core skill and this plugin's skill together,
as the core skill says.

This plugin gates nothing by itself. The `guards` plugin is what refuses an edit before the rubric
is loaded; without it, the skills here load whenever a session or an agent asks for them.

## The gate

`stack.json` tells the `guards` plugin's rubric gate what this stack adds; `hooks/register-stack.py`
registers it for each session at `SessionStart` (the registry is described in the `guards` README).
With both plugins enabled, on a Magento project:

| Target | Needs, beside the core skill and its references |
|---|---|
| PHP source | `magento2:magento2-architecture-php` |
| JS/TS source | `magento2:magento2-architecture-frontend` |
| a plan | `magento2:magento2-architecture-php`; when the plan orders browser work, `magento2:magento2-architecture-frontend` in place of `javascript.md` |

A project is a Magento project when the nearest `composer.json` that any registered stack recognises
has a `type` starting with `magento2-` or requires a `magento/` package, or, when none does, its root
has `bin/magento` or an `app/etc/` directory. On every PHP project of the session, a plan naming
RequireJS, Knockout, `uiComponent`, `AssetRendererInterface`, `x-magento-init`, `data-mage-init` or
`Alpine.data` orders browser work, and a file under `Api/Data/` needs the core skill's `ddd.md`.

| Setup | What is gated |
|---|---|
| `guards` and `magento2` | the table above, for `Edit`/`Write` and for files written through the shell |
| `guards` and `magento2` and another stack plugin | the same; a project both declarations recognise needs both stacks' skills |
| `guards` without `magento2` | the core rules only: no stack skill, the words above do not count, `Api/Data/` is not a domain directory |
| `magento2` without `guards` | nothing; the skills load when asked for |

If the declaration cannot be registered (an unwritable state directory, say), the hook prints one
notice at session start and the gate runs the core rules for that session.

Tests, from the kit clone (they reach the gate at `plugins/guards/hooks/` in the same clone):

```sh
bash plugins/magento2/tests/tests.sh
```
