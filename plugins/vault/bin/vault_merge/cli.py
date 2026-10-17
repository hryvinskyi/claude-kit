"""vault-merge — the command git runs as a merge driver, and the parser's self-check.

    vault-merge keyed|stamps|generated %O %A %B [%P]
    vault-merge selfcheck FILE...

As a driver it writes the merged result over %A and exits 0 when the result is resolved, 1 when
conflicts are left in it for a person. If a driver cannot merge — a version it cannot read, an
exception — git's own text merge (`git merge-file`) is written instead and its exit status returned,
so a fault in a driver surfaces as an ordinary conflict, never as a lost or truncated file. %A is only
ever replaced whole, by renaming a finished file over it.

`selfcheck` reads each file the way the keyed driver does, writes it back in memory and exits 1 if a
byte differs; it prints counts only, never the file's text.
"""
from __future__ import annotations

import os
import stat
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Callable, Dict, List, TextIO

from vault_merge import blocks as md
from vault_merge.driver import Driver, MergeInput
from vault_merge.generated import GeneratedDriver
from vault_merge.gitmerge import Git
from vault_merge.keyed import KeyedDriver
from vault_merge.stamps import StampsDriver

Command = Callable[[List[str]], int]
USAGE = "usage: vault-merge keyed|stamps|generated %O %A %B [%P] | vault-merge selfcheck FILE..."


def replace(path: str, data: bytes) -> None:
    """Write `data` to a new file beside `path`, then rename it over `path`."""
    directory = os.path.dirname(os.path.abspath(path))
    handle, temporary = tempfile.mkstemp(prefix=".vault-merge-", dir=directory)
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        try:
            os.chmod(temporary, stat.S_IMODE(os.stat(path).st_mode))
        except OSError:
            pass
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


class DriverCommand:
    """One driver as git calls it."""

    def __init__(self, name: str, driver: Driver, git: Git, err: TextIO) -> None:
        self.name, self.driver, self.git, self.err = name, driver, git, err

    def __call__(self, args: List[str]) -> int:
        if len(args) not in (3, 4):
            print(USAGE, file=self.err)
            return 2
        base, current, incoming = args[:3]
        path = args[3] if len(args) == 4 else ""
        try:
            outcome = self.driver.merge(MergeInput(Path(base).read_bytes(), Path(current).read_bytes(),
                                                   Path(incoming).read_bytes(), path))
            replace(current, outcome.merged)
        except Exception as exc:  # any fault in a driver is reported and handed to git's text merge
            return self.fallback(base, current, incoming, path, exc)
        for note in outcome.notes:
            print("vault-merge: " + note, file=self.err)
        return 0 if outcome.resolved else 1

    def fallback(self, base: str, current: str, incoming: str, path: str, exc: Exception) -> int:
        print("vault-merge: the %s driver could not merge %s (%s: %s); git's text merge was used instead"
              % (self.name, path or current, type(exc).__name__, exc), file=self.err)
        try:
            merged, conflicts = self.git.merge_file(Path(current).read_bytes(), Path(base).read_bytes(),
                                                    Path(incoming).read_bytes())
            replace(current, merged)
        except Exception as again:  # nothing was written: git sees a failed merge of an untouched file
            print("vault-merge: git's text merge failed too (%s); %s is unchanged" % (again, path or current),
                  file=self.err)
            return 2
        return conflicts


class SelfCheck:
    """Reads and writes back each file as the keyed driver would; fails on any differing byte."""

    def __init__(self, out: TextIO) -> None:
        self.out = out

    def __call__(self, args: List[str]) -> int:
        if not args:
            print(USAGE, file=self.out)
            return 2
        failed = 0
        for name in args:
            failed |= self.check(name)
        return 1 if failed else 0

    def check(self, name: str) -> int:
        try:
            data = Path(name).read_bytes()
            document = md.parse(data.decode("utf-8"))
        except (OSError, UnicodeDecodeError, md.ParseError) as exc:
            print("%s: FAIL, cannot be read: %s" % (name, exc), file=self.out)
            return 1
        written = document.text().encode("utf-8")
        if written != data:
            at = next((i for i, (a, b) in enumerate(zip(written, data)) if a != b), min(len(written), len(data)))
            print("%s: FAIL, written back it differs from byte %d" % (name, at), file=self.out)
            return 1
        print("%s: identical · %s" % (name, describe(document)), file=self.out)
        return 0


def describe(document: md.Document) -> str:
    """Counts of what the document was read as: blocks, items, and how the items are keyed."""
    kinds = Counter(block.kind for block in document.blocks)
    items = Counter(block.ident for block in document.blocks if block.kind == md.ITEM_KIND)
    by = Counter(ident.split(":", 1)[0] for ident in items)
    qualified = sum(1 for ident in items if ident.startswith("ref:") and "/" in ident)
    repeated = [ident for ident, count in items.items() if count > 1]
    extra = sum(items[ident] - 1 for ident in repeated)
    shown = ", ".join("%d %s" % (count, kind) for kind, count in sorted(kinds.items()))
    return ("%d blocks (%s) · %d items · %d distinct item keys (%d by issue reference, %d of them "
            "repo-qualified; %d by bold text; %d by leading text) · %d keys repeated (%d extra rows)"
            % (len(document.blocks), shown, sum(items.values()), len(items), by["ref"], qualified,
               by["bold"], by["text"], len(repeated), extra))


def commands(git: Git, out: TextIO, err: TextIO) -> Dict[str, Command]:
    """Every command by name: the drivers and the self-check."""
    drivers: Dict[str, Driver] = {
        "keyed": KeyedDriver(git),
        "stamps": StampsDriver(),
        "generated": GeneratedDriver(git),
    }
    found: Dict[str, Command] = {name: DriverCommand(name, driver, git, err) for name, driver in drivers.items()}
    found["selfcheck"] = SelfCheck(out)
    return found


def main(argv: List[str], out: TextIO = sys.stdout, err: TextIO = sys.stderr) -> int:
    known = commands(Git(), out, err)
    if not argv or argv[0] not in known:
        print(USAGE, file=err)
        return 2
    return known[argv[0]](argv[1:])
