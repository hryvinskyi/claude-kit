---
name: magento2-docs
description: |
  Magento 2's idiom for the docs:user-guide and docs:technical-guide skills. Covers where a
  module keeps the facts its documentation needs (system.xml, acl.xml, menu.xml, UI
  components, layouts, i18n, admin messages, crontab, queues, email templates, webapi.xml,
  GraphQL schema, di.xml, events, CLI commands, db_schema, composer.json), and which
  document each fact belongs in. The User Guide is for store admins and merchants; the
  Installation Guide and Developer Guide are for developers and operators. It also covers
  Magento's wording (Admin, Storefront, scopes, admin paths, Save Config, cache messages,
  user roles, bin/magento) and a module guide's front matter. Use together with
  docs:user-guide or docs:technical-guide whenever documentation of a Magento Open Source or
  Adobe Commerce module, extension or theme is written, updated or reviewed.
---

# Magento 2 documentation

Load this skill together with `docs:user-guide` or `docs:technical-guide`. A file named without a
skill (`method.md`, `quality-bar.md`) is that core skill's. The core skills carry the method and the
bar; this skill says where a Magento module keeps its facts, which document each belongs in, and
how Magento's own documentation words things.

## 1. The document set of a module

A module serves several readers, and each gets its own document. Most "too technical" guides come
from writing one manual for all of them.

| Document (`doc-type`) | Reader | Holds | Never holds |
|---|---|---|---|
| **User Guide** (`docs:user-guide`) | Store admin, merchant, content or support staff, and, for storefront features, what the customer sees | What the module does for the business; every admin screen and setting explained by its effect; what changes on the storefront; giving a colleague access (user roles); troubleshooting by what the admin sees | Composer, `bin/magento`, configuration paths, ACL resource IDs, class names, XML, database tables, log files |
| **Installation Guide** (`docs:technical-guide`) | Developer or operator who installs and runs it | Requirements; install and deploy sequence; verify; configuration from the command line; cron, queue consumers, indexers, caches; upgrade; uninstall and what it leaves | How to use the admin screens beyond a pointer to the User Guide |
| **Developer Guide** (`docs:technical-guide`) | Developer who integrates with or extends it | Concepts; service contracts (`Api/`, `Api/Data/`); extension points (pools in `di.xml`, events, plugin targets); REST and GraphQL; CLI reference; schema; versioning and backward compatibility | Store-admin tasks |
| **User Manual** | One file for all readers, when the owner asks for one | The User Guide's chapters first, written for the store admin, then the technical material in appendices titled for their reader ("Appendix A — For developers: installation") | Technical material anywhere before the appendices |

When the user asks for "a manual" without saying for whom, propose the User Guide plus an
Installation Guide (or one User Manual with technical appendices) in the outline, and let them pick.

## 2. Where the facts live

Read these into the fact list before writing. The path is relative to the module root
(`app/code/<Vendor>/<Module>/` or the package in `vendor/`).

| Fact | Source | How to read it | Document |
|---|---|---|---|
| Admin menu entries and their path | `etc/adminhtml/menu.xml` | Follow each `parent` up to the top-level menu; the `title` attributes, joined, are the path the admin clicks | User Guide (path); Developer Guide (resource) |
| Settings | `etc/adminhtml/system.xml` | Tab, section, group and field `label`s; `comment` and `tooltip` (the screen's own explanation); `showInDefault`, `showInWebsite`, `showInStore` (where it can be set); `depends` (when it is visible); `source_model` (read its `toOptionArray()` for the option labels); `backend_model` (validation, encryption) | User Guide (labels, effect, options, where it applies); technical (path `section/group/field`) |
| Defaults | `etc/config.xml` | The value under the same `section/group/field`; map it to the option's label for the User Guide | both |
| Permissions | `etc/acl.xml` | Each resource's `title`, nested as the **Role Resources** tree shows it; the `id` for the technical docs | User Guide (as a task); technical (ID table) |
| Grids, forms, buttons | `view/adminhtml/ui_component/*.xml`, button classes under `Block/Adminhtml/` | Column, filter, field and fieldset `label`s; mass actions; button `label` from `getButtonData()`; `notice` texts | User Guide |
| Exact wording | `i18n/en_US.csv` and the other locales | The first column is the source string; a guide in another language uses that locale's second column | both |
| Messages the admin sees | Controllers and services | `addSuccessMessage`, `addErrorMessage`, `addNoticeMessage`, `addWarningMessage`, and `LocalizedException(__('…'))` texts | User Guide troubleshooting (as the admin sees them); technical troubleshooting |
| What runs on its own | `etc/crontab.xml`, `etc/cron_groups.xml` | Job names, schedules or the setting that holds the schedule, the cron group | User Guide (in plain words: "every night"); Installation Guide (cron must run) |
| Message queues | `etc/communication.xml`, `etc/queue_*.xml` | Topics and consumers | Installation Guide (consumers must run, how to start them) |
| E-mails | `etc/email_templates.xml`, `view/*/email/` | Template labels as **Marketing** > **Communications** > **Email Templates** lists them; the settings that pick them | User Guide |
| Storefront | `etc/frontend/routes.xml`, `view/frontend/layout`, `view/frontend/templates` | Pages and blocks the customer sees, their URLs | User Guide (what the customer sees) |
| Indexers and caches | `etc/indexer.xml`, `etc/mview.xml`, `etc/cache.xml` | Indexer and cache type titles | User Guide (when to refresh, in plain words); Installation Guide |
| CLI | `Console/Command/*`, registered in `etc/di.xml` | `bin/magento <command> --help` on an instance; else the command's `configure()` | Installation and Developer Guide |
| Web API | `etc/webapi.xml`, `etc/schema.graphqls` | Routes, methods, the service interface and its ACL resource; GraphQL types, queries and mutations | Developer Guide |
| Extension points | `Api/` interfaces (marked `@api`), `etc/di.xml` pools and virtual types, `etc/events.xml` and the events the module dispatches | What a developer implements or listens to, and how to register it | Developer Guide |
| Stored data | `etc/db_schema.xml`, `Setup/Patch/Data/*` | Tables and columns; data the patches write; what stays after removal | Installation Guide (uninstall); Developer Guide (schema) |
| Requirements and version | `composer.json`, `etc/module.xml` | Package name, version, `require` (PHP range, `magento/framework` and module constraints), `<sequence>` | Installation Guide; the front matter |
| History | `CHANGELOG.md`, git tags | What changed in each version | Document history, migration notes |

Useful sweeps (run from the module root):

```bash
rg -n 'label|comment|tooltip|showIn|depends|source_model' etc/adminhtml/system.xml
rg -n 'title=' etc/acl.xml etc/adminhtml/menu.xml
rg -n 'add(Success|Error|Notice|Warning)Message|LocalizedException\(\s*__\(' --type php
rg -n '<job |<schedule>|<config_path>' etc/crontab.xml
rg -n '<route |resource ref=' etc/webapi.xml
```

**Look at the admin, too.** When a development instance is available, open every screen the guide
describes: the layout, the field order, what a scope switch hides, and labels another module
changes. Take screenshots there (`method.md` §Screenshots). Use a store with invented data only;
never a production admin, never a screen holding real customer or order data.

## 3. Wording

The words Magento's own documentation uses, so the guide matches the screens the reader sees.

- **Product name.** "Magento Open Source and Adobe Commerce" on first mention, "Magento" after.
  Never "Magento 2 CE/EE".
- **Admin and Storefront.** "Admin" for the back office, "Storefront" for what customers see. Not
  "backend", "frontend", "admin panel" or "dashboard" in a User Guide.
- **Admin labels** in bold, in the admin's own case: set **Enable Labels** to **Yes**, then click
  **Save Config**.
- **Menu paths** as bold labels joined by ` > `: **Stores** > **Settings** > **Configuration** >
  **Catalog** > **Product Labels**. Before a procedure, give the path once on its own line.
- **Scopes.** The admin shows `[GLOBAL]`, `[WEBSITE]` or `[STORE VIEW]` beside each setting. In a
  User Guide explain this once, in plain words ("a setting marked [STORE VIEW] can differ for each
  store view"), and give the task of setting a value for one store: choose the store view in the
  **Scope** switcher at the top of the page (its first entry is **Default Config**), clear the
  **Use Website** or **Use Default Value** checkbox beside the setting, change it, and click
  **Save Config**. At **Default Config** the checkbox reads **Use system value**.
- **After saving.** The admin may show "One or more of the Cache Types are invalidated: …". The
  User Guide gives the task: **System** > **Tools** > **Cache Management**, select the invalidated
  types, choose **Refresh** in the actions list and submit. Never tell a store admin to run a
  command.
- **Access for a colleague.** **System** > **Permissions** > **User Roles**, open the role,
  **Role Resources**, set **Resource Access** to **Custom**, select the module's resources by their
  titles from `acl.xml`, **Save Role**.
- **Commands** (technical documents only). Always `bin/magento`, never `php bin/magento` or
  `magento`; run from the Magento root, stated once in the block's title; no prompt; full option
  names; production-only commands marked with a trailing comment. The install sequence:

  ```bash
  composer require <vendor>/<package>:"^<major>.<minor>"
  bin/magento module:enable <Vendor>_<Module>
  bin/magento setup:upgrade
  bin/magento setup:di:compile  # production mode only
  bin/magento setup:static-content:deploy -f  # production mode only
  bin/magento cache:flush
  ```

- **Configuration paths** (technical only): `section/group/field` exactly as in `system.xml`, after
  the label: **Label Position** (`catalog_labels/general/position`). `bin/magento config:set` takes
  the stored value (`1`, `top_right`), not the label; say which. Mention `--lock-env` and
  `--lock-config` where a team keeps configuration in files.
- **ACL resources** (technical only): the title path in bold, then the ID in code on first mention.
- **Versions and dates.** Ranges with an en dash, both ends included: Magento 2.4.6 – 2.4.8,
  PHP 8.1 – 8.4. Dates in ISO 8601.
- **Verbs.** Click, select, enter, expand, run. Not "hit", "choose", "type in". No "simply", "just",
  "easy", no exclamation marks, no emoji.

## 4. Front matter of a module guide

Every guide starts with this front matter; a renderer may read it, and readers of the source see
the same facts.

```yaml
---
title: Product Labels                    # the product name, without the vendor
module: Vendor_ProductLabels             # the module code
doc-type: User Guide                     # User Guide | User Manual | Developer Guide | Installation Guide
version: 1.4.0                           # the module version the guide describes (composer.json)
lede: Show sale and new-in labels on product images in the catalog and on the product page.
magento: 2.4.6 - 2.4.8                   # the range composer.json allows and the module was tested on
php: 8.1 - 8.4
published: 2026-10-02
publisher: Vendor                        # the module's vendor
docs-url: example.com/docs/product-labels   # optional
edition: Magento Open Source and Adobe Commerce   # optional
---
```

The `lede` is one sentence of at most 25 words saying what the module does for the store, in the
reader's words. In a User Guide it never mentions code.

## 5. Magento's additions to the bar

On top of the core skill's conditions:

- **User Guide, condition 3 (reference complete):** every field of the module's `system.xml` an
  admin can see is in the reference, with its label, effect, options, default and the scopes it can
  be set in; every admin grid and form the module adds is described.
- **User Guide, condition 1 (goals):** if the module adds ACL resources, "let a colleague use this"
  is a goal with a how-to; if it adds storefront output, "see what customers see" is covered.
- **User Guide, condition 10 (plain language):** no configuration path, ACL ID, command, class,
  table or XML name in the body; a step that needs a developer says so and links the Installation
  or Developer Guide.
- **Installation Guide:** every cron job, queue consumer, indexer and cache type the module relies
  on is named with how to check it runs; uninstall lists the tables of `db_schema.xml`, the
  configuration paths and any data the patches wrote; the requirements match `composer.json`.
- **Developer Guide:** every `@api` interface, `webapi.xml` route, GraphQL operation, CLI command and
  event the module dispatches is in the reference; every extension point has a recipe showing its
  `di.xml` registration.
- **Every document:** labels match `i18n/en_US.csv` (or the locale the guide is written in), not the
  code's variable names; the version in the front matter is the one in `composer.json`.
