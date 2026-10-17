#!/usr/bin/env python3
"""Personal policies of the guard hooks, read from one TOML file.

The file is `${XDG_CONFIG_HOME:-~/.config}/claude-kit/policies.toml`; an unset,
empty or relative XDG_CONFIG_HOME falls back to `~/.config`. Every policy is a
top-level boolean:

    # ~/.config/claude-kit/policies.toml
    forbid_assistant_commit_trailers = true

A policy that is absent, not a boolean, or in a file that cannot be read or
parsed takes its default, so a missing or broken file never blocks anything.
On Python 3.11+ the file is parsed with tomllib; older interpreters read the
top-level `key = true|false` lines and nothing else.

Run as a script to print the effective value of each known policy and the file
it came from: `python3 policies.py [name ...]`.
"""
import os
import re
import sys

try:
    import tomllib
except ImportError:  # Python < 3.11
    tomllib = None

# Every policy the hooks read, with the value it takes when the file says nothing
DEFAULTS = {
    "forbid_assistant_commit_trailers": False,
}

BOOLEAN_LINE = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*(?:#.*)?$")
TABLE_LINE = re.compile(r"^\s*\[")


def policy_file() -> str:
    """The path of the policy file, whether or not it exists."""
    base = os.environ.get("XDG_CONFIG_HOME") or ""
    if not os.path.isabs(base):
        base = os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "claude-kit", "policies.toml")


def _parse(text: str) -> dict:
    """Read the top-level booleans of a policy file's text; {} when it is not valid TOML."""
    if tomllib is not None:
        try:
            data = tomllib.loads(text)
        except Exception:
            return {}
        return {k: v for k, v in data.items() if isinstance(v, bool)}
    found = {}
    for line in text.splitlines():
        if TABLE_LINE.match(line):
            break  # everything after the first table belongs to that table
        m = BOOLEAN_LINE.match(line)
        if m:
            found[m.group(1)] = m.group(2) == "true"
    return found


def load() -> dict:
    """The booleans the policy file sets; {} when it is absent or unreadable."""
    try:
        with open(policy_file(), encoding="utf-8") as fh:
            return _parse(fh.read())
    except (OSError, UnicodeDecodeError):
        return {}


def enabled(name: str) -> bool:
    """Report whether the named policy is on.

    @param name A key of DEFAULTS.
    @return The file's boolean for it, else its default.
    """
    value = load().get(name)
    return value if isinstance(value, bool) else DEFAULTS.get(name, False)


def main(argv) -> int:
    names = argv or sorted(DEFAULTS)
    unknown = [n for n in names if n not in DEFAULTS]
    if unknown:
        print(f"unknown policy: {', '.join(unknown)}", file=sys.stderr)
        return 2
    print(f"# {policy_file()}")
    for name in names:
        print(f"{name} = {'true' if enabled(name) else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
