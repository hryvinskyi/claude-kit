#!/usr/bin/env python3
"""Make the user's CLAUDE.md import the engineering standards of this kit clone.

Claude Code expands an `@path` import in a user-scope CLAUDE.md at launch, so the standards load
in every session from this clone and stay current with it. The import names the file in the
clone itself, never a copy in the plugin cache, whose path changes with every plugin version.

States of the user's CLAUDE.md (`$CLAUDE_CONFIG_DIR/CLAUDE.md`, else `~/.claude/CLAUDE.md`):

  present   it already imports this clone's standards file, once        -> nothing to do
  absent    no import of a standards file, no standards section inline   -> the import is appended
  refused   it imports a standards file from another path, imports one
            twice, or carries the standards' sections written inline
            (importing them as well would load every rule twice)         -> nothing is written

Usage: import_standards.py [--check] [--print-line] [--target FILE]
  --check       report the state; exit 0 when present, 1 otherwise; never writes
  --print-line  print the import line this clone needs and exit
  --target      the CLAUDE.md to inspect instead of the user's
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

STANDARDS = Path(__file__).resolve().parent / "CLAUDE.standards.md"
STANDARDS_NAME = STANDARDS.name

FENCE = re.compile(r"^\s*(```|~~~)")
CODE_SPAN = re.compile(r"`+[^`]*`+")
# An import token: `@` at the start of a word, the path running to the first unescaped space.
IMPORT_TOKEN = re.compile(r"(?:(?<=\s)|^)@((?:\\ |\S)+)")


def import_line(standards: Path = STANDARDS, home: Path | None = None) -> str:
    """The import line for a standards file: `~/…` under the home directory, absolute elsewhere.

    @param standards The standards file to import.
    @param home The home directory; the current user's when omitted.
    @return The line, with each space escaped by a backslash as the import syntax requires.
    """
    home = home or Path.home()
    path = str(standards)
    for root in dict.fromkeys((str(home), str(home.resolve()))):
        if path.startswith(root.rstrip("/") + "/"):
            path = "~/" + path[len(root.rstrip("/")) + 1 :]
            break
    return "@" + path.replace(" ", "\\ ")


def prose_lines(text: str) -> list[str]:
    """The lines of a Markdown text outside fenced code blocks, with code spans blanked out.

    Claude Code does not evaluate an import inside a code span or a fenced block, so neither may
    count as one here.

    @param text Markdown.
    @return The remaining lines, in order.
    """
    lines, fenced = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            lines.append(CODE_SPAN.sub(" ", line))
    return lines


def imports(text: str) -> list[str]:
    """Every `@path` import of a Markdown text, as written (`\\ ` escapes kept).

    @param text Markdown.
    @return The import paths, in order.
    """
    found: list[str] = []
    for line in prose_lines(text):
        found.extend(IMPORT_TOKEN.findall(line))
    return found


def headings(text: str, level: int = 2) -> list[str]:
    """The headings of one level outside fenced code blocks.

    @param text Markdown.
    @param level The heading level.
    @return Their titles, in order.
    """
    marker = "#" * level + " "
    titles, fenced = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced and line.startswith(marker):
            titles.append(line[len(marker) :].strip())
    return titles


def assess(target_text: str, standards_text: str, line: str) -> tuple[str, str]:
    """Classify a user CLAUDE.md against the import it needs.

    @param target_text The user CLAUDE.md ("" when it does not exist).
    @param standards_text The standards file.
    @param line The import line this clone needs.
    @return (state, detail) with state in present | absent | refused.
    """
    wanted = line[1:]
    found = [path for path in imports(target_text) if path.endswith(STANDARDS_NAME)]
    sections = set(headings(standards_text))
    inline = [title for title in headings(target_text) if title in sections]
    if inline:
        return "refused", (
            "the standards are already written into this file (sections: " + "; ".join(inline) + "); "
            "importing them as well would load every rule twice. Remove those sections first."
        )
    if not found:
        return "absent", "no import of " + STANDARDS_NAME
    if found == [wanted]:
        return "present", "imports " + wanted
    if len(found) > 1:
        return "refused", "imports a standards file " + str(len(found)) + " times: " + ", ".join(found)
    return "refused", "imports " + found[0] + ", not " + wanted + "; correct that line by hand"


def target_path(argv: list[str]) -> Path:
    """The CLAUDE.md to work on: `--target`, else the active configuration directory's.

    @param argv Command-line arguments.
    @return The path (it may not exist yet).
    """
    if "--target" in argv:
        return Path(argv[argv.index("--target") + 1]).expanduser()
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(config).expanduser() if config else Path.home() / ".claude") / "CLAUDE.md"


def append(target: Path, line: str) -> None:
    """Append the import line, writing through a symbolic link rather than replacing it.

    @param target The user CLAUDE.md.
    @param line The import line.
    """
    real = target.resolve()
    text = real.read_text(encoding="utf-8") if real.exists() else ""
    if text and not text.endswith("\n"):
        text += "\n"
    if text and not text.endswith("\n\n"):
        text += "\n"
    real.parent.mkdir(parents=True, exist_ok=True)
    mode = real.stat().st_mode if real.exists() else 0o644
    tmp = real.with_name(real.name + ".standards-tmp")
    tmp.write_text(text + line + "\n", encoding="utf-8")
    os.chmod(tmp, mode)
    tmp.replace(real)


def main(argv: list[str]) -> int:
    """Entry point.

    @param argv Command-line arguments.
    @return The exit status.
    """
    unknown = [a for a in argv if a.startswith("-") and a not in ("--check", "--print-line", "--target")]
    if unknown or ("--target" in argv and argv.index("--target") + 1 >= len(argv)):
        print(__doc__, file=sys.stderr)
        return 2
    if not STANDARDS.is_file():
        print(f"FAIL  {STANDARDS} is missing", file=sys.stderr)
        return 1
    line = import_line()
    if "--print-line" in argv:
        print(line)
        return 0

    target = target_path(argv)
    text = target.read_text(encoding="utf-8") if target.exists() else ""
    state, detail = assess(text, STANDARDS.read_text(encoding="utf-8"), line)
    print(f"{state:<8} {target}: {detail}")
    if state == "refused":
        return 1
    if "--check" in argv:
        return 0 if state == "present" else 1
    if state == "absent":
        append(target, line)
        again, detail = assess(target.read_text(encoding="utf-8"), STANDARDS.read_text(encoding="utf-8"), line)
        if again != "present":
            print(f"FAIL  {target}: after writing, it reads as {again}: {detail}", file=sys.stderr)
            return 1
        print(f"added    {target}: {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
