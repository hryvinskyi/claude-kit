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
