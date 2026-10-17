# shellcheck shell=sh
# What both of this package's command wrappers do before they start Node:
# find the package's installed dependencies, and read the optional credentials.
# Sourced by bin/board-queue and bin/board-queue-mcp; never run on its own.

# board_queue_require_dependencies PACKAGE_DIR FORWARD_COMMAND ARGS...
#
# A copy of this package without its dependencies — a plugin cache holds the
# files and never what `npm ci` installs — hands the call to the same command
# installed from a clone that has them, once; otherwise it stops with the step
# that fixes it.
board_queue_require_dependencies() {
  _bq_dir=$1
  _bq_forward=$2
  shift 2
  [ -d "$_bq_dir/node_modules" ] && return 0
  if [ -z "${BOARD_QUEUE_FORWARDED:-}" ] && [ -x "$_bq_forward" ]; then
    BOARD_QUEUE_FORWARDED=1
    export BOARD_QUEUE_FORWARDED
    exec "$_bq_forward" "$@"
  fi
  echo "board-queue: its dependencies are not installed in $_bq_dir; run: npm ci --prefix \"$_bq_dir\"" >&2
  exit 1
}

# board_queue_load_credentials
#
# The optional GitHub App credential lives in an environment file that may set
# GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH — the path to the App's PEM file,
# itself chmod 600, never the key text — and, to skip the installation lookup,
# GITHUB_APP_INSTALLATION_ID. The file is $BOARD_QUEUE_ENV when that is set,
# else ${XDG_CONFIG_HOME:-~/.config}/board-queue/board-queue.env, else the
# older ~/.claude/secrets/board-queue.env. Without one the queue falls back to
# the credential the GitHub command line tool holds.
board_queue_load_credentials() {
  _bq_config=${XDG_CONFIG_HOME:-}
  case "$_bq_config" in /*) ;; *) _bq_config="$HOME/.config" ;; esac
  if [ -n "${BOARD_QUEUE_ENV:-}" ]; then
    _bq_secrets=$BOARD_QUEUE_ENV
  elif [ -f "$_bq_config/board-queue/board-queue.env" ]; then
    _bq_secrets="$_bq_config/board-queue/board-queue.env"
  else
    _bq_secrets="$HOME/.claude/secrets/board-queue.env"
  fi
  [ -f "$_bq_secrets" ] || return 0
  # Anything another account on this machine can read is not a secret, so a
  # file that is readable by anyone else is skipped rather than used. GNU stat
  # is asked first: BSD stat refuses -c outright, while GNU stat would read
  # BSD's -f as a different question and print an answer to it.
  _bq_mode=$(stat -c %a "$_bq_secrets" 2>/dev/null || stat -f %Lp "$_bq_secrets" 2>/dev/null || echo "")
  if [ "$_bq_mode" = "600" ]; then
    set -a
    . "$_bq_secrets"
    set +a
  else
    echo "board-queue: $_bq_secrets is mode ${_bq_mode:-unknown}, not 600; it was not read (chmod 600 it)" >&2
  fi
}
