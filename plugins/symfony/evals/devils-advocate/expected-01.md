# Answer key — devils-advocate / fixture-01 (plan: credit-notes)

Seven seeded flaws. A finding counts as FOUND if it points at the same defect, however
phrased. Expected severity: Critical or Important for all seven (severity noted per flaw).

| ID | Seeded flaw | Where | Should be caught by | Expected severity |
|----|-------------|-------|---------------------|-------------------|
| F1 | Task 1 calls `CreditNoteIssuer::issue()` (built in Task 3) but the task table says Task 1 depends on nothing — an implementer of Task 1 is blocked / builds against an undefined contract | Task table + Task 1 | Generic №1 (missing task dependencies) | Critical |
| F2 | Task 3 introduces tagged-style strategies (`RefundMethodInterface` in `Api/` + 3 implementations) but NO task registers them in `Resources/config/services.yaml` — pool silently empty | Task 3 | Project checklist №2 (service registration) / Generic №6 (integration completeness) | Critical |
| F3 | `InvoiceRepositoryInterface::findActive()` does not exist — the interface ships `findAllActive()` (`packages/billing/src/Api/InvoiceRepositoryInterface.php`) | Task 1 | Generic №3 (interface contract gaps) — verifiable against fixture code | Critical |
| F4 | Task 4 plans `switch ($invoice->paymentMethod())` behavioral dispatch instead of a registry/strategy resolution | Task 4 | CA/SOLID check "no switch/elseif behavioral dispatch (MANDATORY)" | Important+ |
| F5 | Task 2 changes schema (`CreditNote` entity + `credited_total_minor` column on Invoice) with NO migration task anywhere in the plan | Task 2 | Project checklist №1 (entity → migration) / CLAUDE.md gate 4 | Critical |
| F6 | Task 5 adds user-facing strings to `messages.en.yaml` only — `de` missing; parity gate fails | Task 5 | Project checklist №3 / CLAUDE.md gate 3 | Important+ |
| F7 | Plan decision + Task 5 renumber the issued invoice with a `-C` suffix — directly contradicts accepted decision record `kb/Decisions/2026-05-10 invoice-numbers-are-immutable.md` without acknowledging it | Decisions + Task 5 | Step 2 (vault decision records are binding context) | Critical |

## Scoring

- **found**: N/7 (list per-flaw hit/miss with the agent's own wording)
- **severity accuracy**: flaws rated at least Important
- **apply-check**: F1–F7 findings rated Critical/Important must have `[APPLIED]` plan edits
  (F7 may legitimately land in *Questions for the Team* instead — intent change; that counts
  as correct handling, not a miss)
- **noise**: count findings unrelated to F1–F7; judge each real-vs-noise. Real extra
  findings are fine (the fixture is imperfect); hallucinated ones are a defect.
