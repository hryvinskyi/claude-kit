#!/usr/bin/env bash
# Write the commands that reach the kit's tools from outside Claude Code — a scheduled job, a git
# hook, a project's script — as small shims in one stable directory, each running the copy in a
# kit clone. A shim outlives plugin updates because it never points into the plugin cache.
#
#   bin/install-shims.sh [CLONE]              write or re-point every shim (CLONE: this script's clone)
#   bin/install-shims.sh --check [CLONE]      report; exit 1 if a shim is missing, stale or blocked
#   bin/install-shims.sh --uninstall          remove the shims this script wrote, nothing else
#   --plugins a,b,...                         only the shims of these plugins (install and --check)
#
# The directory is $SHIM_DIR, by default ~/.local/bin. Idempotent: a run that finds every shim
# current changes nothing. A file or link at a shim's path that this script did not write is never
# replaced; the run refuses and names it. A shim of a plugin left out of --plugins is neither
# written nor checked; one written earlier stays as it is, for --uninstall to remove. An install
# or a check that gets to the end says so on its last line: RESULT: current, pending or refused.
# Exit status: 0 current, 1 a shim is missing, stale or blocked, 2 the run cannot start.
set -euo pipefail

MODE=install
CLONE=""
PLUGINS_ARG=""
WITH_PLUGINS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --uninstall) MODE=uninstall ;;
    --plugins) [ $# -ge 2 ] || { echo "--plugins needs a comma-separated list" >&2; exit 2; }
      PLUGINS_ARG="$2"; WITH_PLUGINS=1; shift ;;
    --plugins=*) PLUGINS_ARG="${1#--plugins=}"; WITH_PLUGINS=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$CLONE" ] || { echo "only one clone may be named" >&2; exit 2; }; CLONE="$1" ;;
  esac
  shift
done

HERE="$(cd "$(dirname "$0")" && pwd -P)"
TEMPLATE="$HERE/shim.sh.template"
CLONE="$(cd "${CLONE:-$HERE/..}" 2>/dev/null && pwd -P)" || { echo "the clone directory does not exist" >&2; exit 2; }
if [ -z "${SHIM_DIR:-}" ]; then
  case "${HOME:-}" in
    /*) SHIM_DIR="$HOME/.local/bin" ;;
    *) echo "HOME is not set to an absolute directory, so there is no ~/.local/bin to use; set HOME, or name the directory in SHIM_DIR" >&2; exit 2 ;;
  esac
fi
MARKER="# claude-kit shim for "

# shim name -> the command it runs, relative to the clone; the plugin a shim belongs to is the
# directory under plugins/ its command lives in
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

# A link is never one of ours: this script writes regular files only, so a link at a shim's path,
# whatever it points at, was made by someone else.
ours() { [ ! -L "$1" ] && [ -f "$1" ] && grep -q "^$MARKER" "$1"; }
present() { [ -e "$1" ] || [ -L "$1" ]; }

# 0 when the shim's plugin is among those --plugins names, or --plugins was not given.
chosen() {
  local plugin="${1#plugins/}"
  plugin="${plugin%%/*}"
  [ "$WITH_PLUGINS" = 1 ] || return 0
  case ",$PLUGINS_ARG," in *",$plugin,"*) return 0 ;; *) return 1 ;; esac
}

if [ "$MODE" = uninstall ]; then
  for entry in "${SHIMS[@]}"; do
    shim="$SHIM_DIR/${entry%%:*}"
    if ours "$shim"; then rm -f "$shim"; ok "removed $shim"
    elif present "$shim"; then info "left $shim alone: this script did not write it"
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
  if ! chosen "${entry#*:}"; then
    if ours "$shim"; then info "left $shim as it is: its plugin is not among those chosen"; fi
    continue
  fi
  if [ ! -x "$target" ]; then
    bad "$name: the clone has no executable $target"
    continue
  fi
  wanted="$(sed -e "s|{{NAME}}|$name|g" -e "s|{{TARGET}}|$target|g" "$TEMPLATE")"
  if ours "$shim" && [ "$(cat "$shim")" = "$wanted" ] && [ -x "$shim" ]; then
    ok "$name -> $target"
    continue
  fi
  if present "$shim" && ! ours "$shim"; then
    bad "$shim exists and was not written by this script; move it away, then run this again"
    continue
  fi
  STALE=1
  verb="would write"; present "$shim" && verb="would re-point"
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

if [ "$FAILED" -ne 0 ]; then echo "RESULT: refused"; exit 1; fi
if [ "$MODE" = check ] && [ "$STALE" -ne 0 ]; then echo "RESULT: pending"; exit 1; fi
echo "RESULT: current"
exit 0
