#!/usr/bin/env python3
"""Stop hook: close the knowledge loop, once, after real work in THIS session.

Fires at most ONCE per session, and only when ALL of these hold:
  - the cwd is a vault project (resolved by this plugin's bin/find-vault.sh),
  - this session's transcript shows real work: at least MIN_EDITS Edit/Write/
    NotebookEdit calls or `git commit` invocations (a dirty tree inherited from
    yesterday is NOT work done here),
  - the session has not already run a journal or feature skill (a feature
    run journals on its own),
  - no journal entry for today exists in <vault>/Journal/.

Then it blocks the stop once with an instruction to OFFER /vault:journal to the
user — never to auto-write. Kill switch: CLAUDE_NO_JOURNAL_NUDGE=1.
Tunable: CLAUDE_JOURNAL_NUDGE_MIN_EDITS (default 5).
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys

FIND_VAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "find-vault.sh")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SKIP_SKILLS = {"journal", "feature"}
GIT_COMMIT = re.compile(r"\bgit\b[^|;&]*\bcommit\b")


def find_vault(cwd: str):
    try:
        res = subprocess.run(
            [FIND_VAULT, cwd], capture_output=True, text=True, timeout=5
        )
    except Exception:
        return None
    if res.returncode != 0 or not res.stdout.strip():
        return None
    return os.path.join(cwd, res.stdout.strip())


def session_work(transcript_path: str):
    """Count edit-like tool calls and collect the skills used in this session.

    @param transcript_path Path to the session's JSONL transcript.
    @return (edits, skills) — edits is 0 when the transcript cannot be read.
    """
    edits, skills = 0, set()
    if not transcript_path or not os.path.isfile(transcript_path):
        return edits, skills
    try:
        with open(transcript_path, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if '"tool_use"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                content = (entry.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for item in content:
                    if not isinstance(item, dict) or item.get("type") != "tool_use":
                        continue
                    name = item.get("name")
                    args = item.get("input") or {}
                    if name in EDIT_TOOLS:
                        edits += 1
                    elif name == "Bash" and GIT_COMMIT.search(str(args.get("command", ""))):
                        edits += 1
                    elif name == "Skill":
                        skills.add(str(args.get("skill", "")).split(":")[-1])
    except OSError:
        pass
    return edits, skills


def main() -> int:
    if os.environ.get("CLAUDE_NO_JOURNAL_NUDGE"):
        return 0
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("stop_hook_active"):
        return 0  # never loop
    cwd = data.get("cwd") or os.getcwd()
    vault = find_vault(cwd)
    if not vault:
        return 0

    sid = str(data.get("session_id") or "nosession")
    marker = os.path.join("/tmp", f"claude-journal-nudge-{sid}")
    if os.path.exists(marker):
        return 0

    today = datetime.date.today().isoformat()
    if glob.glob(os.path.join(vault, "Journal", f"{today}*")):
        return 0

    try:
        min_edits = int(os.environ.get("CLAUDE_JOURNAL_NUDGE_MIN_EDITS", "5"))
    except ValueError:
        min_edits = 5
    edits, skills = session_work(data.get("transcript_path") or "")
    if edits < min_edits or skills & SKIP_SKILLS:
        return 0

    try:
        open(marker, "w").close()
    except OSError:
        pass

    rel = os.path.relpath(vault, cwd)
    print(
        json.dumps(
            {
                "decision": "block",
                "reason": (
                    f"Knowledge-loop nudge (fires once per session): this session made "
                    f"{edits} edits/commits in a vault project, and {rel}/Journal/ has no "
                    f"entry for today. ASK the user once whether to run /vault:journal now (and "
                    f"/vault:decision if a non-obvious decision was taken this session). If they "
                    f"decline or don't answer, end the turn without writing anything. Do NOT "
                    f"auto-write the journal or the decision record."
                ),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
