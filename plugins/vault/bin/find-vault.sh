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
#      depth 1 or under .claude/ only. Deliberately not deeper: from a parent
#      directory full of projects that would leak a sibling's vault.
#
# A vault is a directory strictly inside the project root. The tools commit and push a vault that
# is a repository of its own, so a declaration that names the root itself, leaves it (an absolute
# path, a `..` component, a symbolic link that leads out) or is empty is refused: exit 1, nothing
# printed, and no fallback to rule 2. A candidate of rule 2 that leads out of the root is skipped.
#
set -u
unset CDPATH
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || exit 1
TOP=$(pwd -P) || exit 1

# inside REL — whether REL, followed through every symbolic link, lies strictly inside the root.
# A path that does not exist yet is judged by its nearest existing ancestor, which may be the root.
inside() {
    P=$1
    while [ ! -d "$P" ]; do
        case "$P" in */*) P=${P%/*} ;; *) P=. ;; esac
    done
    REAL=$(cd "./$P" 2>/dev/null && pwd -P) || return 1
    case "$REAL" in
        "$TOP") [ "$P" != "$1" ] ;;
        "$TOP"/*) return 0 ;;
        *) return 1 ;;
    esac
}

for f in CLAUDE.md AGENTS.md; do
    [ -f "$f" ] || continue
    LINE=$(sed -n 's/.*[Kk]nowledge-base directory: *`\([^`]*\)`.*/=\1/p' "$f" | head -1)
    [ -n "$LINE" ] || continue
    V=${LINE#=}
    while [ "${V%/}" != "$V" ]; do V=${V%/}; done
    V=${V#./}
    case "$V" in
        ""|.|/*|..|../*|*/..|*/../*) exit 1 ;;
    esac
    inside "$V" || exit 1
    printf '%s\n' "$V"
    exit 0
done

FOUND=""
N=0
for d in */ .claude/*/; do
    [ -f "${d}To DO.md" ] && [ -d "${d}Decisions" ] || continue
    inside "${d%/}" || continue
    N=$((N + 1))
    FOUND="$FOUND ${d%/}"
done
case $N in
    0) exit 1 ;;
    1) printf '%s\n' "${FOUND# }"; exit 0 ;;
    *) echo "find-vault: ambiguous, declare one in CLAUDE.md (Knowledge-base directory: \`X/\`):$FOUND" >&2; exit 2 ;;
esac
