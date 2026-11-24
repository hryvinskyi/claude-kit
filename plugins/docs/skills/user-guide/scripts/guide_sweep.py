#!/usr/bin/env python3
"""Sweeps an end-user guide for the places a reader-first check has to read.

A hit is a place to read, not a defect: "administrator" is right when the guide's reader is one,
and "no longer" is right in a state of the reader's own data. The sweep finds the places; settling
each one is the author's or the reviewer's work.

Usage: guide_sweep.py GUIDE.md [GUIDE.md ...] [--other-reader NAME ...]

--other-reader names a role, a team or a person that is not the guide's reader (a role of the fact
list that is out of reach): every mention of it is listed.

Fenced code and the document history are left out: a sample may hold anything, and the history is
where a change is told. Exits 0 when the files could be read, whatever it found.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

CLASSES: list[tuple[str, str, str]] = [
    ("another reader", "who is this sentence for? what the reader cannot open goes to another document",
     r"\b(administrators?|operators?|super[- ]?admins?|support (team|staff)|developers?|whoever (runs|administers|installed|operates))\b"),
    ("what other people see", "the guide says what its reader does, not what others see or are told",
     r"\b(does not|do not|cannot|never|no longer) see\b|\bis (told|shown|asked) to\b|\beveryone else\b|\bsees? (the|a|an) [^.]{0,40} instead\b"
     r"|\bsteps below are\b|\bonly [A-Za-z ]{0,30} (see|sees|can)\b"),
    ("history", "the body tells the product as it is; a change is told in the document history",
     r"\b(used to|previously|formerly|until now|no longer)\b|\b(was|were|has been|have been) (moved|renamed|removed|replaced)\b"
     r"|\b(this|the last|the next) (release|version)\b|\bnew in\b"),
    ("a word with a clock", "true on the day of writing only: write the fact without the clock",
     r"\b(now|newly|recently|currently|at present|for now|for the time being|today|soon)\b"),
    ("not available", "what the reader cannot use yet is not in the guide; a control that does nothing is a finding for the user",
     r"\b(not|never) (\w+ ){0,2}yet\b|\bcoming\b|\bplanned\b|\bstill cannot\b|\bnot (enforced|switched on|released|supported|sent|built)\b"
     r"|\bthere is no [^.]{0,40} (for|to)\b|\bdoes nothing\b"),
    ("a design defended", "a reason only when it changes what the reader does",
     r"\b(deliberate(ly)?|on purpose|by design|intentional(ly)?|not a limitation)\b|\brather than\b"),
    ("the inside view", "the effect for the reader, not how the product does it",
     r"\b(server|log files?|logs|queued?|caches?|cached|background jobs?|jobs?|workers?|databases?|tables? (row|column)s?|stored in|enforced|is refused|returns?|endpoints?|payloads?|tokens? bucket|transactions?|centrally|page load)\b"),
    ("an identifier", "the label the screen shows; a code only where the screen shows it, after the label",
     r"`[a-z][a-z0-9]*([._:][a-z0-9_<>*]+)+`|`/[a-z][^`\s]*`|\bROLE_[A-Z_]+\b|`[A-Z][A-Za-z]+(\\[A-Z][A-Za-z]+)+`"),
    ("a picture the page distrusts", "retake it or remove it; a caption never says its picture is old",
     r"\b(previous|earlier|old) layout\b|\bpredates\b|\bout of date\b|\boutdated\b|\bolder version of the screen\b"),
]
LIMITS = (("paragraph", 100), ("list item", 60), ("table cell", 40))


def prose_lines(text: str) -> list[tuple[int, str]]:
    """The lines a reader reads as prose: no fenced code, nothing from the document history on."""
    lines: list[tuple[int, str]] = []
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        if re.match(r"^#+\s+Document history\b", line, flags=re.I):
            break
        lines.append((number, line))
    return lines


def long_units(lines: list[tuple[int, str]]) -> list[tuple[int, str, int]]:
    """Paragraphs, list items and table cells that hold more words than a reader can take as one idea."""
    found: list[tuple[int, str, int]] = []
    block: list[str] = []
    start = 0

    def close() -> None:
        if not block:
            return
        first = block[0].lstrip()
        if first.startswith("|"):
            for cell in (c for row in block for c in row.strip().strip("|").split("|")):
                words = len(cell.split())
                if words > LIMITS[2][1]:
                    found.append((start, LIMITS[2][0], words))
        else:
            marker = re.match(r"([-*+]|\d+\.)\s+", first)
            kind = LIMITS[1] if marker else LIMITS[0]
            words = len(" ".join([first[marker.end():] if marker else first, *block[1:]]).split())
            if words > kind[1] and not first.startswith(("#", "!", ">")):
                found.append((start, kind[0], words))

    for number, line in lines:
        stripped = line.strip()
        starts_item = bool(re.match(r"([-*+]|\d+\.)\s", stripped))
        if not stripped or stripped.startswith("#") or (starts_item and block and not block[0].lstrip().startswith("|")):
            close()
            block = []
        if stripped and not stripped.startswith("#"):
            if not block:
                start = number
            block.append(line)
    close()
    return found


def sweep(path: pathlib.Path, other_readers: list[str]) -> int:
    lines = prose_lines(path.read_text(encoding="utf-8"))
    classes = list(CLASSES)
    if other_readers:
        named = "|".join(re.escape(name) for name in other_readers)
        classes.insert(0, ("a reader named as out of reach", "every mention is a defect, except the request to them", r"(?i:\b(" + named + r")\b)"))
    hits = 0
    print("== %s" % path)
    for name, question, pattern in classes:
        compiled = re.compile(pattern, 0 if pattern.startswith("(?i:") or name == "an identifier" else re.I)
        found = [(number, line) for number, line in lines if compiled.search(line)]
        if not found:
            continue
        print("\n%s (%d) — %s" % (name, len(found), question))
        for number, line in found:
            match = compiled.search(line)
            assert match is not None
            begin = max(0, match.start() - 45)
            print("  %d: %s" % (number, line[begin: match.end() + 45].strip()))
        hits += len(found)
    units = long_units(lines)
    if units:
        print("\ntoo much in one unit (%d) — one idea in a paragraph, a list item, a table cell" % len(units))
        for number, kind, words in units:
            print("  %d: a %s of %d words" % (number, kind, words))
        hits += len(units)
    print("\n%d place(s) to read in %s" % (hits, path.name))
    return hits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("guides", nargs="+", type=pathlib.Path)
    parser.add_argument("--other-reader", action="append", default=[], metavar="NAME")
    arguments = parser.parse_args()
    missing = [str(guide) for guide in arguments.guides if not guide.is_file()]
    if missing:
        print("no such file: " + ", ".join(missing), file=sys.stderr)
        return 2
    total = sum(sweep(guide, arguments.other_reader) for guide in arguments.guides)
    print("\nSettle every place: fix it, or know why it stands. %d in all." % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
