#!/usr/bin/env python3
"""PreToolUse guard (Edit|Write): protect sync-script-owned generated regions.

Blocks edits that fall inside `<!-- …generated:start --> … <!-- …generated:end -->`
regions and full-file Writes over files containing such regions. Those blocks are
owned by a generator (e.g. a wiki-sync script) and any hand edit is silently lost
on the next sync. Project-agnostic: triggers on the marker pattern, not on any
project name. Code files (scripts, tests, the generator itself) are exempt: a
marker in them is content to be edited, not a managed block.
"""
import json
import os
import re
import sys

# Generators own notes and pages, not code. A file with one of these extensions
# that happens to contain the marker text (a hook test, a sync-script fixture,
# the generator itself) must stay writable.
CODE_EXTENSIONS = {
    ".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".php",
    ".rb", ".pl", ".go", ".rs", ".java", ".kt", ".json", ".yaml", ".yml",
}

START_END = re.compile(
    r"<!--\s*[\w.-]*:?generated:start\s*-->.*?<!--\s*[\w.-]*:?generated:end\s*-->",
    re.S,
)
ANY_MARKER = re.compile(r"<!--\s*[\w.-]*:?generated:(start|end)\s*-->")


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}
    path = ti.get("file_path", "")
    if not path:
        return 0
    if os.path.splitext(path)[1].lower() in CODE_EXTENSIONS:
        return 0  # a marker inside a script/test/fixture is content, not a managed block
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            content = fh.read()
    except OSError:
        return 0  # new file — nothing to protect

    if not ANY_MARKER.search(content):
        return 0

    if tool == "Write":
        print(
            "BLOCKED: this file contains generated regions (generated:start/end markers) "
            "owned by a sync script. A full-file Write would clobber them. "
            "Edit the prose outside the markers with Edit, or run the project's sync script.",
            file=sys.stderr,
        )
        return 2

    old = ti.get("old_string", "")
    if not old:
        return 0
    spans = [(m.start(), m.end()) for m in START_END.finditer(content)]
    idx = content.find(old)
    while idx != -1:
        end = idx + len(old)
        if any(not (end <= s or idx >= e) for s, e in spans):
            print(
                "BLOCKED: this edit touches a generated region (between generated:start/end "
                "markers). That block is owned by the project's sync script and will be "
                "overwritten on the next sync. Edit outside the markers, or change the generator.",
                file=sys.stderr,
            )
            return 2
        if not ti.get("replace_all"):
            break
        idx = content.find(old, idx + 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
