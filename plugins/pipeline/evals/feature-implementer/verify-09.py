#!/usr/bin/env python3
"""Scorer for feature-implementer/fixture-09 (acme-parcel, "tests that earn their place").

    verify-09.py prove
    verify-09.py score <copy>

The task adds an insured value to a quote. The project's law asks for a unit test and an integration
test, its suite already carries a table repeated through the route and a module's copy of a
suite-wide check, and the criteria read like a table. The fixture measures what the agent adds:

- E1  the product behaves as the criteria say (`reference-09/behaviour.test.js`, run against the
      agent's product);
- E2  the agent's tests pin every criterion: they pass against the reference product
      (`reference-09/src` over the fixture), and every required change in `mutants-09.json` turns
      one of them red;
- E3  the tests earn their place. A case the agent added is *surplus* when it can be taken out and
      every change still turns a remaining case red — at any level for an integration case, at the
      unit level for a unit case. Surplus is counted from the most expensive case down;
- E4  scope: only the files the task names changed.

`prove` checks the scorer itself: the fixture with the reference product and the reference tests
(`reference-09/tests`) scores E1 to E4 with no surplus case, and every required change is caught.

Needs `node` on PATH. Exit status: 0 PASS, 1 FAIL, 2 unusable input.
"""
from __future__ import annotations

import filecmp
import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from xml.etree import ElementTree

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixture-09"
REFERENCE = HERE / "reference-09"
MUTANTS = json.loads((HERE / "mutants-09.json").read_text(encoding="utf-8"))
PRODUCT = ("src", "config", "vendor", "scripts", "package.json")
MAY_CHANGE = {
    "src/quote.js", "src/messages/en.js", "src/messages/de.js",
    "tests/unit/quote.test.js", "tests/integration/quotes.test.js",
}
SURPLUS_AT_MOST = {"integration": 0, "unit": 3}
Case = Tuple[str, str]


def level_of(case: Case) -> int:
    """How expensive a case's level is: unit before integration."""
    return 1 if case[0].startswith("tests/integration/") else 0


def put(source: Path, target: Path, parts: Tuple[str, ...]) -> None:
    """Copy the named parts of one tree into another, over what is there."""
    for part in parts:
        if (source / part).is_dir():
            shutil.copytree(source / part, target / part, dirs_exist_ok=True)
        elif (source / part).exists():
            shutil.copy2(source / part, target / part)


def run(root: Path, where: str) -> Tuple[Set[Case], Set[Case]]:
    """Run the tests under a directory of a tree: the cases that passed and the ones that failed."""
    done = subprocess.run(
        ["node", "--test", "--test-reporter=junit", where], cwd=str(root), capture_output=True, text=True,
    )
    passed: Set[Case] = set()
    failed: Set[Case] = set()
    try:
        tree = ElementTree.fromstring(done.stdout)
    except ElementTree.ParseError:
        raise SystemExit("verify-09: no JUnit report from %s in %s:\n%s" % (where, root, done.stderr[-1500:]))
    for case in tree.iter("testcase"):
        file = case.get("file") or ""
        relative = file[len(str(root.resolve())) + 1:] if file.startswith(str(root.resolve())) else file
        key = (relative, case.get("name") or "")
        if {child.tag for child in case} & {"failure", "error"}:
            failed.add(key)
        elif "skipped" not in {child.tag for child in case}:
            passed.add(key)
    return passed, failed


def reference_tree(scratch: Path, name: str, tests_from: Path, mutant: Optional[Dict[str, Any]]) -> Path:
    """The reference product under somebody's tests, with one change applied."""
    target = scratch / name
    target.mkdir()
    put(FIXTURE, target, PRODUCT)
    put(REFERENCE, target, ("src",))
    shutil.copytree(tests_from / "tests", target / "tests")
    if mutant:
        path = target / mutant["file"]
        text = path.read_text(encoding="utf-8")
        if text.count(mutant["find"]) != 1:
            raise SystemExit("verify-09: the change %s does not apply exactly once to %s" % (mutant["id"], mutant["file"]))
        path.write_text(text.replace(mutant["find"], mutant["replace"]), encoding="utf-8")
    return target


def changed_files(copy: Path) -> List[str]:
    """Every file that differs between the fixture and the copy, added and removed ones included."""
    out: List[str] = []

    def walk(compared: filecmp.dircmp, prefix: str) -> None:
        for name in compared.left_only + compared.right_only + compared.diff_files + compared.funny_files:
            out.append(prefix + name)
        for name, sub in compared.subdirs.items():
            walk(sub, prefix + name + "/")

    walk(filecmp.dircmp(str(FIXTURE), str(copy), ignore=["node_modules", ".git"]), "")
    return sorted(out)


def surplus_cases(new: Set[Case], every: Set[Case], kills: Dict[str, Set[Case]]) -> List[Case]:
    """The added cases that can go, most expensive first, with every change still caught."""
    caught_by = {case: {change for change, failed in kills.items() if case in failed} for case in every}
    remaining = set(every)
    out: List[Case] = []
    for case in sorted(new, key=lambda c: (-level_of(c), len(caught_by[c]), c)):
        others = remaining - {case}
        if all(any(change in caught_by[other] and level_of(other) <= level_of(case) for other in others) for change in caught_by[case]):
            out.append(case)
            remaining = others
    return out


def score(copy: Path) -> int:
    """Score a copy of the fixture after the agent worked in it."""
    problems: List[str] = []

    def claim(label: str, ok: bool, text: str) -> None:
        print("%s %s %s" % (label, "ok   " if ok else "FAIL ", text))
        if not ok:
            problems.append(label)

    changed = changed_files(copy)
    outside = [path for path in changed if path not in MAY_CHANGE and not (path.startswith(".claude/plans/insured-value/_red-") and path.endswith(".sha256"))]
    claim("E4", not outside, "only the files the task names changed" + ("" if not outside else ": also %s" % outside))

    with tempfile.TemporaryDirectory() as scratch_name:
        scratch = Path(scratch_name)
        own = scratch / "own"
        own.mkdir()
        put(copy, own, PRODUCT)
        (own / "key").mkdir()
        shutil.copy2(REFERENCE / "behaviour.test.js", own / "key" / "behaviour.test.js")
        passed, failed = run(own, "key/")
        claim("E1", bool(passed) and not failed, "the product behaves as the criteria say (%d of %d checks)" % (len(passed), len(passed) + len(failed))
              + ("" if not failed else ": not %s" % sorted(name for _file, name in failed)))

        base_passed, base_failed = run(reference_tree(scratch, "base", FIXTURE, None), "tests/")
        base = base_passed | base_failed
        pristine_passed, pristine_failed = run(reference_tree(scratch, "pristine", copy, None), "tests/")
        every = pristine_passed | pristine_failed
        claim("E2", not pristine_failed, "the agent's tests pass against the reference product"
              + ("" if not pristine_failed else ": red there %s" % sorted(pristine_failed)))

        def one(mutant: Dict[str, Any]) -> Tuple[str, Set[Case]]:
            _passed, broken = run(reference_tree(scratch, mutant["id"], copy, mutant), "tests/")
            return mutant["id"], broken - pristine_failed

        with ThreadPoolExecutor(max_workers=6) as pool:
            kills = dict(pool.map(one, MUTANTS))

    by_id = {mutant["id"]: mutant for mutant in MUTANTS}
    required = [m["id"] for m in MUTANTS if m["required"]]
    escaped = [m for m in required if not kills[m]]
    claim("E2", not escaped, "every criterion is pinned: %d of %d required changes turn a test red" % (len(required) - len(escaped), len(required))
          + ("" if not escaped else ": nothing fails for %s" % [by_id[m]["breaks"] for m in escaped]))
    optional = [m["id"] for m in MUTANTS if not m["required"]]
    print("   also caught, beyond the criteria: %d of %d %s" % (
        len([m for m in optional if kills[m]]), len(optional), [by_id[m]["breaks"] for m in optional if not kills[m]]))

    new = every - base
    gone = base - every
    surplus = surplus_cases(new, every, kills)
    idle = [case for case in new if not any(case in failed for failed in kills.values())]
    counts = {"integration": len([c for c in new if level_of(c) == 1]), "unit": len([c for c in new if level_of(c) == 0])}
    over = {"integration": [c for c in surplus if level_of(c) == 1], "unit": [c for c in surplus if level_of(c) == 0]}
    print("   added: %d unit cases, %d integration cases; cases of the suite that are gone: %d" % (counts["unit"], counts["integration"], len(gone)))
    for name in ("integration", "unit"):
        claim("E3", len(over[name]) <= SURPLUS_AT_MOST[name], "surplus %s cases: %d (at most %d)" % (name, len(over[name]), SURPLUS_AT_MOST[name]))
        for _file, test in over[name]:
            print("        - %s%s" % (test, "  (catches no change at all)" if (_file, test) in idle else ""))
    print("\nPASS" if not problems else "\nFAIL (%s)" % ", ".join(sorted(set(problems))))
    return 1 if problems else 0


def prove() -> int:
    """Score the fixture with the reference product and the reference tests: nothing may be surplus."""
    with tempfile.TemporaryDirectory() as scratch_name:
        copy = Path(scratch_name) / "copy"
        shutil.copytree(FIXTURE, copy)
        put(REFERENCE, copy, ("src", "tests"))
        return score(copy)


def main(argv: List[str]) -> int:
    """Run one of the two modes."""
    if argv == ["prove"]:
        return prove()
    if len(argv) == 2 and argv[0] == "score" and Path(argv[1]).is_dir():
        return score(Path(argv[1]).resolve())
    sys.stderr.write(__doc__.split("\n\n")[1] + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
