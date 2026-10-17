# symfony

A stack plugin: the rubrics of the `architecture` plugin in Symfony's idiom. The core skills state
every rule without naming a framework; this plugin says where each piece goes in a Symfony project,
how the container wires it, and which spellings the detection recipes search for.

| Skill | Load it with | What it holds |
|---|---|---|
| `symfony:symfony-architecture-php` | `architecture:clean-architecture-php` | Layouts for a context and for a modular-monolith package, Doctrine mapping and repositories, Messenger handlers and transactions, `services.yaml` wiring and tagged iterators, API Platform resources, events, Deptrac, testing, detection recipes, generated factories and native lazy services, the core lenses in Symfony's names, the stack lines of the implementer checklist |
| `symfony:symfony-architecture-frontend` | `architecture:clean-architecture-js` | AssetMapper, Encore and Vite pipelines, Stimulus controllers, wording from Twig, per-package asset registration, Turbo, Live and Twig Components, React islands, CSRF and CSP, testing, detection recipes, the stack lines of the implementer checklist |

## Install

```sh
claude plugin install symfony@claude-kit
```

The manifest declares a dependency on `architecture`, so Claude Code installs and enables it with
this plugin. A session on a Symfony project loads the core skill and this plugin's skill together,
as the core skill says.

This plugin gates nothing by itself. The `guards` plugin is what refuses an edit before the rubric
is loaded; without it, the skills here load whenever a session or an agent asks for them.

## The gate

`stack.json` tells the `guards` plugin's rubric gate what this stack adds; `hooks/register-stack.py`
registers it for each session at `SessionStart` (the registry is described in the `guards` README).
With both plugins enabled, on a Symfony project:

| Target | Needs, beside the core skill and its references |
|---|---|
| PHP source | `symfony:symfony-architecture-php` |
| JS/TS source | `symfony:symfony-architecture-frontend` |
| a plan | `symfony:symfony-architecture-php`; when the plan orders browser work, `symfony:symfony-architecture-frontend` in place of `javascript.md` |

A project is a Symfony project when the nearest `composer.json` that any registered stack recognises
requires `symfony/framework-bundle` or `symfony/symfony`, or, when none does, its root has
`bin/console` or `config/bundles.php`. On every PHP project of the session, a plan naming Stimulus or
`stimulus_controller` orders browser work. On a Symfony project the JS of a page is not treated as a
React app because `package.json` depends on React: `react.md` is asked for a `.jsx`/`.tsx` file, or
under a `tsconfig.json` that sets `jsx`.

| Setup | What is gated |
|---|---|
| `guards` and `symfony` | the table above, for `Edit`/`Write` and for files written through the shell |
| `guards` and `symfony` and another stack plugin | the same; a project both declarations recognise needs both stacks' skills |
| `guards` without `symfony` | the core rules only: no stack skill, the words above do not count, and on a project whose `package.json` depends on React every JS/TS file needs `react.md`, a Stimulus controller included |
| `symfony` without `guards` | nothing; the skills load when asked for |

If the declaration cannot be registered (an unwritable state directory, say), the hook prints one
notice at session start and the gate runs the core rules for that session.

Tests, from the kit clone (they reach the gate at `plugins/guards/hooks/` in the same clone):

```sh
bash plugins/symfony/tests/tests.sh
```
