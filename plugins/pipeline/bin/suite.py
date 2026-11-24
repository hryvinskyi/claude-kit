"""suite.py — where a test suite's cases and seconds are, whether a list of verdicts on its tests holds up,
and what a change took out of it.

Usage:
    pipeline-suite census <report>... [--root DIR] [--top N] [--json]
    pipeline-suite check <verdicts.json> [--root DIR] [--ready] [--json]
    pipeline-suite diff --before <report>... --after <report>... [--verdicts FILE] [--budget LEVEL=SECONDS]...
                        [--root DIR] [--json]

A report is a JUnit XML file, the format nearly every test runner writes (PHPUnit and ParaTest
`--log-junit`, pytest `--junitxml`, Jest and Vitest through their JUnit reporters, Go through
`go-junit-report`, cargo-nextest). A run that writes one file per worker or per package passes them all.

`census` answers where to read first. It counts cases (one `<testcase>` each; a parameterised test is
one test and as many cases as it has rows), tests, files and seconds, and prints them by level (the
path segment named unit, integration, functional, …), by area (the package a test directory belongs
to, or the directory below it), by file and by test, with the widest parameter sets and how the
seconds concentrate. The seconds are the sum of the cases' own times: on a parallel run that is
processor time, not the time a person waits.

`check` reads the verdicts a review of the tests produced — a JSON array, one object per test, in the
shape the `pipeline:test-value` skill gives — and reports every entry that does not carry what its
verdict owes: a verdict or class nobody defined, a verdict with no evidence, a duplicate with no
surviving test named, a cheap test that leaves on the word of expensive ones only, a cited file that does not exist, a line past the end of its file, a quoted
line that is not where the entry says it is, a test that is not in its file (a name a template
literal builds in a loop counts as there). With `--ready` it also
refuses an entry whose proof is missing: nothing leaves a suite on a verdict nobody proved.

`diff` compares the suite before and after a change: cases, tests and seconds, as a whole and level
by level, and every test that left the suite or lost cases. With `--verdicts` it names the ones no
verdict accounts for — a test that vanished because a rename or a move took it out of the runner's
sight looks, in a green run, exactly like one that was deleted on purpose — and the ones a verdict
removes that still run. It also says what the tests that joined the suite cost at each level, in the
seconds of the run after: the whole time of a new test, and of a test that gained rows the time of
those rows at its own average. That number does not compare two machines, so it holds between a
run of the base on one and a run of the change on another. `--budget integration=30` makes it a
gate: the comparison fails when the tests a change adds at that level cost more than that many
seconds.

`--root` is the checkout the reported paths belong to (default: the directory the command runs in).
Reports hold the absolute paths of the machine that ran them. Each run's paths are made relative to
the root by finding the suffix that exists there, so two runs from two machines name a test alike.
A run none of whose files exists under the root loses the directory its paths share instead, cut so
that the test directory stays in the path.

Exit status: 0 done, and nothing to object to; 1 `check` found an entry that does not hold up,
`diff --verdicts` found a test unaccounted for or a removal not applied, or `diff --budget` found
a level whose new tests cost more than its budget; 2 the request is unusable — a report that is not
JUnit XML or declares a DTD, a verdict file that is not a JSON array, a budget that is not
`level=seconds`, a missing file.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from xml.etree import ElementTree

LEVELS = (
    "unit", "integration", "functional", "feature", "acceptance", "e2e", "system", "contract",
    "browser", "smoke",
)
COST = {
    "unit": 0, "integration": 1, "functional": 2, "feature": 2, "acceptance": 2, "system": 2, "contract": 2,
    "e2e": 3, "browser": 3, "smoke": 3,
}
TEST_ROOTS = ("tests", "test", "__tests__", "spec", "specs")
PARAMETERISED = (
    re.compile(r"^(?P<test>.+?) with data set (?P<row>.+)$", re.S),
    re.compile(r"^(?P<test>[^\[\]]+)\[(?P<row>.*)\]$", re.S),
    re.compile(r"^(?P<test>Test\w*)/(?P<row>.+)$", re.S),
)
VERDICTS = ("keep", "trim", "delete", "rewrite", "move", "unsure")
CLASSES = (
    "none", "restates", "tool", "gate", "duplicate", "dead", "vacuous", "file-read", "implementation",
    "level", "fixture", "other",
)
LEAVING = ("trim", "delete", "rewrite", "move")
NEEDS_RUN = ("duplicate", "vacuous", "file-read", "implementation", "level", "fixture")
SURVIVOR_ON_DELETE = ("vacuous", "file-read", "implementation", "level", "fixture")
PROOF_KINDS = ("run", "gate", "read", "list")
TEMPLATE_NAME = re.compile(r"`([^`\n]*\$\{[^`\n]*)`")
QUOTE_WINDOW = 3
SHARES = (0.25, 0.5, 0.75, 0.9)
SLOW = (1.0, 5.0)


class Refused(Exception):
    """The request cannot be carried out; the message says why."""


class Case:
    """One test case of a report: where it is, which test it is a row of, and what it cost."""

    __slots__ = ("group", "test", "row", "seconds", "skipped", "failed")

    def __init__(self, group: str, test: str, row: Optional[str], seconds: float, skipped: bool, failed: bool) -> None:
        self.group = group
        self.test = test
        self.row = row
        self.seconds = seconds
        self.skipped = skipped
        self.failed = failed


def split_name(name: str) -> Tuple[str, Optional[str]]:
    """A case's name as its test and its row; the row is None for a test with no parameters."""
    for form in PARAMETERISED:
        found = form.match(name)
        if found:
            return found.group("test").strip(), found.group("row").strip().strip('"')
    return name, None


def refuse_declarations(path: Path) -> None:
    """Refuse a report that declares a DTD or an entity: a JUnit report holds neither."""
    try:
        with path.open("rb") as handle:
            carried = b""
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    return
                window = carried + chunk
                if b"<!DOCTYPE" in window or b"<!ENTITY" in window:
                    raise Refused("%s declares a DTD or an entity; a JUnit report holds neither" % path)
                carried = chunk[-16:]
    except OSError as error:
        raise Refused("%s cannot be read: %s" % (path, error.strerror or error))


def read_report(path: Path) -> List[Tuple[str, str, str, float, bool, bool]]:
    """The cases of one JUnit file: reported path or class, name, class name, seconds, skipped, failed."""
    if not path.is_file():
        raise Refused("no such report: %s" % path)
    refuse_declarations(path)
    found: List[Tuple[str, str, str, float, bool, bool]] = []
    root_seen = False
    try:
        for event, node in ElementTree.iterparse(str(path), events=("start", "end")):
            if event == "start":
                if not root_seen:
                    root_seen = True
                    if node.tag not in ("testsuites", "testsuite"):
                        raise Refused("%s is not a JUnit report: its root is <%s>" % (path, node.tag))
                continue
            if node.tag != "testcase":
                continue
            where = node.get("file") or ""
            class_name = node.get("classname") or node.get("class") or ""
            try:
                seconds = float(node.get("time") or 0)
            except ValueError:
                seconds = 0.0
            children = {child.tag for child in node}
            found.append((
                where, node.get("name") or "", class_name, seconds,
                "skipped" in children, bool(children & {"failure", "error"}),
            ))
            node.clear()
    except ElementTree.ParseError as error:
        raise Refused("%s is not well-formed XML: %s" % (path, error))
    if not root_seen:
        raise Refused("%s is empty" % path)
    return found


def as_posix(reported: str) -> str:
    """A reported path with forward slashes."""
    return reported.replace("\\", "/")


def is_absolute(reported: str) -> bool:
    """Whether a reported path is absolute, on any system."""
    return reported.startswith("/") or re.match(r"^[A-Za-z]:/", reported) is not None


def voted_prefix(paths: Iterable[str], root: Path) -> Optional[str]:
    """The prefix most reported paths lose to become a file that exists under the root; None when none does."""
    absolute = sorted({path for path in paths if is_absolute(path)})
    votes: Counter = Counter()
    for reported in absolute[:: max(1, len(absolute) // 200)]:
        parts = reported.split("/")
        for at in range(1, len(parts)):
            if (root / "/".join(parts[at:])).is_file():
                votes["/".join(parts[:at]) + "/"] += 1
                break
    return votes.most_common(1)[0][0] if votes else None


def shared_prefix(paths: Iterable[str]) -> str:
    """The directory every reported path shares, cut before its first test directory so that one stays in the path."""
    absolute = sorted({path for path in paths if is_absolute(path)})
    if not absolute:
        return ""
    shared = absolute[0].split("/")[:-1]
    for reported in absolute[1:]:
        parts = reported.split("/")[:-1]
        keep = 0
        while keep < len(shared) and keep < len(parts) and shared[keep] == parts[keep]:
            keep += 1
        shared = shared[:keep]
    for at, part in enumerate(shared):
        if part.lower() in TEST_ROOTS:
            shared = shared[:at]
            break
    return "/".join(shared) + "/" if shared else ""


def reported_paths(raw: Iterable[Tuple[str, str, str, float, bool, bool]]) -> List[str]:
    """The file paths a report's cases name."""
    return [as_posix(where) for where, _name, _class, _seconds, _skipped, _failed in raw if where]


def read_reports(reports: Sequence[str]) -> List[Tuple[str, str, str, float, bool, bool]]:
    """The cases of every report of one run."""
    raw: List[Tuple[str, str, str, float, bool, bool]] = []
    for report in reports:
        raw.extend(read_report(Path(report)))
    return raw


def to_cases(raw: Iterable[Tuple[str, str, str, float, bool, bool]], prefix: str) -> List[Case]:
    """Cases grouped by their file with the machine's prefix stripped, or by their class when they name no file."""
    cases: List[Case] = []
    for where, name, class_name, seconds, skipped, failed in raw:
        group = as_posix(where)
        if group and prefix and group.startswith(prefix):
            group = group[len(prefix):]
        if not group:
            group = class_name or "(no file or class reported)"
        test, row = split_name(name)
        cases.append(Case(group, test, row, seconds, skipped, failed))
    return cases


def load_cases(reports: Sequence[str], root: Path) -> Tuple[List[Case], bool]:
    """Every case of one run, its path made relative to the root."""
    raw = read_reports(reports)
    paths = reported_paths(raw)
    prefix = voted_prefix(paths, root)
    return to_cases(raw, shared_prefix(paths) if prefix is None else prefix), bool(paths)


def load_two_runs(before: Sequence[str], after: Sequence[str], root: Path) -> Tuple[List[Case], List[Case]]:
    """The cases of two runs under one naming, so that a test is the same test in both.

    Each run's paths lose the prefix that makes them files under the root. A run none of whose files
    exists there loses the directory both runs share: two runs named apart would look like one suite
    leaving and another joining.
    """
    raw_before, raw_after = read_reports(before), read_reports(after)
    paths_before, paths_after = reported_paths(raw_before), reported_paths(raw_after)
    prefix_before, prefix_after = voted_prefix(paths_before, root), voted_prefix(paths_after, root)
    if prefix_before is None or prefix_after is None:
        both = shared_prefix(paths_before + paths_after)
        prefix_before = both if prefix_before is None else prefix_before
        prefix_after = both if prefix_after is None else prefix_after
    return to_cases(raw_before, prefix_before), to_cases(raw_after, prefix_after)


def tokens(group: str) -> List[str]:
    """The segments of a file path or a class name."""
    return [part for part in re.split(r"[/\\.:]+", group) if part]


def level_of(group: str) -> str:
    """The level a test belongs to: the first path segment that names one, else `other`."""
    for part in tokens(group)[:-1]:
        if part.lower() in LEVELS:
            return part.lower()
    return "other"


def area_of(group: str) -> str:
    """The package a test directory belongs to, or the directory below the tests; `.` when neither."""
    parts = group.split("/")[:-1] if "/" in group else tokens(group)[:-1]
    for at, part in enumerate(parts):
        if part.lower() in TEST_ROOTS:
            if at > 0:
                return "/".join(parts[:at])
            below = [p for p in parts[at + 1:] if p.lower() not in LEVELS]
            return below[0] if below else "."
    below = [p for p in parts if p.lower() not in LEVELS]
    return "/".join(below[:2]) if below else "."


def tally(cases: Iterable[Case], key: Any) -> List[Dict[str, Any]]:
    """Cases and seconds per key, costliest first."""
    held: Dict[Any, List[float]] = defaultdict(lambda: [0, 0.0])
    for case in cases:
        entry = held[key(case)]
        entry[0] += 1
        entry[1] += case.seconds
    rows = [{"name": name, "cases": int(count), "seconds": round(seconds, 3)} for name, (count, seconds) in held.items()]
    rows.sort(key=lambda row: (-row["seconds"], -row["cases"], str(row["name"])))
    return rows


def census(cases: List[Case], has_files: bool) -> Dict[str, Any]:
    """Where the cases and the seconds of a suite are."""
    seconds = sum(case.seconds for case in cases)
    per_test: Dict[Tuple[str, str], List[float]] = defaultdict(lambda: [0, 0.0])
    for case in cases:
        entry = per_test[(case.group, case.test)]
        entry[0] += 1
        entry[1] += case.seconds
    tests = [
        {"file": group, "test": test, "cases": int(count), "seconds": round(spent, 3)}
        for (group, test), (count, spent) in per_test.items()
    ]
    tests.sort(key=lambda row: (-row["seconds"], -row["cases"], row["file"], row["test"]))
    wide = [row for row in tests if row["cases"] > 1]
    buckets = []
    for low, high in ((2, 5), (6, 10), (11, 25), (26, 50), (51, 100), (101, None)):
        inside = [row for row in wide if row["cases"] >= low and (high is None or row["cases"] <= high)]
        buckets.append({
            "rows": "%d-%s" % (low, high if high is not None else ""),
            "tests": len(inside), "cases": sum(row["cases"] for row in inside),
            "seconds": round(sum(row["seconds"] for row in inside), 3),
        })
    ordered = sorted((case.seconds for case in cases), reverse=True)
    concentration = []
    running = 0.0
    marks = list(SHARES)
    for count, spent in enumerate(ordered, 1):
        running += spent
        while marks and seconds > 0 and running >= marks[0] * seconds:
            concentration.append({"share_of_seconds": marks.pop(0), "cases": count, "share_of_cases": round(count / len(cases), 4)})
    files = tally(cases, lambda case: case.group)
    return {
        "cases": len(cases),
        "tests": len(per_test),
        "files": len(files),
        "seconds": round(seconds, 3),
        "skipped": sum(1 for case in cases if case.skipped),
        "failed": sum(1 for case in cases if case.failed),
        "groups_are_files": has_files,
        "levels": tally(cases, lambda case: level_of(case.group)),
        "areas": tally(cases, lambda case: area_of(case.group)),
        "by_file": files,
        "by_test": tests,
        "parameterised": {
            "tests": len(wide), "cases": sum(row["cases"] for row in wide),
            "seconds": round(sum(row["seconds"] for row in wide), 3), "buckets": buckets,
            "widest": sorted(wide, key=lambda row: (-row["cases"], -row["seconds"], row["file"], row["test"])),
        },
        "concentration": concentration,
        "slow": [
            {"at_least_seconds": limit, "cases": sum(1 for spent in ordered if spent >= limit),
             "seconds": round(sum(spent for spent in ordered if spent >= limit), 3)}
            for limit in SLOW
        ],
    }


def share(part: float, whole: float) -> str:
    """A share as a percentage, or a dash when there is no whole."""
    return "%5.1f%%" % (100.0 * part / whole) if whole else "    -"


def render_census(report: Dict[str, Any], top: int) -> str:
    """The census as text: totals, levels, concentration, then the costliest and the widest."""
    cases, seconds = report["cases"], report["seconds"]
    lines = [
        "%d cases in %d tests and %d files; %.0f s summed over the cases (processor time on a parallel run)"
        % (cases, report["tests"], report["files"], seconds),
    ]
    if report["skipped"] or report["failed"]:
        lines.append("%d skipped, %d failed or in error" % (report["skipped"], report["failed"]))
    if not report["groups_are_files"]:
        lines.append("the report names no files: the groups below are class names")

    def table(title: str, rows: List[Dict[str, Any]], label: Any) -> None:
        lines.append("")
        lines.append(title)
        lines.append("%8s %7s %10s %7s %9s" % ("cases", "share", "seconds", "share", "ms/case"))
        for row in rows:
            per_case = 1000.0 * row["seconds"] / row["cases"] if row["cases"] else 0.0
            lines.append("%8d %7s %10.1f %7s %9.1f  %s" % (
                row["cases"], share(row["cases"], cases), row["seconds"], share(row["seconds"], seconds),
                per_case, label(row),
            ))

    table("By level", report["levels"], lambda row: row["name"])
    if report["concentration"]:
        lines.append("")
        lines.append("Where the seconds are")
        for mark in report["concentration"]:
            lines.append("  %d%% of the seconds are in the %d costliest cases (%.1f%% of the cases)" % (
                round(100 * mark["share_of_seconds"]), mark["cases"], 100 * mark["share_of_cases"],
            ))
        for slow in report["slow"]:
            lines.append("  %d cases take %g s or more: %.0f s" % (slow["cases"], slow["at_least_seconds"], slow["seconds"]))
    table("By area, costliest first", report["areas"][:top], lambda row: row["name"])
    table("Costliest files", report["by_file"][:top], lambda row: row["name"])
    table("Costliest tests", report["by_test"][:top], lambda row: "%s::%s" % (row["file"], row["test"]))
    held = report["parameterised"]
    lines.append("")
    lines.append("Parameterised tests: %d tests run as %d cases (%s of the cases), %.0f s" % (
        held["tests"], held["cases"], share(held["cases"], cases).strip(), held["seconds"],
    ))
    for bucket in held["buckets"]:
        if bucket["tests"]:
            lines.append("  %8s rows: %5d tests, %6d cases, %8.1f s" % (bucket["rows"], bucket["tests"], bucket["cases"], bucket["seconds"]))
    table("Widest parameter sets", held["widest"][:top], lambda row: "%s::%s" % (row["file"], row["test"]))
    return "\n".join(lines) + "\n"


def cited(entry: Any) -> List[Tuple[str, Dict[str, Any]]]:
    """Every place an entry cites: its evidence lines and its surviving tests."""
    places: List[Tuple[str, Dict[str, Any]]] = []
    for key in ("evidence", "survivors"):
        held = entry.get(key)
        if isinstance(held, list):
            for at, place in enumerate(held):
                if isinstance(place, dict):
                    places.append(("%s[%d]" % (key, at), place))
    return places


def names_test(lines: Optional[List[str]], test: str) -> bool:
    """Whether a file's text holds the test's name: as a whole word, or as a template literal that makes it."""
    if lines is None:
        return False
    text = "\n".join(lines)
    if re.search(r"(?<![\w$])%s(?![\w$])" % re.escape(test), text) is not None:
        return True
    for template in TEMPLATE_NAME.findall(text):
        static = re.split(r"\$\{[^}]*\}", template)
        if re.fullmatch(".+?".join(re.escape(part) for part in static), test, re.S):
            return True
    return False


def squeeze(text: str) -> str:
    """Text with its whitespace collapsed, for comparing a quoted line with the file's."""
    return re.sub(r"\s+", " ", text).strip()


def check_place(root: Path, label: str, place: Dict[str, Any], lines_of: Dict[str, Optional[List[str]]]) -> List[str]:
    """What is wrong with one citation: a path outside the root, a missing file, a line past the end, a quote that is not there."""
    path = place.get("path")
    if not isinstance(path, str) or not path:
        return ["%s names no path" % label]
    target = (root / path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return ["%s cites %s, outside the checkout" % (label, path)]
    if path not in lines_of:
        try:
            lines_of[path] = target.read_text(encoding="utf-8", errors="replace").splitlines() if target.is_file() else None
        except OSError:
            lines_of[path] = None
    held = lines_of[path]
    if held is None:
        return ["%s cites %s, which does not exist" % (label, path)]
    line = place.get("line")
    if line is None:
        return []
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        return ["%s cites %s with a line that is not a positive number" % (label, path)]
    if line > len(held):
        return ["%s cites %s:%d, past the end of the file (%d lines)" % (label, path, line, len(held))]
    quote = place.get("quote")
    if isinstance(quote, str) and squeeze(quote):
        low, high = max(0, line - 1 - QUOTE_WINDOW), min(len(held), line + QUOTE_WINDOW)
        nearby = squeeze(" ".join(held[low:high]))
        wanted = squeeze(quote.splitlines()[0])
        if wanted and wanted not in nearby:
            return ["%s quotes a line that is not at %s:%d" % (label, path, line)]
    return []


def has_text(entry: Dict[str, Any], key: str) -> bool:
    """Whether an entry holds a non-empty text under the key."""
    value = entry.get(key)
    return isinstance(value, str) and bool(value.strip())


def check_entry(root: Path, entry: Any, ready: bool, lines_of: Dict[str, Optional[List[str]]]) -> List[str]:
    """Everything one verdict entry owes and does not carry."""
    if not isinstance(entry, dict):
        return ["is not an object"]
    problems: List[str] = []
    for key in ("file", "test", "verdict", "class"):
        if not has_text(entry, key):
            problems.append("has no %s" % key)
    if problems:
        return problems
    verdict, kind = entry["verdict"], entry["class"]
    if verdict not in VERDICTS:
        problems.append("has a verdict nobody defined: %s" % verdict)
    if kind not in CLASSES:
        problems.append("has a class nobody defined: %s" % kind)
    if problems:
        return problems
    file_place = {"path": entry["file"]}
    problems.extend(check_place(root, "file", file_place, lines_of))
    held = lines_of.get(entry["file"])
    if held is not None and entry["test"] != "*" and not names_test(held, entry["test"]):
        problems.append("names a test that is not in its file: %s" % entry["test"])
    if verdict == "keep":
        if kind != "none":
            problems.append("keeps a test and gives it a class (%s): a kept test has class none" % kind)
        return problems
    if verdict == "unsure":
        if not has_text(entry, "settle_by"):
            problems.append("is unsure and does not say what would settle it (settle_by)")
        return problems
    if kind == "none":
        problems.append("%ss a test and names no class" % verdict)
    if not has_text(entry, "rule"):
        problems.append("states no rule (write \"none\" when the test states none)")
    places = cited(entry)
    if not [label for label, _place in places if label.startswith("evidence")]:
        problems.append("quotes no evidence")
    for label, place in places:
        problems.extend(check_place(root, label, place, lines_of))
    survivors = [place for label, place in places if label.startswith("survivors")]
    needs_survivor = kind == "duplicate" or (verdict == "delete" and kind in SURVIVOR_ON_DELETE)
    if needs_survivor and not survivors:
        problems.append("names no surviving test (survivors) for the %s test it %ss" % (kind, verdict))
    for at, survivor in enumerate(survivors):
        if not has_text(survivor, "test"):
            problems.append("names survivors[%d] with no test name" % at)
            continue
        if survivor.get("path") == entry["file"] and survivor["test"] == entry["test"]:
            if verdict != "trim":
                problems.append("names itself as its own survivor: only a trimmed test survives itself, in the rows it keeps")
        elif isinstance(survivor.get("path"), str) and lines_of.get(survivor["path"]) is not None:
            if not names_test(lines_of[survivor["path"]], survivor["test"]):
                problems.append("names a survivor that is not in its file: %s" % survivor["test"])
    own_cost = COST.get(level_of(entry["file"]))
    costs = [COST.get(level_of(s["path"])) for s in survivors if isinstance(s.get("path"), str)]
    if kind == "duplicate" and own_cost is not None and costs and all(c is not None and c > own_cost for c in costs):
        problems.append(
            "names only survivors at a costlier level than the duplicate it %ss: a test of a rule does not leave "
            "because a costlier test covers it (a joining rebuilt out of stand-ins is class level)" % verdict
        )
    if kind == "gate" and not has_text(entry, "gate"):
        problems.append("does not name the gate that catches the defect (gate)")
    if kind in NEEDS_RUN and not has_text(entry, "mutation"):
        problems.append("does not say what to break to see the proof fail (mutation)")
    if verdict in ("trim", "rewrite", "move") and not has_text(entry, "action"):
        problems.append("does not say what the %s does (action)" % verdict)
    if ready:
        problems.extend(check_proof(root, entry, kind))
    return problems


def check_proof(root: Path, entry: Dict[str, Any], kind: str) -> List[str]:
    """What is missing from the proof an entry owes before its test may leave or change."""
    proof = entry.get("proof")
    if not isinstance(proof, dict) or proof.get("kind") not in PROOF_KINDS:
        return ["has no proof (proof.kind is one of %s)" % ", ".join(PROOF_KINDS)]
    held = proof["kind"]
    if kind in NEEDS_RUN and held != "run":
        return ["owes a run and has a proof by %s: a %s is proven by seeing a test fail" % (held, kind)]
    if kind == "gate" and held not in ("gate", "run", "read"):
        return ["owes the gate's own failure, or a second reading when the gate cannot run here"]
    if not has_text(proof, "result"):
        return ["has a proof that states no result"]
    problems: List[str] = []
    logs = proof.get("logs")
    if held in ("run", "gate", "list"):
        if not isinstance(logs, list) or not logs:
            return ["has a proof by %s and keeps no output of it (proof.logs)" % held]
        for log in logs:
            target = Path(log) if isinstance(log, str) else None
            if target is None:
                problems.append("has a proof log that is not a path")
                continue
            if not target.is_absolute():
                target = root / target
            if not target.is_file() or target.stat().st_size == 0:
                problems.append("has a proof log that is missing or empty: %s" % log)
    return problems


def load_verdicts(path: Path) -> List[Any]:
    """The verdict file's entries."""
    try:
        held = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise Refused("%s cannot be read: %s" % (path, error.strerror or error))
    except ValueError as error:
        raise Refused("%s is not JSON: %s" % (path, error))
    if not isinstance(held, list):
        raise Refused("%s is not a JSON array of verdicts" % path)
    return held


def touched_survivors(entries: List[Any]) -> Dict[int, List[str]]:
    """For each entry, the survivors it names that the same batch trims, deletes, rewrites or moves.

    A survivor is a test the batch leaves as it is: otherwise two tests could leave on each other's word.
    """
    touched: Dict[Tuple[str, str], str] = {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("verdict") in LEAVING and has_text(entry, "file") and has_text(entry, "test"):
            touched[(entry["file"], entry["test"])] = entry["verdict"]
    found: Dict[int, List[str]] = {}
    for at, entry in enumerate(entries):
        if not isinstance(entry, dict) or entry.get("verdict") not in LEAVING:
            continue
        survivors = entry.get("survivors")
        for survivor in survivors if isinstance(survivors, list) else []:
            if not isinstance(survivor, dict) or not has_text(survivor, "test") or not isinstance(survivor.get("path"), str):
                continue
            if survivor["path"] == entry.get("file") and survivor["test"] == entry.get("test"):
                continue
            verdict = touched.get((survivor["path"], survivor["test"])) or touched.get((survivor["path"], "*"))
            if verdict:
                found.setdefault(at, []).append(
                    "names as a survivor a test this batch %ss: %s::%s" % (verdict, survivor["path"], survivor["test"])
                )
    return found


def check(root: Path, entries: List[Any], ready: bool) -> Dict[str, Any]:
    """Every entry that does not hold up, and the counts of the ones that do."""
    lines_of: Dict[str, Optional[List[str]]] = {}
    found: Dict[int, List[str]] = {}
    seen: Dict[Tuple[str, str], int] = {}
    for at, entry in enumerate(entries):
        found[at] = check_entry(root, entry, ready, lines_of)
        if isinstance(entry, dict) and has_text(entry, "file") and has_text(entry, "test"):
            key = (entry["file"], entry["test"])
            if key in seen:
                found[at].append("is judged twice (entries %d and %d)" % (seen[key], at))
            seen[key] = at
    for at, texts in touched_survivors(entries).items():
        found[at].extend(texts)
    problems = []
    by_verdict: Counter = Counter()
    by_class: Counter = Counter()
    leaving = 0
    for at, entry in enumerate(entries):
        if found[at]:
            name = "%s::%s" % (entry.get("file"), entry.get("test")) if isinstance(entry, dict) else "entry %d" % at
            problems.append({"entry": at, "test": name, "problems": found[at]})
            continue
        by_verdict[entry["verdict"]] += 1
        if entry["verdict"] != "keep":
            by_class[entry["class"]] += 1
        cases = entry.get("cases")
        if entry["verdict"] in LEAVING and isinstance(cases, int) and not isinstance(cases, bool) and cases > 0:
            leaving += cases
    return {
        "entries": len(entries), "problems": problems,
        "by_verdict": dict(sorted(by_verdict.items())), "by_class": dict(sorted(by_class.items())),
        "cases_leaving": leaving, "ready": ready,
    }


def render_check(report: Dict[str, Any]) -> str:
    """The check as text: what holds, then every entry that does not and why."""
    lines = ["%d verdicts; %d do not hold up" % (report["entries"], len(report["problems"]))]
    if report["by_verdict"]:
        lines.append("verdicts: " + ", ".join("%s %d" % pair for pair in report["by_verdict"].items()))
    if report["by_class"]:
        lines.append("classes: " + ", ".join("%s %d" % pair for pair in report["by_class"].items()))
    if report["cases_leaving"]:
        lines.append("cases these verdicts take out of the suite: %d" % report["cases_leaving"])
    for problem in report["problems"]:
        lines.append("")
        lines.append("%s (entry %d)" % (problem["test"], problem["entry"]))
        for text in problem["problems"]:
            lines.append("  - %s" % text)
    return "\n".join(lines) + "\n"


def per_test(cases: Iterable[Case]) -> Dict[Tuple[str, str], List[float]]:
    """Cases and seconds per test."""
    held: Dict[Tuple[str, str], List[float]] = defaultdict(lambda: [0, 0.0])
    for case in cases:
        entry = held[(case.group, case.test)]
        entry[0] += 1
        entry[1] += case.seconds
    return held


def parse_budgets(given: Optional[Sequence[str]]) -> Dict[str, float]:
    """The seconds a change's new tests may cost, by level, from `level=seconds` arguments."""
    budgets: Dict[str, float] = {}
    for text in given or ():
        level, _, seconds = text.partition("=")
        try:
            budgets[level.strip().lower()] = float(seconds)
        except ValueError:
            raise Refused("a budget is written level=seconds, as in integration=30: %s" % text)
        if not level.strip() or budgets[level.strip().lower()] < 0:
            raise Refused("a budget is written level=seconds, as in integration=30: %s" % text)
    return budgets


def joined_cost(added: List[Dict[str, Any]], grown: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """What the tests and rows that joined the suite cost, by level, in the seconds of the run after."""
    rows: List[Dict[str, Any]] = []
    for row in added:
        rows.append({"file": row["file"], "test": row["test"], "cases": row["cases_after"], "seconds": row["seconds_after"]})
    for row in grown:
        more = row["cases_after"] - row["cases_before"]
        rows.append({
            "file": row["file"], "test": row["test"], "cases": more,
            "seconds": round(row["seconds_after"] / row["cases_after"] * more, 3),
        })
    levels: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        held = levels.setdefault(level_of(row["file"]), {"cases": 0, "seconds": 0.0, "tests": []})
        held["cases"] += row["cases"]
        held["seconds"] += row["seconds"]
        held["tests"].append(row)
    out = []
    for level, held in levels.items():
        held["tests"].sort(key=lambda row: (-row["seconds"], -row["cases"], row["file"], row["test"]))
        out.append({"level": level, "cases": held["cases"], "seconds": round(held["seconds"], 3), "tests": held["tests"]})
    out.sort(key=lambda row: (-row["seconds"], -row["cases"], row["level"]))
    return out


def diff(before: List[Case], after: List[Case], verdicts: Optional[List[Any]], budgets: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """What left the suite between two runs, what joined it, and what no verdict accounts for."""
    old, new = per_test(before), per_test(after)
    removed, shrunk, grown, added = [], [], [], []
    for key in sorted(set(old) | set(new)):
        had, has = int(old[key][0]) if key in old else 0, int(new[key][0]) if key in new else 0
        row = {
            "file": key[0], "test": key[1], "cases_before": had, "cases_after": has,
            "seconds_before": round(old[key][1], 3) if key in old else 0.0,
            "seconds_after": round(new[key][1], 3) if key in new else 0.0,
        }
        if had and not has:
            removed.append(row)
        elif has and not had:
            added.append(row)
        elif has < had:
            shrunk.append(row)
        elif has > had:
            grown.append(row)
    report: Dict[str, Any] = {
        "before": {"cases": len(before), "tests": len(old), "seconds": round(sum(c.seconds for c in before), 3)},
        "after": {"cases": len(after), "tests": len(new), "seconds": round(sum(c.seconds for c in after), 3)},
        "levels": {
            "before": tally(before, lambda case: level_of(case.group)),
            "after": tally(after, lambda case: level_of(case.group)),
        },
        "removed": removed, "shrunk": shrunk, "grown": grown, "added": added,
        "joined": joined_cost(added, grown),
    }
    if budgets:
        cost = {row["level"]: row["seconds"] for row in report["joined"]}
        report["over_budget"] = [
            {"level": level, "seconds": cost[level], "budget": budget}
            for level, budget in sorted(budgets.items()) if cost.get(level, 0.0) > budget
        ]
    if verdicts is not None:
        leaving = set()
        whole_files = set()
        deleted = []
        for entry in verdicts:
            if not isinstance(entry, dict) or entry.get("verdict") not in LEAVING:
                continue
            file_name, test = entry.get("file"), entry.get("test")
            if not isinstance(file_name, str) or not isinstance(test, str):
                continue
            if test == "*":
                whole_files.add(file_name)
            else:
                leaving.add((file_name, test))
            if entry.get("verdict") == "delete":
                deleted.append((file_name, test))

        def accounted(row: Dict[str, Any]) -> bool:
            return (row["file"], row["test"]) in leaving or row["file"] in whole_files

        report["unaccounted"] = [row for row in removed + shrunk if not accounted(row)]
        still = []
        for file_name, test in deleted:
            running = [key for key in new if key[0] == file_name and (test == "*" or key[1] == test)]
            if running:
                still.append({"file": file_name, "test": test, "cases_after": sum(int(new[key][0]) for key in running)})
        report["not_applied"] = still
    return report


def render_diff(report: Dict[str, Any], top: int) -> str:
    """The comparison as text."""
    before, after = report["before"], report["after"]
    lines = [
        "cases   %7d -> %7d (%+d)" % (before["cases"], after["cases"], after["cases"] - before["cases"]),
        "tests   %7d -> %7d (%+d)" % (before["tests"], after["tests"], after["tests"] - before["tests"]),
        "seconds %7.0f -> %7.0f (%+.0f; comparable only between runs on one machine with one setting)"
        % (before["seconds"], after["seconds"], after["seconds"] - before["seconds"]),
    ]
    names = sorted({row["name"] for side in ("before", "after") for row in report["levels"][side]})
    if len(names) > 1:
        lines.append("")
        lines.append("By level")
        for name in names:
            was = next((row for row in report["levels"]["before"] if row["name"] == name), {"cases": 0, "seconds": 0.0})
            now = next((row for row in report["levels"]["after"] if row["name"] == name), {"cases": 0, "seconds": 0.0})
            lines.append("  %-12s cases %7d -> %7d (%+d)   seconds %7.0f -> %7.0f" % (
                name, was["cases"], now["cases"], now["cases"] - was["cases"], was["seconds"], now["seconds"]))
    if report["joined"]:
        lines.append("")
        lines.append("What joined the suite costs, in the seconds of the run after")
        for row in report["joined"]:
            lines.append("  %-12s %+7d cases   %8.1f s" % (row["level"], row["cases"], row["seconds"]))
    for over in report.get("over_budget", []):
        lines.append("")
        lines.append("OVER BUDGET at the %s level: the tests this change adds cost %.1f s there, and the budget is %g s. The costliest:" % (
            over["level"], over["seconds"], over["budget"]))
        held = next(row for row in report["joined"] if row["level"] == over["level"])
        for row in held["tests"][:10]:
            lines.append("  %8.1f s  %4d cases  %s::%s" % (row["seconds"], row["cases"], row["file"], row["test"]))
    for title, key in (("Tests that left the suite", "removed"), ("Tests that lost cases", "shrunk"),
                       ("Tests that gained cases", "grown"), ("Tests that joined the suite", "added")):
        rows = report[key]
        if not rows:
            continue
        lines.append("")
        lines.append("%s: %d (%d cases)" % (title, len(rows), sum(abs(row["cases_before"] - row["cases_after"]) for row in rows)))
        for row in rows[:top]:
            lines.append("  %4d -> %-4d %s::%s" % (row["cases_before"], row["cases_after"], row["file"], row["test"]))
        if len(rows) > top:
            lines.append("  … and %d more (--json holds them all)" % (len(rows) - top))
    if "unaccounted" in report:
        lines.append("")
        if report["unaccounted"]:
            lines.append("NO VERDICT ACCOUNTS FOR %d tests that left the suite or lost cases:" % len(report["unaccounted"]))
            for row in report["unaccounted"]:
                lines.append("  %4d -> %-4d %s::%s" % (row["cases_before"], row["cases_after"], row["file"], row["test"]))
        else:
            lines.append("Every test that left the suite or lost cases has a verdict.")
        if report["not_applied"]:
            lines.append("")
            lines.append("A verdict deletes %d tests that still run:" % len(report["not_applied"]))
            for row in report["not_applied"]:
                lines.append("  %s::%s (%d cases)" % (row["file"], row["test"], row["cases_after"]))
    return "\n".join(lines) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    """Run one of the three commands and return its exit status."""
    parser = argparse.ArgumentParser(prog="pipeline-suite", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command")
    for name in ("census", "check", "diff"):
        sub = commands.add_parser(name)
        sub.add_argument("--root", help="the checkout the paths belong to (default: the current directory)")
        sub.add_argument("--json", action="store_true", help="print the result as JSON")
        if name == "census":
            sub.add_argument("reports", nargs="+", help="JUnit XML reports of one run")
            sub.add_argument("--top", type=int, default=25, help="rows per table (default 25)")
        elif name == "check":
            sub.add_argument("verdicts", help="the verdict file, a JSON array")
            sub.add_argument("--ready", action="store_true", help="also refuse a verdict whose proof is missing")
        else:
            sub.add_argument("--before", nargs="+", required=True, help="reports of the run before the change")
            sub.add_argument("--after", nargs="+", required=True, help="reports of the run after it")
            sub.add_argument("--verdicts", help="the verdict file that accounts for what left")
            sub.add_argument("--budget", action="append", metavar="LEVEL=SECONDS",
                             help="fail when the tests the change adds at a level cost more seconds than this (repeatable)")
            sub.add_argument("--top", type=int, default=40, help="rows per list (default 40)")
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_usage(sys.stderr)
        return 2
    try:
        root = Path(args.root) if args.root else Path.cwd()
        if not root.is_dir():
            raise Refused("not a directory: %s" % root)
        root = root.resolve()
        if args.command == "census":
            cases, has_files = load_cases(args.reports, root)
            if not cases:
                raise Refused("the reports hold no test case")
            report = census(cases, has_files)
            sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=1) + "\n" if args.json else render_census(report, args.top))
            return 0
        if args.command == "check":
            report = check(root, load_verdicts(Path(args.verdicts)), args.ready)
            sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=1) + "\n" if args.json else render_check(report))
            return 1 if report["problems"] else 0
        budgets = parse_budgets(args.budget)
        before, after = load_two_runs(args.before, args.after, root)
        verdicts = load_verdicts(Path(args.verdicts)) if args.verdicts else None
        report = diff(before, after, verdicts, budgets)
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=1) + "\n" if args.json else render_diff(report, args.top))
        return 1 if report.get("unaccounted") or report.get("not_applied") or report.get("over_budget") else 0
    except Refused as refused:
        sys.stderr.write("pipeline-suite: %s\n" % refused)
        return 2


if __name__ == "__main__":
    sys.exit(main())
