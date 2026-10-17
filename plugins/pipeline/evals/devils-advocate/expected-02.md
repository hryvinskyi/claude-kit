# Answer key — devils-advocate / fixture-02 (plan: credit-notes, precision case)

The same project and feature as fixture-01, planned correctly. Nothing is seeded. What is
seeded instead are seven **decoys**: places that look like F1–F7 at a glance and are right
when the agent reads the file the plan points at. This fixture measures the failure
fixture-01 cannot see — a reviewer that manufactures findings, and then **applies** them to
a plan that was correct.

| ID | Decoy | Why it is not a flaw | A finding here means |
|----|-------|----------------------|----------------------|
| D1 | Task 2 adds `getForUpdate()` and Task 5 calls it; Task 6 calls `CreditNoteIssuer::issue()` | The task table declares 5 → 2, 3, 4 and 6 → 5; every consumer depends on its producer | dependencies were not read from the table |
| D2 | Task 4 introduces a tagged `Api/` interface and plans **no** `services.yaml` edit | `packages/billing/src/Resources/config/services.yaml` globs `'../../'` and excludes only `Entity/`, `Migrations/`, `Resources/`, so `Api/` is loaded; the plan says so and ships a kernel test over `PaymentMethod::cases()` | the config file was not opened |
| D3 | The plan calls `InvoiceRepositoryInterface::getForUpdate()`, which is not in the interface | Task 2 states it does not exist today and adds it, with signature and `@throws` | "method does not exist" raised against a method the plan creates |
| D4 | Task 7 contains a `match ($method)` over `PaymentMethod` | value→value map to translation keys; the rubric and check 15 both allow it. Behavior is dispatched by `RefundMethodRegistry` | pattern-matched on the keyword |
| D5 | Task 2 adds a column to `Invoice`; Task 3 adds two entities | Task 1 is the migration, hand-written, reversible, first in the table | the task list was not read before flagging |
| D6 | Task 7 adds user-facing strings | to both `messages.en.yaml` and `messages.de.yaml`, named in the task | — |
| D7 | The plan mentions a `-C` suffix on the invoice number | as a dropped alternative, citing the decision record; `Invoice::number()` is untouched | the mention was read as the intent |

## Scoring

- **decoys**: N/7 left alone. A decoy counts as tripped when a Critical or Important
  finding asserts the flaw, or when a plan edit "fixes" it (adds a wiring task, removes
  the `match`, adds a migration task, and so on). A Minor or a Question that asks for
  confirmation and changes nothing is not a trip; note it.
- **Critical count**: expected **0 manufactured**. Any Critical is quoted in the run record
  with the judgement. A *real* one is a defect of this fixture, not of the agent: the run
  is recorded as it came out, the plan is corrected afterwards, and the correction is
  logged — never the other way round, and never for a finding that is a matter of taste.
- **apply-check, inverted**: diff the plan copy against the fixture. Every `[APPLIED]`
  edit is judged on its own: it must rest on something verifiable in the fixture (a file,
  a gate in `CLAUDE.md`, a checklist line, the decision record). An applied edit that
  rests on nothing is the defect this fixture exists to catch.
- **noise**: findings outside D1–D7, each judged real or hallucinated, as in fixture-01.
  Real ones are recorded and stay in the fixture: a fixture is never edited to make a
  later run look better, so the same real extras are expected run after run and only a
  *new* one is news.
- **verdict line**: the agent's final summary should say the plan is ready (or ready
  with minors). A summary that calls a correct plan not ready, with no real Critical
  behind it, is recorded as severity inflation.

## Calibration (2026-09-19)

The first run, on the plan as first written, returned two Critical findings and both were
real: the idempotency lookup ran before the row lock, and the endpoint's integration test
demanded a `422` the payload rule makes unreachable. Those were authoring mistakes in a
fixture that claims to be clean, so the plan was corrected **before it was ever committed** —
which makes the key stricter, not weaker: from here on a Critical is news.

Real Important findings from that run were left in on purpose and are the expected extras:
the use case naming `EntityManagerInterface`, nobody generating ids, a currency mismatch
surfacing as an unmapped `500`, the `409` body needing the remaining amount on the exception,
the header re-rendered from a body that carries no number, `credited` sharing the currency
column, an untyped `iterable` under PHPStan, `Money` and the parity test having no tests, the
authorization order, and a race test PHPUnit cannot run as written. A later run that misses
most of them has become lenient; one that adds to them is judged finding by finding.
