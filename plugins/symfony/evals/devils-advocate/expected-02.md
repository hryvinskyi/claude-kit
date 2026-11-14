# Answer key — devils-advocate / fixture-02 (plan: credit-notes, precision case)

The same project and feature as fixture-01, planned without the seven flaws fixture-01 seeds:
the task dependencies, the wiring, the migration, the translations and the decision record are
right, and every real Critical a run has reported against this plan was corrected afterwards
(§Calibration, §Fixture corrected). Seven **decoys** sit there instead: places that look like
F1–F7 at a glance and are right when the agent reads the file the plan points at. This half
measures the failure fixture-01 cannot see — a reviewer that manufactures findings, and then
**applies** them to parts of a plan that were correct.

The plan is **not** correct against the architecture rubric and the engineering standards the
agent runs with. Five breaks of them stand in it (R1–R5) and are expected findings. They are not
decoys and not extras: a run that leaves the plan's object creation, its static-analysis level or
its transaction handling as written has scored the plan against an older rubric.

| ID | Decoy | Why it is not a flaw | A finding here means |
|----|-------|----------------------|----------------------|
| D1 | Task 2 adds `getForUpdate()` and Task 5 calls it; Task 6 calls `CreditNoteIssuer::issue()` | The task table declares 5 → 2, 3, 4 and 6 → 5; every consumer depends on its producer | dependencies were not read from the table |
| D2 | Task 4 introduces a tagged `Api/` interface and plans **no** `services.yaml` edit | `packages/billing/src/Resources/config/services.yaml` globs `'../../'` and excludes only `Entity/`, `Migrations/`, `Resources/`, so `Api/` is loaded; the plan says so and ships a kernel test over `PaymentMethod::cases()` | the config file was not opened |
| D3 | The plan calls `InvoiceRepositoryInterface::getForUpdate()`, which is not in the interface | Task 2 states it does not exist today and adds it, with signature and `@throws` | "method does not exist" raised against a method the plan creates |
| D4 | Task 7 contains a `match ($method)` over `PaymentMethod` | value→value map to translation keys; the rubric and check 15 both allow it. Behavior is dispatched by `RefundMethodRegistry` | pattern-matched on the keyword |
| D5 | Task 2 adds a column to `Invoice`; Task 3 adds two entities | Task 1 is the migration, hand-written, reversible, first in the table | the task list was not read before flagging |
| D6 | Task 7 adds user-facing strings | to both `messages.en.yaml` and `messages.de.yaml`, named in the task | — |
| D7 | The plan mentions a `-C` suffix on the invoice number | as a dropped alternative, citing the decision record; `Invoice::number()` is untouched | the mention was read as the intent |

## Rubric breaks — expected findings

A finding counts as FOUND if it points at the same defect, however phrased; one finding may
cover R1 and R2 together when it names both the named constructors and the missing generator
task.

| ID | Break | Where | Rule it breaks | Expected severity | Applied fix looks like |
|----|-------|-------|----------------|-------------------|------------------------|
| R1 | `CreditNote::issue(...)` and `RefundInstruction::owe(...)` are static named constructors, i.e. `new self(...)` behind another spelling; Task 4's strategies and Task 5 build objects through them | Task 3, used in Tasks 4–5 | No `new SomeClass`: a named constructor is the same violation and is never the clean alternative; objects come from an injected factory interface | Important+ | Task 3 declares factory interfaces (`CreditNoteFactoryInterface`, `RefundInstructionFactoryInterface`, one method per object, no computation) and Tasks 4–5 inject them |
| R2 | No task builds the factory generator, and the project has none (`fixture-02` holds no compiler pass; Symfony ships no generator) | Task table | The first task of the plan that creates an object builds the generator, with tests that compile the real container, before any task injects a factory | Important+ (Critical acceptable: an implementer of Task 3 is blocked) | a generator task (compiler pass writing every factory interface's implementation) ahead of Task 3, Task 3 depending on it |
| R3 | `Money::add()` and `Money::subtract()` return `new self(...)`, and `Money` has no tests; `Invoice::credit()` and `remainingCreditable()` call both, and the plan's tech-debt section says "none to remediate" | `packages/billing/src/Entity/Money.php`; plan §Tech-debt in scope | In-scope debt is fixed in the same change (check 14): `Money` is a direct collaborator of the touched `Invoice`, and the module is five classes. An operation yielding a value asks a factory for the result object, handed in as a method argument where there is no container | Important+ | a task that moves `Money`'s results onto an injected money factory and adds `Money`'s unit tests; the tech-debt section lists it |
| R4 | The plan names no static-analysis level for the code it writes; the project's gate is level 9 | `CLAUDE.md` gate 1; the whole plan | The kit's engineering standards (`standards/CLAUDE.standards.md`, §PHP static analysis): code written or changed passes PHPStan at level 10 (`--level=10`), whatever the project's own gate says. The fixture holds no copy of that rule, so a run that does not load the standards cannot find R4, and its record says so | Important+ | a line in the plan (or each task's gates) running the touched files at `--level=10` |
| R5 | `CreditNoteIssuer` runs its steps inside `EntityManagerInterface::wrapInTransaction()`, and the plan's *Dependency rule check* lists only `Api/` and PSR interfaces | Task 5; §Dependency rule check | The application layer opens a transaction through a port it owns; a Doctrine adapter implements it (the Symfony skill's §3 and its framework-leak recipe) | Important+ | a `TransactionInterface` port beside the issuer, a Doctrine adapter, the issuer calling `$this->transactions->run(...)`, the dependency check corrected |

## Scoring

Two halves, both reported; the run passes only when both do.

- **rubric found**: N/5 (R1–R5 hit or miss, with the agent's own wording). Each hit must be
  rated Important or Critical and carry an `[APPLIED]` plan edit like the one in the table; a
  hit rated Minor, or found but not applied, scores half and is named in the run record. Full
  marks are 5/5 found, rated and applied. A run below 5/5 is a miss however clean its decoy
  half is: a reviewer that finds nothing in this plan scores **0/5 and fails**.
  One exception: R4's rule lives only in the kit's engineering standards. A run that did not
  load them as memory (`standards/CLAUDE.standards.md` and the Symfony standards, through
  `--add-dir`) is scored out of 4, R4 not scored, and its record says the standards were
  missing; full marks for it are 4/4.
- **decoys**: N/7 left alone. A decoy counts as tripped when a Critical or Important
  finding asserts the flaw, or when a plan edit "fixes" it (adds a wiring task, removes
  the `match`, adds a migration task, and so on). A Minor or a Question that asks for
  confirmation and changes nothing is not a trip; note it.
- **Critical count**: expected **0 manufactured**. Any Critical is quoted in the run record
  with the judgement. R2 rated Critical is a real Critical, not a manufactured one. Another
  *real* Critical is a defect of this fixture, not of the agent: the run is recorded as it
  came out, the plan is corrected afterwards, and the correction is logged — never the other
  way round, and never for a finding that is a matter of taste. A correction never removes
  R1–R5.
- **apply-check, inverted**: diff the plan copy against the fixture. Every `[APPLIED]`
  edit is judged on its own: it must rest on something verifiable in the fixture or the
  rubric (a file, a gate in `CLAUDE.md`, a checklist line, the decision record, a rule of the
  engineering standards or the architecture skills). An applied edit that rests on nothing is
  the defect this fixture exists to catch.
- **noise**: findings outside D1–D7 and R1–R5, each judged real or hallucinated, as in
  fixture-01. Real ones are recorded and stay in the fixture: a fixture is never edited to
  make a later run look better, so the same real extras are expected run after run and only a
  *new* one is news.
- **verdict line**: the plan as written is not ready (R1–R5). The summary may call it ready
  once its own `[APPLIED]` edits close R1–R5; a summary that calls it ready with any of them
  missed is recorded as leniency, and one that calls it not ready on decoys alone, with no
  real Critical or R finding behind it, as severity inflation.

## Calibration (2026-09-19)

The first run, on the plan as first written, returned two Critical findings and both were
real: the idempotency lookup ran before the row lock, and the endpoint's integration test
demanded a `422` the payload rule makes unreachable. Those were authoring mistakes in a
fixture that claims to be clean, so the plan was corrected **before it was ever committed** —
which makes the key stricter, not weaker: from here on a Critical is news.

Real Important findings from that run were left in on purpose and are the expected extras:
nobody generating ids, a currency mismatch surfacing as an unmapped `500`, the `409` body
needing the remaining amount on the exception, the header re-rendered from a body that carries
no number, `credited` sharing the currency column, an untyped `iterable` under PHPStan, the
parity test having no tests, the authorization order, and a race test PHPUnit cannot run as
written. A later run that misses most of them has become lenient; one that adds to them is
judged finding by finding.

## Re-keyed (2026-11-13)

Until this date the key called the plan correct and scored decoys only, so a run that found
nothing scored 7/7. The rubric had moved under it: a static named constructor and a value
object's `new self` are the no-`new` rule's defects, code written is held to PHPStan level 10,
and a use case reaches its transaction through a port. Those became R1–R5 above; the use case
naming `EntityManagerInterface` and `Money` having no tests left the extras for R5 and R3. The
re-keying left the fixture unchanged. Runs recorded before this date were scored against the old key and are
not re-scored from the log; the next run is the first against this one.

## Fixture corrected (2026-11-14)

The rule above says a real Critical is corrected in the plan after the run that found it. Four
recorded by runs (2026-09-29 and 2026-10-18 in `runs.log`) had not been, and were on this date.
None touches a decoy or one of R1–R5:
- **The lock did not refresh an invoice already loaded** (2026-09-29 C1, 2026-10-18 C1): the
  endpoint's voter loads the invoice first, and a pessimistic read does not overwrite a managed
  instance. Task 2's `getForUpdate()` now refreshes it under the lock, with a test that commits
  a credit from another connection between `get` and `getForUpdate`.
- **The admin UI never sent the required key** (2026-09-29 C2, both 2026-10-18 runs) and **the
  detail screen and an asset pipeline did not exist** (2026-10-18 C4): Task 7 now builds the
  invoice detail screen, server-rendered and without JavaScript, and its form carries a CSRF
  token and an idempotency key drawn when the form is rendered, posted to an admin action that
  delegates to the same issuer.
- **`credited` shared the invoice's currency column, and `Invoice` had no mapping** (2026-09-29
  C3, both 2026-10-18 runs): Task 1 renames `currency` to `total_currency` and adds
  `credited_currency` with a check that keeps the two equal; Task 2 writes the mapping, `Money`
  as an embeddable with a column prefix per use.
- **Schema validation could not pass with foreign keys the mapping does not know** (2026-09-29
  C4): Task 3 now validates the mapping (`--skip-sync`) and leaves the foreign keys, which the
  by-id references keep out of the mapping, to Task 1's test.

A run against the plan before this date may report these four; a run after it that reports one
of them as still standing has misread the plan.

Two follow-ups the same day, from reading the corrections back: the credit-note tables name
their currency column `amount_currency`, as `Money` embedded with `columnPrefix: 'amount_'`
requires (Tasks 1 and 3), and Task 1 says what Task 3 validates and that the round-trip tests
pin the columns; the new screen is guarded by `InvoiceVoter::VIEW`, with a `403` test for a user
outside billing, and names its only labels (`invoice.title` and the task's `credit_note.*`).

Two of the calibration extras above went with these corrections and are no longer expected:
`credited` sharing the currency column, and the header re-rendered from a `201` body that
carries no number (the screen is server-rendered now and shows the stored number).
