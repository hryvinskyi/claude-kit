#!/usr/bin/env bash
# Write the commands that reach the kit's tools from outside Claude Code — a scheduled job, a git
# hook, a project's script — as small shims in one stable directory, each running the copy in a
# kit clone. A shim outlives plugin updates because it never points into the plugin cache.
#
#   bin/install-shims.sh [CLONE]              write or re-point every shim (CLONE: this script's clone)
#   bin/install-shims.sh --check [CLONE]      report; exit 1 if a shim is missing, stale or blocked
#   bin/install-shims.sh --uninstall          remove the shims this script wrote, nothing else
#
# The directory is $SHIM_DIR, by default ~/.local/bin. Idempotent: a run that finds every shim
# current changes nothing. A file at a shim's path that this script did not write is never
# replaced; the run refuses and names it.
set -euo pipefail

MODE=install
CLONE=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) [ -z "$CLONE" ] || { echo "only one clone may be named" >&2; exit 2; }; CLONE="$arg" ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd -P)"
TEMPLATE="$HERE/shim.sh.template"
CLONE="$(cd "${CLONE:-$HERE/..}" 2>/dev/null && pwd -P)" || { echo "the clone directory does not exist" >&2; exit 2; }
SHIM_DIR="${SHIM_DIR:-$HOME/.local/bin}"
MARKER="# claude-kit shim for "

# shim name -> the command it runs, relative to the clone
SHIMS=(
  "board-queue:plugins/board-queue/bin/board-queue"
  "board-queue-mcp:plugins/board-queue/bin/board-queue-mcp"
  "find-vault:plugins/vault/bin/find-vault"
  "vault-check:plugins/vault/bin/vault-check"
  "vault-capture:plugins/vault/bin/vault-capture"
  "vault-search:plugins/vault/bin/vault-search"
  "vault-merge:plugins/vault/bin/vault-merge"
)

FAILED=0
STALE=0
ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAILED=1; }

ours() { [ -f "$1" ] && grep -q "^$MARKER" "$1"; }

if [ "$MODE" = uninstall ]; then
  for entry in "${SHIMS[@]}"; do
    shim="$SHIM_DIR/${entry%%:*}"
    if ours "$shim"; then rm -f "$shim"; ok "removed $shim"
    elif [ -e "$shim" ]; then info "left $shim alone: this script did not write it"
    else ok "$shim absent"; fi
  done
  exit 0
fi

case "$CLONE" in
  *[\"\$\`\\\|\&]*) echo "the clone path holds a character a shim cannot carry: $CLONE" >&2; exit 2 ;;
esac
[ -f "$TEMPLATE" ] || { echo "the shim template is missing: $TEMPLATE" >&2; exit 2; }

printf 'install-shims (%s)\nclone: %s\nshims: %s\n' "$MODE" "$CLONE" "$SHIM_DIR"
[ "$MODE" = check ] || mkdir -p "$SHIM_DIR"

for entry in "${SHIMS[@]}"; do
  name="${entry%%:*}"
  target="$CLONE/${entry#*:}"
  shim="$SHIM_DIR/$name"
  if [ ! -x "$target" ]; then
    bad "$name: the clone has no executable $target"
    continue
  fi
  wanted="$(sed -e "s|{{NAME}}|$name|g" -e "s|{{TARGET}}|$target|g" "$TEMPLATE")"
  if [ -f "$shim" ] && [ "$(cat "$shim")" = "$wanted" ] && [ -x "$shim" ]; then
    ok "$name -> $target"
    continue
  fi
  if [ -e "$shim" ] && ! ours "$shim"; then
    bad "$shim exists and was not written by this script; move it away, then run this again"
    continue
  fi
  STALE=1
  verb="would write"; [ -e "$shim" ] && verb="would re-point"
  if [ "$MODE" = check ]; then
    info "$verb $name -> $target"
    continue
  fi
  tmp="$shim.tmp.$$"
  printf '%s\n' "$wanted" > "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$shim"
  ok "${verb#would } $name -> $target"
done

case ":$PATH:" in
  *":$SHIM_DIR:"*) ;;
  *) info "$SHIM_DIR is not on PATH: add it for shells and sessions (scheduled jobs use the absolute path)" ;;
esac

[ "$FAILED" -eq 0 ] || exit 1
[ "$MODE" = check ] && [ "$STALE" -ne 0 ] && exit 1
exit 0
