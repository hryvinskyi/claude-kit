#!/usr/bin/env python3
"""Scorer for test-judge/fixture-01 (acme-parcel), and the proof that its answer key is right.

    verify-01.py prove <fixture>
    verify-01.py verdicts <fixture> <verdicts.json>
    verify-01.py defence <defended.json>
    verify-01.py suite <fixture> <copy>

The key (`key-01.json` beside this file) says, for every test of the fixture, the verdict a judge
should reach. It is not an opinion: `mutants-01.json` holds one defect for each rule and boundary of
the product, and `prove` runs the fixture's suite against every one of them and checks that

- the suite is green and the build passes on the fixture as it is;
- every defect is caught by some test, except the ones marked `hole`, which the whole suite lets
  through — each is a rule a test claims and does not prove (`required` marks the one a seeded test
  hides; the other sits behind a test that is kept, and a judge that finds it is credited);
- every test the key deletes catches nothing that a test the key keeps does not also catch;
- every decoy — a test that looks removable and is not — catches a defect that no other kept test
  of its level or a cheaper one catches;
- of each group the key keeps one member of, the group catches a defect nothing else does;
- a change marked `refactor`, which breaks no rule, turns red only tests the key calls
  `implementation`;
- the defect marked `build_fails` fails the build, which is the gate the key names.

`verdicts` scores a judge's output against the key: seeded removals found, the verdict and the class
of each, decoys and other kept tests left alone, and what does not hold up mechanically.
`defence` scores a defender's output on the fixture's `brief/defend.json` against `defend-01.key.json`:
the unsound removals it stopped and the sound ones it agreed to. `suite` scores a copy of the fixture after
`/pipeline:tighten-tests` ran in it: the product untouched, the suite green, every defect the old
suite caught still caught, the holes closed, the decoys still there, the seeded tests gone.

Needs `node` on PATH. Exit status: 0 the check passed (for `verdicts`, `defence` and `suite`: the bar
in `expected-01.md`); 1 it did not; 2 unusable input.
"""
from __future__ import annotations

import hashlib
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
KEY = json.loads((HERE / "key-01.json").read_text(encoding="utf-8"))
MUTANTS = json.loads((HERE / "mutants-01.json").read_text(encoding="utf-8"))
PRODUCT = ("src", "config", "vendor", "scripts", "package.json")
LEVELS = {"unit": 0, "integration": 1}
Test = Tuple[str, str]


def level_of(file: str) -> int:
    """How expensive a test's level is: unit before integration."""
    return LEVELS["integration"] if "/integration/" in "/" + file else LEVELS["unit"]


def run_suite(root: Path) -> Tuple[Set[Test], Set[Test], Set[Test]]:
    """Run the suite in a directory: the tests that passed, failed and were skipped, by file and name."""
    done = subprocess.run(
        ["node", "--test", "--test-reporter=junit", "tests/"], cwd=str(root), capture_output=True, text=True,
    )
    passed: Set[Test] = set()
    failed: Set[Test] = set()
    skipped: Set[Test] = set()
    try:
        tree = ElementTree.fromstring(done.stdout)
    except ElementTree.ParseError:
        raise SystemExit("verify-01: the suite printed no JUnit report in %s:\n%s" % (root, done.stderr[-2000:]))
    for case in tree.iter("testcase"):
        file = case.get("file") or ""
        marker = "/tests/"
        relative = "tests/" + file.split(marker, 1)[1] if marker in file else file
        name = case.get("name") or ""
        key = (relative, name)
        children = {child.tag for child in case}
        if "skipped" in children:
            skipped.add(key)
        elif children & {"failure", "error"}:
            failed.add(key)
        else:
            passed.add(key)
    return passed, failed, skipped


def build_passes(root: Path) -> bool:
    """Whether the project's build accepts the tree."""
    return subprocess.run(["node", "scripts/build.mjs"], cwd=str(root), capture_output=True).returncode == 0


def mutated_copy(source: Path, product: Path, mutant: Optional[Dict[str, Any]], scratch: Path) -> Path:
    """A copy holding the tests of one tree and the product of another, with one defect applied."""
    target = scratch / (mutant["id"] if mutant else "pristine")
    target.mkdir()
    shutil.copytree(source / "tests", target / "tests")
    for part in PRODUCT:
        if (product / part).is_dir():
            shutil.copytree(product / part, target / part)
        else:
            shutil.copy2(product / part, target / part)
    if mutant:
        path = target / mutant["file"]
        text = path.read_text(encoding="utf-8")
        if text.count(mutant["find"]) != 1:
            raise SystemExit("verify-01: mutant %s does not apply exactly once to %s" % (mutant["id"], mutant["file"]))
        path.write_text(text.replace(mutant["find"], mutant["replace"]), encoding="utf-8")
    return target


def kill_matrix(tests_from: Path, product_from: Path) -> Dict[str, Any]:
    """Which tests fail for each defect, the tests of one tree run against the product of another."""
    with tempfile.TemporaryDirectory() as scratch_name:
        scratch = Path(scratch_name)
        pristine = mutated_copy(tests_from, product_from, None, scratch)
        passed, failed, skipped = run_suite(pristine)
        build_ok = build_passes(pristine)

        def one(mutant: Dict[str, Any]) -> Tuple[str, Set[Test], bool]:
            copy = mutated_copy(tests_from, product_from, mutant, scratch)
            _passed, broken, _skipped = run_suite(copy)
            return mutant["id"], broken, build_passes(copy)

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(one, MUTANTS))
    return {
        "passed": passed, "failed": failed, "skipped": skipped, "build_ok": build_ok,
        "kills": {mutant_id: broken for mutant_id, broken, _build in results},
        "build": {mutant_id: build for mutant_id, _broken, build in results},
    }


def key_entry(test: Test) -> Dict[str, Any]:
    """What the key says of a test; a test it does not list is kept."""
    for entry in KEY["tests"]:
        if (entry["file"], entry["test"]) == test:
            return entry
    return {"file": test[0], "test": test[1], "verdict": ["keep"], "class": ["none"]}


def kept_by_key(test: Test) -> bool:
    """Whether the key keeps a test as it is."""
    entry = key_entry(test)
    return entry["verdict"][0] == "keep" and not entry.get("group")


def prove(fixture: Path) -> int:
    """Check the key against the mutants; print each claim and whether it holds."""
    matrix = kill_matrix(fixture, fixture)
    every = matrix["passed"] | matrix["failed"] | matrix["skipped"]
    kills: Dict[str, Set[Test]] = matrix["kills"]
    by_id = {mutant["id"]: mutant for mutant in MUTANTS}
    rule_mutants = [m["id"] for m in MUTANTS if not m.get("refactor")]
    problems: List[str] = []

    def claim(ok: bool, text: str) -> None:
        print(("ok    " if ok else "WRONG ") + text)
        if not ok:
            problems.append(text)

    claim(not matrix["failed"] and matrix["build_ok"], "the fixture's suite is green and its build passes (%d tests, %d skipped)" % (len(every), len(matrix["skipped"])))
    listed = {(entry["file"], entry["test"]) for entry in KEY["tests"]} | {(d["file"], d["test"]) for d in KEY["decoys"]}
    claim(listed <= every, "every test the key names exists in the fixture" + ("" if listed <= every else ": %s" % sorted(listed - every)))

    for mutant_id in rule_mutants:
        mutant = by_id[mutant_id]
        if mutant.get("hole"):
            claim(not kills[mutant_id], "hole — no test catches: %s" % mutant["breaks"])
        else:
            claim(bool(kills[mutant_id]), "caught — %s" % mutant["breaks"])
        if mutant.get("build_fails"):
            claim(not matrix["build"][mutant_id], "the build fails for: %s" % mutant["breaks"])

    kept = {test for test in every if kept_by_key(test)}
    for entry in KEY["tests"]:
        test = (entry["file"], entry["test"])
        if entry.get("group") or entry["verdict"][0] != "delete":
            continue
        own = [m for m in rule_mutants if test in kills[m]]
        orphaned = [m for m in own if not (kills[m] & (kept - {test}))]
        claim(not orphaned, "delete — %s catches nothing a kept test does not" % entry["test"] + ("" if not orphaned else " (only it catches %s)" % orphaned))
        if "implementation" in entry["class"]:
            refactors = [m["id"] for m in MUTANTS if m.get("refactor") and test in kills[m["id"]]]
            claim(bool(refactors), "implementation — %s fails on a change that breaks no rule" % entry["test"])
    for mutant in MUTANTS:
        if mutant.get("refactor"):
            innocent = [t for t in kills[mutant["id"]] if "implementation" not in key_entry(t)["class"]]
            claim(not innocent, "a change that breaks no rule turns red only tests the key calls implementation")

    for decoy in KEY["decoys"]:
        test = (decoy["file"], decoy["test"])
        rivals = {other for other in kept if other != test and level_of(other[0]) <= level_of(test[0])}
        unique = [m for m in rule_mutants if test in kills[m] and not (kills[m] & rivals)]
        claim(bool(unique), "decoy — only %s catches, at its level or below: %s" % (decoy["test"], [by_id[m]["breaks"] for m in unique][:2]))

    for name, group in KEY["groups"].items():
        members = {(entry["file"], entry["test"]) for entry in KEY["tests"] if entry.get("group") == name}
        unique = [m for m in rule_mutants if kills[m] and kills[m] <= members]
        claim(bool(unique), "group %s — only its members catch: %s" % (name, [by_id[m]["breaks"] for m in unique][:2]))
        claim(len(members) == group["members"], "group %s has %d members" % (name, group["members"]))

    print("\n%d claims wrong" % len(problems) if problems else "\nthe key holds")
    return 1 if problems else 0


def load_array(path: str) -> List[Dict[str, Any]]:
    """A JSON array of objects from a file."""
    try:
        held = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit("verify-01: %s is not readable JSON: %s" % (path, error))
    if not isinstance(held, list):
        raise SystemExit("verify-01: %s is not a JSON array" % path)
    return [entry for entry in held if isinstance(entry, dict)]


def score_verdicts(fixture: Path, path: str) -> int:
    """Score a judge's verdicts against the key."""
    given = {(entry.get("file"), entry.get("test")): entry for entry in load_array(path)}
    passed, failed, skipped = run_suite(fixture)
    every = sorted(passed | failed | skipped)
    missing = [test for test in every if test not in given]
    seeded = [entry for entry in KEY["tests"] if not entry.get("group")]
    found, exact, class_ok, missed = [], [], [], []
    for entry in seeded:
        answer = given.get((entry["file"], entry["test"]))
        verdict = answer.get("verdict") if answer else None
        if verdict in (None, "keep", "unsure"):
            missed.append("%s (%s)" % (entry["test"], verdict or "no entry"))
            continue
        found.append(entry["test"])
        if verdict in entry["verdict"]:
            exact.append(entry["test"])
        if answer.get("class") in entry["class"]:
            class_ok.append(entry["test"])
    group_lines = []
    groups_right = 0
    second_hole = False
    for name, group in KEY["groups"].items():
        members = [entry for entry in KEY["tests"] if entry.get("group") == name]
        verdicts = [(given.get((m["file"], m["test"])) or {}).get("verdict") for m in members]
        ok = sorted(str(v) for v in verdicts) in [sorted(accepted) for accepted in group["accept"]]
        groups_right += 1 if ok else 0
        if group.get("hole_found_by") in verdicts:
            second_hole = True
        group_lines.append("  %s: %s — %s (%s)" % (name, "right" if ok else "WRONG", group["rule"], ", ".join(str(v) for v in verdicts)))
    decoys = {(d["file"], d["test"]) for d in KEY["decoys"]}
    tripped = [test[1] for test in decoys if (given.get(test) or {}).get("verdict") not in ("keep", None)]
    other_keeps = [test for test in every if kept_by_key(test) and test not in decoys]
    wrongly = ["%s (%s)" % (test[1], given[test].get("verdict")) for test in other_keeps if test in given and given[test].get("verdict") not in ("keep", "unsure")]
    holes = [entry for entry in seeded if entry["verdict"][0] == "rewrite"]
    holes_right = [e["test"] for e in holes if (given.get((e["file"], e["test"])) or {}).get("verdict") == "rewrite"]
    holes_deleted = [e["test"] for e in holes if (given.get((e["file"], e["test"])) or {}).get("verdict") == "delete"]
    print("seeded removals found: %d/%d (exact verdict %d, class %d)" % (len(found), len(seeded), len(exact), len(class_ok)))
    for name in missed:
        print("  missed: %s" % name)
    for test in sorted(set(found) - set(exact)):
        print("  found with another verdict: %s" % test)
    print("groups right: %d/%d" % (groups_right, len(KEY["groups"])))
    print("\n".join(group_lines))
    print("the seeded hole: %d/%d given rewrite; deleted instead: %d %s" % (len(holes_right), len(holes), len(holes_deleted), holes_deleted))
    print("the hole behind a kept test (a refused booking is stored): %s" % ("found" if second_hole else "not found"))
    print("decoys left alone: %d/%d" % (len(decoys) - len(tripped), len(decoys)))
    for name in sorted(tripped):
        print("  tripped: %s" % name)
    print("other kept tests removed or changed: %d" % len(wrongly))
    for name in sorted(wrongly):
        print("  %s" % name)
    print("tests with no entry: %d" % len(missing))
    bar = KEY["bar"]["verdicts"]
    ok = (
        len(found) >= bar["found"] and len(tripped) <= bar["decoys_tripped"] and not holes_deleted
        and groups_right >= bar["groups"] and len(wrongly) <= bar["other_keeps_removed"]
    )
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


def score_defence(path: str) -> int:
    """Score a defender's answers on the fixture's brief/defend.json."""
    given = {(entry.get("file"), entry.get("test")): entry for entry in load_array(path)}
    expected = json.loads((HERE / "defend-01.key.json").read_text(encoding="utf-8"))
    sound, overturned = [], []
    units: Dict[str, List[str]] = {}
    stopped: Set[str] = set()
    for entry in expected:
        answer = (given.get((entry["file"], entry["test"])) or {}).get("answer")
        if entry["answer"] == "agreed":
            (sound if answer == "agreed" else overturned).append("%s (%s)" % (entry["test"], answer))
            continue
        units.setdefault(entry["unit"], []).append("%s (%s)" % (entry["test"], answer))
        if answer in entry["accept"]:
            stopped.add(entry["unit"])
    right_total = len([entry for entry in expected if entry["answer"] == "agreed"])
    print("unsound removals stopped: %d/%d" % (len(stopped), len(units)))
    for unit, answers in sorted(units.items()):
        if unit not in stopped:
            print("  let through: %s" % "; ".join(answers))
    print("sound removals agreed: %d/%d" % (len(sound), right_total))
    for name in overturned:
        print("  overturned: %s" % name)
    bar = KEY["bar"]["defence"]
    ok = len(stopped) >= bar["stopped"] and len(sound) >= bar["agreed"]
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


def digest(root: Path) -> Dict[str, str]:
    """The hash of every file of the product."""
    held = {}
    for part in PRODUCT:
        base = root / part
        files = sorted(p for p in base.rglob("*") if p.is_file()) if base.is_dir() else [base]
        for path in files:
            held[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
    return held


def score_suite(fixture: Path, copy: Path) -> int:
    """Score a copy of the fixture after its suite was tightened."""
    problems: List[str] = []

    def claim(ok: bool, text: str) -> None:
        print(("ok    " if ok else "WRONG ") + text)
        if not ok:
            problems.append(text)

    before, after = digest(fixture), digest(copy)
    changed = sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path))
    claim(not changed, "the product is byte for byte what it was" + ("" if not changed else ": %s" % changed))
    old = kill_matrix(fixture, fixture)
    new = kill_matrix(copy, fixture)
    claim(not new["failed"] and new["build_ok"], "the tightened suite is green and the build passes")
    by_id = {mutant["id"]: mutant for mutant in MUTANTS}
    lost = [m for m in old["kills"] if not by_id[m].get("refactor") and old["kills"][m] and not new["kills"][m]]
    claim(not lost, "every defect the old suite caught, the new one catches" + ("" if not lost else ": lost %s" % [by_id[m]["breaks"] for m in lost]))
    holes = [m["id"] for m in MUTANTS if m.get("hole")]
    owed = [m["id"] for m in MUTANTS if m.get("hole") and m.get("required")]
    closed = [m for m in holes if new["kills"][m]]
    claim(all(m in closed for m in owed), "the seeded hole is closed: %s" % [by_id[m]["breaks"] for m in owed])
    print("holes closed in all: %d/%d %s" % (len(closed), len(holes), [by_id[m]["breaks"] for m in holes if m not in closed]))
    refactor_red = [m["id"] for m in MUTANTS if m.get("refactor") and new["kills"][m["id"]]]
    claim(not refactor_red, "no test fails on a change that breaks no rule")
    names_after = {name for _file, name in new["passed"] | new["failed"] | new["skipped"]}
    decoys_gone = [d["test"] for d in KEY["decoys"] if d["test"] not in names_after]
    claim(not decoys_gone, "every decoy is still in the suite" + ("" if not decoys_gone else ": gone %s" % decoys_gone))
    seeded = [entry for entry in KEY["tests"] if not entry.get("group") and entry["verdict"][0] == "delete"]
    still = [entry["test"] for entry in seeded if entry["test"] in names_after]
    print("seeded tests gone: %d/%d" % (len(seeded) - len(still), len(seeded)))
    for name in still:
        print("  still there: %s" % name)
    unit_catches_label = any(level_of(t[0]) == 0 for t in new["kills"]["returned-label-gone"])
    label_rows = [t for t in new["passed"] if t[0].startswith("tests/integration/") and "tracking page names the state" in t[1]]
    claim(unit_catches_label, "the label table is proven at the unit level")
    print("label rows still at the integration level: %d (one is the joining fact)" % len(label_rows))
    cases_before = len(old["passed"] | old["skipped"])
    cases_after = len(new["passed"] | new["skipped"])
    integration_before = len([t for t in old["passed"] if level_of(t[0]) == 1])
    integration_after = len([t for t in new["passed"] if level_of(t[0]) == 1])
    print("cases %d -> %d; integration cases %d -> %d" % (cases_before, cases_after, integration_before, integration_after))
    bar = KEY["bar"]["suite"]
    ok = not problems and (len(seeded) - len(still)) >= bar["seeded_gone"] and cases_after <= bar["cases_at_most"]
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


def main(argv: List[str]) -> int:
    """Run one of the four modes."""
    if len(argv) == 2 and argv[0] == "prove":
        return prove(Path(argv[1]).resolve())
    if len(argv) == 3 and argv[0] == "verdicts":
        return score_verdicts(Path(argv[1]).resolve(), argv[2])
    if len(argv) == 2 and argv[0] == "defence":
        return score_defence(argv[1])
    if len(argv) == 3 and argv[0] == "suite":
        return score_suite(Path(argv[1]).resolve(), Path(argv[2]).resolve())
    sys.stderr.write(__doc__.split("\n\n")[1] + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
