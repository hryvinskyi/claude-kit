#!/usr/bin/env bash
# Install claude-kit for the person running it, from this clone: the command shims in ~/.local/bin,
# the board queue's Node dependencies, this clone as a local-directory plugin marketplace with the
# chosen plugins installed and enabled at user scope, the import of the engineering standards into
# the user CLAUDE.md, and a policy file with every policy at its default.
#
#   ./install.sh                  install, or bring an earlier install up to date
#   ./install.sh --check          report every step and change nothing; exit 1 when something is
#                                 missing, 2 when a step is refused
#   --stack a,b,...               also enable these stack plugins (a stack plugin ships a stack.json)
#   --plugins a,b,...             the plugins to enable, exactly; overrides the default and --stack
#   --skip-npm                    leave the board queue's dependencies alone
#
# By default every plugin the marketplace lists is enabled except the stack plugins, which add one
# framework's idiom each and are enabled only by name. The standards import covers the standards
# file of each stack plugin that ends up enabled.
#
# The Claude Code profile is the one the `claude` command uses (CLAUDE_CONFIG_DIR when it is set).
# Idempotent: a run that finds every step done changes nothing. A step that finds something it
# did not write in its way refuses and names it; nothing is overwritten. An applying run stops at
# the first refused step. Exit status: 0 done (or nothing to do), 1 something to do (--check), 2
# refused.
set -euo pipefail

CLONE="$(cd "$(dirname "$0")" && pwd -P)"
MARKETPLACE_FILE="$CLONE/.claude-plugin/marketplace.json"
BOARD_QUEUE_DIR="$CLONE/plugins/board-queue"
POLICIES_PY="$CLONE/plugins/guards/hooks/policies.py"
IMPORTER="$CLONE/standards/import_standards.py"
MIN_PYTHON="3.9"
MIN_NODE=26

MODE=apply
SKIP_NPM=0
PLUGINS_ARG=""
STACK_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --skip-npm) SKIP_NPM=1 ;;
    --plugins) [ $# -ge 2 ] || { echo "--plugins needs a comma-separated list" >&2; exit 2; }; PLUGINS_ARG="$2"; shift ;;
    --plugins=*) PLUGINS_ARG="${1#--plugins=}" ;;
    --stack) [ $# -ge 2 ] || { echo "--stack needs a comma-separated list" >&2; exit 2; }; STACK_ARG="$2"; shift ;;
    --stack=*) STACK_ARG="${1#--stack=}" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

PENDING=0
REFUSED=0
ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
todo() { printf '  ..    %s\n' "$*"; PENDING=1; }
bad()  { printf '  FAIL  %s\n' "$*"; REFUSED=1; }
step() { printf '\n== %s\n' "$*"; }
indent() { sed 's/^/        /'; }
have() { command -v "$1" >/dev/null 2>&1; }

# The marketplace's own name, its plugins, or those of its plugins that are stack plugins (one that
# ships a stack.json beside its manifest), from its manifest.
manifest() {
  python3 -I - "$MARKETPLACE_FILE" "$1" <<'EOF'
import json, os, sys
path, what = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
root = os.path.dirname(os.path.dirname(os.path.abspath(path)))
if what == "name":
    print(data["name"])
else:
    for plugin in data.get("plugins", []):
        source = plugin.get("source")
        is_stack = isinstance(source, str) and os.path.isfile(os.path.join(root, source, "stack.json"))
        if what == "plugins" or is_stack:
            print(plugin["name"])
EOF
}

# ---------------------------------------------------------------------------------------------
# Steps. Each is one function; they run in the order of STEPS.

step_prerequisites() {
  step "Prerequisites"
  if have git; then ok "git: $(git --version)"; else bad "git is not installed"; fi
  if have python3 && python3 -I -c "import sys; sys.exit(0 if sys.version_info >= ($(echo "$MIN_PYTHON" | tr . ,),) else 1)"; then
    ok "python3: $(python3 --version 2>&1)"
  elif have python3; then
    bad "python3 is $(python3 --version 2>&1); $MIN_PYTHON or newer is needed"
  else
    bad "python3 is not installed ($MIN_PYTHON or newer)"
  fi
  if have claude; then ok "claude: $(command -v claude)"; else bad "the claude command (Claude Code) is not installed"; fi
  if [ "$WITH_BOARD_QUEUE" = 1 ]; then
    if have node; then
      local major
      major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
      if [ "$major" -ge "$MIN_NODE" ] 2>/dev/null; then ok "node: $(node --version)"
      else bad "node is $(node --version 2>/dev/null || echo unknown); board-queue needs $MIN_NODE or newer"; fi
    else
      bad "node is not installed; board-queue needs Node $MIN_NODE or newer (or leave board-queue out of --plugins)"
    fi
    if [ "$SKIP_NPM" = 0 ]; then
      if have npm; then ok "npm: $(command -v npm)"; else bad "npm is not installed (pass --skip-npm to leave the dependencies alone)"; fi
    fi
  fi
}

step_shims() {
  step "Command shims"
  local out status=0
  out="$("$CLONE/bin/install-shims.sh" --check "$CLONE" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$out" | sed -n '4,$p'
    return
  fi
  if case "$out" in *"  FAIL  "*) true ;; *) false ;; esac; then
    printf '%s\n' "$out" | sed -n '4,$p'
    bad "the shims cannot be written; see the lines above"
    return
  fi
  if [ "$MODE" = check ]; then
    printf '%s\n' "$out" | sed -n '4,$p'
    PENDING=1
    return
  fi
  status=0
  out="$("$CLONE/bin/install-shims.sh" "$CLONE" 2>&1)" || status=$?
  printf '%s\n' "$out" | sed -n '4,$p'
  [ "$status" -eq 0 ] || bad "bin/install-shims.sh failed"
}

# 0 when node_modules holds exactly the packages the lockfile pins, 1 otherwise.
dependencies_current() {
  python3 -I - "$BOARD_QUEUE_DIR" <<'EOF'
import json, os, sys
root = sys.argv[1]
try:
    lock = json.load(open(os.path.join(root, "package-lock.json"), encoding="utf-8"))["packages"]
    installed = json.load(open(os.path.join(root, "node_modules", ".package-lock.json"), encoding="utf-8"))["packages"]
except (OSError, ValueError, KeyError):
    sys.exit(1)
wanted = {name: entry for name, entry in lock.items() if name}
for name, entry in installed.items():
    if wanted.get(name, {}).get("version") != entry.get("version"):
        sys.exit(1)
missing = [name for name, entry in wanted.items() if name not in installed and not entry.get("optional")]
sys.exit(1 if missing else 0)
EOF
}

step_node_dependencies() {
  [ "$WITH_BOARD_QUEUE" = 1 ] || return 0
  step "board-queue's Node dependencies"
  if [ "$SKIP_NPM" = 1 ]; then info "left alone (--skip-npm)"; return; fi
  if dependencies_current; then ok "node_modules matches package-lock.json"; return; fi
  if [ "$MODE" = check ]; then todo "would run npm ci in $BOARD_QUEUE_DIR"; return; fi
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/claude-kit-npm.XXXXXX")"
  if npm ci --prefix "$BOARD_QUEUE_DIR" --no-audit --no-fund >"$log" 2>&1 && dependencies_current; then
    ok "npm ci in $BOARD_QUEUE_DIR"
    rm -f "$log"
  else
    indent <"$log"
    bad "npm ci in $BOARD_QUEUE_DIR failed (log: $log)"
  fi
}

# present | absent | elsewhere:<where it comes from>
marketplace_state() {
  local listing
  listing="$(claude plugin marketplace list --json 2>/dev/null || echo '[]')"
  python3 -I - "$MARKETPLACE" "$CLONE" "$listing" <<'EOF'
import json, os, sys
name, clone, listing = sys.argv[1:4]
try:
    entries = json.loads(listing)
except ValueError:
    entries = []
for entry in entries if isinstance(entries, list) else []:
    if entry.get("name") != name:
        continue
    where = entry.get("path") or entry.get("installLocation") or entry.get("repo") or entry.get("url") or "?"
    if entry.get("source") == "directory" and os.path.realpath(where) == os.path.realpath(clone):
        print("present")
    else:
        print("elsewhere:%s (%s)" % (where, entry.get("source", "?")))
    break
else:
    print("absent")
EOF
}

step_marketplace() {
  step "Marketplace"
  local state
  state="$(marketplace_state)"
  case "$state" in
    present) ok "$MARKETPLACE is added from $CLONE" ;;
    absent)
      if [ "$MODE" = check ]; then todo "would add $CLONE as the marketplace $MARKETPLACE (user scope)"; return; fi
      if out="$(claude plugin marketplace add "$CLONE" --scope user 2>&1)" && [ "$(marketplace_state)" = present ]; then
        ok "added $CLONE as the marketplace $MARKETPLACE (user scope)"
      else
        printf '%s\n' "$out" | indent
        bad "claude plugin marketplace add $CLONE --scope user failed"
      fi ;;
    *) bad "a marketplace named $MARKETPLACE already comes from ${state#elsewhere:}; remove it (claude plugin marketplace remove $MARKETPLACE) or run the installer of that clone" ;;
  esac
}

# enabled | disabled | absent — the plugin's install at user scope.
plugin_state() {
  local listing
  listing="$(claude plugin list --json 2>/dev/null || echo '[]')"
  python3 -I - "$1" "$listing" <<'EOF'
import json, sys
wanted, listing = sys.argv[1:3]
try:
    entries = json.loads(listing)
except ValueError:
    entries = []
for entry in entries if isinstance(entries, list) else []:
    if entry.get("id") == wanted and entry.get("scope") == "user":
        print("enabled" if entry.get("enabled") else "disabled")
        break
else:
    print("absent")
EOF
}

step_plugins() {
  step "Plugins (user scope)"
  if [ "$MODE" = check ] && [ "$(marketplace_state)" != present ]; then
    for plugin in "${PLUGINS[@]}"; do todo "would install and enable $plugin@$MARKETPLACE"; done
    return
  fi
  local plugin id state out done
  for plugin in "${PLUGINS[@]}"; do
    id="$plugin@$MARKETPLACE"
    state="$(plugin_state "$id")"
    case "$state:$MODE" in
      enabled:*) ok "$id installed and enabled"; continue ;;
      disabled:check) todo "would enable $id"; continue ;;
      absent:check) todo "would install $id"; continue ;;
      disabled:apply) done="enabled"; out="$(claude plugin enable "$id" --scope user 2>&1)" || true ;;
      absent:apply) done="installed"; out="$(claude plugin install "$id" --scope user 2>&1)" || true ;;
    esac
    if [ "$(plugin_state "$id")" = enabled ]; then
      ok "$done $id"
    else
      printf '%s\n' "$out" | indent
      bad "$id did not end up enabled"
    fi
  done
}

# The importer's --stack argument: each enabled stack plugin that ships a standards file.
standards_args() {
  local stack list=""
  for stack in ${ENABLED_STACKS[@]+"${ENABLED_STACKS[@]}"}; do
    [ -f "$CLONE/plugins/$stack/standards/CLAUDE.standards.$stack.md" ] && list="${list:+$list,}$stack"
  done
  [ -z "$list" ] || printf '%s\n' --stack "$list"
}

step_standards() {
  step "Engineering standards in the user CLAUDE.md"
  local out args=() lines target index=0 line state absent=0 refused=0
  while IFS= read -r line; do args+=("$line"); done < <(standards_args)
  if ! lines="$(python3 -I "$IMPORTER" --print-line ${args[@]+"${args[@]}"} 2>&1)"; then
    printf '%s\n' "$lines" | indent; bad "a standards file of this clone is missing"; return
  fi
  out="$(python3 -I "$IMPORTER" --check ${args[@]+"${args[@]}"} 2>&1)" || true
  # One "<state> <CLAUDE.md>: <detail>" line per import line, in the same order; the file name ends
  # at its first colon.
  target="$(printf '%s\n' "$out" | sed -n '1s/^[a-z]* *\([^:]*\): .*$/\1/p')"
  while IFS= read -r line; do
    index=$((index + 1))
    state="$(printf '%s\n' "$out" | sed -n "${index}p")"
    case "${state%% *}" in
      present) ok "$target imports $line" ;;
      absent) absent=1; [ "$MODE" = apply ] || todo "would add $line to $target" ;;
      *) refused=1 ;;
    esac
  done <<<"$lines"
  if [ "$refused" -ne 0 ]; then
    printf '%s\n' "$out" | indent; bad "${target:-the user CLAUDE.md} cannot take the import as it is; see above"; return
  fi
  [ "$absent" -eq 1 ] && [ "$MODE" = apply ] || return 0
  if out="$(python3 -I "$IMPORTER" ${args[@]+"${args[@]}"} 2>&1)"; then
    printf '%s\n' "$out" | sed -n 's/^added *\([^:]*\): \(.*\)$/  ok    added \2 to \1/p'
  else
    printf '%s\n' "$out" | indent; bad "the import could not be added to $target"
  fi
}

policy_file() {
  case "${XDG_CONFIG_HOME:-}" in
    /*) printf '%s/claude-kit/policies.toml\n' "$XDG_CONFIG_HOME" ;;
    *) printf '%s/.config/claude-kit/policies.toml\n' "$HOME" ;;
  esac
}

# The policy file with every policy the guards know, each at its default.
policy_defaults() {
  python3 -I - "$POLICIES_PY" <<'EOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("policies", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print("# Personal policies of the claude-kit guard hooks: top-level booleans, each at its default.")
print("# A project switches one on for itself with CLAUDE_KIT_<NAME> in its .claude/settings.json")
print("# \"env\" block; see plugins/guards/README.md.")
for name, value in module.DEFAULTS.items():
    print("%s = %s" % (name, "true" if value else "false"))
EOF
}

step_policies() {
  step "Policies"
  local file tmp
  file="$(policy_file)"
  if [ -e "$file" ]; then ok "$file present; left as it is"; return; fi
  if [ "$MODE" = check ]; then todo "would write $file with every policy at its default"; return; fi
  mkdir -p "$(dirname "$file")"
  tmp="$file.tmp.$$"
  policy_defaults >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$file"
  ok "wrote $file with every policy at its default"
}

STEPS=(step_prerequisites step_shims step_node_dependencies step_marketplace step_plugins step_standards step_policies)

# ---------------------------------------------------------------------------------------------
printf 'claude-kit install (%s)\nclone: %s\n' "$MODE" "$CLONE"
have python3 || { echo "python3 is not installed ($MIN_PYTHON or newer)" >&2; exit 2; }
[ -f "$MARKETPLACE_FILE" ] || { echo "$MARKETPLACE_FILE is missing; this is not a claude-kit clone" >&2; exit 2; }
MARKETPLACE="$(manifest name)"
LISTED=()
while IFS= read -r name; do [ -n "$name" ] && LISTED+=("$name"); done < <(manifest plugins)
STACKS=()
while IFS= read -r name; do [ -n "$name" ] && STACKS+=("$name"); done < <(manifest stacks)
is_stack() { case " ${STACKS[*]:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
PLUGINS=()
if [ -n "$PLUGINS_ARG" ]; then
  [ -z "$STACK_ARG" ] || echo "--stack is left aside: --plugins names every plugin to enable" >&2
  IFS=, read -r -a REQUESTED <<<"$PLUGINS_ARG"
  for name in ${REQUESTED[@]+"${REQUESTED[@]}"}; do
    [ -n "$name" ] || continue
    case " ${LISTED[*]} " in
      *" $name "*) PLUGINS+=("$name") ;;
      *) echo "the marketplace lists no plugin named $name (it lists: ${LISTED[*]})" >&2; exit 2 ;;
    esac
  done
else
  for name in ${LISTED[@]+"${LISTED[@]}"}; do is_stack "$name" || PLUGINS+=("$name"); done
  IFS=, read -r -a REQUESTED <<<"$STACK_ARG"
  for name in ${REQUESTED[@]+"${REQUESTED[@]}"}; do
    [ -n "$name" ] || continue
    is_stack "$name" || { echo "no stack plugin is named $name (stack plugins: ${STACKS[*]:-none})" >&2; exit 2; }
    case " ${PLUGINS[*]:-} " in *" $name "*) ;; *) PLUGINS+=("$name") ;; esac
  done
fi
ENABLED_STACKS=()
LEFT_OUT=()
for name in ${STACKS[@]+"${STACKS[@]}"}; do
  case " ${PLUGINS[*]:-} " in *" $name "*) ENABLED_STACKS+=("$name") ;; *) LEFT_OUT+=("$name") ;; esac
done
[ "${#PLUGINS[@]}" -gt 0 ] || { echo "no plugin to enable" >&2; exit 2; }
WITH_BOARD_QUEUE=0
case " ${PLUGINS[*]} " in *" board-queue "*) WITH_BOARD_QUEUE=1 ;; esac
printf 'marketplace: %s\nplugins: %s\n' "$MARKETPLACE" "${PLUGINS[*]}"
# An explicit --plugins list is the person's whole choice; the hint is for the default.
if [ -z "$PLUGINS_ARG" ] && [ "${#LEFT_OUT[@]}" -gt 0 ]; then
  printf 'stack plugins not enabled: %s (add the one your project runs on with --stack NAME)\n' "${LEFT_OUT[*]}"
fi

for each in "${STEPS[@]}"; do
  "$each"
  if [ "$REFUSED" -ne 0 ] && [ "$MODE" = apply ]; then
    printf '\nRESULT: refused at the step above; the steps after it did not run.\n'
    exit 2
  fi
done

printf '\n'
if [ "$REFUSED" -ne 0 ]; then echo "RESULT: some steps are refused (FAIL above)."; exit 2; fi
if [ "$MODE" = check ]; then
  if [ "$PENDING" -ne 0 ]; then echo "RESULT: something is missing; ./install.sh would do the steps marked .."; exit 1; fi
  echo "RESULT: everything is installed."
  exit 0
fi
echo "RESULT: installed. Start a new Claude Code session to load the plugins."
