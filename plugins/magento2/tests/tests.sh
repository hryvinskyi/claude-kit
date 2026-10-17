#!/bin/bash
# Tests for this plugin's gate part: hooks/register-stack.py and what stack.json makes the rubric
# gate of the guards plugin require on a Magento project. Run from the kit clone; the gate is
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
STACK_CACHE="/home/dev/.claude/plugins/cache/claude-kit/magento2/0.1.0/skills"
# t <transcript> <entry>... ; registered for its session. Entries: php, js (Skill calls of the core skills),
# p:<ref> / j:<ref> (a core reference), mp / mf (the stack skills), anything else is a Read path.
t() {
  local out="$1"; shift; : > "$out"
  for e in "$@"; do
    case "$e" in
      php) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"architecture:clean-architecture-php"}}]}}\n' >> "$out" ;;
      js) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"architecture:clean-architecture-js"}}]}}\n' >> "$out" ;;
      p:*) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s/references/%s"}}]}}\n' "$CORE_PHP" "${e#p:}" >> "$out" ;;
      j:*) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s/references/%s"}}]}}\n' "$CORE_JS" "${e#j:}" >> "$out" ;;
      mp) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"magento2:magento2-architecture-php"}}]}}\n' >> "$out" ;;
      mf) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"magento2:magento2-architecture-frontend"}}]}}\n' >> "$out" ;;
      *) printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"%s"}}]}}\n' "$e" >> "$out" ;;
    esac
  done
  register "$out"
}

# ---------- fixtures ----------
mkdir -p "$TMP/mag/app/code/Acme/Foo/Block" "$TMP/mag/app/code/Acme/Foo/Api/Data" "$TMP/mag/app/code/Acme/Foo/Model" \
  "$TMP/mag/.claude/plans/x" "$TMP/mag/.claude/plans/y" "$TMP/mag/.claude/plans/z" "$TMP/modroot/app/code/Acme/Bar/Block" \
  "$TMP/mag/app/code/Acme/Foo/view/frontend/web/js/model" "$TMP/mag/app/code/Acme/Foo/Test/Js" \
  "$TMP/mag/pub/static/frontend/Acme/theme/en_US/Acme_Foo/js" "$TMP/mag/e2e/src/pages" \
  "$TMP/plain/src/Api/Data" "$TMP/plain/src/Service" "$TMP/rootonly/app/etc" "$TMP/rootonly/src" "$TMP/other/src"
echo '{"require":{"magento/framework":"*"}}' > "$TMP/mag/composer.json"
echo '{"type":"magento2-module"}' > "$TMP/modroot/app/code/Acme/Bar/composer.json"
echo '{"devDependencies":{"@playwright/test":"*"}}' > "$TMP/mag/e2e/package.json"
echo '{}' > "$TMP/plain/composer.json"
echo '{}' > "$TMP/rootonly/composer.json"
echo '{"require":{"acme/other-framework":"^1"}}' > "$TMP/other/composer.json"
t "$TMP/empty.jsonl"
t "$TMP/loaded.jsonl" php
t "$TMP/t-skill-solid.jsonl" php p:solid.md
t "$TMP/t-mag.jsonl" php p:solid.md mp
t "$TMP/t-mag-ddd.jsonl" php p:solid.md mp p:ddd.md
t "$TMP/t-skill-mag.jsonl" php mp
t "$TMP/t-mag-cache.jsonl" php p:solid.md "$STACK_CACHE/magento2-architecture-php/SKILL.md"
t "$TMP/tj-base.jsonl" js j:solid.md j:javascript.md
t "$TMP/tj-mag.jsonl" js j:solid.md j:javascript.md mf
t "$TMP/tj-mag-ddd.jsonl" js j:solid.md j:javascript.md mf j:ddd.md
t "$TMP/t-plan-php-js.jsonl" php mp js mf
t "$TMP/t-both-mag.jsonl" php p:solid.md mp js j:solid.md j:javascript.md mf
t "$TMP/t-php-for-other.jsonl" php p:solid.md

# ---------- PHP source ----------
expect_exit "source gate: magento project needs the magento2 stack skill" 2 \
  "$(gate Edit "$TMP/mag" "$TMP/t-skill-solid.jsonl" "$TMP/mag/app/code/Acme/Foo/Block/Survey.php")" "$P"
expect_exit "source gate: magento block with skill+solid+stack skill allowed" 0 \
  "$(gate Edit "$TMP/mag" "$TMP/t-mag.jsonl" "$TMP/mag/app/code/Acme/Foo/Block/Survey.php")" "$P"
expect_exit "source gate: the stack skill's SKILL.md read from the versioned plugin cache counts" 0 \
  "$(gate Edit "$TMP/mag" "$TMP/t-mag-cache.jsonl" "$TMP/mag/app/code/Acme/Foo/Block/Survey.php")" "$P"
expect_exit "source gate: magento Api/Data needs ddd.md too" 2 \
  "$(gate Write "$TMP/mag" "$TMP/t-mag.jsonl" "$TMP/mag/app/code/Acme/Foo/Api/Data/SurveyOptIn.php")" "$P"
expect_exit "source gate: magento Model needs ddd.md too" 2 \
  "$(gate Write "$TMP/mag" "$TMP/t-mag.jsonl" "$TMP/mag/app/code/Acme/Foo/Model/Order.php")" "$P"
expect_exit "source gate: magento Api/Data with ddd.md allowed" 0 \
  "$(gate Write "$TMP/mag" "$TMP/t-mag-ddd.jsonl" "$TMP/mag/app/code/Acme/Foo/Api/Data/SurveyOptIn.php")" "$P"
expect_exit "source gate: magento detected from a module composer.json below an unmanaged root" 2 \
  "$(gate Write "$TMP/modroot" "$TMP/t-skill-solid.jsonl" "$TMP/modroot/app/code/Acme/Bar/Block/Foo.php")" "$P"
expect_exit "source gate: magento detected from app/etc at the project root" 2 \
  "$(gate Write "$TMP/rootonly" "$TMP/t-skill-solid.jsonl" "$TMP/rootonly/src/Foo.php")" "$P"
expect_exit "source gate: Api/Data needs ddd.md on any PHP project while this stack is registered" 2 \
  "$(gate Write "$TMP/plain" "$TMP/t-skill-solid.jsonl" "$TMP/plain/src/Api/Data/Line.php")" "$P"
expect_exit "source gate: a project of another framework needs no magento2 skill" 0 \
  "$(gate Write "$TMP/other" "$TMP/t-php-for-other.jsonl" "$TMP/other/src/Foo.php")" "$P"
OUT=$(gate Write "$TMP/mag" "$TMP/loaded.jsonl" "$TMP/mag/app/code/Acme/Foo/Api/Data/SurveyOptIn.php" | python3 "$P" 2>&1)
case "$OUT" in *"references/ddd.md"*"references/solid.md"*"Skill tool with \`magento2:magento2-architecture-php\`"*) ok ;;
  *) ko "source gate: denial names every missing reference"; echo "$OUT" ;; esac

# ---------- plans ----------
expect_exit "plan gate: magento plan needs the stack skill" 2 \
  "$(gate Write "$TMP/mag" "$TMP/loaded.jsonl" "$TMP/mag/.claude/plans/x/_plan.md")" "$P"
expect_exit "plan gate: magento plan with skill+stack skill allowed (solid not required for plans)" 0 \
  "$(gate Write "$TMP/mag" "$TMP/t-skill-mag.jsonl" "$TMP/mag/.claude/plans/x/_plan.md")" "$P"
expect_exit "js plan: magento plan naming a JS file needs the JS skill too" 2 \
  "$(gatec Write "$TMP/mag" "$TMP/t-skill-mag.jsonl" "$TMP/mag/.claude/plans/x/_plan.md" "Task 2: add view/frontend/web/js/coupon.js")" "$P"
expect_exit "js plan: magento plan naming a JS file with both skills allowed" 0 \
  "$(gatec Write "$TMP/mag" "$TMP/t-plan-php-js.jsonl" "$TMP/mag/.claude/plans/x/_plan.md" "Task 2: add view/frontend/web/js/coupon.js")" "$P"
expect_exit "js plan: magento plan naming no JS needs only the PHP skill" 0 \
  "$(gatec Write "$TMP/mag" "$TMP/t-skill-mag.jsonl" "$TMP/mag/.claude/plans/x/_plan.md" "Task 2: add Api/CouponInterface.php")" "$P"
printf '# Plan\n| 1 | `web/js/coupon-gap.ts` pure module |\n' > "$TMP/mag/.claude/plans/y/_plan.md"
expect_exit "js plan: a sibling plan file naming a .ts file brings the JS skill into an Edit" 2 \
  "$(gatec Edit "$TMP/mag" "$TMP/t-skill-mag.jsonl" "$TMP/mag/.claude/plans/y/task-1.md" "reword")" "$P"
for word in RequireJS Knockout uiComponent AssetRendererInterface x-magento-init data-mage-init Alpine.data; do
  expect_exit "js plan: a plan naming $word orders browser work" 2 \
    "$(gatec Write "$TMP/mag" "$TMP/t-skill-mag.jsonl" "$TMP/mag/.claude/plans/z/_plan.md" "Task 3: the $word part")" "$P"
done
expect_exit "js plan: a plain PHP plan naming Knockout orders browser work while this stack is registered" 2 \
  "$(gatec Write "$TMP/plain" "$TMP/loaded.jsonl" "$TMP/plain/.claude/plans/x/_plan.md" "Task 3: a Knockout grid")" "$P"

# ---------- JavaScript source ----------
expect_exit "js gate: magento module js needs the magento2 frontend skill" 2 \
  "$(gate Write "$TMP/mag" "$TMP/tj-base.jsonl" "$TMP/mag/app/code/Acme/Foo/view/frontend/web/js/coupon.js")" "$P"
expect_exit "js gate: magento module js with the frontend skill allowed" 0 \
  "$(gate Write "$TMP/mag" "$TMP/tj-mag.jsonl" "$TMP/mag/app/code/Acme/Foo/view/frontend/web/js/coupon.js")" "$P"
expect_exit "js gate: magento js model/ needs ddd.md" 2 \
  "$(gate Write "$TMP/mag" "$TMP/tj-mag.jsonl" "$TMP/mag/app/code/Acme/Foo/view/frontend/web/js/model/cart.js")" "$P"
expect_exit "js gate: magento js model/ with ddd.md allowed" 0 \
  "$(gate Write "$TMP/mag" "$TMP/tj-mag-ddd.jsonl" "$TMP/mag/app/code/Acme/Foo/view/frontend/web/js/model/cart.js")" "$P"
expect_exit "js gate: magento source write with both rubrics loaded allowed" 0 \
  "$(gate Write "$TMP/mag" "$TMP/t-both-mag.jsonl" "$TMP/mag/app/code/Acme/Foo/view/frontend/web/js/coupon.js")" "$P"
for skipped in "$TMP/mag/app/code/Acme/Foo/view/frontend/requirejs-config.js" \
  "$TMP/mag/app/code/Acme/Foo/Test/Js/coupon.test.mjs" "$TMP/mag/pub/static/frontend/Acme/theme/en_US/Acme_Foo/js/coupon.js"; do
  expect_exit "js gate: not source, untouched: ${skipped#$TMP/}" 0 \
    "$(gate Write "$TMP/mag" "$TMP/empty.jsonl" "$skipped")" "$P"
done
expect_exit "js gate: a test suite that is a package of its own untouched" 0 \
  "$(gate Write "$TMP/mag" "$TMP/empty.jsonl" "$TMP/mag/e2e/src/pages/cart.ts")" "$P"

# ---------- writes through the shell ----------
expect_exit "bash write: heredoc plan naming a .ts file on magento needs the JS skill" 2 \
  "$(bash_json "cat > .claude/plans/x/_plan.md <<'EOF'
| 1 | view/frontend/web/js/gap.ts |
EOF" "$TMP/mag" "$TMP/t-skill-mag.jsonl")" "$B"
expect_exit "bash write: heredoc into magento PHP source without the stack skill blocked" 2 \
  "$(bash_json "cat > app/code/Acme/Foo/Block/Survey.php <<'EOF'
<?php
EOF" "$TMP/mag" "$TMP/t-skill-solid.jsonl")" "$B"
expect_exit "bash write: heredoc into magento PHP source with the stack skill allowed" 0 \
  "$(bash_json "cat > app/code/Acme/Foo/Block/Survey.php <<'EOF'
<?php
EOF" "$TMP/mag" "$TMP/t-mag.jsonl")" "$B"
expect_exit "bash write: a copy into pub/static untouched" 0 \
  "$(bash_json "cp /tmp/coupon.js pub/static/frontend/Acme/theme/en_US/Acme_Foo/js/coupon.js" "$TMP/mag" "$TMP/empty.jsonl")" "$B"
OUT=$(bash_json "sed -i '' 's/a/b/' app/code/Acme/Foo/Block/Survey.php" "$TMP/mag" "$TMP/t-skill-solid.jsonl" | python3 "$B" 2>&1)
case "$OUT" in *"a shell write of PHP source"*"magento2:magento2-architecture-php"*) ok ;;
  *) ko "bash write: the denial names the stack skill"; echo "$OUT" ;; esac

# ---------- without the registration ----------
cp "$TMP/t-skill-solid.jsonl" "$TMP/unregistered.jsonl"
expect_exit "no registration: a magento project gets the core rules only" 0 \
  "$(gate Edit "$TMP/mag" "$TMP/unregistered.jsonl" "$TMP/mag/app/code/Acme/Foo/Block/Survey.php")" "$P"

# ---------- hooks/register-stack.py ----------
RS="$TMP/rs"
mkdir -p "$RS"
run_reg() { # stdin-json [env assignments...] -> stdout of the hook; its exit code in $RC
  local json="$1"; shift
  OUT=$(echo "$json" | env "$@" python3 "$REG" 2>/dev/null); RC=$?
}
run_reg '{"session_id":"abc","transcript_path":"/p/projects/x/abc.jsonl"}' CLAUDE_KIT_STATE_DIR="$RS/a"
[ "$RC" -eq 0 ] && [ -z "$OUT" ] && ok || ko "register: a clean registration exits 0 and prints nothing"
cmp -s "$PLUGIN/stack.json" "$RS/a/sessions/abc/stacks/magento2.json" && ok || ko "register: the declaration is copied under the session id"
run_reg '{"session_id":"abc","transcript_path":"/p/projects/x/def.jsonl"}' CLAUDE_KIT_STATE_DIR="$RS/b"
[ -f "$RS/b/sessions/abc/stacks/magento2.json" ] && [ -f "$RS/b/sessions/def/stacks/magento2.json" ] && ok \
  || ko "register: differing session id and transcript stem are both registered"
run_reg '{"transcript_path":"/p/projects/x/par/subagents/agent-1.jsonl"}' CLAUDE_KIT_STATE_DIR="$RS/c"
[ -f "$RS/c/sessions/par/stacks/magento2.json" ] && ok || ko "register: a subagent transcript names its parent session"
run_reg '{"session_id":"abc"}' CLAUDE_KIT_STATE_DIR= XDG_STATE_HOME="$RS/xdg"
[ -f "$RS/xdg/claude-kit/sessions/abc/stacks/magento2.json" ] && ok || ko "register: without the override it writes under the XDG state home"
mkdir -p "$RS/d/sessions/old/stacks" "$RS/d/sessions/fresh/stacks" "$RS/keep"
: > "$RS/keep/precious"
ln -s "$RS/keep" "$RS/d/sessions/linked"
touch -t 202001010000 "$RS/d/sessions/old" "$RS/keep"
run_reg '{"session_id":"now"}' CLAUDE_KIT_STATE_DIR="$RS/d"
[ ! -e "$RS/d/sessions/old" ] && ok || ko "register: a session directory older than seven days is pruned"
[ -d "$RS/d/sessions/fresh" ] && [ -f "$RS/d/sessions/now/stacks/magento2.json" ] && ok || ko "register: fresh sessions are kept"
[ -f "$RS/keep/precious" ] && ok || ko "register: pruning never follows a symlink"
run_reg '{"session_id":"../escape","transcript_path":""}' CLAUDE_KIT_STATE_DIR="$RS/e"
[ "$RC" -eq 0 ] && [ ! -e "$RS/escape" ] && [ ! -e "$RS/e" ] && ok || ko "register: an unsafe session id writes nothing"
case "$OUT" in *'"systemMessage"'*"magento2: the rubric gate runs without this stack"*) ok ;; *) ko "register: an unusable session id says so once"; echo "$OUT" ;; esac
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
sys.exit(0 if stack is not None and stack.name == "magento2" else 1)' "$ENGINE" "$PLUGIN/stack.json" && ok \
  || ko "register: the gate accepts this plugin's declaration"

echo "----------------------------------------"
echo "magento2 tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
