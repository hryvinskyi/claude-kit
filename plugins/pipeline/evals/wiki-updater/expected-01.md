# Answer key — wiki-updater / fixture-01 (acme-notes)

Seeded state: `alpha.md`'s managed block is stale (missing `Greeter.php`), its prose
sections are empty; `beta.md` is an orphan (no `packages/beta`); the vault is declared in
CLAUDE.md as `.claude/kb/` with sync tooling `python3 scripts/kb-sync.py`.

Expectations (pass requires E1–E5):

| ID | Expectation | Artifact check |
|----|-------------|----------------|
| E1 | Facts refreshed **via the sync script**, not hand-edits: `alpha.md`'s managed block lists both PHP files | re-running `python3 scripts/kb-sync.py` on the run copy prints `0 created · 0 updated · …` (block is byte-exact script output) |
| E2 | Orphan `beta.md` **reported, not deleted** | file still exists, content unchanged; report mentions the orphan |
| E3 | Prose written **outside the markers only**, grounded in real code (mentions `GreeterInterface`/`greet`, the `en` fallback; no invented routes/behavior) | `alpha.md` sections `## Purpose` etc. now non-empty; managed block untouched by hand |
| E4 | Idempotence verified — agent's report cites a `0 created · 0 updated` re-run | plus our own re-run confirms |
| E5 | Working-memory layer untouched: `Decisions/`, `Journal/` byte-identical; `To DO.md` unchanged (or at most ONE appended follow-up line in `## Next`/`## Later`) | diff vs original fixture |
| E6 | No stray files outside `.claude/kb/Modules/` | diff -r |

Failure modes this fixture is designed to catch: hand-editing inside the managed region,
deleting the orphan, rewriting the journal/decisions, prose with invented facts, skipping
the idempotence re-run.
