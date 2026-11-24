#!/usr/bin/env python3
"""Tests for bin/suite.py, run as the pipeline runs it: the script as a subprocess, on JUnit reports and
verdict files written into a scratch checkout.

What is pinned: the census counting cases, tests and files and summing seconds over reports of one
run; a parameterised test read as one test with its rows in PHPUnit's, pytest's and Go's spelling,
and a name that only looks like one left whole; the machine's part of a reported path stripped by
finding the suffix that exists under the root, and, when nothing exists there, by the directory the
paths share, cut so that the test directory stays in the path;
levels and areas read from the path, for a package's tests and for a project with one test root; two
runs named alike when they ran on two machines and a file of the first is gone from the checkout; a
report that names no file grouped by class and said so; where the seconds concentrate; a report that
is not XML, is not JUnit, declares a DTD or holds no case refused with exit 2 and nothing on standard
output; the check passing a set of verdicts that carry what they owe and counting them, and naming
each thing an entry owes and lacks — an unknown verdict or class, a kept test with a class, no
evidence, a cited file that is missing or outside the checkout, a line past the end, a quote that is
not at its line (and one that is a line off accepted), a test that is not in its file (a name a
template literal builds in a loop counted as there), a duplicate
with no survivor, a cheap test that leaves on the word of expensive ones only, a survivor with no
name or not in its file, a test that survives itself unless it is
trimmed, a survivor the same batch removes, a missing gate, mutation, action or way to settle, a test
judged twice; `--ready` refusing a missing proof, a reading where a run is owed and a log that is
missing or empty; the comparison listing what left, shrank, grew and joined, exiting 1 for a test no
verdict accounts for and for a deletion that still runs, a whole file accounted for by `*`; what
joined the suite counted in cases and seconds at each level, a new row at its test's own average,
a level over its budget failing the comparison with its costliest new tests named, a level at its
budget passing, and a budget that is not `level=seconds` refused; and the wrapper beside the script
running it.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BIN = Path(__file__).resolve().parent.parent / "bin"
SCRIPT = BIN / "suite.py"
WRAPPER = BIN / "pipeline-suite"


def case(name: str, file: Optional[str] = None, seconds: float = 0.0, classname: Optional[str] = None, child: str = "") -> str:
    """One <testcase> element."""
    attrs = ['name="%s"' % name.replace('"', "&quot;")]
    if file:
        attrs.append('file="%s"' % file)
    if classname:
        attrs.append('classname="%s"' % classname)
    attrs.append('time="%s"' % seconds)
    return "<testcase %s>%s</testcase>" % (" ".join(attrs), child)


def junit(*cases: str) -> str:
    """A JUnit report holding the cases, nested the way PHPUnit nests them."""
    return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name=""><testsuite name="inner">%s</testsuite></testsuite></testsuites>\n' % "".join(cases)


class SuiteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve() / "repo"
        self.root.mkdir()

    def write(self, relative: str, text: str) -> Path:
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target

    def run_script(self, *args: str, program: Optional[Path] = None) -> Tuple[int, str, str]:
        command = [str(program)] if program else [sys.executable, str(SCRIPT)]
        done = subprocess.run(command + list(args), cwd=str(self.root), capture_output=True, text=True)
        return done.returncode, done.stdout, done.stderr

    def census(self, *reports: str, root: bool = True) -> Dict[str, Any]:
        args = ["census", *reports, "--json"] + (["--root", str(self.root)] if root else [])
        code, out, err = self.run_script(*args)
        self.assertEqual(0, code, err)
        return json.loads(out)

    def refused(self, *args: str) -> str:
        code, out, err = self.run_script(*args)
        self.assertEqual(2, code, out + err)
        self.assertEqual("", out)
        self.assertTrue(err.startswith("pipeline-suite: "), err)
        return err

    # -- census ---------------------------------------------------------------------------------

    def test_the_census_counts_cases_tests_files_and_seconds(self) -> None:
        report = self.write("r.xml", junit(
            case("testA", "/ci/app/tests/Unit/FeeTest.php", 0.5),
            case('testB with data set "one"', "/ci/app/tests/Unit/FeeTest.php", 0.25),
            case('testB with data set "two"', "/ci/app/tests/Unit/FeeTest.php", 0.25),
            case("testC", "/ci/app/tests/Integration/RouteTest.php", 3.0),
        ))
        held = self.census(str(report))
        self.assertEqual((4, 3, 2, 4.0), (held["cases"], held["tests"], held["files"], held["seconds"]))
        self.assertEqual("tests/Integration/RouteTest.php", held["by_file"][0]["name"])
        self.assertEqual({"file": "tests/Unit/FeeTest.php", "test": "testB", "cases": 2, "seconds": 0.5}, held["by_test"][1])

    def test_several_reports_of_one_run_are_summed(self) -> None:
        first = self.write("a.xml", junit(case("testA", "/ci/app/tests/Unit/ATest.php", 1.0)))
        second = self.write("b.xml", junit(case("testB", "/ci/app/tests/Unit/BTest.php", 2.0)))
        held = self.census(str(first), str(second))
        self.assertEqual((2, 3.0), (held["cases"], held["seconds"]))

    def test_a_parameterised_test_is_one_test_in_each_runners_spelling(self) -> None:
        report = self.write("r.xml", junit(
            case('testFee with data set "late"', "/x/tests/FeeTest.php"),
            case("testFee with data set #1", "/x/tests/FeeTest.php"),
            case("test_fee[late]", "/x/tests/test_fee.py"),
            case("test_fee[early-2]", "/x/tests/test_fee.py"),
            case("TestFee/late", "/x/fee_test.go"),
            case("TestFee/early", "/x/fee_test.go"),
        ))
        held = self.census(str(report))
        self.assertEqual(3, held["tests"])
        self.assertEqual({"tests": 3, "cases": 6}, {key: held["parameterised"][key] for key in ("tests", "cases")})

    def test_a_name_that_only_looks_parameterised_stays_whole(self) -> None:
        report = self.write("r.xml", junit(
            case("answers GET /api/fees with the list", "/x/tests/fees.test.js"),
            case("answers GET /api/fees/1 with one fee", "/x/tests/fees.test.js"),
        ))
        held = self.census(str(report))
        self.assertEqual(2, held["tests"])
        self.assertEqual(0, held["parameterised"]["tests"])

    def test_the_machines_part_of_a_path_is_stripped_by_what_exists_under_the_root(self) -> None:
        self.write("packages/billing/tests/Unit/FeeTest.php", "<?php\n")
        report = self.write("r.xml", junit(
            case("testA", "/__w/app/app/packages/billing/tests/Unit/FeeTest.php", 1.0),
            case("testB", "/__w/app/app/packages/billing/tests/Unit/GoneTest.php", 1.0),
        ))
        held = self.census(str(report))
        self.assertEqual(
            ["packages/billing/tests/Unit/FeeTest.php", "packages/billing/tests/Unit/GoneTest.php"],
            sorted(row["name"] for row in held["by_file"]),
        )

    def test_with_nothing_under_the_root_the_shared_directory_goes_and_the_test_directory_stays(self) -> None:
        report = self.write("r.xml", junit(
            case("testA", "/var/www/html/tests/Unit/ATest.php"),
            case("testB", "/var/www/html/tests/Unit/Sub/BTest.php"),
        ))
        held = self.census(str(report))
        self.assertEqual(["tests/Unit/ATest.php", "tests/Unit/Sub/BTest.php"], sorted(row["name"] for row in held["by_file"]))
        self.assertEqual("unit", held["levels"][0]["name"])
        plain = self.write("p.xml", junit(case("a", "/srv/app/lib/a_test.go"), case("b", "/srv/app/lib/deep/b_test.go")))
        self.assertEqual(["a_test.go", "deep/b_test.go"], sorted(row["name"] for row in self.census(str(plain))["by_file"]))

    def test_levels_and_areas_are_read_from_the_path(self) -> None:
        for path in ("packages/billing/tests/Unit/FeeTest.php", "packages/crm/tests/Integration/Http/ListTest.php",
                     "tests/Integration/Tenancy/PurgeTest.php", "tests/e2e/checkout.spec.ts", "src/fee.test.js"):
            self.write(path, "")
        report = self.write("r.xml", junit(
            case("a", "/ci/packages/billing/tests/Unit/FeeTest.php", 1.0),
            case("b", "/ci/packages/crm/tests/Integration/Http/ListTest.php", 2.0),
            case("c", "/ci/tests/Integration/Tenancy/PurgeTest.php", 4.0),
            case("d", "/ci/tests/e2e/checkout.spec.ts", 8.0),
            case("e", "/ci/src/fee.test.js", 16.0),
        ))
        held = self.census(str(report))
        self.assertEqual(
            {"other": 16.0, "e2e": 8.0, "integration": 6.0, "unit": 1.0},
            {row["name"]: row["seconds"] for row in held["levels"]},
        )
        self.assertEqual(
            {"src": 16.0, ".": 8.0, "Tenancy": 4.0, "packages/crm": 2.0, "packages/billing": 1.0},
            {row["name"]: row["seconds"] for row in held["areas"]},
        )

    def test_a_report_that_names_no_file_is_grouped_by_class_and_says_so(self) -> None:
        report = self.write("r.xml", junit(
            case("test_fee[late]", classname="tests.unit.test_fee.TestFee", seconds=1.0),
            case("test_fee[early]", classname="tests.unit.test_fee.TestFee", seconds=1.0),
        ))
        held = self.census(str(report))
        self.assertFalse(held["groups_are_files"])
        self.assertEqual("tests.unit.test_fee.TestFee", held["by_file"][0]["name"])
        self.assertEqual("unit", held["levels"][0]["name"])
        code, out, _err = self.run_script("census", str(report))
        self.assertEqual(0, code)
        self.assertIn("the report names no files", out)

    def test_the_census_says_where_the_seconds_concentrate(self) -> None:
        cases = [case("slow", "/x/tests/SlowTest.php", 90.0)] + [case("fast%d" % at, "/x/tests/FastTest.php", 1.0) for at in range(10)]
        held = self.census(str(self.write("r.xml", junit(*cases))))
        self.assertEqual({"share_of_seconds": 0.25, "cases": 1, "share_of_cases": 0.0909}, held["concentration"][0])
        self.assertEqual({"at_least_seconds": 5.0, "cases": 1, "seconds": 90.0}, held["slow"][1])

    def test_the_text_census_names_its_columns_and_prints_the_costliest_first(self) -> None:
        report = self.write("r.xml", junit(
            case("cheap", "/x/tests/Unit/CheapTest.php", 0.001),
            case("dear", "/x/tests/Integration/DearTest.php", 9.0),
        ))
        code, out, _err = self.run_script("census", str(report), "--top", "1")
        self.assertEqual(0, code)
        self.assertIn("2 cases in 2 tests and 2 files", out)
        self.assertIn("cases   share    seconds   share   ms/case", out)
        files = out.split("Costliest files")[1].split("Costliest tests")[0]
        self.assertIn("DearTest.php", files)
        self.assertNotIn("CheapTest.php", files)

    def test_a_report_that_cannot_be_a_junit_report_is_refused(self) -> None:
        self.assertIn("no such report", self.refused("census", "absent.xml"))
        self.assertIn("not well-formed XML", self.refused("census", str(self.write("a.xml", "<testsuites><testcase"))))
        self.assertIn("not a JUnit report", self.refused("census", str(self.write("b.xml", "<html><testcase name='x'/></html>"))))
        self.assertIn("holds neither", self.refused("census", str(self.write(
            "c.xml", '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY a "b">]><testsuites><testcase name="&a;"/></testsuites>'))))
        self.assertIn("hold no test case", self.refused("census", str(self.write("d.xml", "<testsuites></testsuites>"))))

    # -- check ----------------------------------------------------------------------------------

    def seed(self) -> None:
        self.write("src/fee.js", "export function fee(days) {\n  if (days > 0) {\n    return days * 2;\n  }\n  return 0;\n}\n")
        self.write("tests/fee.test.js", "test('charges nothing on the due date', () => {});\ntest('is free until the due date has passed', () => {});\ntest('holds what it was given', () => {});\n")

    def verdicts(self, *entries: Dict[str, Any]) -> str:
        return str(self.write("verdicts.json", json.dumps(list(entries))))

    def duplicate(self, **changes: Any) -> Dict[str, Any]:
        entry: Dict[str, Any] = {
            "file": "tests/fee.test.js", "test": "charges nothing on the due date", "verdict": "delete",
            "class": "duplicate", "rule": "No fee is charged until the due date has passed.",
            "evidence": [{"path": "src/fee.js", "line": 2, "quote": "if (days > 0) {"}],
            "survivors": [{"path": "tests/fee.test.js", "line": 2, "test": "is free until the due date has passed"}],
            "mutation": "src/fee.js:2 — compare with >= in place of >", "cases": 1,
        }
        entry.update(changes)
        return {key: value for key, value in entry.items() if value is not None}

    def problems(self, *entries: Dict[str, Any], ready: bool = False) -> List[str]:
        args = ["check", self.verdicts(*entries), "--json"] + (["--ready"] if ready else [])
        code, out, err = self.run_script(*args)
        report = json.loads(out)
        self.assertEqual(1 if report["problems"] else 0, code, err)
        return [text for problem in report["problems"] for text in problem["problems"]]

    def test_verdicts_that_carry_what_they_owe_pass_and_are_counted(self) -> None:
        self.seed()
        keep = {"file": "tests/fee.test.js", "test": "is free until the due date has passed", "verdict": "keep", "class": "none"}
        restates = {
            "file": "tests/fee.test.js", "test": "holds what it was given", "verdict": "delete", "class": "restates",
            "rule": "none", "evidence": [{"path": "src/fee.js", "line": 5, "quote": "return 0;"}], "cases": 1,
        }
        code, out, err = self.run_script("check", self.verdicts(self.duplicate(), keep, restates), "--json")
        self.assertEqual(0, code, out + err)
        report = json.loads(out)
        self.assertEqual([], report["problems"])
        self.assertEqual({"delete": 2, "keep": 1}, report["by_verdict"])
        self.assertEqual({"duplicate": 1, "restates": 1}, report["by_class"])
        self.assertEqual(2, report["cases_leaving"])

    def test_a_verdict_or_class_nobody_defined_is_named(self) -> None:
        self.seed()
        self.assertEqual(["has a verdict nobody defined: remove"], self.problems(self.duplicate(verdict="remove")))
        self.assertEqual(["has a class nobody defined: redundant"], self.problems(self.duplicate(**{"class": "redundant"})))
        self.assertEqual(["has no verdict"], self.problems(self.duplicate(verdict=None)))

    def test_a_kept_test_has_no_class_and_a_removed_one_has(self) -> None:
        self.seed()
        self.assertEqual(
            ["keeps a test and gives it a class (duplicate): a kept test has class none"],
            self.problems(self.duplicate(verdict="keep")),
        )
        self.assertIn("deletes a test and names no class", self.problems(self.duplicate(**{"class": "none"})))

    def test_a_removal_quotes_its_evidence_from_the_checkout(self) -> None:
        self.seed()
        self.assertEqual(["quotes no evidence"], self.problems(self.duplicate(evidence=[])))
        self.assertEqual(
            ["evidence[0] cites src/gone.js, which does not exist"],
            self.problems(self.duplicate(evidence=[{"path": "src/gone.js", "line": 1}])),
        )
        self.assertEqual(
            ["evidence[0] cites ../outside.js, outside the checkout"],
            self.problems(self.duplicate(evidence=[{"path": "../outside.js", "line": 1}])),
        )
        self.assertEqual(
            ["evidence[0] cites src/fee.js:40, past the end of the file (6 lines)"],
            self.problems(self.duplicate(evidence=[{"path": "src/fee.js", "line": 40}])),
        )

    def test_a_quote_must_be_at_the_line_it_is_cited_at(self) -> None:
        self.seed()
        self.assertEqual(
            ["evidence[0] quotes a line that is not at src/fee.js:2"],
            self.problems(self.duplicate(evidence=[{"path": "src/fee.js", "line": 2, "quote": "return days * 3;"}])),
        )
        near = self.duplicate(evidence=[{"path": "src/fee.js", "line": 4, "quote": "  if (days   > 0) {"}])
        self.assertEqual([], self.problems(near))

    def test_the_judged_test_must_be_in_its_file(self) -> None:
        self.seed()
        self.assertEqual(
            ["names a test that is not in its file: charges double"],
            self.problems(self.duplicate(test="charges double")),
        )
        self.assertEqual(["file cites tests/none.test.js, which does not exist"], self.problems(self.duplicate(file="tests/none.test.js")))

    def test_a_name_built_by_a_template_in_a_loop_counts_as_in_its_file(self) -> None:
        self.seed()
        self.write("tests/rows.test.js", "for (const [kg, price] of rows) {\n  test(`a parcel of ${kg} kg costs ${price}`, () => {});\n}\n")
        row = {"file": "tests/rows.test.js", "test": "a parcel of 2 kg costs 6.5", "verdict": "keep", "class": "none"}
        self.assertEqual([], self.problems(row))
        self.assertEqual(
            ["names a test that is not in its file: a crate of 2 kg costs 6.5"],
            self.problems(dict(row, test="a crate of 2 kg costs 6.5")),
        )

    def test_a_duplicate_names_a_survivor_that_exists_and_is_another_test(self) -> None:
        self.seed()
        self.assertEqual(["names no surviving test (survivors) for the duplicate test it deletes"], self.problems(self.duplicate(survivors=[])))
        self.assertEqual(
            ["names survivors[0] with no test name"],
            self.problems(self.duplicate(survivors=[{"path": "tests/fee.test.js", "line": 2}])),
        )
        self.assertEqual(
            ["names a survivor that is not in its file: is always free"],
            self.problems(self.duplicate(survivors=[{"path": "tests/fee.test.js", "test": "is always free"}])),
        )
        own = [{"path": "tests/fee.test.js", "test": "charges nothing on the due date"}]
        self.assertEqual(
            ["names itself as its own survivor: only a trimmed test survives itself, in the rows it keeps"],
            self.problems(self.duplicate(survivors=own)),
        )
        self.assertEqual([], self.problems(self.duplicate(survivors=own, verdict="trim", action="drop the second row")))

    def test_a_cheap_test_never_leaves_on_the_word_of_expensive_ones_only(self) -> None:
        self.write("src/fee.js", "export function fee(days) {\n  if (days > 0) {\n    return days * 2;\n  }\n  return 0;\n}\n")
        self.write("tests/unit/fee.test.js", "test('charges nothing on the due date', () => {});\ntest('is free until the due date has passed', () => {});\n")
        self.write("tests/integration/fee.test.js", "test('the desk shows no fee on the due date', () => {});\n")
        unit = {"path": "tests/unit/fee.test.js", "test": "is free until the due date has passed"}
        dear = {"path": "tests/integration/fee.test.js", "test": "the desk shows no fee on the due date"}
        cheap = self.duplicate(file="tests/unit/fee.test.js", survivors=[dear])
        self.assertEqual(
            [
                "names only survivors at a costlier level than the duplicate it deletes: a test of a rule does not leave "
                "because a costlier test covers it (a joining rebuilt out of stand-ins is class level)"
            ],
            self.problems(cheap),
        )
        rebuilt = dict(cheap, **{"class": "level"})
        self.assertEqual([], self.problems(rebuilt))
        self.assertEqual([], self.problems(self.duplicate(file="tests/unit/fee.test.js", survivors=[dear, unit])))
        expensive = self.duplicate(file="tests/integration/fee.test.js", test="the desk shows no fee on the due date", survivors=[unit])
        self.assertEqual([], self.problems(expensive))

    def test_a_vacuous_test_of_a_real_rule_is_deleted_only_with_a_survivor(self) -> None:
        self.seed()
        self.assertEqual(
            ["names no surviving test (survivors) for the vacuous test it deletes"],
            self.problems(self.duplicate(**{"class": "vacuous"}, survivors=None)),
        )
        self.assertEqual([], self.problems(self.duplicate(**{"class": "vacuous"}, survivors=None, verdict="rewrite", action="post with a valid token")))

    def test_a_survivor_is_a_test_the_batch_leaves_as_it_is(self) -> None:
        self.seed()
        first = self.duplicate()
        second = self.duplicate(
            test="is free until the due date has passed",
            survivors=[{"path": "tests/fee.test.js", "test": "charges nothing on the due date"}],
        )
        self.assertEqual(
            [
                "names as a survivor a test this batch deletes: tests/fee.test.js::is free until the due date has passed",
                "names as a survivor a test this batch deletes: tests/fee.test.js::charges nothing on the due date",
            ],
            self.problems(first, second),
        )
        whole_file = {
            "file": "tests/fee.test.js", "test": "*", "verdict": "delete", "class": "dead", "rule": "none",
            "evidence": [{"path": "tests/fee.test.js", "line": 1}],
        }
        self.assertIn(
            "names as a survivor a test this batch deletes: tests/fee.test.js::is free until the due date has passed",
            self.problems(first, whole_file),
        )

    def test_each_class_names_what_its_proof_needs(self) -> None:
        self.seed()
        self.assertEqual(
            ["does not say what to break to see the proof fail (mutation)"],
            self.problems(self.duplicate(mutation="")),
        )
        self.assertEqual(
            ["does not name the gate that catches the defect (gate)"],
            self.problems(self.duplicate(**{"class": "gate"}, survivors=None, mutation=None)),
        )
        self.assertEqual(
            ["does not say what the move does (action)"],
            self.problems(self.duplicate(**{"class": "level"}, verdict="move")),
        )
        self.assertEqual(
            ["is unsure and does not say what would settle it (settle_by)"],
            self.problems(self.duplicate(verdict="unsure")),
        )
        self.assertEqual(["states no rule (write \"none\" when the test states none)"], self.problems(self.duplicate(rule="")))

    def test_a_test_judged_twice_is_named(self) -> None:
        self.seed()
        self.assertEqual(["is judged twice (entries 0 and 1)"], self.problems(self.duplicate(), self.duplicate()))

    def test_ready_refuses_a_removal_nobody_proved(self) -> None:
        self.seed()
        self.assertEqual(
            ["has no proof (proof.kind is one of run, gate, read, list)"],
            self.problems(self.duplicate(), ready=True),
        )
        self.assertEqual([], self.problems(self.duplicate()))
        read = self.duplicate(proof={"kind": "read", "result": "the defender agreed"})
        self.assertEqual(
            ["owes a run and has a proof by read: a duplicate is proven by seeing a test fail"],
            self.problems(read, ready=True),
        )
        self.assertEqual(
            ["has a proof by run and keeps no output of it (proof.logs)"],
            self.problems(self.duplicate(proof={"kind": "run", "result": "the survivor failed"}), ready=True),
        )
        self.write("logs/empty.log", "")
        missing = self.duplicate(proof={"kind": "run", "result": "the survivor failed", "logs": ["logs/none.log", "logs/empty.log"]})
        self.assertEqual(
            ["has a proof log that is missing or empty: logs/none.log", "has a proof log that is missing or empty: logs/empty.log"],
            self.problems(missing, ready=True),
        )

    def test_ready_accepts_each_class_with_the_proof_it_owes(self) -> None:
        self.seed()
        log = self.write("logs/red.log", "1 failed\n")
        ran = self.duplicate(proof={"kind": "run", "result": "the survivor failed", "logs": [str(log)]})
        restates = {
            "file": "tests/fee.test.js", "test": "holds what it was given", "verdict": "delete", "class": "restates",
            "rule": "none", "evidence": [{"path": "src/fee.js", "line": 5}],
            "proof": {"kind": "read", "result": "the defender found no defect only it catches"},
        }
        self.assertEqual([], self.problems(ran, restates, ready=True))
        self.assertEqual(
            ["has a proof that states no result"],
            self.problems(dict(restates, proof={"kind": "read"}), ready=True),
        )

    def test_a_verdict_file_that_is_not_an_array_is_refused(self) -> None:
        self.assertIn("is not a JSON array of verdicts", self.refused("check", str(self.write("v.json", "{}"))))
        self.assertIn("is not JSON", self.refused("check", str(self.write("w.json", "[{"))))
        self.assertIn("cannot be read", self.refused("check", "absent.json"))

    def test_the_text_check_lists_each_entry_that_does_not_hold_up(self) -> None:
        self.seed()
        code, out, _err = self.run_script("check", self.verdicts(self.duplicate(survivors=[]), self.duplicate(test="holds what it was given", verdict="keep", **{"class": "none"})))
        self.assertEqual(1, code)
        self.assertIn("2 verdicts; 1 do not hold up", out)
        self.assertIn("tests/fee.test.js::charges nothing on the due date (entry 0)", out)
        self.assertIn("  - names no surviving test (survivors) for the duplicate test it deletes", out)

    # -- diff -----------------------------------------------------------------------------------

    def runs(self) -> Tuple[str, str]:
        before = self.write("before.xml", junit(
            case("testKept", "/ci/tests/Unit/ATest.php", 1.0),
            case("testGone", "/ci/tests/Unit/ATest.php", 2.0),
            case('testRows with data set "a"', "/ci/tests/Unit/BTest.php", 1.0),
            case('testRows with data set "b"', "/ci/tests/Unit/BTest.php", 1.0),
            case('testRows with data set "c"', "/ci/tests/Unit/BTest.php", 1.0),
            case("testMoved", "/ci/tests/Integration/CTest.php", 5.0),
        ))
        after = self.write("after.xml", junit(
            case("testKept", "/ci/tests/Unit/ATest.php", 1.0),
            case('testRows with data set "a"', "/ci/tests/Unit/BTest.php", 1.0),
            case("testMoved", "/ci/tests/Unit/CTest.php", 0.1),
        ))
        return str(before), str(after)

    def test_the_comparison_lists_what_left_shrank_and_joined(self) -> None:
        before, after = self.runs()
        code, out, err = self.run_script("diff", "--before", before, "--after", after, "--json")
        self.assertEqual(0, code, err)
        report = json.loads(out)
        self.assertEqual({"cases": 6, "tests": 4, "seconds": 11.0}, report["before"])
        self.assertEqual({"cases": 3, "tests": 3, "seconds": 2.1}, report["after"])
        self.assertEqual(
            [("tests/Integration/CTest.php", "testMoved"), ("tests/Unit/ATest.php", "testGone")],
            [(row["file"], row["test"]) for row in report["removed"]],
        )
        self.assertEqual([("tests/Unit/BTest.php", "testRows", 3, 1)], [(r["file"], r["test"], r["cases_before"], r["cases_after"]) for r in report["shrunk"]])
        self.assertEqual([("tests/Unit/CTest.php", "testMoved")], [(row["file"], row["test"]) for row in report["added"]])
        self.assertNotIn("unaccounted", report)

    def growth(self) -> Tuple[str, str]:
        before = self.write("before.xml", junit(
            case("testKept", "/ci/tests/Unit/ATest.php", 0.01),
            case('testPages with data set "a"', "/ci/tests/Integration/PagesTest.php", 2.0),
        ))
        after = self.write("after.xml", junit(
            case("testKept", "/ci/tests/Unit/ATest.php", 0.01),
            case("testNewRule", "/ci/tests/Unit/ATest.php", 0.02),
            case('testPages with data set "a"', "/ci/tests/Integration/PagesTest.php", 2.0),
            case('testPages with data set "b"', "/ci/tests/Integration/PagesTest.php", 2.0),
            case('testPages with data set "c"', "/ci/tests/Integration/PagesTest.php", 2.0),
            case("testNewScreen", "/ci/tests/Integration/ScreenTest.php", 5.0),
        ))
        return str(before), str(after)

    def test_the_comparison_says_what_joined_costs_at_each_level(self) -> None:
        before, after = self.growth()
        code, out, err = self.run_script("diff", "--before", before, "--after", after, "--json")
        self.assertEqual(0, code, err)
        joined = {row["level"]: (row["cases"], row["seconds"]) for row in json.loads(out)["joined"]}
        self.assertEqual({"integration": (3, 9.0), "unit": (1, 0.02)}, joined)
        _code, text, _err = self.run_script("diff", "--before", before, "--after", after)
        self.assertIn("  integration  cases       1 ->       4 (+3)   seconds       2 ->      11", text)
        self.assertIn("  integration       +3 cases        9.0 s", text)

    def test_a_level_whose_new_tests_cost_more_than_its_budget_fails_the_comparison(self) -> None:
        before, after = self.growth()
        code, out, _err = self.run_script("diff", "--before", before, "--after", after, "--budget", "integration=8", "--budget", "unit=1")
        self.assertEqual(1, code)
        self.assertIn("OVER BUDGET at the integration level: the tests this change adds cost 9.0 s there, and the budget is 8 s. The costliest:", out)
        self.assertIn("       5.0 s     1 cases  tests/Integration/ScreenTest.php::testNewScreen", out)
        self.assertNotIn("OVER BUDGET at the unit level", out)
        code, out, _err = self.run_script("diff", "--before", before, "--after", after, "--budget", "integration=9")
        self.assertEqual(0, code, out)
        self.assertNotIn("OVER BUDGET", out)

    def test_a_budget_that_is_not_level_and_seconds_is_refused(self) -> None:
        before, after = self.growth()
        for text in ("integration", "integration=soon", "=3", "integration=-1"):
            code, out, err = self.run_script("diff", "--before", before, "--after", after, "--budget", text)
            self.assertEqual((2, ""), (code, out), text)
            self.assertIn("a budget is written level=seconds, as in integration=30: %s" % text, err)

    def test_two_runs_are_named_alike_when_a_file_of_the_first_is_gone_from_the_checkout(self) -> None:
        self.write("pkg/tests/Unit/StaysTest.php", "<?php\n")
        before = self.write("b.xml", junit(
            case("testStays", "/ci/w/pkg/tests/Unit/StaysTest.php", 1.0),
            case("testDeleted", "/ci/w/pkg/tests/Unit/DeletedTest.php", 1.0),
        ))
        after = self.write("a.xml", junit(case("testStays", "/var/www/html/pkg/tests/Unit/StaysTest.php", 1.0)))
        code, out, err = self.run_script("diff", "--before", str(before), "--after", str(after), "--json")
        self.assertEqual(0, code, err)
        report = json.loads(out)
        self.assertEqual([("pkg/tests/Unit/DeletedTest.php", "testDeleted")], [(row["file"], row["test"]) for row in report["removed"]])
        self.assertEqual([], report["added"])

    def test_a_test_no_verdict_accounts_for_fails_the_comparison(self) -> None:
        before, after = self.runs()
        verdicts = self.verdicts(
            {"file": "tests/Unit/ATest.php", "test": "testGone", "verdict": "delete", "class": "restates"},
            {"file": "tests/Unit/BTest.php", "test": "testRows", "verdict": "trim", "class": "duplicate"},
        )
        code, out, _err = self.run_script("diff", "--before", before, "--after", after, "--verdicts", verdicts, "--json")
        self.assertEqual(1, code)
        report = json.loads(out)
        self.assertEqual([("tests/Integration/CTest.php", "testMoved")], [(row["file"], row["test"]) for row in report["unaccounted"]])
        self.assertEqual([], report["not_applied"])
        code, out, _err = self.run_script("diff", "--before", before, "--after", after, "--verdicts", verdicts)
        self.assertEqual(1, code)
        self.assertIn("NO VERDICT ACCOUNTS FOR 1 tests", out)
        self.assertIn("tests/Integration/CTest.php::testMoved", out)

    def test_every_departure_accounted_for_passes_and_a_whole_file_is_one_entry(self) -> None:
        before, after = self.runs()
        verdicts = self.verdicts(
            {"file": "tests/Unit/ATest.php", "test": "testGone", "verdict": "delete", "class": "restates"},
            {"file": "tests/Unit/BTest.php", "test": "testRows", "verdict": "trim", "class": "duplicate"},
            {"file": "tests/Integration/CTest.php", "test": "*", "verdict": "move", "class": "level"},
            {"file": "tests/Unit/ATest.php", "test": "testKept", "verdict": "keep", "class": "none"},
        )
        code, out, err = self.run_script("diff", "--before", before, "--after", after, "--verdicts", verdicts)
        self.assertEqual(0, code, out + err)
        self.assertIn("Every test that left the suite or lost cases has a verdict.", out)
        self.assertIn("cases         6 ->       3 (-3)", out)

    def test_a_deletion_that_still_runs_fails_the_comparison(self) -> None:
        before, after = self.runs()
        verdicts = self.verdicts(
            {"file": "tests/Unit/ATest.php", "test": "testGone", "verdict": "delete", "class": "restates"},
            {"file": "tests/Unit/ATest.php", "test": "testKept", "verdict": "delete", "class": "restates"},
            {"file": "tests/Unit/BTest.php", "test": "*", "verdict": "delete", "class": "dead"},
            {"file": "tests/Integration/CTest.php", "test": "testMoved", "verdict": "move", "class": "level"},
        )
        code, out, _err = self.run_script("diff", "--before", before, "--after", after, "--verdicts", verdicts, "--json")
        self.assertEqual(1, code)
        report = json.loads(out)
        self.assertEqual([], report["unaccounted"])
        self.assertEqual(
            [("tests/Unit/ATest.php", "testKept", 1), ("tests/Unit/BTest.php", "*", 1)],
            [(row["file"], row["test"], row["cases_after"]) for row in report["not_applied"]],
        )

    # -- the command itself ---------------------------------------------------------------------

    def test_the_wrapper_beside_the_script_runs_it(self) -> None:
        report = self.write("r.xml", junit(case("testA", "/x/tests/ATest.php", 1.0)))
        code, out, err = self.run_script("census", str(report), program=WRAPPER)
        self.assertEqual(0, code, err)
        self.assertIn("1 cases in 1 tests and 1 files", out)

    def test_a_command_with_no_name_or_a_root_that_is_no_directory_is_unusable(self) -> None:
        code, out, err = self.run_script()
        self.assertEqual((2, ""), (code, out))
        self.assertIn("usage: pipeline-suite", err)
        report = self.write("r.xml", junit(case("testA", "/x/tests/ATest.php")))
        self.assertIn("not a directory", self.refused("census", str(report), "--root", str(self.root / "absent")))


if __name__ == "__main__":
    unittest.main()
