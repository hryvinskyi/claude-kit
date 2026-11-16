#!/usr/bin/env python3
"""Tests for bin/review_report.py, run as the pipeline runs it: the script as a subprocess over JSON
files written into a temporary directory.

What is pinned: the members of the wave and of each delta pass under their own headings, one table row
per finding in the order the results give (the wave first, then the delta passes in the order given),
the location, verdict and found-by cells (a failing gate has no location, a duplicate adds its member),
the outcome cell of each outcome kind and of an id with none, the refuted, checked-and-cleared,
readers-checked, not-verified, discarded and not-checked lists, TODO rows only for a finding moved to a
ticket and only with a date, a pipe or line break in a defect never leaving its table cell, no secret
value and no live mention reaching the output (code spans kept as written, a location printed as code,
the lines that lost a value counted under "Not checked"), and every unusable input — a bad outcome, an unknown id, an id in two results,
invalid or oversized JSON, a result missing a field, a member's checks of the wrong shape, a secret filter
that cannot be loaded — exiting 2
with the cause on standard error and nothing on standard output.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

SCRIPT = Path(__file__).resolve().parent.parent / "bin" / "review_report.py"


def member(name: str, status: str = "ok", findings: int = 0, model: str = "opus", effort: str = "high") -> Dict[str, Any]:
    return {"name": name, "model": model, "effort": effort, "status": status, "findings": findings}


def finding(ident: str, defect: str = "a defect", file: Optional[str] = "src/a.php", line: Optional[int] = 10,
            verdict: str = "confirmed", found_by: Optional[List[str]] = None,
            duplicates: Optional[List[Dict[str, Any]]] = None, scenario: Optional[str] = "it breaks") -> Dict[str, Any]:
    return {"id": ident, "cluster": 1, "file": file, "line": line, "defect": defect, "failure_scenario": scenario,
            "rule": "r", "severity": "Important", "verdict": verdict, "evidence": "src/a.php:10: x", "trace": "t",
            "fix": "f", "found_by": found_by or [ident.rsplit("-", 1)[0]], "duplicates": duplicates or []}


def result(mode: str = "wave", round_: Optional[int] = None, **parts: Any) -> Dict[str, Any]:
    data: Dict[str, Any] = {"mode": mode, "class": "M", "members": [], "findings": [], "refuted": [], "unverified": [],
                            "discarded": [], "gates": [], "not_checked": [],
                            "budget": {"max_agents": 16, "used": 4, "batched": [], "over_by": 0}}
    if round_ is not None:
        data["round"] = round_
    data.update(parts)
    return data


class ReviewReportTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)

    def write(self, name: str, data: Any) -> str:
        path = self.dir / name
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        return str(path)

    def run_report(self, wave: Any, outcomes: Any, deltas: Optional[List[Any]] = None, *extra: str) -> subprocess.CompletedProcess:
        args = [sys.executable, str(SCRIPT), "--result", self.write("wave.json", wave), "--outcomes", self.write("outcomes.json", outcomes)]
        for index, delta in enumerate(deltas or []):
            args += ["--delta", self.write("delta%d.json" % index, delta)]
        completed = subprocess.run(args + list(extra), capture_output=True, timeout=60)
        return subprocess.CompletedProcess(args, completed.returncode, completed.stdout.decode("utf-8"), completed.stderr.decode("utf-8"))

    def assert_rejected(self, completed: subprocess.CompletedProcess, *needles: str) -> None:
        self.assertEqual(2, completed.returncode, completed.stderr)
        self.assertEqual("", completed.stdout)
        for needle in needles:
            self.assertIn(needle, completed.stderr)

    def wave(self) -> Dict[str, Any]:
        return result(
            members=[member("lens-a", findings=1), member("lens-b", findings=1), member("builtin", "unavailable", 0, "opus", "medium")],
            findings=[finding("lens-a-1", "stale cache after write", "src/Cache.php", 42),
                      finding("lens-b-1", "unchecked input", "src/In.php", 7, verdict="plausible")],
            refuted=[finding("lens-a-2", "missing null guard", "src/Guard.php", 3)],
            not_checked=["the migration was not run"])

    def test_wave_renders_members_rows_refuted_and_not_checked(self) -> None:
        completed = self.run_report(self.wave(), {"lens-a-1": {"outcome": "fixed", "commit": "abc1234"},
                                                  "lens-b-1": {"outcome": "answered", "answer": "intended: the input is trusted"}})
        self.assertEqual(0, completed.returncode, completed.stderr)
        out = completed.stdout
        self.assertTrue(out.startswith("## Review\n\n/pipeline:review, class M.\n"))
        self.assertIn("- lens-a · opus · high — ok, 1 finding\n", out)
        self.assertIn("- lens-b · opus · high — ok, 1 finding\n", out)
        self.assertIn("- builtin · opus · medium — unavailable, 0 findings\n", out)
        self.assertIn("| # | file:line | defect | found by | verdict | outcome |", out)
        self.assertIn("| 1 | `src/Cache.php:42` | stale cache after write | lens-a | confirmed | fixed abc1234 |", out)
        self.assertIn("| 2 | `src/In.php:7` | unchecked input | lens-b | plausible | answered: intended: the input is trusted |", out)
        self.assertIn("**Refuted**\n\n- `src/Guard.php:3` — missing null guard — `src/a.php:10: x`\n", out)
        self.assertIn("**Not checked**\n\n- the migration was not run\n", out)
        self.assertNotIn("## TODO rows", out)
        self.assertNotIn("**Not verified**", out)
        self.assertNotIn("**Discarded**", out)

    def test_delta_passes_follow_the_wave_in_the_order_given(self) -> None:
        first = result("delta", 1, members=[member("delta-1", findings=1)], findings=[finding("delta-1-1", "regression one")])
        second = result("delta", 2, members=[member("delta-2", findings=1)], findings=[finding("delta-2-1", "regression two")])
        out = self.run_report(self.wave(), {}, [first, second]).stdout
        self.assertLess(out.index("**Members**"), out.index("**Delta pass 1**"))
        self.assertLess(out.index("**Delta pass 1**"), out.index("**Delta pass 2**"))
        self.assertIn("**Delta pass 1**\n\n- delta-1 · opus · high — ok, 1 finding\n", out)
        rows = [line for line in out.splitlines() if line[:3] in ("| 1", "| 2", "| 3", "| 4")]
        self.assertEqual(
            ["| 1 | `src/Cache.php:42` | stale cache after write | lens-a | confirmed | open |",
             "| 2 | `src/In.php:7` | unchecked input | lens-b | plausible | open |",
             "| 3 | `src/a.php:10` | regression one | delta-1 | confirmed | open |",
             "| 4 | `src/a.php:10` | regression two | delta-2 | confirmed | open |"], rows)

    def test_a_failing_gate_has_no_location(self) -> None:
        gate = finding("mechanical-1", "`composer test` fails", None, None, "gate_failed", ["mechanical"])
        out = self.run_report(result(members=[member("mechanical", findings=1)], findings=[gate]), {}).stdout
        self.assertIn("| 1 | — | `composer test` fails | mechanical | gate failed | open |", out)

    def test_a_duplicate_adds_its_member_and_an_unverified_finding_shows_its_reason_and_outcome(self) -> None:
        duplicate = finding("builtin-1", "same defect, other words", "src/Cache.php", 42, found_by=["builtin"])
        merged = finding("lens-a-1", "stale cache", "src/Cache.php", 42, found_by=["lens-a", "lens-c"],
                         duplicates=[dict(duplicate, member="builtin")])
        loose = finding("lens-b-2", "different defect on the line", "src/Cache.php", 42)
        loose["reason"] = "same line as lens-a-1, different defect"
        data = result(members=[member("lens-a", findings=1)], findings=[merged], unverified=[loose],
                      discarded=[{"member": "lens-c", "reason": "reviewed another tree; rerun", "findings": [{"id": "lens-c-1"}]},
                                 {"member": "builtin", "reason": "reviewed another tree", "findings": 3}])
        out = self.run_report(data, {"lens-b-2": {"outcome": "fixed", "commit": "def5678"}}).stdout
        self.assertIn("| lens-a, lens-c (+builtin) |", out)
        self.assertIn("**Not verified**\n\n- `src/Cache.php:42` — different defect on the line — same line as lens-a-1, "
                      "different defect; fixed def5678\n", out)
        self.assertIn("**Discarded**\n\n- lens-c — reviewed another tree; rerun (1 finding)\n- builtin — reviewed another tree (3 findings)\n", out)

    def test_empty_outcomes_render_every_finding_open_without_a_todo_section(self) -> None:
        out = self.run_report(self.wave(), {}).stdout
        self.assertEqual(2, out.count("| open |"))
        self.assertNotIn("## TODO rows", out)

    def test_a_result_with_nothing_in_it_renders_none(self) -> None:
        out = self.run_report(result(members=[member("lens-a")]), {}).stdout
        self.assertIn("**Findings**\n\nNone.\n", out)
        self.assertIn("**Refuted**\n\nNone.\n", out)

    def test_a_moved_finding_prints_a_todo_row_with_the_date(self) -> None:
        completed = self.run_report(self.wave(), {"lens-b-1": {"outcome": "moved", "ticket": "#123"}}, None, "--todo-date", "2026-11-16")
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("| moved to #123 |", completed.stdout)
        self.assertTrue(completed.stdout.endswith(
            "## TODO rows\n\n- [ ] **#123 — unchecked input** (2026-11-16) — `src/In.php:7`; it breaks\n"))
        self.assertEqual(1, completed.stdout.count("- [ ]"))

    def test_a_moved_finding_without_a_date_is_refused(self) -> None:
        completed = self.run_report(self.wave(), {"lens-b-1": {"outcome": "moved", "ticket": "#123"}})
        self.assert_rejected(completed, "--todo-date")

    def test_a_date_that_is_not_a_date_is_refused(self) -> None:
        for bad in ("2026-13-01", "16/11/2026", "2026-1-5", ""):
            with self.subTest(bad=bad):
                self.assert_rejected(self.run_report(self.wave(), {}, None, "--todo-date", bad), "--todo-date")

    def test_a_pipe_and_a_line_break_stay_inside_one_cell(self) -> None:
        awkward = finding("lens-a-1", "a | b\nsecond line\r\nthird", "src/x|y.php", 1)
        out = self.run_report(result(members=[member("lens-a", findings=1)], findings=[awkward]), {"lens-a-1": {"outcome": "answered", "answer": "x | y\nz"}}).stdout
        row = next(line for line in out.splitlines() if line.startswith("| 1 |"))
        self.assertEqual("| 1 | `src/x\\|y.php:1` | a \\| b second line third | lens-a | confirmed | answered: x \\| y z |", row)
        self.assertEqual(6, len([cell for cell in row.replace("\\|", "").split("|") if cell.strip()]))

    def test_evidence_is_quoted_as_code_with_a_backtick_replaced(self) -> None:
        refuted = finding("lens-a-1", "no guard", "a.php", 2)
        refuted["evidence"] = "a.php:2: `if ($x)` guards it"
        out = self.run_report(result(members=[member("lens-a")], refuted=[refuted]), {}).stdout
        self.assertIn("- `a.php:2` — no guard — `a.php:2: 'if ($x)' guards it`\n", out)

    def test_outcomes_may_name_a_refuted_unverified_or_duplicate_id(self) -> None:
        duplicate = finding("builtin-1", "dup", found_by=["builtin"])
        merged = finding("lens-a-1", "first", duplicates=[dict(duplicate, member="builtin")])
        unverified = dict(finding("lens-b-2", "loose"), reason="verifier died")
        data = result(members=[member("lens-a")], findings=[merged], refuted=[finding("lens-a-2", "gone")], unverified=[unverified])
        completed = self.run_report(data, {"builtin-1": {"outcome": "answered", "answer": "a"},
                                           "lens-a-2": {"outcome": "answered", "answer": "b"},
                                           "lens-b-2": {"outcome": "moved", "ticket": "#9"}}, None, "--todo-date", "2026-11-16")
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("- [ ] **#9 — loose**", completed.stdout)

    def test_each_invalid_outcome_is_refused_naming_its_id(self) -> None:
        cases = {
            "unknown kind": {"lens-a-1": {"outcome": "ignored"}},
            "no kind": {"lens-a-1": {}},
            "fixed without a commit": {"lens-a-1": {"outcome": "fixed"}},
            "answered without an answer": {"lens-a-1": {"outcome": "answered", "answer": "  "}},
            "moved without a ticket": {"lens-a-1": {"outcome": "moved"}},
            "an outcome that is not an object": {"lens-a-1": "fixed"},
            "an id no result holds": {"lens-a-1": {"outcome": "fixed", "commit": "a"}, "lens-z-9": {"outcome": "fixed", "commit": "b"}},
        }
        for name, outcomes in cases.items():
            with self.subTest(name):
                self.assert_rejected(self.run_report(self.wave(), outcomes, None, "--todo-date", "2026-11-16"),
                                     "lens-z-9" if "no result" in name else "lens-a-1")
        self.assert_rejected(self.run_report(self.wave(), ["lens-a-1"]), "outcomes")

    def test_an_id_held_by_two_results_is_refused(self) -> None:
        again = result("delta", 1, members=[member("delta-1", findings=1)], findings=[finding("lens-a-1", "reused")])
        self.assert_rejected(self.run_report(self.wave(), {}, [again]), "lens-a-1")

    def test_invalid_json_is_refused(self) -> None:
        self.assert_rejected(self.run_report("{not json", {}), "not valid JSON")
        self.assert_rejected(self.run_report(self.wave(), "[1,"), "not valid JSON")
        self.assert_rejected(self.run_report(self.wave(), {}, ["nope"]), "--delta")

    def test_a_missing_or_oversized_file_is_refused(self) -> None:
        outcomes = self.write("outcomes.json", {})
        completed = subprocess.run([sys.executable, str(SCRIPT), "--result", str(self.dir / "absent.json"), "--outcomes", outcomes],
                                   capture_output=True, text=True, timeout=60)
        self.assert_rejected(completed, "absent.json")
        big = self.write("big.json", " " * (8 * 1024 * 1024 + 1))
        completed = subprocess.run([sys.executable, str(SCRIPT), "--result", big, "--outcomes", outcomes],
                                   capture_output=True, text=True, timeout=60)
        self.assert_rejected(completed, "larger than")

    def test_a_result_missing_a_field_the_output_needs_is_refused(self) -> None:
        def without(section: str, key: str) -> Dict[str, Any]:
            data = self.wave()
            target = data[section]
            if isinstance(target, list):
                del target[0][key]
            else:
                del data[section]
            return data

        for name, data in {
            "members": without("members", "name"),
            "no findings list": {k: v for k, v in self.wave().items() if k != "findings"},
            "finding defect": without("findings", "defect"),
            "finding found_by": without("findings", "found_by"),
            "refuted evidence": without("refuted", "evidence"),
            "no not_checked": {k: v for k, v in self.wave().items() if k != "not_checked"},
            "no class": {k: v for k, v in self.wave().items() if k != "class"},
            "wrong mode": dict(self.wave(), mode="delta"),
            "not an object": [],
        }.items():
            with self.subTest(name):
                self.assert_rejected(self.run_report(data, {}))

    def test_a_delta_result_must_name_its_round(self) -> None:
        no_round = result("delta", None, members=[member("delta-1")])
        self.assert_rejected(self.run_report(self.wave(), {}, [no_round]), "round")

    def test_secret_values_are_masked_everywhere_they_would_be_printed_and_counted_once(self) -> None:
        secret = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"
        refuted = finding("lens-a-2", "the key STRIPE_SECRET=%s is committed" % secret, ".env.local", 3)
        refuted["evidence"] = ".env.local:3: STRIPE_SECRET=%s" % secret
        confirmed = finding("lens-a-1", "SESSION_TOKEN=t0k3nt0k3nt0k3n is logged", scenario="DB_PASSWORD=hunter2hunter2 leaks into the log")
        unverified = dict(finding("lens-b-1", "loose"), reason="Authorization: Bearer abcdefghijklmnopqrstuvwx")
        lens = dict(member("lens-a", findings=1), cleared=[{"candidate": "a leaked key", "refuting_line": "API_KEY=zx81zx81zx81"}])
        data = result(members=[lens], findings=[confirmed], refuted=[refuted], unverified=[unverified],
                      not_checked=["the staging run with APP_SECRET=s3cr3tv4lue"])
        completed = self.run_report(data, {"lens-a-1": {"outcome": "moved", "ticket": "#5"},
                                           "lens-b-1": {"outcome": "answered", "answer": "rotated, token=tok3n-v4lue-1"}},
                                    None, "--todo-date", "2026-11-16")
        self.assertEqual(0, completed.returncode, completed.stderr)
        out = completed.stdout
        for value in (secret, "t0k3nt0k3nt0k3n", "hunter2hunter2", "abcdefghijklmnopqrstuvwx", "zx81zx81zx81", "s3cr3tv4lue",
                      "tok3n-v4lue-1"):
            self.assertNotIn(value, out)
        self.assertIn("| 1 | `src/a.php:10` | SESSION_TOKEN=[withheld] |", out)
        self.assertIn("- [ ] **#5 — SESSION_TOKEN=[withheld]** (2026-11-16)", out)
        self.assertIn("- `.env.local:3` — the key STRIPE_SECRET=[withheld] is committed — `.env.local:3: STRIPE_SECRET=[withheld]`\n", out)
        self.assertIn("- lens-a: a leaked key — `API_KEY=[withheld]`\n", out)
        self.assertIn("(2026-11-16) — `src/a.php:10`; DB_PASSWORD=[withheld]\n", out)
        self.assertIn("- the staging run with APP_SECRET=[withheld]\n- 8 lines with a secret-looking value withheld\n", out)
        self.assertEqual(1, out.count("secret-looking"))

    def test_a_secret_filter_that_cannot_be_loaded_exits_2_with_the_cause(self) -> None:
        alone = self.dir / "bin"
        alone.mkdir()
        (alone / "review_report.py").write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
        args = ["--result", self.write("r.json", self.wave()), "--outcomes", self.write("o.json", {})]
        missing = subprocess.run([sys.executable, str(alone / "review_report.py")] + args, capture_output=True, text=True)
        self.assertEqual((2, ""), (missing.returncode, missing.stdout), missing.stderr)
        self.assertIn("cannot load the secret filter", missing.stderr)
        (alone / "decide.py").write_text("raise ImportError('no yaml here')\n", encoding="utf-8")
        broken = subprocess.run([sys.executable, str(alone / "review_report.py")] + args, capture_output=True, text=True)
        self.assertEqual((2, ""), (broken.returncode, broken.stdout), broken.stderr)
        self.assertIn("no yaml here", broken.stderr)

    def test_nothing_masked_prints_no_count(self) -> None:
        self.assertNotIn("secret-looking", self.run_report(self.wave(), {}).stdout)

    def test_a_single_masked_value_is_counted_in_the_singular(self) -> None:
        refuted = dict(finding("lens-a-2", "committed key"), evidence="APP_KEY=base64:Zm9vYmFyYmF6")
        out = self.run_report(result(members=[member("lens-a")], refuted=[refuted]), {}).stdout
        self.assertIn("**Not checked**\n\n- 1 line with a secret-looking value withheld\n", out)

    def test_a_mention_outside_a_code_span_is_broken_and_a_code_span_is_kept(self) -> None:
        zwj = "‍"
        row = finding("lens-a-1", "the docblock's @throws omits it; `@param int $x` is right", "node_modules/@types/a.ts", 4)
        refuted = dict(finding("lens-a-2", "@author is stale"), evidence="a.php:2: @var int")
        stray = dict(finding("lens-a-3", "a stray ` before @x"), evidence="b.php:1: @x")
        data = result(members=[member("lens-a", findings=1)], findings=[row], refuted=[refuted, stray],
                      not_checked=["ask @octocat", "a `@code` span and a stray `", "the stray ` backtick and `@team` after it"])
        out = self.run_report(data, {"lens-a-1": {"outcome": "moved", "ticket": "@someone owns #4"}}, None,
                              "--todo-date", "2026-11-16").stdout
        self.assertIn("| `node_modules/@types/a.ts:4` | the docblock's @%sthrows omits it; `@param int $x` is right |"
                      % zwj, out)
        self.assertIn("- `src/a.php:10` — @%sauthor is stale — `a.php:2: @var int`\n" % zwj, out)
        self.assertIn("- `src/a.php:10` — a stray ' before @%sx — `b.php:1: @x`\n" % zwj, out)
        self.assertIn("- ask @%soctocat\n" % zwj, out)
        self.assertIn("- a `@code` span and a stray '\n", out)
        # Markdown pairs the first two backticks, so `@team` is outside a code span and is broken.
        self.assertIn("- the stray ` backtick and `@%steam' after it\n" % zwj, out)
        self.assertIn("**@%ssomeone owns #4 — the docblock" % zwj, out)

    def test_every_at_before_a_name_character_is_broken_an_email_included(self) -> None:
        out = self.run_report(result(members=[member("lens-a")], not_checked=["mail ops@example.com", "a lone @ sign"]), {}).stdout
        self.assertIn("- mail ops@‍example.com\n- a lone @ sign\n", out)

    def wave_with_checks(self) -> Dict[str, Any]:
        lens_a = dict(member("lens-a", findings=1),
                      cleared=[{"candidate": "a null @param slips through", "refuting_line": "src/A.php:12: if ($x === null) { return; }"},
                               {"candidate": "the cache is not flushed", "refuting_line": "src/Cache.php:40: $this->pool->clear();"}],
                      readers_checked=[{"symbol": "Cache::get", "command": "rg -n 'Cache::get'", "hits": 3, "verdict": "every reader handles a miss"}])
        lens_b = dict(member("lens-b"), cleared=[], readers_checked=[])
        lens_c = member("lens-c")
        return result(members=[lens_a, lens_b, lens_c], refuted=[finding("lens-a-2", "gone")],
                      unverified=[dict(finding("lens-b-1", "loose"), reason="verifier died")])

    def test_checked_and_cleared_and_readers_checked_follow_refuted(self) -> None:
        delta = result("delta", 1, members=[dict(member("delta-1"), readers_checked=[
            {"symbol": "Out::put", "command": "rg -n put", "hits": 1, "verdict": "one caller, guarded"}])])
        out = self.run_report(self.wave_with_checks(), {}, [delta]).stdout
        self.assertIn("**Checked and cleared**\n\n"
                      "- lens-a: a null @‍param slips through — `src/A.php:12: if ($x === null) { return; }`\n"
                      "- lens-a: the cache is not flushed — `src/Cache.php:40: $this->pool->clear();`\n\n"
                      "**Readers checked**\n\n"
                      "- lens-a: `Cache::get` — 3 hits — every reader handles a miss\n"
                      "- delta-1: `Out::put` — 1 hit — one caller, guarded\n", out)
        self.assertLess(out.index("**Refuted**"), out.index("**Checked and cleared**"))
        self.assertLess(out.index("**Readers checked**"), out.index("**Not verified**"))
        self.assertNotIn("lens-b:", out)
        self.assertNotIn("lens-c:", out)

    def test_no_checks_print_neither_heading(self) -> None:
        data = self.wave_with_checks()
        data["members"][0]["cleared"] = []
        out = self.run_report(data, {}).stdout
        self.assertNotIn("**Checked and cleared**", out)
        self.assertIn("**Readers checked**", out)
        out = self.run_report(self.wave(), {}).stdout
        self.assertNotIn("**Checked and cleared**", out)
        self.assertNotIn("**Readers checked**", out)

    def test_checks_of_the_wrong_shape_are_refused(self) -> None:
        def with_member(**fields: Any) -> Dict[str, Any]:
            return result(members=[dict(member("lens-a"), **fields)])

        for name, data in {
            "cleared not a list": with_member(cleared={"candidate": "x"}),
            "cleared entry not an object": with_member(cleared=["x"]),
            "cleared without a refuting line": with_member(cleared=[{"candidate": "x"}]),
            "cleared candidate not text": with_member(cleared=[{"candidate": 1, "refuting_line": "a"}]),
            "readers not a list": with_member(readers_checked="none"),
            "reader hits not a count": with_member(readers_checked=[{"symbol": "s", "command": "c", "hits": "3", "verdict": "v"}]),
            "reader without a symbol": with_member(readers_checked=[{"command": "c", "hits": 3, "verdict": "v"}]),
            "reader verdict null": with_member(readers_checked=[{"symbol": "s", "command": "c", "hits": 3, "verdict": None}]),
            "cleared null": with_member(cleared=None),
        }.items():
            with self.subTest(name):
                self.assert_rejected(self.run_report(data, {}), "members[0]")


if __name__ == "__main__":
    unittest.main()
