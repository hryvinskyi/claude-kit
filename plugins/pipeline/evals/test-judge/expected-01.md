# Answer key — test-judge / fixture-01 (acme-parcel, "a suite that grew")

`fixture-01/checkout/` is a small parcel desk in plain JavaScript (`node --test`, no dependency) with
71 tests at two levels. `fixture-01/brief/` holds what a caller hands the agent: the list of tests
(`tests.json`), the project's gates (`gates.md`) and, for the defender, twenty verdicts
(`defend.json`). The agent writes into `out/` of the copy.

The key is `key-01.json`, and it is not an opinion. `mutants-01.json` holds 67 changes to the
product: one defect for each rule and each boundary, one change that breaks no rule, and two defects
that no test catches. `python3 verify-01.py prove fixture-01/checkout` runs the suite against every one of
them and checks each claim below; it must print `the key holds` before a run is scored. Run it again
after any edit to the fixture: a key that the mutants no longer prove is a bug in the fixture.

## Seeded tests — 21 outside the groups

A test counts as **found** when its verdict is not `keep`; the verdict and the class are scored apart.

| Class | Tests | Expected verdict | Why (what `prove` shows) |
|---|---|---|---|
| duplicate — rows of one class | `a parcel of 2 kg costs 6.5`, `… 3 kg …`, `… 4 kg …` (`tests/unit/quote.test.js`) | delete (or trim) | every defect they catch, the boundary rows `1.01 kg` and `5 kg` catch |
| duplicate — a module's copy of a suite-wide check | `every quote refusal is worded in both languages` | delete | `tests/unit/messages.test.js` holds every message to every language, and `CLAUDE.md` says a module adds none |
| restates | `a parcel holds what it was given` | delete | it reads three constructor arguments back; a swap of two of them is caught by the export's test |
| vacuous, the rule proven elsewhere | `the sender is never shown the depot note` | delete (rewrite accepted) | the parcel has no note, so nothing can leak; the exact-shape assertions of `the sender is shown the id, the postcode and the state` catch the leak |
| duplicate — a contract pinned twice | `the states are written in lower case` | delete | `the stored values of the states are the published ones` pins the same values exactly |
| implementation | `the notice is logged before it is sent` | delete | it fails when the log line is dropped, which breaks no rule (`CLAUDE.md`, *Things nothing relies on*); the message itself is proven by its sibling |
| tool | `a path parameter is read from the address`, `an address with one segment too many matches nothing` | delete | both call `vendor/tiny-router`, which is not the project's to test |
| file-read, and the gate proves it | `every route names a handler that exists` | delete | it parses `config/routes.json`; the build (`scripts/build.mjs`) fails on the same defect, and so does a route's own integration test |
| duplicate — a fake where the survivor is real | `booking a parcel answers its id` (`tests/unit/booking.test.js`) | delete | the handler built by hand over a fake ledger; the integration booking test asserts the same and more |
| duplicate — a table one level up | the four `the quote page prices a parcel of … kg at …` | delete (move accepted) | the unit table holds every one, and `a quote is answered with the price` proves the route |
| duplicate — a product of independent factors | `POST /quotes refuses a parcel for no_weight`, `… for too_heavy` | delete | the reasons are proven at the unit level, the route's refusal by `a refused quote is answered 422 …` |
| duplicate — a subset of a sibling | `booking a parcel answers 201` | delete | the test above it asserts the whole answer |
| **vacuous, the rule proven nowhere — a hole** | `a guest may not book a parcel` | **rewrite** | its bogus token is refused before the role is read, so it passes with the role check removed; no other test sends a guest with a valid token |
| dead | `a delivered parcel is reported to the partner` | delete | it skips unless `PARTNER_SANDBOX_URL` is set, no environment sets it, and nothing in `src/` talks to the partner |

A `delete` given to the hole is the error this agent exists to avoid: it is scored apart, and one is a
failed run.

## Groups — a verdict for the group, not for each member

| Group | Members | Right when | Why |
|---|---|---|---|
| `parcels-refusal` | `POST /parcels refuses a parcel for no_weight`, `… for too_heavy` | one is kept and one deleted; or one is `rewrite` and the other kept or deleted | only these two fail when a booking swallows the quote's refusal: one of them is the joining fact, the second repeats it. Neither checks that the refused parcel is not stored, which is the second hole (below) |
| `labels` | the four `the tracking page names the state …` | three or four are `move`, the rest `keep`, none `delete` | the table belongs at the unit level; a row deleted with nothing in its place loses the defect "a state has no label", which nothing else catches |

## The hole behind a kept test

Both `POST /parcels refuses …` rows assert the answer and nothing about the ledger: a booking that
stores the parcel before it asks for the quote answers 422 and keeps the parcel, and no test fails
(`refused-booking-stored` in `mutants-01.json`). The fixture did not seed it. The first run of the
agent on Opus found it, and gave one row `rewrite` — which the key then counted as a wrong group,
so the key was corrected: the mutant was added, `prove` shows that no test catches it, and a
`rewrite` in the group is accepted. The scorer prints whether a run found it. It is credited and not
required: a judge that keeps the row loses nothing the suite had.

## Decoys — 15 tests that look removable and are not

`key-01.json` lists them with the reason for each. `prove` shows that each catches a defect no other
kept test of its level or a cheaper one catches. The kinds: a read-back through a transformation; a
recorded call that is the outcome; a literal that is a published contract; two members of a closed
set that share an answer; an absence beside a presence; a refusal through the route that is the
joining fact and not the unit rule again; a stubbed clock whose outcome is the rule; a file read back
that the code under test wrote; the boundary rows that survive the trimmed ones.

## Scoring a judge — `python3 verify-01.py verdicts fixture-01/checkout <copy>/out/verdicts.json`

It prints: seeded tests found, with the exact verdict and the class; the groups; the seeded hole
(rewrite, or deleted instead); whether the hole behind a kept test was found; decoys left alone; other
kept tests removed or changed; tests with no entry.
Then check the output mechanically, as the command does:
`pipeline-suite check <copy>/out/verdicts.json --root <copy>/checkout` — an entry that does not hold
up (a quote that is not at its line, a duplicate with no survivor, a survivor the same output
removes) is counted in the run line.

**PASS**: at least 19 of 21 found, both groups right, the seeded hole given `rewrite`, at most one
decoy tripped, at most two other kept tests removed or changed.

## Scoring a defender — `python3 verify-01.py defence <copy>/out/defended.json`

`brief/defend.json` holds twenty verdicts in the rubric's shape, all `delete`, all passing
`pipeline-suite check`. Nine are sound. Eleven are unsound, in ten units:

| Unsound removal | What the defender must find |
|---|---|
| `returned is the end of the road`, as one equivalence class with `delivered` | a member of a closed set: giving `returned` a next state turns only its row red |
| `a refused quote is answered 422 with its reason, worded for the reader`, as the unit refusal one level up | the wording through the route: no named survivor asserts the message |
| both `POST /parcels refuses a parcel for …` rows, with the `/quotes` rows as survivors (one unit: stopping either is enough) | a booking that swallows the quote's refusal turns only these two red |
| `a guest may not book a parcel`, as proving nothing | the rule is real and proven nowhere: `partly`, a rewrite with a valid token |
| `the tracking page names the state returned`, as covered by the message check | a state whose label is missing in the source catalogue is caught by this row alone |
| `only a collected parcel is out for delivery`, as covered by the step tests | a delivered parcel still listed turns only this test red |
| `the export holds a heading and one line for each parcel`, as a file-reading test | the file is what the code under test wrote; the column order is a contract |
| `a parcel booked at five is collected the next day`, as one class with `before five` | the boundary: a cut-off one hour off turns only one of the two red |
| `a parcel's postcode is stored the way postcodes are stored`, as `level` with the integration test of the sender's view as its survivor | the survivor does fail on the defect, and it is the costlier test: this is the rule's own unit test, built from the real objects, and the project asks for one |
| `the sender is shown the id, the postcode and the state`, the same way | the same: a rule of `parcel.js` proven at its own level |

The last two are removals a judge really proposed (the first Sonnet run of this fixture, and the
Sonnet baseline). No defect is caught by these tests alone, so a defender that only looks for one
agrees: what stops them is the rule that a survivor stands at the level where the rule belongs.

**PASS**: at least 8 of the 10 unsound units stopped (`objection` or `partly`), and at least 7 of the
9 sound removals agreed.

## The baseline

`prompt-01-baseline.md` is the judge's task, and `prompt-02-baseline.md` the defender's, with no
rubric and no agent definition, for a plain session on the same model (`claude -p --model <model>`
from inside the copy, with the same settings flags and no `--plugin-dir`). They say what the
definition and the skill add: record their scores beside the agent's, and say plainly where they are
no worse.

What the first runs showed (`runs.log`): on this fixture a plain Opus session reaches the key's
verdicts as the agent does. The fixture is small, and every proof of a rule is a file or two away;
what it measures is the classes, not the reading distance of a real suite. What the definition adds
there is the entry itself — quoted lines, named survivors, the mutation — which `pipeline-suite check`
holds and the later phases of `/pipeline:tighten-tests` consume. On Sonnet the difference is in the
verdicts: the plain session deleted unit tests of a rule on the word of an integration test, and so
did the agent until the rubric said where a survivor stands.

## Scoring a tightened copy — `python3 verify-01.py suite fixture-01/checkout <copy>/checkout`

Used by the command eval (`evals/tighten-tests/README.md`): the product byte for byte what it was,
the suite green, every defect the old suite caught still caught, the hole closed, no test failing on
the change that breaks no rule, every decoy still there, the label table proven at the unit level,
and the seeded tests gone.

## Calibration

See `runs.log`. The bars above were set before the first run and are revised only from runs, with
the run line that does it saying so.
