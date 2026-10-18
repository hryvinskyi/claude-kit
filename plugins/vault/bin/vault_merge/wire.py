"""`vault-merge wire` and `vault-merge unwire`: the drivers registered in one vault clone, or removed.

    vault-merge wire [--check] [--vault DIR] [--command PATH]
                     [--generated-begin RE --generated-end RE]
                     [--attributes FILE [--commit] [--commit-message TEXT]]
                     [--expect PATH=DRIVER]...
    vault-merge unwire [--check] [--vault DIR] [--attributes FILE]

`wire` registers the three drivers in the clone's own git configuration (`merge.vault-<driver>.name`
and `.driver`, running COMMAND — by default the `vault-merge` shim in `~/.local/bin`, which survives
plugin updates) and, when given, the two regular expressions that delimit a generated region. Before
it registers anything it reads back, byte for byte, every tracked file the vault's attributes give
to the keyed driver, and it refuses when one would not survive.

`--attributes FILE` names the `.gitattributes` the vault should carry. When the vault's own file is
identical, nothing is written. When the vault has none, `--commit` writes it and commits it in the
vault (nothing is pushed); without `--commit` the absence is reported and the drivers are registered
anyway, since a clone whose attributes arrive later merges with them from then on. A different file
is never overwritten: the run refuses and shows the lines to fold in by hand.

`--expect PATH=DRIVER` asserts that git assigns DRIVER (keyed, stamps or generated) to PATH once the
run is done, with the attributes in effect then.

`unwire` removes the drivers' and the markers' configuration and, while it is byte for byte the
`--attributes FILE` given, the vault's `.gitattributes` (committed as a removal when it was tracked).

`--check` reports without writing. Exit status: 0 nothing to do (or done), 1 something to do (only
with `--check`), 2 refused or failed.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, TextIO, Tuple

import vaultlib

DRIVERS = ("keyed", "stamps", "generated")
BEGIN_KEY = "vault-merge.generatedBegin"
END_KEY = "vault-merge.generatedEnd"
ATTRIBUTES_NAME = ".gitattributes"
DEFAULT_COMMIT_MESSAGE = "Merge drivers for the vault's busiest files"
DEFAULT_COMMAND = os.path.join("~", ".local", "bin", "vault-merge")

# Exit statuses shared by both commands.
DONE, PENDING, REFUSED = 0, 1, 2

# Reads a file as the keyed driver does and writes it back in memory: (0 when identical, the line to show).
ReadBack = Callable[[str], Tuple[int, str]]


class Report:
    """The lines a run prints, and whether anything is left to do or refused."""

    def __init__(self, out: TextIO) -> None:
        self.out = out
        self.pending = False
        self.refused = False

    def ok(self, text: str) -> None:
        print("  ok    " + text, file=self.out)

    def info(self, text: str) -> None:
        print("  ..    " + text, file=self.out)

    def todo(self, text: str) -> None:
        self.pending = True
        print("  ..    " + text, file=self.out)

    def bad(self, text: str) -> None:
        self.refused = True
        print("  FAIL  " + text, file=self.out)

    def step(self, text: str) -> None:
        print("\n== " + text, file=self.out)

    def status(self, check: bool) -> int:
        if self.refused:
            return REFUSED
        return PENDING if check and self.pending else DONE


class Vault:
    """git, run in one clone with the configuration scope a clone owns."""

    def __init__(self, top: Path) -> None:
        self.top = top

    def run(self, *args: str, input_text: Optional[str] = None) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(self.top), *args], input=input_text, capture_output=True,
                              text=True, timeout=60)

    def config(self, key: str) -> Optional[str]:
        done = self.run("config", "--local", "--get", key)
        return done.stdout.rstrip("\n") if done.returncode == 0 else None

    def tracked(self) -> List[str]:
        done = self.run("ls-files", "-z")
        return [name for name in done.stdout.split("\0") if name]

    def is_tracked(self, name: str) -> bool:
        return self.run("ls-files", "--error-unmatch", "--", name).returncode == 0

    def committed(self, name: str) -> bool:
        return self.is_tracked(name) and self.run("diff", "--quiet", "HEAD", "--", name).returncode == 0


def toplevel(directory: Path) -> Tuple[Optional[Path], str]:
    """The clone whose top `directory` is, or why it is not one."""
    done = subprocess.run(["git", "-C", str(directory), "rev-parse", "--show-toplevel"], capture_output=True,
                          text=True, timeout=60)
    if done.returncode != 0:
        return None, "%s is not inside a git repository" % directory
    top = Path(done.stdout.strip()).resolve()
    if top != directory.resolve():
        return None, "%s is not the top of a git repository (that is %s)" % (directory, top)
    return top, ""


def assignments(repo: Path, paths: Sequence[str]) -> Dict[str, str]:
    """The `merge` attribute git gives each path in `repo`: unspecified, set, unset or a driver name."""
    if not paths:
        return {}
    done = subprocess.run(["git", "-C", str(repo), "check-attr", "-z", "--stdin", "merge"],
                          input="\0".join(paths) + "\0", capture_output=True, text=True, timeout=60)
    fields = done.stdout.split("\0")
    found: Dict[str, str] = {}
    for index in range(0, len(fields) - 2, 3):
        found[fields[index]] = fields[index + 2]
    return found


def assignments_under(attributes: bytes, paths: Sequence[str]) -> Dict[str, str]:
    """The assignments `paths` would get from a `.gitattributes` holding `attributes`, at the top."""
    with tempfile.TemporaryDirectory(prefix="vault-merge-wire-") as scratch:
        subprocess.run(["git", "init", "-q", scratch], capture_output=True, check=True, timeout=60)
        Path(scratch, ATTRIBUTES_NAME).write_bytes(attributes)
        return assignments(Path(scratch), paths)


def driver_line(command: str, driver: str) -> str:
    """The command git runs for one driver."""
    return "'%s' %s %%O %%A %%B %%P" % (command, driver)


def replace_file(path: Path, data: bytes) -> None:
    """Write a new file beside `path`, then rename it over `path`."""
    handle, temporary = tempfile.mkstemp(prefix=".vault-merge-wire-", dir=str(path.parent))
    with os.fdopen(handle, "wb") as out:
        out.write(data)
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


@dataclass
class Expectation:
    path: str
    driver: str


@dataclass
class Plan:
    """What `wire` found and would change."""

    config: List[Tuple[str, str]] = field(default_factory=list)
    write_attributes: bool = False
    commit_attributes: bool = False


def expectation(text: str) -> Expectation:
    """PATH=DRIVER, split at the last `=` so a path may hold one."""
    path, sep, driver = text.rpartition("=")
    driver = driver[len("vault-"):] if driver.startswith("vault-") else driver
    if not sep or not path or driver not in DRIVERS:
        raise argparse.ArgumentTypeError("expected PATH=DRIVER with DRIVER one of %s: %s" % ("|".join(DRIVERS), text))
    return Expectation(path, driver)


def parser(name: str) -> argparse.ArgumentParser:
    found = argparse.ArgumentParser(prog="vault-merge " + name, add_help=True)
    found.add_argument("--check", action="store_true", help="report; write nothing")
    found.add_argument("--vault", default=".", help="the vault clone (default: the current directory)")
    found.add_argument("--attributes", help="the .gitattributes the vault should carry")
    if name == "wire":
        found.add_argument("--command", default=DEFAULT_COMMAND, help="what git runs (default: %(default)s)")
        found.add_argument("--generated-begin", help="regular expression opening a generated region")
        found.add_argument("--generated-end", help="regular expression closing a generated region")
        found.add_argument("--commit", action="store_true", help="write and commit --attributes when the vault has none")
        found.add_argument("--commit-message", default=DEFAULT_COMMIT_MESSAGE)
        found.add_argument("--expect", action="append", default=[], type=expectation, metavar="PATH=DRIVER")
    return found


def open_vault(options: argparse.Namespace, report: Report) -> Optional[Vault]:
    report.step("The vault clone")
    top, why = toplevel(Path(options.vault).expanduser())
    if top is None:
        report.bad(why)
        return None
    vault = Vault(top)
    report.ok("%s is a git repository of its own" % top)
    busy = vaultlib.unfinished(top, str(top))
    if busy:
        report.bad(busy)
        return None
    report.ok("nothing in progress in the vault, and it is on a branch")
    return vault


def read_attributes(options: argparse.Namespace, report: Report) -> Optional[bytes]:
    if not options.attributes:
        return None
    try:
        return Path(options.attributes).expanduser().read_bytes()
    except OSError as exc:
        report.bad("the attributes file cannot be read: %s" % exc)
        return None


class Wire:
    """`vault-merge wire`."""

    def __init__(self, out: TextIO, read_back: ReadBack) -> None:
        self.out = out
        self.read_back = read_back

    def __call__(self, argv: List[str]) -> int:
        try:
            options = parser("wire").parse_args(argv)
        except SystemExit as exc:
            return REFUSED if exc.code else DONE
        if bool(options.generated_begin) != bool(options.generated_end):
            print("vault-merge wire: --generated-begin and --generated-end go together", file=self.out)
            return REFUSED
        report = Report(self.out)
        print("vault-merge wire (%s)" % ("check" if options.check else "apply"), file=self.out)
        vault = open_vault(options, report)
        if vault is None:
            return REFUSED
        command = os.path.expanduser(options.command)
        plan = Plan()
        self.command(command, options.check, report)
        wanted = read_attributes(options, report)
        effective = self.attributes(vault, wanted, options, plan, report)
        assigned = self.assigned(vault, effective, options.expect, plan)
        self.keyed_files(vault, assigned, report)
        self.configuration(vault, command, options, assigned, plan, report)
        self.expectations(options.expect, assigned, effective, report)
        if options.check or report.refused:
            if report.refused and not options.check:
                report.step("Refused: nothing was changed")
            return report.status(options.check)
        self.apply(vault, wanted, options, plan, report)
        return report.status(False)

    def command(self, command: str, check: bool, report: Report) -> None:
        report.step("The command git runs")
        if "'" in command:
            report.bad("the command path holds a single quote, which the driver line cannot carry: %s" % command)
        elif os.access(command, os.X_OK):
            report.ok(command)
        elif check:
            report.todo("%s is not there yet; it must exist before the drivers are registered" % command)
        else:
            report.bad("%s is not an executable; install the command shims first" % command)

    def attributes(self, vault: Vault, wanted: Optional[bytes], options: argparse.Namespace, plan: Plan,
                   report: Report) -> Optional[bytes]:
        """The `.gitattributes` in effect once the run is done, or None when the vault has none."""
        report.step(ATTRIBUTES_NAME)
        path = vault.top / ATTRIBUTES_NAME
        current = path.read_bytes() if path.is_file() else None
        if wanted is None:
            if current is None:
                report.info("the vault carries no %s; git uses its text merge until it does" % ATTRIBUTES_NAME)
            else:
                report.ok("the vault's own %s decides which files the drivers merge" % ATTRIBUTES_NAME)
            return current
        if current == wanted:
            if vault.committed(ATTRIBUTES_NAME):
                report.ok("%s is the one given, committed" % ATTRIBUTES_NAME)
            elif options.commit:
                plan.commit_attributes = True
                report.todo("would commit the vault's %s (not pushed)" % ATTRIBUTES_NAME)
            else:
                report.info("%s is the one given, not committed" % ATTRIBUTES_NAME)
            return current
        if current is None:
            if options.commit:
                plan.write_attributes = plan.commit_attributes = True
                report.todo("would write %s and commit it in the vault (not pushed)" % ATTRIBUTES_NAME)
                return wanted
            report.info("the vault carries no %s yet; the drivers are registered and apply once it arrives"
                        % ATTRIBUTES_NAME)
            return None
        report.bad("the vault's %s differs from the one given; fold these lines into it by hand:" % ATTRIBUTES_NAME)
        for line in wanted.decode("utf-8", "replace").splitlines():
            print("          " + line, file=self.out)
        return current

    def assigned(self, vault: Vault, effective: Optional[bytes], expected: Sequence[Expectation],
                 plan: Plan) -> Dict[str, str]:
        """Every tracked or expected path the drivers would merge, with the driver's attribute value."""
        paths = list(dict.fromkeys(vault.tracked() + [e.path for e in expected]))
        if effective is None:
            return {}
        found = assignments_under(effective, paths) if plan.write_attributes else assignments(vault.top, paths)
        return {path: value for path, value in found.items() if value.startswith("vault-")}

    def keyed_files(self, vault: Vault, assigned: Dict[str, str], report: Report) -> None:
        report.step("Every file the keyed driver merges reads back byte for byte")
        keyed = sorted(path for path, value in assigned.items() if value == "vault-keyed")
        present = [path for path in keyed if (vault.top / path).is_file()]
        if not present:
            report.info("no tracked file is given to the keyed driver")
        prefix = str(vault.top) + os.sep
        for path in present:
            status, line = self.read_back(str(vault.top / path))
            shown = line[len(prefix):] if line.startswith(prefix) else line
            if status == 0:
                report.ok(shown)
            else:
                report.bad("%s — the keyed driver must not merge it" % shown)

    def configuration(self, vault: Vault, command: str, options: argparse.Namespace, assigned: Dict[str, str],
                      plan: Plan, report: Report) -> None:
        report.step("Driver registration in the clone's configuration")
        for value in sorted(set(assigned.values())):
            if value[len("vault-"):] not in DRIVERS:
                report.bad("the attributes name %s, which is not one of the drivers (%s)" % (value, ", ".join(DRIVERS)))
        wanted: List[Tuple[str, str]] = []
        for driver in DRIVERS:
            wanted.append(("merge.vault-%s.name" % driver, "vault-merge %s" % driver))
            wanted.append(("merge.vault-%s.driver" % driver, driver_line(command, driver)))
        if options.generated_begin:
            wanted.append((BEGIN_KEY, options.generated_begin))
            wanted.append((END_KEY, options.generated_end))
        elif vault.config(BEGIN_KEY) and vault.config(END_KEY):
            report.ok("%s and %s already set" % (BEGIN_KEY, END_KEY))
        elif "vault-generated" in assigned.values():
            report.bad("files go to the generated driver but %s and %s are not both set; pass --generated-begin "
                       "and --generated-end" % (BEGIN_KEY, END_KEY))
        for key, value in wanted:
            have = vault.config(key)
            if have == value:
                report.ok(key)
            else:
                plan.config.append((key, value))
                report.todo("would set %s = %s%s" % (key, value, " (now: %s)" % have if have else ""))

    def expectations(self, expected: Sequence[Expectation], assigned: Dict[str, str], effective: Optional[bytes],
                     report: Report) -> None:
        if not expected:
            return
        report.step("Assignments")
        for item in expected:
            got = assigned.get(item.path, "unspecified")
            if effective is None:
                report.bad('%s: the vault carries no %s to assign vault-%s' % (item.path, ATTRIBUTES_NAME, item.driver))
            elif got == "vault-" + item.driver:
                report.ok('check-attr merge -- "%s": %s' % (item.path, got))
            else:
                report.bad('check-attr merge -- "%s": %s, expected vault-%s' % (item.path, got, item.driver))

    def apply(self, vault: Vault, wanted: Optional[bytes], options: argparse.Namespace, plan: Plan,
              report: Report) -> None:
        report.step("Apply")
        if plan.write_attributes and wanted is not None:
            replace_file(vault.top / ATTRIBUTES_NAME, wanted)
            report.ok("wrote %s" % ATTRIBUTES_NAME)
        if plan.commit_attributes:
            done = vault.run("add", "--", ATTRIBUTES_NAME)
            if done.returncode == 0:
                done = vault.run("commit", "-q", "-m", options.commit_message, "--", ATTRIBUTES_NAME)
            if done.returncode == 0:
                report.ok("committed %s (not pushed)" % ATTRIBUTES_NAME)
            else:
                report.bad("committing %s failed: %s" % (ATTRIBUTES_NAME, (done.stderr or done.stdout).strip()))
        for key, value in plan.config:
            if vault.run("config", "--local", key, value).returncode == 0:
                report.ok("set %s" % key)
            else:
                report.bad("could not set %s" % key)
        if not plan.config and not plan.commit_attributes:
            report.ok("nothing to change")
        if options.expect:
            effective = (vault.top / ATTRIBUTES_NAME).read_bytes() if (vault.top / ATTRIBUTES_NAME).is_file() else None
            after = {path: value for path, value in
                     assignments(vault.top, [e.path for e in options.expect]).items() if value.startswith("vault-")}
            self.expectations(options.expect, after, effective, report)


class Unwire:
    """`vault-merge unwire`."""

    def __init__(self, out: TextIO) -> None:
        self.out = out

    def __call__(self, argv: List[str]) -> int:
        try:
            options = parser("unwire").parse_args(argv)
        except SystemExit as exc:
            return REFUSED if exc.code else DONE
        report = Report(self.out)
        print("vault-merge unwire (%s)" % ("check" if options.check else "apply"), file=self.out)
        vault = open_vault(options, report)
        if vault is None:
            return REFUSED
        wanted = read_attributes(options, report)
        if report.refused:
            return REFUSED
        report.step("Configuration")
        sections = ["merge.vault-%s" % driver for driver in DRIVERS] + ["vault-merge"]
        for section in sections:
            present = vault.run("config", "--local", "--get-regexp", "^%s\\." % section.replace(".", "\\.")).returncode == 0
            if not present:
                report.ok("%s absent" % section)
            elif options.check:
                report.todo("would remove %s.*" % section)
            elif vault.run("config", "--local", "--remove-section", section).returncode == 0:
                report.ok("removed %s.*" % section)
            else:
                report.bad("could not remove %s.*" % section)
        report.step(ATTRIBUTES_NAME)
        path = vault.top / ATTRIBUTES_NAME
        if not path.is_file():
            report.ok("%s absent" % ATTRIBUTES_NAME)
        elif wanted is None or path.read_bytes() != wanted:
            report.info("%s is not the one given; left alone" % ATTRIBUTES_NAME)
        elif options.check:
            report.todo("would remove %s%s" % (ATTRIBUTES_NAME, " and commit the removal" if vault.is_tracked(ATTRIBUTES_NAME) else ""))
        elif vault.is_tracked(ATTRIBUTES_NAME):
            removed = vault.run("rm", "-q", "--", ATTRIBUTES_NAME)
            if removed.returncode == 0:
                removed = vault.run("commit", "-q", "-m", "Remove the merge drivers' attributes", "--", ATTRIBUTES_NAME)
            if removed.returncode == 0:
                report.ok("removed %s and committed the removal (not pushed)" % ATTRIBUTES_NAME)
            else:
                report.bad("removing %s failed: %s" % (ATTRIBUTES_NAME, (removed.stderr or removed.stdout).strip()))
        else:
            path.unlink()
            report.ok("removed the uncommitted %s" % ATTRIBUTES_NAME)
        return report.status(options.check)
