#!/usr/bin/env python3
"""PostToolUse (Edit|Write): instant syntax check for edited PHP files.

Runs host `php -l` on the just-edited file so syntax errors surface immediately
instead of at the next quality-gate run. Host-php only by design: linting inside
a container (ddev exec) can read a stale copy when file sync is asynchronous.

When the host has no `php`, the hook cannot do its job — it says so ONCE per
session (exit 2, so the message reaches the model) instead of failing silently,
then stays quiet. Override the binary with CLAUDE_PHP_BIN (tests use this).
"""
import json
import os
import shutil
import subprocess
import sys


def php_binary():
    override = os.environ.get("CLAUDE_PHP_BIN")
    if override:
        return override if os.access(override, os.X_OK) else None
    return shutil.which("php")


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    path = (data.get("tool_input") or {}).get("file_path", "")
    if not path.endswith((".php", ".phtml")):
        return 0
    php = php_binary()
    if not php:
        sid = str(data.get("session_id") or "nosession")
        marker = os.path.join("/tmp", f"claude-php-lint-nophp-{sid}")
        if os.path.exists(marker):
            return 0
        try:
            open(marker, "w").close()
        except OSError:
            pass
        print(
            "php_lint: no `php` on the host PATH, so the syntax of edited PHP files is NOT "
            "being checked this session. Run the project's lint gate (e.g. `ddev exec php -l "
            "<file>` or the composer/make lint script) before handing back, or install php on "
            "the host (`brew install php`). This notice appears once per session.",
            file=sys.stderr,
        )
        return 2
    try:
        res = subprocess.run(
            [php, "-l", path], capture_output=True, text=True, timeout=15
        )
    except Exception:
        return 0
    if res.returncode != 0:
        out = (res.stdout + res.stderr).strip()
        print(f"PHP syntax error in {path}:\n{out}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
