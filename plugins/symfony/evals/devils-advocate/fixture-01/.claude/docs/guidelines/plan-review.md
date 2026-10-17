# Plan-review checklist — Acme Billing

Project-specific checks applied by the `pipeline:devils-advocate` agent on top of its generic checks.

1. **Entity → migration** — every new/changed entity ships a hand-written, reversible
   migration in the module's `src/Migrations/`, as its own plan task.
2. **Service registration** — every new service, listener, and tagged `Api/` interface is
   registered in the module's `Resources/config/services.yaml`; plans that introduce tagged
   strategies must include the wiring task (an unregistered tagged interface yields a
   silently empty pool).
3. **Translation completeness** — every new user-facing string lands in BOTH locales
   (`en` and `de`) within the same plan.
