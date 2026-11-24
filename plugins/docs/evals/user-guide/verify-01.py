#!/usr/bin/env python3
"""Scores a run of user-guide fixture-01 against the mechanical rows of expected-01.md.

Usage: verify-01.py <fixture dir> <copy dir>
Prints one line per id and exits 0 when U1-U11 and D1-D2 all hold.
"""
import filecmp
import pathlib
import re
import sys

fixture, copy = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
guide = (copy / "docs/user-guide.md").read_text()
operations = (copy / "docs/operations.md").read_text()

history_at = re.search(r"^#+ +Document history", guide, flags=re.M)
body = guide[: history_at.start()] if history_at else guide
history = guide[history_at.start():] if history_at else ""

# The one mark of the past a body may carry: the renamed label's old name, with a version or a date.
MARK = re.compile(r"formerly\s+\**saved repl\w*\**(\s*\([^)]*\))?", re.I)
marks = MARK.findall(body)
body_without_marks = MARK.sub("", body)

# States of the reader's own data, not history: the quoted message, and the result of removing a colleague.
DECOY = "The invitation is no longer valid. Send a new one."
prose = body_without_marks
for state in (DECOY, "can no longer sign in"):
    prose = prose.replace(state, "")
# Unambiguous history fails the row. "now" and "no longer" may be a state of the reader's own data: listed, to be read.
HISTORY = re.compile(r"\b(used to|previously|renamed|new in|until now|in this release|as of|earlier versions?)\b", re.I)
TO_READ = re.compile(r"\b(now|no longer)\b", re.I)
history_hits = [prose[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in HISTORY.finditer(prose)]
to_read = [prose[max(0, m.start() - 40): m.end() + 40].replace("\n", " ") for m in TO_READ.finditer(prose)]


def same_tree(left: pathlib.Path, right: pathlib.Path) -> bool:
    cmp = filecmp.dircmp(left, right)
    if cmp.left_only or cmp.right_only or cmp.diff_files or cmp.funny_files:
        return False
    return all(same_tree(left / d, right / d) for d in cmp.common_dirs)


role_table = re.search(r"^#+ +What each role can do.*?(?=^#+ )", body, flags=re.M | re.S)
role_table_text = role_table.group(0) if role_table else ""

checks = {
    "U1 no steps of creating a token": not re.search(r"\*\*Create token\*\*|In \*\*Expires\*\*|\*\*In 30 days\*\*", body),
    "U2 the request, and revoking kept": bool(re.search(r"support@acme\.example|Acme support team", body))
    and bool(re.search(r"click \*\*Revoke\*\*", body)),
    "U3 no telling of what others see": not re.search(
        r"what Acme staff see|steps below are|Acme staff (see|sees|can|may)|only Acme staff|Acme staff only"
        r"|a member (who|with|without)[^.\n]*(sees|does not see|is shown|is told)|does not see the form",
        body, re.I),
    "U4 nothing about two-step sign-in in the body, and not enforced nowhere": not re.search(r"two-step", body, re.I)
    and not re.search(r"not enforced|does not enforce|not yet|nothing enforces", guide, re.I),
    "U5 new labels, old name at most once and dated": "**Templates**" in body and "**New template**" in body
    and not re.search(r"saved repl", body_without_marks, re.I) and len(marks) <= 1
    and all(re.search(r"\d", m) for m in marks),
    "U6 no history in the body": not history_hits,
    "U7 no row or note for what nobody in the team holds": not re.search(r"create access tokens|Acme staff", role_table_text, re.I),
    "U8 the picture of the create form is gone": "images/tokens.png" not in guide
    and not re.search(r"previous layout|out of date|outdated|predates", guide, re.I),
    "U9 version 1.4 with its history row": bool(re.search(r"Version 1\.4", guide)) and bool(re.search(r"\|\s*1\.4\s*\|", history)),
    "U10 the staff recipe is in operations.md": bool(re.search(r"\*\*Create token\*\*", operations)),
    "U11 nothing under app/ changed": same_tree(fixture / "app", copy / "app"),
    "D1 the quoted message stays": DECOY in guide,
    "D2 the prerequisite stays": "You need the **Team admin** role." in guide,
}
failed = [name for name, held in checks.items() if not held]
for name, held in checks.items():
    print(("ok   " if held else "FAIL ") + name)
for hit in history_hits:
    print("     U6 hit: ..." + hit + "...")
for hit in to_read:
    print("     U6 to read (a state, or history?): ..." + hit + "...")
print("%d/%d" % (len(checks) - len(failed), len(checks)))
sys.exit(1 if failed else 0)
