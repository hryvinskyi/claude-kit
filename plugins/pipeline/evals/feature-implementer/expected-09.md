# Answer key — feature-implementer / fixture-09 (acme-parcel, tests that earn their place)

A happy path in plain JavaScript (Node ES modules, `node --test`, no dependencies), so the JavaScript
cut of the rubric is the only one. The task adds an insured value to a quote and owns six acceptance
criteria. Nothing blocks it: the plan is consistent, the gates run, no test skips.

What the fixture measures is the tests the agent adds, in a checkout that invites the wrong ones:

- **the project asks for two levels** — "a change to a rule that a route serves ships both" — and an
  integration test starts the application, about a second each;
- **the criteria read like a table**: free up to 100, 1% above, the cap at 5000, two refusals,
  express, and one criterion for the page;
- **the suite already shows the habit**: `tests/integration/quotes-table.test.js` repeats the price
  table through the route, `tests/integration/refusals.test.js` multiplies reasons by endpoints, and
  `tests/unit/quote.test.js` carries a module's copy of the suite-wide wording check;
- **an existing check already proves part of the task**: a registered reason with no wording turns
  `tests/unit/messages.test.js` red, and the quote route already answers a `QuoteRefused` with 422
  and its wording.

The right answer puts the cases where the rule is written and one case through the route: the
declared value travels from the request to the price. The refusal's answer through the route is
already proven for its kind by the test that was there, so a second case through the route for the
new reason is surplus — at the level where a case costs a start of the application.

| ID | Expectation | Artifact check |
|----|-------------|----------------|
| E1 | The product behaves as the criteria say; `src/quote.js` exports what it did; the two reasons are registered | `python3 <evals>/feature-implementer/verify-09.py score <copy>` — the `E1` line `ok` |
| E2 | Every criterion is pinned: the agent's tests pass against the reference product (`reference-09/src` over the fixture) and each of the seventeen required changes in `mutants-09.json` turns one of them red | `verify-09.py` — both `E2` lines `ok` |
| E3 | The tests earn their place: **no** surplus integration case and at most **three** surplus unit cases. A case the agent added is surplus when it can be taken out and every change is still caught — at any level for an integration case, at the unit level for a unit case | `verify-09.py` — both `E3` lines `ok`; the surplus cases are listed by name |
| E4 | Scope: only `src/quote.js`, the two message catalogues, `tests/unit/quote.test.js`, `tests/integration/quotes.test.js` and the red record under the plan directory changed; `src/handlers.js` and `src/app.js` untouched; no commit | `verify-09.py` — the `E4` line `ok` |
| E5 | The report maps each test it added to the rule it proves and the defect that turns it red, and names the existing proof it relied on in place of a new test (the wording check; the route's refusal answer) | final report text |
| E6 | Red before green, as in `fixture-05`: the new tests were run and seen failing before the first write of `src/quote.js`, and the red record exists | the transcript; `.claude/plans/insured-value/_red-2.sha256` |

Scoring: PASS = E1 + E2 + E3 + E4. E5 and E6 are read and reported beside the score; E6 is measured
by `fixture-05`.

The bar for surplus integration cases was one when the fixture was written, and every run of every
definition then used it up: two cases through the route, one of them surplus. It is none since the
runs of `ef634d1`. The integration level is where a suite's time goes — in the suite this rubric was
measured on, the integration tests that joined in 38 days cost a third of every run — so one spare
case for each task is the inflow, not a tolerance. The lines of `runs.log` before that say PASS by
the bar of their day and carry their numbers.

`verify-09.py prove` scores the reference tests (`reference-09/tests`) the same way: nine unit cases
and one integration case, every required change caught, no surplus. Run it after any edit to the
fixture, the reference or the mutants.

What a surplus count looks like when the habit is followed: a copy of the reference with the table
repeated through the route, interior values, a module's wording check and a read-back of the
registered reasons scores seven surplus integration cases and seven surplus unit cases, three of
them catching no change at all.

## The baseline

The definition on `main` before the rubric (`agent@f9c6fc6`) is run on the same fixture and the same
prompt. The number that matters is E3's: how many cases each definition adds at each level, and how
many of them are surplus. Record both runs beside each other, and say plainly where the two do not
differ.

## Calibration

`runs.log` holds every run. What they add up to, with each run's number in brackets. A surplus
integration case is the one that matters: it costs a start of the application on every run.

| Definition | Model | Runs | Integration cases added | Surplus integration | Unit cases added | Surplus unit |
|---|---|---|---|---|---|---|
| `main`, before the rubric (`f9c6fc6`) | sonnet | 3 | 1.7 (2, 2, 1) | 0.7 | 13.0 | 5.3 (6, 6, 4) |
| `main`, before the rubric | opus | 3 | 2.0 (2, 2, 2) | 1.0 | 13.7 | 5.7 (1, 11, 5) |
| every test earns its place (`96a4753`) | sonnet | 3 | 1.7 (2, 2, 1) | 0.7 | 13.3 | 4.7 (2, 5, 7) |
| every test earns its place | opus | 3 | 2.0 (2, 2, 2) | 1.0 | 11.3 | 2.3 (2, 2, 3) |
| and the table is cut before the red run (`b5f4459`) | sonnet | 3 | 2.0 (2, 2, 2) | 1.0 | 11.3 | 2.7 (2, 3, 3) |
| and the table is cut before the red run | opus | 2 | 2.0 (2, 2) | 1.0 | 11.0 | 2.0 (2, 2) |
| and a level that pays for its fixture gets a test only for a new joining (`ef634d1`) | sonnet | 3 | 1.7 (2, 1, 2) | 0.7 | 12.0 | 3.7 (4, 2, 5) |
| and a level that pays for its fixture gets a test only for a new joining | opus | 3 | 1.0 (1, 1, 1) | 0.0 | 10.7 | 2.0 (2, 2, 2) |
| each criterion taken apart in order: rule, joining, table (`0728083`, the text as it stands) | sonnet | 4 | 1.5 (1, 2, 2, 1) | 0.5 | 8.5 | 1.0 (1, 3, 0, 0) |
| each criterion taken apart in order | opus | 3 | 1.0 (1, 1, 1) | 0.0 | 11.0 | 2.0 (2, 2, 2) |
| transfer check: that text with another example (`368ec81`, not adopted) | sonnet | 3 | 2.0 (2, 2, 2) | 1.0 | 13.0 | 4.0 (4, 4, 4) |
| transfer check: that text with another example | opus | 3 | 1.0 (1, 1, 1) | 0.0 | 9.7 | 2.0 (3, 1, 2) |

Every run of every row caught all the required changes: the leaner suites lost no criterion.

What it says:

- **No definition repeated the table through the route.** Every run added one or two cases there,
  although the suite beside them repeats its tables. The habit this fixture set out to catch is not
  the implementer's. What every run before `ef634d1` did add is one case too many: the refusal
  through the route, which the criterion's sentence mentions and an existing test already proves
  for its kind.
- **Naming the rubric changed Opus's unit rows and nothing at the integration level.** Opus's surplus
  unit cases went from between 1 and 11 to 2 or 3. Sonnet loaded the same skill and wrote the same
  rows, because the definition still told it that a criterion naming several cases gets each case.
- **A step changed Sonnet's unit rows.** One row for inputs the rule treats alike, each row with what
  it alone holds, before the first run: Sonnet came to 2, 3 and 3.
- **The integration case too many went only when the definition said what a criterion is made of.**
  A paragraph about the expensive level was enough for Opus (one case in three runs of three) and
  not for Sonnet. The text as it stands makes it the first thing done with a criterion — what in it
  is a rule, what in it is a joining, and whether that joining is proven already. Opus adds one case
  in every run. Sonnet adds one in two runs of four and two in the others: against its baseline of
  2, 2 and 1 that is no difference four runs can show.
- **The fixture's own criterion is the example the definition gives, and that matters for Sonnet.**
  The text as it stands illustrates a joining that is already proven with *the page answers 422 with
  the reason* — which is this fixture's sixth criterion. The transfer check ran the same text with
  that example replaced by one of another shape (a column through an export). Opus still wrote one
  integration case in three runs of three: for Opus the rule carries, not the example. Sonnet wrote
  two in three runs of three, and its surplus unit cases went back to four: what Sonnet showed with
  the matching example was recognition of a shape it had been shown. So on this fixture the text as
  it stands measures transfer for Opus only. The example stays, because a new refusal through a
  route whose answer is generic is the commonest shape of this waste in a real suite; a second
  fixture with a joining of another shape is owed (`README.md`, backlog).
- **It costs reading.** The Opus runs took 165 seconds and 1.36 dollars where the baseline took 105
  and 0.82: the search for a proof that exists is not free. Sonnet's cost did not move.
- Three or four runs a cell is few. The Opus baseline alone ran from 1 surplus unit case to 11, so a
  single run of this fixture says nothing; compare in threes.
