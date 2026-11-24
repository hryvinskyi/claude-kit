---
name: symfony-docs
description: |
  Symfony's idiom for the docs:user-guide and docs:technical-guide skills. Covers where a
  Symfony application, bundle or package keeps the facts its documentation needs (routes and
  controllers, security.yaml, #[IsGranted] and voters, Twig templates and components, form
  types, validation and flash messages, translation catalogues, e-mails, console commands,
  bundle configuration and environment variables, Messenger, Scheduler, API Platform, events,
  Doctrine migrations, composer.json), where it writes down who may open each screen, and
  which document each fact belongs in: a user guide for each kind of person who uses its
  screens, an administration guide for the screens only its own staff open, an installation
  guide for whoever deploys and runs it, a developer guide for whoever calls or extends it.
  Also Symfony's wording (bin/console, environments, environment variables) and its additions
  to the quality bars. Use together with docs:user-guide or docs:technical-guide whenever
  documentation of a Symfony project is written, updated or reviewed, a help page changed as
  part of a code change included.
---

# Symfony documentation

Load this skill together with `docs:user-guide` or `docs:technical-guide`. A file named without a
skill (`method.md`, `quality-bar.md`) is that core skill's. The core skills carry the method and the
bar; this skill says where a Symfony project keeps its facts, where it writes down who may open
what, which document each fact belongs in, and how Symfony's own documentation words things.

## 1. The document set of a Symfony application

A Symfony application defines its own roles, so its readers are not given: find them first. The
roles are in `config/packages/security.yaml` (`role_hierarchy`), in the user entity's `getRoles()`
and in the screens that assign them. Each kind of person behind those roles gets a document.

| Document | Reader | Holds | Never holds |
|---|---|---|---|
| **User guide** (`docs:user-guide`), one per kind of user | A person who uses the application's screens with one role: a member, a customer, the administrator of their own account or team | Their goals by the screen, with labels from the translation catalogues, the messages they see and the e-mails they get | A route, a role name (`ROLE_…`), a console command, an environment variable, an entity or table name, an HTTP status; anything behind a rule their role does not pass |
| **Administration guide** (`docs:technical-guide`) | The application's own staff, or an operator working by the screen: whoever holds the roles its users never get | Each task those roles allow, what it changes for a user, what is recorded | The users' own how-tos (link them) |
| **Installation guide** (`docs:technical-guide`) | Whoever deploys and runs it | Requirements, environment variables and secrets, the deploy sequence, workers and schedules, logs, upgrade and rollback | How to use the screens |
| **Developer guide** (`docs:technical-guide`) | Whoever calls its API or extends it | The API as a contract, events, extension points, the console reference | End-user tasks; for someone who only calls the API, nothing behind it |

An application that serves many customers from one installation has two kinds of administrator: the
administrator of one customer's account, and the vendor's own staff. Both may be called "admin" on
the screen. They are different readers with different documents. Find the role or the flag that
tells them apart before you collect anything else, and say in the outline which one "you" is.

A bundle or a package for other developers has no end user of its own: its documents are the
installation guide and the developer guide, and a user guide only for the screens it adds.

## 2. Who may open what

The core skills call this **reach**, and record it with every fact. A Symfony application writes
it down in several places. A screen is in a reader's reach only when every one of them lets that
reader through.

| Where | What it decides | How to read it |
|---|---|---|
| `security.yaml` → `firewalls` | Which part of the application a sign-in covers | `php bin/console debug:firewall`. A separate firewall (an admin area, an API) is usually a separate reader |
| `security.yaml` → `access_control` | The roles a path needs | `php bin/console debug:config security access_control`. The **first** rule that matches the request decides; later rules are not read |
| `security.yaml` → `role_hierarchy` | Which role includes which | `php bin/console debug:config security role_hierarchy`. A role holds everything the roles under it hold |
| `#[IsGranted(…)]` on a controller class or action; `denyAccessUnlessGranted(…)` and `isGranted(…)` in the code | The role or the permission the action needs | A role (`ROLE_…`) is checked against the hierarchy; any other attribute is decided by a voter |
| Voters (classes implementing `VoterInterface`, usually under `src/Security/`) | Who gets a permission: by role, by ownership, by a setting, by a plan | Read `supports()` and `voteOnAttribute()`. "Only the owner" and "only our staff" rules live here |
| Twig: `is_granted(…)` around a link, a button or a menu entry; a menu builder's own condition | Which controls and entries are drawn for whom | A control that is not drawn for the reader is not in their guide, even where the route would answer |
| API Platform: `security` on a resource or an operation; the scopes of a token | Who may call an operation | The expression, and what gives a caller the role or scope it names |
| `switch_user` on a firewall | Who may act as another user | Staff material: the administration guide |

```bash
php bin/console debug:router --show-controllers       # every route with the controller that serves it
php bin/console router:match /some/path                 # which route answers a path
rg -n "IsGranted\(|denyAccessUnlessGranted\(|->isGranted\(" src/
rg -n "is_granted\(" templates/
```

- Record for each screen the rule that guards it (file and line) and the role of the guide's
  reader that passes it. "Probably everyone" is not a fact.
- A route that only a role of the application's own staff passes is out of every customer's reach:
  it belongs in the administration guide, however useful its description would be.
- A permission a voter decides is named in a user guide by the label the application shows where
  it is granted, never by the attribute string.
- **Sign in as the reader and look.** In the `dev` environment the profiler's Security panel shows
  the signed-in user's roles and the access decision log of the request: every attribute that was
  checked, and which voter granted or denied it. It settles a doubt faster than reading the code.

## 3. Where the other facts live

Read these into the fact list before writing. Paths are those of a standard application; a bundle
or a package keeps the same files under its own `src/`, `config/`, `templates/` and `translations/`
(or `Resources/`).

| Fact | Source | How to read it | Document |
|---|---|---|---|
| Screens | `#[Route]` on controllers, `config/routes/` | `debug:router`: name, method, path | User guide (the screen, by its menu path, never the route); technical (the path) |
| Menu and navigation | The layout and sidebar templates; a menu builder when the application has one | The labels, joined, are the path the user clicks; the conditions around an entry are reach (§2) | User guide |
| Labels, headings, help texts, button captions | `translations/<domain>.<locale>.yaml` (or `.xlf`, `.php`); `\|trans` and `{% trans %}` in templates; Twig components | `php bin/console debug:translation <locale> --domain=<domain>` lists each id with its text and whether it is missing or unused. Take the text from the catalogue of the guide's language, never the id | both |
| Forms | Form types (`src/Form/*Type.php`): `label`, `help`, `choices`, `required`, defaults; the template that lays the form out | `php bin/console debug:form <Type>`; the choice labels go through the translator; the order is the order the screen shows | User guide (reference) |
| Validation messages | Constraints on the entity or the DTO (`#[Assert\…(message: …)]`); `translations/validators.<locale>.*`; Symfony's own catalogue for the default messages | `php bin/console debug:validator <Class>`; the user sees the translated message | User guide (troubleshooting) |
| Messages after an action | `addFlash(…)` in controllers; texts passed to a toast or a Turbo stream; the application's error pages (`templates/bundles/TwigBundle/Exception/`) | `rg -n "addFlash\(" src/`; quote the translated text | User guide (result lines, troubleshooting) |
| E-mails and notifications | `TemplatedEmail` and the templates it names; Notifier notifications; subjects from the translator | Subject, sender, and what makes it go out (the handler or listener that sends it) | User guide ("you get an e-mail with…"); installation guide (the mailer transport) |
| Settings a user changes on a screen | The settings form and what stores it | Defaults from the property defaults or the form's `data` | User guide (reference) |
| Configuration an operator sets | `config/packages/*.yaml`, `config/services.yaml` parameters, `.env` files, real environment variables, the secrets vault | `php bin/console debug:config <bundle>`; `php bin/console debug:container --env-vars` (every variable the container reads and its default; it prints the real values too, secrets included, so run it on a development copy and never paste its output into a document); `php bin/console debug:dotenv`; `php bin/console secrets:list` | Installation guide; never a user guide |
| Console commands | `#[AsCommand]` classes | `php bin/console list`, then `php bin/console <command> --help` for each; the help output is the reference | Installation, administration or developer guide |
| What runs in the background | Messenger: `config/packages/messenger.yaml` (transports, routing), `#[AsMessageHandler]` classes | `php bin/console debug:messenger` (which message goes to which handler); `messenger:stats`; the failure transport; the consumer command the deploy starts | Installation guide (the workers must run, and how to check); user guide only as the effect ("it takes a few minutes") |
| What runs on a schedule | Scheduler (`#[AsPeriodicTask]`, `#[AsCronTask]`, schedule providers), or a crontab that calls console commands | `php bin/console debug:scheduler` where the Scheduler component is installed; else the crontab or the process manager | Installation guide; user guide in plain words ("every night") |
| API | API Platform (`#[ApiResource]`, operations, `security`, filters, serialization groups); controllers under an API prefix | `php bin/console api:openapi:export`; `php bin/console debug:api-resource <Class>` | Developer guide and reference |
| Events and extension points | Events the code dispatches for others; interfaces with `#[AutoconfigureTag]` read through a tagged iterator; services meant to be decorated | `php bin/console debug:event-dispatcher [event]`; `php bin/console debug:container --tag=<tag>` | Developer guide |
| Stored data | Doctrine entities, `migrations/` | `php bin/console doctrine:migrations:status`; what an upgrade migrates and what a removal leaves | Installation guide (upgrade, removal); developer guide (schema) |
| Requirements and version | `composer.json` (`php`, `ext-*`, the `symfony/*` constraint), `symfony.lock`, the container or server definition | `composer check-platform-reqs`; `php bin/console about` | Installation guide; the front matter |
| Browser assets | AssetMapper (`importmap.php`, `assets/`), or an Encore or Vite build | The build step the deploy runs (`asset-map:compile`, or the bundler's) | Installation guide |
| Logs | `config/packages/monolog.yaml`: channels, handlers, where each writes | Which channel or file shows which failure | Installation guide (troubleshooting) |
| History | `CHANGELOG.md`, `UPGRADE-*.md`, git tags | What changed in each version | Document history, migration notes |

**Look at the running application, too.** Open every screen the guide describes, signed in as the
guide's reader (§2). In the `dev` environment the profiler helps with exact facts: its Translation
panel lists every message the page used with its domain and its text, the Forms panel the fields,
the E-mails panel what a submit sent. Take screenshots with no debug toolbar in them: where the
toolbar is off, or hidden in the page for the shot. Do not change tracked configuration for a
screenshot. Use an instance with invented data only.

## 4. Wording

- **A user guide uses none of Symfony's words.** No route, controller, bundle, entity, voter, flash
  message or firewall; no `ROLE_…` and no permission attribute. A role is named by the label the
  application shows where roles are given. A refusal is quoted as the application's own page shows
  it, not as "403". A screen is reached by its menu path.
- **Commands** (technical documents only) as Symfony's documentation writes them: `php bin/console
  <command>`, run from the project root, one command per line, no prompt, full option names. When
  the project runs them another way (`bin/console`, `symfony console`, inside a container), follow
  the project in every block and say once where commands run.
- **Environment** and **environment variable** are two things. `dev`, `test` and `prod` are
  environments (`APP_ENV`); `DATABASE_URL` is an environment variable. Say which environment a
  command is for when it matters (`--env=prod`).
- **Environment variables** in code style and upper case, each with what it is for and where its
  production value lives (the server's environment, `.env.local`, the secrets vault set with
  `php bin/console secrets:set`). Never a real value; a made-up one that shows the format.
- **Configuration keys** by their full path: `framework.messenger.transports.async`.
- **Classes and services** in code style, with the namespace on first mention.
- **The deploy sequence is the project's, not this skill's.** Find it in the project's deploy
  script, container definition or CI job, and document it in its own order: installing the
  dependencies, the environment, the migrations, the asset build, warming the cache, restarting the
  workers (`messenger:stop-workers` lets them come back on the new code). A step you did not find in
  the project is not written.
- **Versions.** The Symfony range `composer.json` allows and the PHP range, both ends given. Dates
  in ISO 8601.

## 5. Front matter of a guide

Every guide starts with front matter; a renderer may read it, and readers of the source see the
same facts. When the project's renderer or documentation site defines its own keys, use those.

```yaml
---
title: Acme Helpdesk                 # the product, as its users call it
doc-type: User Guide                 # User Guide | Administration Guide | Installation Guide | Developer Guide
reader: Support agent                # the one reader of this document, by the label the product gives the role
version: 2.4.0                       # the application or package version the guide describes
lede: Answer your customers' requests from one shared inbox.
symfony: 7.4 - 8.1                   # technical documents: the range composer.json allows
php: 8.3 - 8.5                       # technical documents
published: 2026-10-02
publisher: Acme
---
```

The `lede` is one sentence of at most 25 words saying what the product does for this reader, in
their words. In a user guide it never mentions code.

## 6. Symfony's additions to the bar

On top of the core skill's conditions:

- **User guide, condition 13 (reach):** the fact list quotes, for each screen, the rule that guards
  it (the `access_control` line, the `#[IsGranted]` attribute, the voter) and the role of the
  guide's reader that passes it. A route that only a staff role passes, a control drawn only inside
  an `is_granted()` the reader fails, and anything behind `switch_user` are not in a customer's
  guide. A change that tightens a rule (a new `#[IsGranted]`, a changed voter, a control moved
  inside `is_granted()`) is a change of reach: the guide loses what the reader lost.
- **User guide, conditions 4 and 10:** every label matches the translation catalogue of the guide's
  language (`debug:translation`), not the message id and not a variable name; no route, role
  constant, command, class or table name in the body.
- **User guide, condition 6:** troubleshooting is built from the application's flash messages,
  validation messages and error pages, quoted as the reader sees them.
- **Administration guide:** every route that only a staff role passes and every console command
  meant for an operator has a recipe; acting as another user (`switch_user`) says what the user
  sees of it and what is recorded.
- **Installation guide:** every environment variable the container reads
  (`debug:container --env-vars`) is named with its purpose and where its production value lives,
  never with a value that command printed;
  every Messenger transport with the command that consumes it and how to check it runs; every
  scheduled task; the migrations; the asset build; the cache warm-up; what must be writable.
- **Developer guide:** the API as the OpenAPI export shows it; every event the application
  dispatches for others; every tagged extension point with how an implementation is registered; the
  console reference taken from each command's `--help`.
- **Every technical document:** commands are written the way the project runs them, and the page
  says once where that is.
