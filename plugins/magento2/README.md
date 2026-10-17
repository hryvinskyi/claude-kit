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
