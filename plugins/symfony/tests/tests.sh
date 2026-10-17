#!/bin/bash
# Tests for this plugin's gate part: hooks/register-stack.py and what stack.json makes the rubric
# gate of the guards plugin require on a Symfony project. Run from the kit clone; the gate is
# reached by its path in the clone, never through a plugin cache.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(dirname "$HERE")"
KIT="$(cd "$PLUGIN/../.." && pwd)"
ENGINE="$KIT/plugins/guards/hooks"
P="$ENGINE/plan_skill_gate.py"
B="$ENGINE/bash_guard.py"
REG="$PLUGIN/hooks/register-stack.py"
if [ ! -f "$P" ] || [ ! -f "$B" ]; then
  echo "FAIL: the guards plugin's gate is not at $ENGINE; run these tests from the kit clone"
  exit 1
fi
PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export XDG_CONFIG_HOME="$TMP/xdg"
export CLAUDE_KIT_STATE_DIR="$TMP/state"
unset CLAUDE_NO_PLAN_SKILL_GATE CLAUDE_NO_DEBT_GUARD CLAUDE_KIT_GITHUB_REST_ONLY CLAUDE_KIT_FORBID_ASSISTANT_COMMIT_TRAILERS

ok() { PASS=$((PASS + 1)); }
ko() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
# expect_exit <name> <want_exit> <stdin-json> <script>
expect_exit() {
  local name="$1" want="$2" json="$3" script="$4"
  echo "$json" | python3 "$script" >/dev/null 2>&1
  local got=$?
  [ "$got" -eq "$want" ] && ok || ko "$name (want exit $want, got $got)"
}
gate() { printf '{"tool_name":"%s","cwd":"%s","transcript_path":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" "$3" "$4"; }
gatec() { # tool cwd transcript path content -> hook stdin carrying the written text
  python3 -c 'import json, sys
t, c, tr, p, x = sys.argv[1:6]
key = "content" if t == "Write" else "new_string"
print(json.dumps({"tool_name": t, "cwd": c, "transcript_path": tr, "tool_input": {"file_path": p, key: x}}))' "$@"
}
bash_json() { # command cwd transcript -> hook stdin for a Bash PreToolUse call
  python3 -c 'import json, sys
print(json.dumps({"tool_input": {"command": sys.argv[1]}, "cwd": sys.argv[2], "transcript_path": sys.argv[3]}))' "$@"
}
# register <transcript>: this plugin's SessionStart hook, run for the session the transcript belongs to
register() {
  local stem; stem="$(basename "$1" .jsonl)"
  printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"%s","transcript_path":"%s"}' "$stem" "$1" \
    | python3 "$REG" >/dev/null 2>&1
}
CORE_PHP="/root/.claude/skills/clean-architecture-php"
CORE_JS="/root/.claude/skills/clean-architecture-js"
STACK_CACHE="/home/dev/.claude/plugins/cache/claude-kit/symfony/0.1.0/skills"
# t <transcript> <entry>... ; registered for its session. Entries: php, js (Skill calls of the core skills),
# p:<ref> / j:<ref> (a core reference), sp / sf (the stack skills), anything else is a Read path.
t() {
  local out="$1"; shift; : > "$out"
  for e in "$@"; do
    case "$e" in
      php) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"architecture:clean-architecture-php"}}]}}\n' >> "$out" ;;
      js) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"architecture:clean-architecture-js"}}]}}\n' >> "$out" ;;
      p:*) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s/references/%s"}}]}}\n' "$CORE_PHP" "${e#p:}" >> "$out" ;;
      j:*) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s/references/%s"}}]}}\n' "$CORE_JS" "${e#j:}" >> "$out" ;;
      sp) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"symfony:symfony-architecture-php"}}]}}\n' >> "$out" ;;
      sf) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"symfony:symfony-architecture-frontend"}}]}}\n' >> "$out" ;;
      *) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s"}}]}}\n' "$e" >> "$out" ;;
    esac
  done
  register "$out"
}

# ---------- fixtures ----------
mkdir -p "$TMP/sf/src/Controller" "$TMP/sf/assets/controllers" "$TMP/sf/packages/editor/src/Resources/react-editor/lib" \
  "$TMP/sf/public/build" "$TMP/sf/.claude/plans/x" "$TMP/sf/.claude/plans/z" "$TMP/console/bin" "$TMP/console/src" \
  "$TMP/bundles/config" "$TMP/bundles/src" "$TMP/plain/src" "$TMP/other/src"
echo '{"require":{"symfony/framework-bundle":"^7.0"}}' > "$TMP/sf/composer.json"
echo '{"dependencies":{"react":"^19"}}' > "$TMP/sf/package.json"
printf '{\n  "compilerOptions": {\n    "strict": true, // comments are allowed here\n    "jsx": "react-jsx",\n    "paths": {"@/*": ["./*"]}\n  }\n}\n' \
  > "$TMP/sf/packages/editor/src/Resources/react-editor/tsconfig.json"
echo '{}' > "$TMP/console/composer.json" && : > "$TMP/console/bin/console"
echo '{}' > "$TMP/bundles/composer.json" && echo '<?php return [];' > "$TMP/bundles/config/bundles.php"
echo '{}' > "$TMP/plain/composer.json"
echo '{"require":{"acme/other-framework":"^1"}}' > "$TMP/other/composer.json"
t "$TMP/empty.jsonl"
t "$TMP/loaded.jsonl" php
t "$TMP/t-skill-solid.jsonl" php p:solid.md
t "$TMP/t-sf.jsonl" php p:solid.md sp
t "$TMP/t-sf-cache.jsonl" php p:solid.md "$STACK_CACHE/symfony-architecture-php/SKILL.md"
t "$TMP/t-skill-sf.jsonl" php sp
t "$TMP/t-php-for-other.jsonl" php p:solid.md
t "$TMP/tj-base.jsonl" js j:solid.md j:javascript.md
t "$TMP/tj-sf.jsonl" js j:solid.md j:javascript.md sf
t "$TMP/tj-sf-ts.jsonl" js j:solid.md j:javascript.md sf j:typescript.md
t "$TMP/tj-sf-island.jsonl" js j:solid.md j:javascript.md sf j:typescript.md j:react.md
t "$TMP/t-plan-php-js.jsonl" php sp js sf

# ---------- PHP source ----------
expect_exit "source gate: symfony project needs the symfony stack skill" 2 \
  "$(gate Edit "$TMP/sf" "$TMP/t-skill-solid.jsonl" "$TMP/sf/src/Controller/FooController.php")" "$P"
expect_exit "source gate: symfony with skill+solid+stack skill allowed" 0 \
  "$(gate Edit "$TMP/sf" "$TMP/t-sf.jsonl" "$TMP/sf/src/Controller/FooController.php")" "$P"
expect_exit "source gate: the stack skill's SKILL.md read from the versioned plugin cache counts" 0 \
  "$(gate Edit "$TMP/sf" "$TMP/t-sf-cache.jsonl" "$TMP/sf/src/Controller/FooController.php")" "$P"
expect_exit "source gate: symfony detected from bin/console at the project root" 2 \
  "$(gate Write "$TMP/console" "$TMP/t-skill-solid.jsonl" "$TMP/console/src/Foo.php")" "$P"
expect_exit "source gate: symfony detected from config/bundles.php at the project root" 2 \
  "$(gate Write "$TMP/bundles" "$TMP/t-skill-solid.jsonl" "$TMP/bundles/src/Foo.php")" "$P"
expect_exit "source gate: a project of another framework needs no symfony skill" 0 \
  "$(gate Write "$TMP/other" "$TMP/t-php-for-other.jsonl" "$TMP/other/src/Foo.php")" "$P"
OUT=$(gate Write "$TMP/sf" "$TMP/loaded.jsonl" "$TMP/sf/src/Controller/FooController.php" | python3 "$P" 2>&1)
case "$OUT" in *"references/solid.md"*"Skill tool with \`symfony:symfony-architecture-php\`"*) ok ;;
  *) ko "source gate: denial names the core reference and the stack skill"; echo "$OUT" ;; esac

# ---------- plans ----------
expect_exit "plan gate: symfony plan needs the stack skill" 2 \
  "$(gate Write "$TMP/sf" "$TMP/loaded.jsonl" "$TMP/sf/.claude/plans/x/_plan.md")" "$P"
expect_exit "plan gate: symfony plan with skill+stack skill allowed" 0 \
  "$(gate Write "$TMP/sf" "$TMP/t-skill-sf.jsonl" "$TMP/sf/.claude/plans/x/_plan.md")" "$P"
expect_exit "js plan: symfony plan naming a JS file needs the JS skill and the frontend skill" 2 \
  "$(gatec Write "$TMP/sf" "$TMP/t-skill-sf.jsonl" "$TMP/sf/.claude/plans/x/_plan.md" "Task 2: add assets/controllers/coupon_controller.js")" "$P"
expect_exit "js plan: symfony plan naming a JS file with both skills allowed" 0 \
  "$(gatec Write "$TMP/sf" "$TMP/t-plan-php-js.jsonl" "$TMP/sf/.claude/plans/x/_plan.md" "Task 2: add assets/controllers/coupon_controller.js")" "$P"
for word in Stimulus stimulus_controller; do
  expect_exit "js plan: a plan naming $word orders browser work" 2 \
    "$(gatec Write "$TMP/sf" "$TMP/t-skill-sf.jsonl" "$TMP/sf/.claude/plans/z/_plan.md" "Task 3: the $word part")" "$P"
done
expect_exit "js plan: a plain PHP plan naming Stimulus orders browser work while this stack is registered" 2 \
  "$(gatec Write "$TMP/plain" "$TMP/loaded.jsonl" "$TMP/plain/.claude/plans/x/_plan.md" "Task 3: a Stimulus controller")" "$P"

# ---------- JavaScript source ----------
expect_exit "js gate: stimulus controller needs the symfony frontend skill" 2 \
  "$(gate Write "$TMP/sf" "$TMP/tj-base.jsonl" "$TMP/sf/assets/controllers/coupon_controller.js")" "$P"
expect_exit "js gate: stimulus controller does not need react.md on a PHP host" 0 \
  "$(gate Write "$TMP/sf" "$TMP/tj-sf.jsonl" "$TMP/sf/assets/controllers/coupon_controller.js")" "$P"
expect_exit "js gate: island .ts under a jsx tsconfig needs react.md" 2 \
  "$(gate Write "$TMP/sf" "$TMP/tj-sf-ts.jsonl" "$TMP/sf/packages/editor/src/Resources/react-editor/lib/api.ts")" "$P"
expect_exit "js gate: island .ts with react.md allowed" 0 \
  "$(gate Write "$TMP/sf" "$TMP/tj-sf-island.jsonl" "$TMP/sf/packages/editor/src/Resources/react-editor/lib/api.ts")" "$P"
expect_exit "js gate: not source, untouched: sf/public/build/app.js" 0 \
  "$(gate Write "$TMP/sf" "$TMP/empty.jsonl" "$TMP/sf/public/build/app.js")" "$P"

# ---------- writes through the shell ----------
expect_exit "bash write: heredoc into symfony PHP source without the stack skill blocked" 2 \
  "$(bash_json "cat > src/Controller/FooController.php <<'EOF'
<?php
EOF" "$TMP/sf" "$TMP/t-skill-solid.jsonl")" "$B"
expect_exit "bash write: heredoc into symfony PHP source with the stack skill allowed" 0 \
  "$(bash_json "cat > src/Controller/FooController.php <<'EOF'
<?php
EOF" "$TMP/sf" "$TMP/t-sf.jsonl")" "$B"
expect_exit "bash write: heredoc plan naming a Stimulus controller needs the JS skill" 2 \
  "$(bash_json "cat > .claude/plans/x/_plan.md <<'EOF'
| 1 | a Stimulus controller for the coupon form |
EOF" "$TMP/sf" "$TMP/t-skill-sf.jsonl")" "$B"
expect_exit "bash write: a copy into public/build untouched" 0 \
  "$(bash_json "cp /tmp/app.js public/build/app.js" "$TMP/sf" "$TMP/empty.jsonl")" "$B"
OUT=$(bash_json "sed -i '' 's/a/b/' src/Controller/FooController.php" "$TMP/sf" "$TMP/t-skill-solid.jsonl" | python3 "$B" 2>&1)
case "$OUT" in *"a shell write of PHP source"*"symfony:symfony-architecture-php"*) ok ;;
  *) ko "bash write: the denial names the stack skill"; echo "$OUT" ;; esac

# ---------- without the registration ----------
cp "$TMP/tj-base.jsonl" "$TMP/unregistered.jsonl"
expect_exit "no registration: a stimulus controller on a React host needs react.md" 2 \
  "$(gate Write "$TMP/sf" "$TMP/unregistered.jsonl" "$TMP/sf/assets/controllers/coupon_controller.js")" "$P"
cp "$TMP/t-skill-solid.jsonl" "$TMP/unregistered-php.jsonl"
expect_exit "no registration: a symfony project gets the core rules only" 0 \
  "$(gate Edit "$TMP/sf" "$TMP/unregistered-php.jsonl" "$TMP/sf/src/Controller/FooController.php")" "$P"

# ---------- hooks/register-stack.py ----------
RS="$TMP/rs"
mkdir -p "$RS"
run_reg() { # stdin-json [env assignments...] -> stdout of the hook; its exit code in $RC
  local json="$1"; shift
  OUT=$(echo "$json" | env "$@" python3 "$REG" 2>/dev/null); RC=$?
}
run_reg '{"session_id":"abc","transcript_path":"/p/projects/x/abc.jsonl"}' CLAUDE_KIT_STATE_DIR="$RS/a"
[ "$RC" -eq 0 ] && [ -z "$OUT" ] && ok || ko "register: a clean registration exits 0 and prints nothing"
cmp -s "$PLUGIN/stack.json" "$RS/a/sessions/abc/stacks/symfony.json" && ok || ko "register: the declaration is copied under the session id"
run_reg '{"session_id":"abc","transcript_path":"/p/projects/x/def.jsonl"}' CLAUDE_KIT_STATE_DIR="$RS/b"
[ -f "$RS/b/sessions/abc/stacks/symfony.json" ] && [ -f "$RS/b/sessions/def/stacks/symfony.json" ] && ok \
  || ko "register: differing session id and transcript stem are both registered"
run_reg '{"transcript_path":"/p/projects/x/par/subagents/agent-1.jsonl"}' CLAUDE_KIT_STATE_DIR="$RS/c"
[ -f "$RS/c/sessions/par/stacks/symfony.json" ] && ok || ko "register: a subagent transcript names its parent session"
run_reg '{"session_id":"abc"}' CLAUDE_KIT_STATE_DIR= XDG_STATE_HOME="$RS/xdg"
[ -f "$RS/xdg/claude-kit/sessions/abc/stacks/symfony.json" ] && ok || ko "register: without the override it writes under the XDG state home"
mkdir -p "$RS/d/sessions/old/stacks" "$RS/d/sessions/fresh/stacks" "$RS/keep"
: > "$RS/keep/precious"
ln -s "$RS/keep" "$RS/d/sessions/linked"
touch -t 202001010000 "$RS/d/sessions/old" "$RS/keep"
run_reg '{"session_id":"now"}' CLAUDE_KIT_STATE_DIR="$RS/d"
[ ! -e "$RS/d/sessions/old" ] && ok || ko "register: a session directory older than seven days is pruned"
[ -d "$RS/d/sessions/fresh" ] && [ -f "$RS/d/sessions/now/stacks/symfony.json" ] && ok || ko "register: fresh sessions are kept"
[ -f "$RS/keep/precious" ] && ok || ko "register: pruning never follows a symlink"
run_reg '{"session_id":"../escape","transcript_path":""}' CLAUDE_KIT_STATE_DIR="$RS/e"
[ "$RC" -eq 0 ] && [ ! -e "$RS/escape" ] && [ ! -e "$RS/e" ] && ok || ko "register: an unsafe session id writes nothing"
case "$OUT" in *'"systemMessage"'*"symfony: the rubric gate runs without this stack"*) ok ;; *) ko "register: an unusable session id says so once"; echo "$OUT" ;; esac
: > "$RS/blocked"
run_reg '{"session_id":"abc"}' CLAUDE_KIT_STATE_DIR="$RS/blocked"
[ "$RC" -eq 0 ] && ok || ko "register: an unwritable registry never fails the session"
case "$OUT" in *'"systemMessage"'*) ok ;; *) ko "register: an unwritable registry says so once"; echo "$OUT" ;; esac
run_reg 'not json' CLAUDE_KIT_STATE_DIR="$RS/f"
[ "$RC" -eq 0 ] && ok || ko "register: malformed hook input never fails the session"
python3 -c 'import json, sys
sys.path.insert(0, sys.argv[1])
import plan_skill_gate as g
with open(sys.argv[2]) as fh:
    stack = g.parse_declaration(json.load(fh))
sys.exit(0 if stack is not None and stack.name == "symfony" else 1)' "$ENGINE" "$PLUGIN/stack.json" && ok \
  || ko "register: the gate accepts this plugin's declaration"

echo "----------------------------------------"
echo "symfony tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
