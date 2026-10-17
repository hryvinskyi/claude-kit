#!/bin/sh
#
# find-vault.sh — the ONE rule for locating a project's knowledge vault.
# Used by the SessionStart brief, the journal nudge, every vault command
# (/vault:decision /vault:journal /vault:todo /vault:wiki-sync) and the
# wiki-updater agent. On the PATH it is the `find-vault` command beside it.
#
# Usage:  find-vault.sh [project-root]      (default: current directory)
# Prints the vault path relative to the project root (no trailing slash).
# Exit 0 found · 1 none · 2 ambiguous (candidates listed on stderr).
#
# Rules:
#   1. A declaration in CLAUDE.md or AGENTS.md:   Knowledge-base directory: `kb/`
#      (returned even if the directory does not exist yet — callers check).
#   2. Otherwise a UNIQUE directory holding "To DO.md" + Decisions/, searched at
#      depth 1 and under .claude/ only. Deliberately not deeper: from a parent
#      directory full of projects that would leak a sibling's vault.
#
set -u
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || exit 1

for f in CLAUDE.md AGENTS.md; do
    [ -f "$f" ] || continue
    V=$(sed -n 's/.*[Kk]nowledge-base directory: *`\([^`]*\)`.*/\1/p' "$f" | head -1)
    if [ -n "$V" ]; then
        V="${V%/}"
        V="${V#./}"
        printf '%s\n' "$V"
        exit 0
    fi
done

FOUND=""
N=0
for d in */ .claude/*/; do
    [ -f "${d}To DO.md" ] && [ -d "${d}Decisions" ] || continue
    N=$((N + 1))
    FOUND="$FOUND ${d%/}"
done
case $N in
    0) exit 1 ;;
    1) printf '%s\n' "${FOUND# }"; exit 0 ;;
    *) echo "find-vault: ambiguous, declare one in CLAUDE.md (Knowledge-base directory: \`X/\`):$FOUND" >&2; exit 2 ;;
esac
