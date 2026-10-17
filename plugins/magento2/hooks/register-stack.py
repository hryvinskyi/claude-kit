#!/usr/bin/env python3
"""SessionStart: register this plugin's stack declaration for the session's rubric gate.

Copies `stack.json` from the plugin root into
`<state>/sessions/<session id>/stacks/<stack>.json`, where `<state>` is
$CLAUDE_KIT_STATE_DIR, or `${XDG_STATE_HOME:-~/.local/state}/claude-kit`. The
rubric gate reads that directory for the session a transcript belongs to, so
only plugins enabled in this session add their requirements. The session id is
taken from the hook input's `session_id` and from the stem of its
`transcript_path`; when the two differ, both are registered.

Each run also removes the session directories under `<state>/sessions/` that
were last registered more than seven days ago.

Never blocks a session: it always exits 0. When the declaration cannot be
registered, it prints one `systemMessage` saying the gate runs without this
stack in this session.
"""
import json
import os
import re
import shutil
import sys
import time

STATE_DIR_ENV = "CLAUDE_KIT_STATE_DIR"
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
STACK_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
KEEP_SECONDS = 7 * 24 * 3600
DECLARATION = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "stack.json")


def state_dir() -> str:
    """The base of the per-session registry: $CLAUDE_KIT_STATE_DIR, else the XDG state home's claude-kit."""
    override = os.environ.get(STATE_DIR_ENV, "")
    if os.path.isabs(override):
        return override
    xdg = os.environ.get("XDG_STATE_HOME", "")
    base = xdg if os.path.isabs(xdg) else os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "claude-kit")


def sessions_of(data: dict) -> list:
    """The session ids to register under: the input's `session_id` and its transcript's stem.

    A subagent transcript (`<id>/subagents/agent-*.jsonl`) names its parent session.
    @return Safe, distinct ids, in that order.
    """
    found = []
    transcript = str(data.get("transcript_path") or "")
    stem = ""
    if transcript:
        directory, base = os.path.split(transcript)
        if os.path.basename(directory) == "subagents":
            stem = os.path.basename(os.path.dirname(directory))
        else:
            stem = base[: -len(".jsonl")] if base.endswith(".jsonl") else base
    for candidate in (str(data.get("session_id") or ""), stem):
        if candidate and SAFE_SEGMENT.match(candidate) and candidate not in found:
            found.append(candidate)
    return found


def prune(sessions: str, keep: set, now: float) -> None:
    """Remove session directories older than KEEP_SECONDS, never a symlink and never one in `keep`."""
    try:
        entries = os.listdir(sessions)
    except OSError:
        return
    for name in entries:
        path = os.path.join(sessions, name)
        if name in keep or not SAFE_SEGMENT.match(name) or os.path.islink(path) or not os.path.isdir(path):
            continue
        try:
            if now - os.stat(path).st_mtime > KEEP_SECONDS:
                shutil.rmtree(path)
        except OSError:
            continue


def register(data: dict, now: float) -> None:
    """Write the declaration under every session id of the input.

    @throws ValueError When the declaration or the session id is unusable.
    @throws OSError When the registry cannot be written.
    """
    with open(DECLARATION, encoding="utf-8") as fh:
        text = fh.read()
    declaration = json.loads(text)
    stack = declaration.get("stack") if isinstance(declaration, dict) else None
    if not isinstance(stack, str) or not STACK_NAME.match(stack):
        raise ValueError("stack.json names no valid stack")
    sessions = sessions_of(data)
    if not sessions:
        raise ValueError("the hook input names no session")
    base = os.path.join(state_dir(), "sessions")
    for session in sessions:
        directory = os.path.join(base, session, "stacks")
        os.makedirs(directory, exist_ok=True)
        target = os.path.join(directory, f"{stack}.json")
        partial = f"{target}.{os.getpid()}.tmp"
        with open(partial, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(partial, target)
        os.utime(os.path.join(base, session), (now, now))
    prune(base, set(sessions), now)


def plugin_name() -> str:
    """This plugin's directory name, for the notice."""
    return os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            raise ValueError("the hook input is not an object")
        register(data, time.time())
    except Exception as error:
        notice = (f"{plugin_name()}: the rubric gate runs without this stack in this session, because its "
                  f"declaration could not be registered ({error.__class__.__name__}: {error}).")
        print(json.dumps({"systemMessage": notice}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
