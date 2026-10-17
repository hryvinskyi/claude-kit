#!/usr/bin/env python3
"""Make the user's CLAUDE.md import the engineering standards of this kit clone.

Claude Code expands an `@path` import in a user-scope CLAUDE.md at launch, so the standards load
in every session from this clone and stay current with it. The import names the file in the
clone itself, never a copy in the plugin cache, whose path changes with every plugin version.

The standards name no framework. A stack plugin of the clone ships the spellings they mean on its
stack in `plugins/<stack>/standards/CLAUDE.standards.<stack>.md`; `--stack <stack>` imports that
file beside the standards, so it is always loaded too.

States of the user's CLAUDE.md (`$CLAUDE_CONFIG_DIR/CLAUDE.md`, else `~/.claude/CLAUDE.md`), for the
standards file and for each stack file, each on its own:

  present   it already imports this clone's file, once                   -> nothing to do
  absent    no import of a file of that name, none of its sections inline -> the import is appended
  refused   it imports a file of that name from another path, imports one
            twice, or carries the file's sections written inline
            (importing them as well would load every rule twice)         -> nothing is written

When any file is refused, nothing is written for any of them.

Usage: import_standards.py [--check] [--print-line] [--target FILE] [--stack NAME[,NAME…]]…
  --check       report the states; exit 0 when every one is present, 1 otherwise; never writes
  --print-line  print the import lines this clone needs, one per file, and exit
  --target      the CLAUDE.md to inspect instead of the user's
  --stack       also import that stack plugin's standards file; repeatable, or a comma-separated list
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

STANDARDS = Path(__file__).resolve().parent / "CLAUDE.standards.md"
STANDARDS_NAME = STANDARDS.name
KIT = STANDARDS.parent.parent
STACK_NAME = re.compile(r"[a-z0-9][a-z0-9-]*")

FENCE = re.compile(r"^\s*(```|~~~)")
CODE_SPAN = re.compile(r"`+[^`]*`+")
# An import token: `@` at the start of a word, the path running to the first unescaped space.
IMPORT_TOKEN = re.compile(r"(?:(?<=\s)|^)@((?:\\ |\S)+)")


def stack_standards(stack: str, kit: Path = KIT) -> Path:
    """The standards file a stack plugin of the clone ships.

    @param stack The stack plugin's name.
    @param kit The kit clone.
    @return Its path (it may not exist).
    """
    return kit / "plugins" / stack / "standards" / f"CLAUDE.standards.{stack}.md"


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


def names_file(path: str, name: str) -> bool:
    """Whether an import path, as written, names a file of that name.

    @param path An import path (`\\ ` escapes kept).
    @param name A file name.
    @return True when the path's last segment is the name.
    """
    return path.replace("\\ ", " ").rsplit("/", 1)[-1] == name


def assess(target_text: str, standards_text: str, line: str, name: str = STANDARDS_NAME) -> tuple[str, str]:
    """Classify a user CLAUDE.md against one import it needs.

    @param target_text The user CLAUDE.md ("" when it does not exist).
    @param standards_text The file to import.
    @param line The import line this clone needs.
    @param name The file's name, by which an import of another copy is recognised.
    @return (state, detail) with state in present | absent | refused.
    """
    wanted = line[1:]
    found = [path for path in imports(target_text) if names_file(path, name)]
    sections = set(headings(standards_text))
    inline = [title for title in headings(target_text) if title in sections]
    if inline:
        return "refused", (
            "the sections of " + name + " are already written into this file (" + "; ".join(inline) + "); "
            "importing them as well would load every rule twice. Remove those sections first."
        )
    if not found:
        return "absent", "no import of " + name
    if found == [wanted]:
        return "present", "imports " + wanted
    if len(found) > 1:
        return "refused", "imports " + name + " " + str(len(found)) + " times: " + ", ".join(found)
    return "refused", "imports " + found[0] + ", not " + wanted + "; correct that line by hand"


def option_values(argv: list[str], option: str) -> list[str]:
    """Every value an option takes, in order: `--opt VALUE` repeated, each value possibly a comma list.

    @param argv Command-line arguments.
    @param option The option.
    @return The values; an empty string for a missing or empty one.
    """
    values: list[str] = []
    for index, arg in enumerate(argv):
        if arg == option:
            value = argv[index + 1] if index + 1 < len(argv) else ""
            values.extend(part.strip() for part in value.split(","))
    return values


def target_path(argv: list[str]) -> Path:
    """The CLAUDE.md to work on: `--target`, else the active configuration directory's.

    @param argv Command-line arguments.
    @return The path (it may not exist yet).
    """
    if "--target" in argv:
        return Path(argv[argv.index("--target") + 1]).expanduser()
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(config).expanduser() if config else Path.home() / ".claude") / "CLAUDE.md"


def append(target: Path, lines: list[str]) -> None:
    """Append import lines, writing through a symbolic link rather than replacing it.

    @param target The user CLAUDE.md.
    @param lines The import lines, in order.
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
    tmp.write_text(text + "".join(line + "\n" for line in lines), encoding="utf-8")
    os.chmod(tmp, mode)
    tmp.replace(real)


def main(argv: list[str]) -> int:
    """Entry point.

    @param argv Command-line arguments.
    @return The exit status.
    """
    takes_value = ("--target", "--stack")
    values = {index + 1 for index, arg in enumerate(argv) if arg in takes_value}
    unknown = [a for i, a in enumerate(argv)
               if i not in values and a not in ("--check", "--print-line", *takes_value)]
    stacks = option_values(argv, "--stack")
    missing_value = any(argv.index(o) + 1 >= len(argv) for o in takes_value if o in argv)
    if unknown or missing_value or any(not STACK_NAME.fullmatch(s) for s in stacks):
        print(__doc__, file=sys.stderr)
        return 2
    files = [STANDARDS] + [stack_standards(s) for s in dict.fromkeys(stacks)]
    absent_files = [f for f in files if not f.is_file()]
    if absent_files:
        for path in absent_files:
            print(f"FAIL  {path} is missing", file=sys.stderr)
        return 1
    lines = [import_line(f) for f in files]
    if "--print-line" in argv:
        print("\n".join(lines))
        return 0

    target = target_path(argv)

    def states() -> list[tuple[str, str]]:
        text = target.read_text(encoding="utf-8") if target.exists() else ""
        return [assess(text, f.read_text(encoding="utf-8"), line, f.name) for f, line in zip(files, lines)]

    found = states()
    for (state, detail) in found:
        print(f"{state:<8} {target}: {detail}")
    if any(state == "refused" for state, _ in found):
        return 1
    if "--check" in argv:
        return 0 if all(state == "present" for state, _ in found) else 1
    wanted = [line for line, (state, _) in zip(lines, found) if state == "absent"]
    if wanted:
        append(target, wanted)
        for again, detail in states():
            if again != "present":
                print(f"FAIL  {target}: after writing, it reads as {again}: {detail}", file=sys.stderr)
                return 1
        for line in wanted:
            print(f"added    {target}: {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
