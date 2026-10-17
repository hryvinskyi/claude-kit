#!/bin/bash
# Self-tests of the vault plugin's hooks and commands, run as Claude Code runs them: the resolver,
# the session-start brief (with the board-queue line when the sibling board-queue plugin and its
# dependencies are present), the session-end capture's deference, the journal nudge, and the Python
# unit tests beside this file. Run from anywhere: plugins/vault/tests/tests.sh
set -u
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
H="$PLUGIN/hooks"
BIN="$PLUGIN/bin"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# The vault tools write state and start detached processes; neither may reach the real ~/.claude.
export CLAUDE_VAULT_STATE="$TMP/vault-state" CLAUDE_VAULT_NO_SPAWN=1
# Run from a git hook, these tests would otherwise hand the hook's index and repository to every
# git call they make in their own temporary repositories.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX

ok() { PASS=$((PASS + 1)); }
ko() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# ---------- bin/find-vault.sh ----------
FV="$BIN/find-vault.sh"
mkvault() { # dir vaultpath
  mkdir -p "$1/$2/Decisions" "$1/$2/Journal"
  printf '## Now\n- [ ] item one\n## Next\n- [ ] item two\n## Done\n' > "$1/$2/To DO.md"
}
mkvault "$TMP/p1" "kb"
printf 'Knowledge-base directory: `kb/`\n' > "$TMP/p1/CLAUDE.md"
[ "$("$FV" "$TMP/p1")" = "kb" ] && ok || ko "find-vault: declared vault"
mkvault "$TMP/p2" ".claude/kb"
[ "$("$FV" "$TMP/p2")" = ".claude/kb" ] && ok || ko "find-vault: .claude/kb fallback"
mkdir -p "$TMP/p0"
"$FV" "$TMP/p0" >/dev/null 2>&1; [ $? -eq 1 ] && ok || ko "find-vault: none -> exit 1"
mkvault "$TMP/p3/subproj" "Vault"
"$FV" "$TMP/p3" >/dev/null 2>&1; [ $? -eq 1 ] && ok || ko "find-vault: sibling-project vault leaked"
mkvault "$TMP/p6" "kb1"; mkvault "$TMP/p6" "kb2"
"$FV" "$TMP/p6" >/dev/null 2>&1; [ $? -eq 2 ] && ok || ko "find-vault: ambiguous -> exit 2"
mkdir -p "$TMP/p7"; printf 'Knowledge-base directory: `./docs/kb/`\n' > "$TMP/p7/AGENTS.md"
[ "$("$FV" "$TMP/p7")" = "docs/kb" ] && ok || ko "find-vault: AGENTS.md declaration normalized"
(cd "$TMP/p1" && [ "$("$FV")" = "kb" ]) && ok || ko "find-vault: defaults to cwd"

# ---------- session_brief.sh ----------
SB="$H/session_brief.sh"
OUT=$(cd "$TMP/p1" && "$SB")
case "$OUT" in *"Knowledge-vault brief (kb/)"*"[NOW]"*) ok ;; *) ko "brief: declared vault" ;; esac
OUT=$(cd "$TMP/p2" && "$SB")
case "$OUT" in *"Knowledge-vault brief (.claude/kb/)"*) ok ;; *) ko "brief: .claude/kb fallback" ;; esac
OUT=$(cd "$TMP/p3" && "$SB")
[ -z "$OUT" ] && ok || ko "brief: sibling-project vault leaked"
mkvault "$TMP/p4" "kb"
mkdir -p "$TMP/p4/.claude"
printf '{"hooks":{"SessionStart":[]}}' > "$TMP/p4/.claude/settings.json"
OUT=$(cd "$TMP/p4" && "$SB")
[ -z "$OUT" ] && ok || ko "brief: did not defer to project hook"
mkdir -p "$TMP/p5/kb/Decisions"
printf '# Board\n## In progress\n- thing\n' > "$TMP/p5/kb/To DO.md"
printf 'Knowledge-base directory: `kb/`\n' > "$TMP/p5/CLAUDE.md"
OUT=$(cd "$TMP/p5" && "$SB")
case "$OUT" in *"[BOARD] sections: In progress"*) ok ;; *) ko "brief: nonstandard board shape" ;; esac
OUT=$(cd "$TMP/p6" && "$SB")
[ -z "$OUT" ] && ok || ko "brief: ambiguous vault should stay silent"
OUT=$(cd "$TMP/p1" && "$SB")
case "$OUT" in *"[VAULT] not checked yet"*"[VAULT] no copy off this machine — the project is not a git repository"*) ok ;;
  *) ko "brief: vault check and backup lines missing" ;; esac
OUT=$(cd "$TMP/p1" && CLAUDE_NO_VAULT_TOOLS=1 "$SB")
case "$OUT" in *"[VAULT]"*) ko "brief: CLAUDE_NO_VAULT_TOOLS should silence the vault tools" ;; *) ok ;; esac
OUT=$(cd "$TMP/p1" && "$SB")
case "$OUT" in *"[BOARD QUEUE]"*) ko "brief: board queue line without an origin remote" ;; *) ok ;; esac

# A vault that is a repository of its own is brought up to date before the board is read: a row
# another member pushed is on the brief of the session that starts next.
(
  export GIT_CONFIG_GLOBAL="$TMP/empty-gitconfig" GIT_CONFIG_NOSYSTEM=1
  : > "$GIT_CONFIG_GLOBAL"
  git init -q --bare -b main "$TMP/remote.git"
  mkvault "$TMP/seed" "kb"
  cd "$TMP/seed/kb" && git init -q -b main && git -c user.name=T -c user.email=t@example.com add -A \
    && git -c user.name=T -c user.email=t@example.com commit -q -m seed \
    && git remote add origin "$TMP/remote.git" && git push -q origin main
  mkdir -p "$TMP/p8" && printf 'Knowledge-base directory: `kb/`\n' > "$TMP/p8/CLAUDE.md"
  git clone -q "$TMP/remote.git" "$TMP/p8/kb"
  printf '## Now\n- [ ] pushed by a teammate\n## Next\n## Done\n' > "$TMP/seed/kb/To DO.md"
  cd "$TMP/seed/kb" && git -c user.name=T -c user.email=t@example.com commit -q -am teammate && git push -q origin main
) >/dev/null 2>&1
OUT=$(cd "$TMP/p8" && GIT_CONFIG_GLOBAL="$TMP/empty-gitconfig" GIT_CONFIG_NOSYSTEM=1 "$SB")
case "$OUT" in *"[VAULT] brought up to date — 1 commit from the remote"*"[NOW]  pushed by a teammate"*) ok ;;
  *) ko "brief: an own-repo vault was not fast-forwarded before the board was read" ;; esac

# The board-queue line. A temp state directory and a temp configuration keep the
# real queue out of it; the remote is spelled in capitals because the queue stores
# a repository lower-cased and the hook has to match it.
# The queue is the board-queue plugin beside this one in the kit, named to the brief
# through BOARD_QUEUE_CLI. It runs its dependencies from its own node_modules, which
# nothing here installs: a clone that has not had `npm ci` run in it cannot answer,
# and that is a missing setup step rather than a broken hook.
BQ_DIR="$(cd "$PLUGIN/.." && pwd)/board-queue"
BQ="$BQ_DIR/bin/board-queue"
BQ_DEPS="$BQ_DIR/node_modules"
if [ -x "$BQ" ] && [ -d "$BQ_DEPS" ] && command -v node >/dev/null 2>&1; then
  mkvault "$TMP/bq" "kb"
  printf 'Knowledge-base directory: `kb/`\n' > "$TMP/bq/CLAUDE.md"
  git -C "$TMP/bq" init -q -b main
  git -C "$TMP/bq" remote add origin git@github.com:Example-Org/Example-Repo.git
  cp "$BQ_DIR/config.example.json" "$TMP/bq-config.json"
  export BOARD_QUEUE_STATE_DIR="$TMP/bq-state" BOARD_QUEUE_CONFIG="$TMP/bq-config.json" BOARD_QUEUE_CLI="$BQ"
  OUT=$(cd "$TMP/bq" && "$SB")
  case "$OUT" in *"[BOARD QUEUE]"*) ko "brief: board queue line on an empty queue" ;; *) ok ;; esac
  "$BQ" enqueue --repo example-org/example-repo --issue 412 --status "In progress" \
    >"$TMP/bq-seed.log" 2>&1 && ok || { ko "brief: seeding the queue fixture failed"; cat "$TMP/bq-seed.log"; }
  OUT=$(cd "$TMP/bq" && "$SB")
  case "$OUT" in *"[BOARD QUEUE] queued 1"*) ok ;; *) ko "brief: no board queue line for a repository with work" ;; esac
  OUT=$(cd "$TMP/bq" && CLAUDE_NO_VAULT_TOOLS=1 "$SB")
  case "$OUT" in *"[BOARD QUEUE]"*) ko "brief: CLAUDE_NO_VAULT_TOOLS should silence the board queue line" ;; *) ok ;; esac
  unset BOARD_QUEUE_STATE_DIR BOARD_QUEUE_CONFIG BOARD_QUEUE_CLI
else
  echo "SKIP: board-queue, its node_modules or node not on host — session brief board queue cases skipped"
fi

# ---------- bin/vault_check.py · session_capture.py · vault_search.py ----------
if python3 -m unittest discover -s "$PLUGIN/tests" >"$TMP/vault-unit.log" 2>&1; then
  ok
else
  ko "vault tools: unit tests"; tail -25 "$TMP/vault-unit.log"
fi
SC="$BIN/session_capture.py"
mkvault "$TMP/s1" "kb"
printf 'Knowledge-base directory: `kb/`\n' > "$TMP/s1/CLAUDE.md"
mkdir -p "$TMP/s1/.claude"
printf '{"hooks":{"SessionEnd":[]}}' > "$TMP/s1/.claude/settings.json"
printf '{"session_id":"abcdefgh-1234","cwd":"%s"}' "$TMP/s1" | python3 "$SC"
ls "$CLAUDE_VAULT_STATE"/*/payloads/abcdefgh-1234.json >/dev/null 2>&1 \
  && ko "capture: did not defer to the project's own SessionEnd hook" || ok
rm -f "$TMP/s1/.claude/settings.json"
printf '{"session_id":"abcdefgh-1234","cwd":"%s"}' "$TMP/s1" | python3 "$SC"
ls "$CLAUDE_VAULT_STATE"/*/payloads/abcdefgh-1234.json >/dev/null 2>&1 \
  && ok || ko "capture: the hook saved no payload for a vault project"

# ---------- journal_nudge.py ----------
J="$H/journal_nudge.py"
mk_transcript() { # path n_edits [skill] [n_commits]
  python3 - "$@" <<'PY'
import json, sys
path, n = sys.argv[1], int(sys.argv[2])
skill = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
commits = int(sys.argv[4]) if len(sys.argv) > 4 else 0
def line(name, inp):
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}) + "\n"
with open(path, "w") as fh:
    for i in range(n):
        fh.write(line("Edit", {"file_path": f"/x/{i}.php"}))
    for i in range(commits):
        fh.write(line("Bash", {"command": f"git commit -m 'step {i}'"}))
    if skill:
        fh.write(line("Skill", {"skill": skill}))
PY
}
nudge() { # cwd sid transcript
  printf '{"session_id":"%s","cwd":"%s","transcript_path":"%s"}' "$2" "$1" "$3" | python3 "$J" 2>/dev/null
}
mk_transcript "$TMP/t-work.jsonl" 6
mk_transcript "$TMP/t-small.jsonl" 2
mk_transcript "$TMP/t-journaled.jsonl" 6 journal
mk_transcript "$TMP/t-feature.jsonl" 6 feature
mk_transcript "$TMP/t-namespaced.jsonl" 6 vault:journal
mk_transcript "$TMP/t-commits.jsonl" 0 "" 5
mkvault "$TMP/j1" "kb"
printf 'Knowledge-base directory: `kb/`\n' > "$TMP/j1/CLAUDE.md"
mkdir -p "$TMP/j0"
rm -f /tmp/claude-journal-nudge-t[0-9]*
OUT=$(nudge "$TMP/j0" "t0" "$TMP/t-work.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired without a vault"
OUT=$(nudge "$TMP/j1" "t1" "$TMP/t-work.jsonl")
case "$OUT" in *'"decision": "block"'*) ok ;; *) ko "nudge: no block after real work in a vault project" ;; esac
OUT=$(nudge "$TMP/j1" "t1" "$TMP/t-work.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired twice in one session"
OUT=$(nudge "$TMP/j1" "t2" "$TMP/t-small.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired on a session with too little work"
OUT=$(nudge "$TMP/j1" "t3" "$TMP/t-journaled.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired although the journal command already ran"
OUT=$(nudge "$TMP/j1" "t4" "$TMP/t-feature.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired although a feature run journals itself"
OUT=$(nudge "$TMP/j1" "t9" "$TMP/t-namespaced.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired although vault:journal already ran"
OUT=$(nudge "$TMP/j1" "t5" "$TMP/nope.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired without a readable transcript"
OUT=$(nudge "$TMP/j1" "t6" "$TMP/t-commits.jsonl")
case "$OUT" in *'"decision": "block"'*) ok ;; *) ko "nudge: git commits should count as work" ;; esac
touch "$TMP/j1/kb/Journal/$(date +%F) work.md"
OUT=$(nudge "$TMP/j1" "t7" "$TMP/t-work.jsonl")
[ -z "$OUT" ] && ok || ko "nudge: fired despite today's journal entry"
rm -f "$TMP/j1/kb/Journal/$(date +%F) work.md"
OUT=$(printf '{"session_id":"t8","cwd":"%s","transcript_path":"%s","stop_hook_active":true}' "$TMP/j1" "$TMP/t-work.jsonl" | python3 "$J" 2>/dev/null)
[ -z "$OUT" ] && ok || ko "nudge: ignored stop_hook_active"
rm -f /tmp/claude-journal-nudge-t[0-9]*

echo "----------------------------------------"
echo "vault tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
