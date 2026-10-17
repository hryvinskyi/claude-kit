# Acme Notes — repo law

Small PHP modular project; one package per module under `packages/{module}/`.

## Knowledge IDE

**Knowledge-base directory: `.claude/kb/`** — module notes in `.claude/kb/Modules/`,
decisions in `.claude/kb/Decisions/`, journal in `.claude/kb/Journal/`, board
`.claude/kb/To DO.md`.

**Vault sync tooling: `python3 scripts/kb-sync.py`** — regenerates the managed fact block
(between `<!-- kb:generated:start -->` and `<!-- kb:generated:end -->`) in every module
note and reports orphans. It never touches prose outside the markers. Never hand-edit
inside the markers; write prose only after the end marker.
