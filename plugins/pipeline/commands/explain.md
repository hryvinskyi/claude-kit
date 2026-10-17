---
description: "Explain how something works — a route, a console command, a class, a module, a flow — from the entry point to the database and back, grounded in the code"
argument-hint: "<GET /path | command:name | Class::method | path/ | a question> [quick|deep|onboarding|business]"
---

Explain: `$ARGUMENTS`

Read-only. Nothing is edited, nothing is committed. The explanation is **traced, not recalled**: every claim about behaviour points at a `file:line` you opened in this session. Where you did not open the code, say "not traced" instead of describing what such code usually does.

## 1. What is being asked

| Input looks like | It is | Entry point to find |
|---|---|---|
| `GET /api/orders/{id}`, a URL path | an HTTP route | the route → controller / API resource / processor: the framework's route listing, or where it declares routes (the stack skill's *Finding things* names both); otherwise the framework's router config |
| `app:sync-orders`, `vendor:thing:do` | a console command | the class carrying that name, found where the framework declares or registers its commands (the stack skill's *Finding things*); otherwise grep for the name |
| `Class`, `Class::method`, a file | a unit | that symbol |
| a directory, a package, a module name | a module | its public surface first (`Api/`, events, routes, commands), then what is behind it |
| a sentence | a question | the symbols the sentence names; answer the question, not the whole module |

Mode, when not given: a route, command, class or file → **quick**; a directory or module → **deep**; the repo root → **onboarding**; **business** only when asked for.

## 2. Orient before reading code

- The project's `CLAUDE.md`/`AGENTS.md` and the docs it points to for this area — they say what the layers are called here.
- On a project a stack plugin covers, its PHP architecture skill (the Skill tool lists the installed ones): its *Finding things* section says how to list that framework's routes, commands, listeners and pools, which is where the trace below starts and branches.
- The vault (`find-vault`, which the kit's vault tooling puts on `PATH`): the module's note, and any decision record touching the area. A decision explains *why* the code is shaped this way, which the code cannot. Treat a note as a lead and check it against the code; when they disagree, the code wins and the disagreement is worth one line in the answer.

## 3. Trace

Follow one request, top to bottom, and stop where the project's code ends:

1. **Entry** — the route/command/handler: what it accepts, how it is authorised, what it validates.
2. **Translation** — the DTO/command it builds; what is dropped or defaulted on the way in.
3. **Use case** — the service or handler that orchestrates; the ports it calls, in order; where the transaction begins and ends.
4. **Domain** — the entity or aggregate method that decides; the invariants it enforces; the events it records.
5. **Persistence and outside effects** — queries (and the index they rely on, when it matters), messages dispatched and on which transport, HTTP calls, cache reads and invalidations.
6. **The way back** — what is returned, how errors become responses, what a person sees when it fails.
7. **Dynamic hops** — event listeners, tagged strategies, plugins/observers, middleware, ORM lifecycle callbacks. These are where an explanation that only follows `->` calls goes wrong: list the listeners of each event dispatched and the members of each tagged pool resolved on the path.

For a module: the public surface and who consumes it, the entities and their invariants, the extension points (tags, events, slots), the configuration it owns, its failure modes.

## 4. Answer, by mode

- **quick** (about a screen): one paragraph of what it does and for whom → the numbered path with `file:line` per step → side effects → what is not obvious (a listener that changes the result, a cache, an ordering dependency, a known trap) → where to change it for the two or three most likely changes.
- **deep**: the above per flow, plus the domain model and its invariants, the module's boundaries and dependencies (who calls it, what it calls, through which contracts), extension points, configuration, failure modes, test coverage worth knowing about, and the debt you noticed while reading — named, with `file:line`, not fixed. One Mermaid sequence or flow diagram when the path has more than about five hops or a branch; none when a list says it better.
- **onboarding**: what the system is for; the architecture in one page (layers/rings, how modules talk); how to run it, test it and which gates must be green; where the five most important flows start; the conventions that will get a first PR rejected; where the knowledge lives (vault, docs, decisions).
- **business**: what it does for the person using it, the rules it applies, what can go wrong and what they see — no class names, no file paths.

Close every mode with **what was not traced** (a branch you skipped, a vendor call you did not open, behaviour that depends on configuration you did not read) — an honest gap is worth more than a confident paragraph.
