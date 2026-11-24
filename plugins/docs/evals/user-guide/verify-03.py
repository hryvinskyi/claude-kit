#!/usr/bin/env python3
"""Scores a run of user-guide fixture-03 against the mechanical rows of expected-03.md.

Usage: verify-03.py <fixture dir> <copy dir>
"""
import filecmp
import pathlib
import re
import sys

fixture, copy = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
guide = (copy / "docs/user-guide.md").read_text()
operations = (copy / "docs/operations.md").read_text()
labels = set(re.findall(r"=> '((?:[^'\\]|\\.)*)'", (fixture / "app/labels.en.php").read_text()))

history_at = re.search(r"^#+ +Document history", guide, flags=re.M)
body = guide[: history_at.start()] if history_at else guide
history = guide[history_at.start():] if history_at else ""

LIMIT_MESSAGE = "You can archive up to 50 requests at a time. Select fewer and try again."
MARK = re.compile(r"formerly\s+\**saved repl\w*\**(\s*\([^)]*\))?", re.I)
prose = MARK.sub("", body)
for state in ("The invitation is no longer valid. Send a new one.", "can no longer sign in"):
    prose = prose.replace(state, "")
# Unambiguous history fails the row. "now" and "no longer" may be a state of the reader's own data: listed, to be read.
HISTORY = re.compile(r"\b(used to|previously|new in|until now|in this release|as of|forever)\b", re.I)
TO_READ = re.compile(r"\b(now|no longer)\b", re.I)
history_hits = [prose[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in HISTORY.finditer(prose)]
to_read = [prose[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in TO_READ.finditer(prose)]
MECHANISM = re.compile(r"archived_at|soft[- ]delet|transaction|\bqueued?\b|\bjobs?\b|nightly|\bcron\b|hard-delet|\b422\b|handler|timed out|03:00", re.I)
mechanism_hits = [body[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in MECHANISM.finditer(body)]
RATIONALE = re.compile(r"deliberate|on purpose|by design|evidence|we did not|we chose|we cap|no delete button", re.I)
CODES = re.compile(r"requests\.(archive|unarchive|purge|export)|/inbox/requests|\bPOST\b|kept_days|batch_limit|export\.build|archive\.cleanup")


def same_tree(left: pathlib.Path, right: pathlib.Path) -> bool:
    cmp = filecmp.dircmp(left, right)
    if cmp.left_only or cmp.right_only or cmp.diff_files or cmp.funny_files:
        return False
    return all(same_tree(left / d, right / d) for d in cmp.common_dirs)


def step_with(label: str) -> bool:
    return bool(re.search(r"^\s*\d+\.\s[^\n]*\*\*" + re.escape(label) + r"\*\*", body, flags=re.M))


role_table = re.search(r"^#+ +What each role can do.*?(?=^#+ )", body, flags=re.M | re.S)
role_table_text = role_table.group(0) if role_table else ""
# The limit belongs in the how-to where the reader meets it and in the reference entry of its control; troubleshooting
# names it under its message. A third section that tells it again is the repeat the key excludes.
sections = re.split(r"^(?=#{2,} )", body, flags=re.M)
troubleshooting_from = next((i for i, part in enumerate(sections) if re.match(r"#{2} +[^\n]*troubleshoot", part, re.I)), len(sections))
next_part = next((i for i in range(troubleshooting_from + 1, len(sections)) if re.match(r"#{2} ", sections[i])), len(sections))
limit_sections = [re.match(r"#+ +([^\n]*)", part).group(1) for i, part in enumerate(sections)
                  if not troubleshooting_from <= i < next_part and re.search(r"\b50\b", part.split("\n", 1)[-1])]

checks = {
    "F1 a how-to for archiving, in steps": step_with("Archive"),
    "F2 steps for bringing a request back": step_with("Bring back"),
    "F3 the limit told, and in one place outside the quoted message": bool(re.search(r"\b50\b", body)) and len(limit_sections) <= 2,
    "F4 no history in the body": not history_hits,
    "F5 no mechanism": not mechanism_hits,
    "F6 no defence of the design": not RATIONALE.search(body),
    "F7 no code, route or key": not CODES.search(guide),
    "F8 the switch that does nothing is not in the guide": not re.search(r"weekly summary", guide, re.I),
    "F9 the staff action is in operations.md only": "Delete for good" not in guide and "Delete for good" in operations,
    "F10 deleted after 365 days is told": bool(re.search(r"\b365\b", body)),
    "F11 exporting: the step, the e-mail, the empty case": step_with("Export archived requests")
    and bool(re.search(r"e-?mail", body, re.I)) and "There is nothing to export: no request is archived." in body,
    "F12 the reference describes Show, Open, Archived": all("**%s**" % label in body for label in ("Show", "Open", "Archived")),
    "F13 version 1.5 with its history row": bool(re.search(r"Version 1\.5", guide)) and bool(re.search(r"\|\s*1\.5\s*\|", history)),
    "F14 the role table gains archiving and exporting": bool(re.search(r"archiv", role_table_text, re.I))
    and bool(re.search(r"export", role_table_text, re.I)) and not re.search(r"for good|Acme staff", role_table_text, re.I),
    "F15 nothing under app/ changed": same_tree(fixture / "app", copy / "app"),
    "D1 the quoted message stays": "The invitation is no longer valid. Send a new one." in guide,
    "D3 the dated mark stays": bool(MARK.search(body)),
}
failed = [name for name, held in checks.items() if not held]
for name, held in checks.items():
    print(("ok   " if held else "FAIL ") + name)
for hit in history_hits:
    print("     F4 hit: ..." + hit + "...")
for hit in to_read:
    print("     F4 to read (a state, or history?): ..." + hit + "...")
for hit in mechanism_hits:
    print("     F5 hit: ..." + hit + "...")
print("     F3: the limit is told in: " + (", ".join(limit_sections) or "nowhere outside troubleshooting"))
unknown = sorted({b for b in re.findall(r"\*\*([^*\n]+)\*\*", body) if b.rstrip(".:,") not in labels and b not in labels})
print("     F18 bold text that is not a label of the catalogue: " + (", ".join(unknown) if unknown else "none"))
print("%d/%d" % (len(checks) - len(failed), len(checks)))
sys.exit(1 if failed else 0)
