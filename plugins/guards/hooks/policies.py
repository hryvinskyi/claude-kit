#!/usr/bin/env python3
"""Personal policies of the guard hooks, read from one TOML file.

The file is `${XDG_CONFIG_HOME:-~/.config}/claude-kit/policies.toml`; an unset,
empty or relative XDG_CONFIG_HOME falls back to `~/.config`. Every policy is a
top-level boolean:

    # ~/.config/claude-kit/policies.toml
    forbid_assistant_commit_trailers = true

A policy that is absent, not a boolean, or in a file that cannot be read takes
its default, so a missing or broken file never blocks anything.

The environment overrides the file, so a project can switch a policy on for
itself (in its `.claude/settings.json` `env` block) without touching the
person's machine-wide file: `CLAUDE_KIT_<NAME IN CAPITALS>`, for example
`CLAUDE_KIT_GITHUB_REST_ONLY=1`. `1`/`true` turn the policy on and `0`/`false`
turn it off, in any case; any other value is ignored and the file decides.

The file is read the same way on every Python: line by line, each top-level
`key = true|false` line (a trailing comment allowed) sets that key, a table
header ends the top level, and every other line is ignored. A full TOML parser
would reject the whole file over one malformed line and switch off a policy
another line plainly turns on, and only on the interpreters that ship one; here a
line that says `name = true` means it on every machine.

Run as a script to print the effective value of each known policy and the file
it came from: `python3 policies.py [name ...]`.
"""
import os
import re
import sys

# Every policy the hooks read, with the value it takes when the file says nothing
DEFAULTS = {
    "forbid_assistant_commit_trailers": False,
    "github_rest_only": False,
}

ENV_PREFIX = "CLAUDE_KIT_"
ENV_ON = {"1", "true"}
ENV_OFF = {"0", "false"}

BOOLEAN_LINE = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*(?:#.*)?$")
TABLE_LINE = re.compile(r"^\s*\[")


def policy_file() -> str:
    """The path of the policy file, whether or not it exists."""
    base = os.environ.get("XDG_CONFIG_HOME") or ""
    if not os.path.isabs(base):
        base = os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "claude-kit", "policies.toml")


def _parse(text: str) -> dict:
    """Read the top-level `key = true|false` lines of a policy file's text, ignoring every other line."""
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


def env_name(name: str) -> str:
    """The environment variable that overrides the named policy."""
    return ENV_PREFIX + name.upper()


def resolve(name: str, environ=None) -> tuple:
    """Resolve the named policy and say where the value came from.

    The environment variable wins when it holds a recognised value, then the
    policy file, then the default.

    @param name    A key of DEFAULTS.
    @param environ Mapping to read the variable from; os.environ when omitted.
    @return (value, source) where source is "environment", "file" or "default".
    """
    env = os.environ if environ is None else environ
    raw = (env.get(env_name(name)) or "").strip().lower()
    if raw in ENV_ON:
        return True, "environment"
    if raw in ENV_OFF:
        return False, "environment"
    value = load().get(name)
    if isinstance(value, bool):
        return value, "file"
    return DEFAULTS.get(name, False), "default"


def enabled(name: str, environ=None) -> bool:
    """Report whether the named policy is on.

    @param name    A key of DEFAULTS.
    @param environ Mapping to read the override from; os.environ when omitted.
    @return The environment's boolean for it, else the file's, else its default.
    """
    return resolve(name, environ)[0]


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
