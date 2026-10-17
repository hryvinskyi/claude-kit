#!/bin/sh
#
# Global SessionStart brief — project-agnostic knowledge-vault snapshot.
# Resolves the project's vault via the plugin's bin/find-vault.sh and prints its
# working memory so every session starts oriented. Injected into session
# context: keep it tiny.
#
# Defers to the project: if the repo defines its own SessionStart hook (a
# brief of its own), this script exits silently.

set -u

# The plugin's own directory, from this script's place inside it.
PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Project ships its own SessionStart brief -> don't duplicate it.
if [ -f .claude/settings.json ] && grep -q '"SessionStart"' .claude/settings.json 2>/dev/null; then
    exit 0
fi

# Vault resolution lives in ONE place: bin/find-vault.sh (declared
# `Knowledge-base directory:` line, else a unique To DO.md + Decisions/ dir at
# depth 1 or under .claude/). None or ambiguous -> nothing to brief.
VAULT=$("$PLUGIN_ROOT/bin/find-vault.sh" 2>/dev/null) || exit 0
[ -z "$VAULT" ] && exit 0
BOARD="$VAULT/To DO.md"
[ -f "$BOARD" ] || exit 0

echo "=== Knowledge-vault brief ($VAULT/) ==="
ITEMS=$(awk '
  /^## Now$/  { s = 1; next }
  /^## Next$/ { s = 2; next }
  /^## /      { s = 0 }
  s == 1 && /^- \[ \]/ && m < 8  { m++; print "[NOW]  " substr($0, 7) }
  s == 2 && /^- \[ \]/ && n < 3  { n++; print "[NEXT] " substr($0, 7) }
' "$BOARD" | cut -c1-200)
if [ -n "$ITEMS" ]; then
    echo "$ITEMS"
else
    # Board uses its own section scheme — surface its shape instead of nothing.
    echo "[BOARD] sections: $(grep -E '^## ' "$BOARD" | sed 's/^## //' | head -4 | paste -sd '·' -)"
fi

last_journal=$(ls -1 "$VAULT/Journal/"*.md 2>/dev/null | sort | tail -1)
[ -n "${last_journal:-}" ] && echo "[JOURNAL]  latest: $(basename "$last_journal" .md)"

last_decision=$(ls -1 "$VAULT/Decisions/"*.md 2>/dev/null | grep -viE '(readme| MOC)' | sort | tail -1)
[ -n "${last_decision:-}" ] && echo "[DECISION] latest: $(basename "$last_decision" .md)"

# Prose that stopped matching the code, sessions nobody journaled, whether the vault has a copy off
# this machine — a cache and local reads, so none of it waits — and a search index of the project's
# own, started in the background the first time.
if command -v python3 >/dev/null 2>&1 && [ -z "${CLAUDE_NO_VAULT_TOOLS:-}" ]; then
    python3 "$PLUGIN_ROOT/bin/vault_check.py" --brief 2>/dev/null
    python3 "$PLUGIN_ROOT/bin/session_capture.py" --brief 2>/dev/null
    python3 "$PLUGIN_ROOT/bin/vault_search.py" ensure --detach 2>/dev/null
fi

# Work filed against a shared project board outlives the session that filed it —
# a move waiting on a deploy, an action that needs a person before it can run —
# and nobody goes looking for it. The queue's own command prints those lines for
# whichever repository this project is, reading its database and never the
# network, and prints nothing when that repository has no outstanding work (or is
# one the queue does not carry), so the lines appear only when there is something
# to say. Nothing here is allowed to break a session start: no queue, no node, no
# origin remote, or a command that fails — all of them stay silent. The queue is
# the `board-queue` command ($BOARD_QUEUE_CLI names another one), looked up on the
# search path and then where the shims are installed.
QUEUE="${BOARD_QUEUE_CLI:-$(command -v board-queue 2>/dev/null || echo "$HOME/.local/bin/board-queue")}"
if [ -x "$QUEUE" ] && [ -z "${CLAUDE_NO_VAULT_TOOLS:-}" ] && command -v node >/dev/null 2>&1; then
    # Any form the remote takes — ssh, https, with or without the .git suffix —
    # down to owner/name, lower-cased because that is how the queue stores it.
    REPO=$(git remote get-url origin 2>/dev/null \
        | tr '[:upper:]' '[:lower:]' \
        | sed -e 's#/*$##' -e 's#\.git$##' \
        | sed -n 's#^.*github\.com[:/]\([^/][^/]*/[^/][^/]*\)$#\1#p')
    if [ -n "${REPO:-}" ]; then
        "$QUEUE" brief --repo "$REPO" 2>/dev/null || true
    fi
fi

echo "(Board: $BOARD · commands: /vault:todo /vault:decision /vault:journal /vault:wiki-sync)"
exit 0
