#!/usr/bin/env python3
"""Test fixture: complete a hand-written transcript with the results a session logs.

The rubric gate counts a tool call only by its result, so a fixture that lists tool calls
alone shows nothing loaded. This gives every `tool_use` without an id an id and, right after
its line, the entries Claude Code writes for it:

  Skill  the launch result, then the skill's base-directory announcement with a body
  Read   the file's lines, numbered as the Read tool numbers them (its offset and limit
         applied); an error result when the file cannot be read
  Bash   what the command prints when it runs here (stdout and stderr), an error when it fails

Usage: transcript_fixture.py [--cwd DIR] TRANSCRIPT...   (the Bash commands run in DIR)
Calls that already carry an id are left as they are, so a file can be completed again after
more calls are appended to it.
"""
import json
import subprocess
import sys
import uuid

COMMAND_TIMEOUT = 10


def tool_result(use_id, text, error=False):
    """A user entry carrying one tool result."""
    item = {"type": "tool_result", "tool_use_id": use_id, "content": text}
    if error:
        item["is_error"] = True
    return {"type": "user", "message": {"role": "user", "content": [item]}}


def read_result(use_id, args):
    """What the Read tool returns for its arguments: numbered lines, or an error."""
    try:
        with open(str(args.get("file_path", "")), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except (OSError, ValueError):
        return tool_result(use_id, "<tool_use_error>File does not exist.</tool_use_error>", True)
    offset = int(args.get("offset") or 1)
    limit = int(args.get("limit") or 2000)
    shown = lines[offset - 1:offset - 1 + limit]
    if not shown:
        return tool_result(use_id, "<system-reminder>Warning: the file exists but is shorter than the provided offset.</system-reminder>")
    return tool_result(use_id, "\n".join(f"{offset + i}\t{line}" for i, line in enumerate(shown)))


def results_of(item, cwd):
    """The entries logged after one tool call."""
    use_id, name, args = item["id"], item.get("name"), item.get("input") or {}
    if name == "Skill":
        called = str(args.get("skill", ""))
        skill = called.lstrip("/").split(":")[-1]
        announcement = f"Base directory for this skill: /fixture/skills/{skill}\n\n# {skill}\n\nThe rubric's lenses."
        return [
            tool_result(use_id, f"Launching skill: {called}"),
            {"type": "user", "isMeta": True, "sourceToolUseID": use_id,
             "message": {"role": "user", "content": [{"type": "text", "text": announcement}]}},
        ]
    if name == "Read":
        return [read_result(use_id, args)]
    if name == "Bash":
        run = subprocess.run(["bash", "-c", str(args.get("command", ""))], cwd=cwd, capture_output=True,
                             text=True, timeout=COMMAND_TIMEOUT, stdin=subprocess.DEVNULL)
        return [tool_result(use_id, run.stdout + run.stderr, run.returncode != 0)]
    return [tool_result(use_id, "done")]


def complete(path, cwd):
    """Rewrite one transcript with an id and results for each call that has none."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    out = []
    for line in lines:
        out.append(line)
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        content = (entry.get("message") or {}).get("content") if isinstance(entry, dict) else None
        if entry.get("type") != "assistant" or not isinstance(content, list):
            continue
        logged = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_use" and "id" not in item:
                item["id"] = "toolu_fx" + uuid.uuid4().hex
                logged.extend(results_of(item, cwd))
        if logged:
            out[-1] = json.dumps(entry)
            out.extend(json.dumps(result) for result in logged)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + ("\n" if out else ""))


def main(argv):
    cwd = None
    if len(argv) > 1 and argv[0] == "--cwd":
        cwd, argv = argv[1], argv[2:]
    for path in argv:
        complete(path, cwd)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
