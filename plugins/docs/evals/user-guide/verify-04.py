#!/usr/bin/env python3
"""Scores a run of user-guide fixture-04 against the mechanical rows of expected-04.md.

Usage: verify-04.py <fixture dir> <copy dir>
"""
import filecmp
import pathlib
import re
import sys

fixture, copy = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
guide_path, facts_path = copy / "docs/agent-guide.md", copy / "docs/agent-guide.facts.md"
guide = guide_path.read_text() if guide_path.exists() else ""
facts = facts_path.read_text() if facts_path.exists() else ""
labels = set(re.findall(r"=> '((?:[^'\\]|\\.)*)'", (fixture / "app/labels.en.php").read_text()))
history_at = re.search(r"^#+ +Document history", guide, flags=re.M)
body = guide[: history_at.start()] if history_at else guide
LIMIT_MESSAGE = "You can archive up to 50 requests at a time. Select fewer and try again."


def same_tree(left: pathlib.Path, right: pathlib.Path) -> bool:
    cmp = filecmp.dircmp(left, right)
    if cmp.left_only or cmp.right_only or cmp.diff_files or cmp.funny_files:
        return False
    return all(same_tree(left / d, right / d) for d in cmp.common_dirs)


def step_with(label: str) -> bool:
    return bool(re.search(r"^\s*\d+\.\s[^\n]*\*\*" + re.escape(label) + r"\*\*", body, flags=re.M))


def heading(pattern: str) -> bool:
    return bool(re.search(r"^#+ +[^\n]*(" + pattern + r")", guide, flags=re.M | re.I))


prose = body
for state in ("The invitation is no longer valid. Send a new one.", "can no longer sign in"):
    prose = prose.replace(state, "")
# "now" and "no longer" may be a state of the reader's own data: they are listed below, to be read.
TO_READ = re.compile(r"\b(now|no longer)\b", re.I)
to_read = [prose[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in TO_READ.finditer(prose)]
WRONG_SIDE = re.compile(
    r"\b(used to|previously|new in|until now|in this release)\b|archived_at|soft[- ]delet|transaction"
    r"|\bqueued?\b|\bjobs?\b|nightly|\bcron\b|\b422\b|handler|deliberate|on purpose|by design", re.I)
wrong_side_hits = [prose[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in WRONG_SIDE.finditer(prose)]
# The limit belongs in the how-to where the reader meets it and in the reference entry of its control; troubleshooting
# names it under its message. A third section that tells it again is the repeat the key excludes.
sections = re.split(r"^(?=#{2,} )", body, flags=re.M)
troubleshooting_from = next((i for i, part in enumerate(sections) if re.match(r"#{2} +[^\n]*troubleshoot", part, re.I)), len(sections))
next_part = next((i for i in range(troubleshooting_from + 1, len(sections)) if re.match(r"#{2} ", sections[i])), len(sections))
limit_sections = [re.match(r"#+ +([^\n]*)", part).group(1) for i, part in enumerate(sections)
                  if not troubleshooting_from <= i < next_part and re.search(r"\b50\b", part.split("\n", 1)[-1])]

checks = {
    "W1 the parts of a guide": bool(guide) and all(heading(p) for p in (
        "start here", "getting started|first", "how", "screens|settings|reference", "troubleshoot", "glossary", "history")),
    "W2 none of the team admin's screens or steps": not re.search(
        r"Send invitation|Remove from team|Sign-in lasts|Save security settings|\*\*Members\*\*|\*\*Security\*\*", guide)
    and not re.search(r"^\s*\d+\.\s[^\n]*Export archived requests", guide, flags=re.M)
    and not re.search(r"^#+ +[^\n]*Export archived requests\s*$", body.split("Troubleshooting")[0], flags=re.M),
    "W3 nothing of the staff's": not re.search(r"Delete for good|Close team|\*\*Staff\*\*|\*\*Create token\*\*|two-step", guide, re.I),
    "W4 the switch that does nothing is not in the guide": not re.search(r"weekly summary", guide, re.I),
    "W5 the agent's goals in steps": all(step_with(label) for label in ("Archive", "Bring back", "Revoke", "New template")),
    "W6 the limit told, in one place outside the quoted message": bool(re.search(r"\b50\b", body)) and len(limit_sections) <= 2,
    "W7 deleted after 365 days is told": bool(re.search(r"\b365\b", body)),
    "W8 the request for an access token": "support@acme.example" in body,
    "W9 no code, route or path": not re.search(
        r"`(agent|team_admin|staff)`|requests\.(archive|unarchive|purge|export)|tokens\.(create|revoke)|/inbox/|/account/|app/|\.php", guide),
    "W10 a fact list that carries reach": bool(facts) and bool(re.search(r"reach", facts, re.I))
    and bool(re.search(r"out of reach", facts, re.I)) and bool(re.search(r"not available", facts, re.I)),
    "W11 troubleshooting quotes the limit message and names who to turn to": LIMIT_MESSAGE in guide
    and bool(re.search(r"support@acme\.example|team admin", guide[guide.lower().find("troubleshoot"):], re.I)),
    "W12 no history, mechanism or defended design": not wrong_side_hits,
    "W13 the code and the other documents are unchanged": same_tree(fixture / "app", copy / "app")
    and filecmp.cmp(fixture / "docs/user-guide.md", copy / "docs/user-guide.md", shallow=False)
    and filecmp.cmp(fixture / "docs/operations.md", copy / "docs/operations.md", shallow=False),
}
failed = [name for name, held in checks.items() if not held]
for name, held in checks.items():
    print(("ok   " if held else "FAIL ") + name)
for hit in wrong_side_hits:
    print("     W12 hit: ..." + hit + "...")
for hit in to_read:
    print("     W12 to read (a state, or history?): ..." + hit + "...")
print("     W6: the limit is told in: " + (", ".join(limit_sections) or "nowhere outside troubleshooting"))
unknown = sorted({b for b in re.findall(r"\*\*([^*\n]+)\*\*", body) if b.rstrip(".:,") not in labels and b not in labels})
print("     W14 bold text that is not a label of the catalogue: " + (", ".join(unknown) if unknown else "none"))
print("%d/%d" % (len(checks) - len(failed), len(checks)))
sys.exit(1 if failed else 0)
