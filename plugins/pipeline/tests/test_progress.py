#!/usr/bin/env python3
"""Tests for bin/progress.py, run as the pipeline runs it: the script as a subprocess inside a scratch
git checkout that holds a plan directory.

What is pinned: a finished phase and an accepted task each recorded with a checkpoint that holds the
whole working tree (modified, staged and untracked files, a file rewritten to the same size in the
second the index was written included) while the index stays as it was; a task
moving through started, blocked (only with its question) and accepted, keeping the base it took at
its start while it is in flight and taking a new one when started again after acceptance; acceptance
decided by the
task's hash files — an intact red record accepts, a test changed or deleted after its red run needs a
deviation, a changed frozen contract is never accepted, an intact contract stands in for a red
record, a task with neither file needs its reason, and a hash line that leaves the checkout or a hash
file with no usable line is no evidence; resume taking the only recorded run, listing several,
finding none, and reporting the phase, each task with what its hash files say now, and the files
changed since the first task still in flight started (else since the last checkpoint) with the plan
directory left out; a checkpoint that is gone from the object store named rather than crashed on;
resume writing nothing to the record, the index or the working tree; set-aside putting the files a
started task left under the named paths back as they were at its base (added ones removed with the
directories they leave empty, changed and deleted ones restored), keeping them as a patch under the
git directory that brings them back, moving the task's red record beside it, forgetting the task,
leaving the index and every unnamed file alone, and refusing an accepted or unrecorded task, no
paths, a path outside the checkout or in the plan directory, a file of a frozen contract and a base
that is gone; every unusable request exiting 2 with the cause on standard error and nothing on
standard output; and the wrapper beside the script running it.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

BIN = Path(__file__).resolve().parent.parent / "bin"
SCRIPT = BIN / "progress.py"
WRAPPER = BIN / "pipeline-progress"
SLUG = "late-fee"


class ProgressTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve() / "repo"
        self.root.mkdir()
        self.git("init", "-q")
        self.write("src/a.js", "export const a = 1;\n")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "base")
        self.plan = self.root / ".claude" / "plans" / SLUG
        self.plan.mkdir(parents=True)
        self.write(".claude/plans/%s/_plan.md" % SLUG, "# plan\n")

    def git(self, *args: str) -> str:
        done = subprocess.run(["git", *args], cwd=str(self.root), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def write(self, name: str, text: str) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def run_script(self, *args: str, cwd: Any = None) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args], cwd=str(cwd or self.root), capture_output=True, text=True,
        )

    def done(self, *args: str) -> str:
        result = self.run_script(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def refused(self, *args: str, cwd: Any = None) -> str:
        result = self.run_script(*args, cwd=cwd)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotEqual(result.stderr.strip(), "")
        return result.stderr

    def record(self) -> Dict[str, Any]:
        return json.loads((self.plan / "_progress.json").read_text(encoding="utf-8"))

    def report(self, *args: str) -> Dict[str, Any]:
        return json.loads(self.done("resume", *args, "--json"))

    def hash_file(self, kind: str, task: str, names: List[str], marker: str = " ") -> None:
        lines = []
        for name in names:
            digest = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
            lines.append("%s %s%s\n" % (digest, marker, name))
        (self.plan / ("_%s-%s.sha256" % (kind, task))).write_text("".join(lines), encoding="utf-8")

    def red_test(self, task: str = "2", name: str = "test/late-fee.test.js") -> str:
        self.write(name, "test('a loan returned on its due date costs nothing', () => {});\n")
        self.hash_file("red", task, [name])
        return name

    # --- phases and checkpoints ---

    def test_a_finished_phase_is_recorded_with_a_checkpoint_of_the_whole_tree(self) -> None:
        self.write("src/a.js", "export const a = 2;\n")
        self.write("src/new.js", "export const fresh = true;\n")

        self.assertIn("phase 3 finished", self.done("phase", SLUG, "3"))

        record = self.record()
        self.assertEqual(record["phase"], 3)
        tree = record["checkpoint"]["tree"]
        self.assertEqual(record["checkpoint"]["after"], "phase 3 finished")
        self.assertEqual(self.git("cat-file", "-t", tree).strip(), "tree")
        self.assertIn("src/new.js", self.git("ls-tree", "-r", "--name-only", tree).splitlines())
        self.assertEqual(self.git("show", "%s:src/a.js" % tree), "export const a = 2;\n")

    def test_a_checkpoint_leaves_the_index_as_it_was(self) -> None:
        self.write("src/staged.js", "export const staged = true;\n")
        self.git("add", "src/staged.js")
        self.write("src/loose.js", "export const loose = true;\n")
        self.write("src/a.js", "export const a = 3;\n")
        before = self.git("status", "--porcelain")

        self.done("phase", SLUG, "1")

        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertIn("A  src/staged.js", before)
        self.assertIn("?? src/loose.js", before)

    def test_a_checkpoint_holds_a_file_rewritten_to_the_same_size_in_the_second_the_index_was_written(self) -> None:
        self.git("config", "core.trustctime", "false")
        path = self.root / "src" / "a.js"
        index = self.root / ".git" / "index"
        self.git("update-index", "--refresh")
        before = path.stat()
        path.write_text("export const a = 7;\n", encoding="utf-8")
        os.utime(str(path), ns=(before.st_atime_ns, before.st_mtime_ns))
        os.utime(str(index), ns=(before.st_atime_ns, before.st_mtime_ns))

        self.done("phase", SLUG, "1")

        tree = self.record()["checkpoint"]["tree"]
        self.assertEqual(self.git("show", "%s:src/a.js" % tree), "export const a = 7;\n")

    def test_a_checkpoint_is_taken_in_a_checkout_that_never_had_an_index(self) -> None:
        bare = Path(self.scratch.name).resolve() / "fresh"
        (bare / ".claude" / "plans" / SLUG).mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=str(bare), check=True)
        (bare / "only.txt").write_text("one\n", encoding="utf-8")

        result = self.run_script("phase", SLUG, "1", cwd=bare)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((bare / ".git" / "index").exists())

    # --- tasks ---

    def test_a_task_moves_through_started_blocked_and_accepted(self) -> None:
        self.done("task", SLUG, "2", "started")
        self.assertEqual(self.record()["tasks"]["2"]["status"], "started")

        self.done("task", SLUG, "2", "blocked", "--note", "which rate applies on a holiday?")
        self.assertEqual(self.record()["tasks"]["2"]["note"], "which rate applies on a holiday?")

        self.done("task", SLUG, "2", "accepted", "--no-red", "a translation file")
        entry = self.record()["tasks"]["2"]
        self.assertEqual(entry["status"], "accepted")
        self.assertEqual(entry["red"], "none: a translation file")
        self.assertEqual(self.record()["checkpoint"]["after"], "task 2 accepted")
        self.assertEqual(self.record()["checkpoint"]["tree"], entry["tree"])

    def test_a_blocked_task_needs_its_question(self) -> None:
        self.done("task", SLUG, "2", "started")

        self.assertIn("--note", self.refused("task", SLUG, "2", "blocked"))

        self.assertEqual(self.record()["tasks"]["2"]["status"], "started")

    def test_a_task_with_no_hash_file_is_accepted_only_with_its_reason(self) -> None:
        self.done("task", SLUG, "2", "started")

        error = self.refused("task", SLUG, "2", "accepted")

        self.assertIn("_red-2.sha256", error)
        self.assertIn("--no-red", error)
        self.assertEqual(self.record()["tasks"]["2"]["status"], "started")

    def test_an_intact_red_record_accepts_the_task(self) -> None:
        self.red_test()

        self.done("task", SLUG, "2", "accepted")

        entry = self.record()["tasks"]["2"]
        self.assertEqual(entry["red"], "ok")
        self.assertEqual(self.git("cat-file", "-t", entry["tree"]).strip(), "tree")

    def test_a_hash_line_in_binary_form_is_read(self) -> None:
        self.write("test/late-fee.test.js", "test('pinned', () => {});\n")
        self.hash_file("red", "2", ["test/late-fee.test.js"], marker="*")

        self.done("task", SLUG, "2", "accepted")

        self.assertEqual(self.record()["tasks"]["2"]["red"], "ok")

    def test_a_test_changed_after_its_red_run_needs_a_deviation(self) -> None:
        name = self.red_test()
        self.write(name, "test('a loan returned on its due date costs nothing', () => { /* loosened */ });\n")

        error = self.refused("task", SLUG, "2", "accepted")
        self.assertIn("%s (changed)" % name, error)
        self.assertIn("--deviation", error)
        self.assertNotIn("2", self.record_or_empty().get("tasks", {}))

        self.done("task", SLUG, "2", "accepted", "--deviation", "the expected fee said 250, the criterion says 150")
        self.assertEqual(
            self.record()["tasks"]["2"]["red"], "deviation: the expected fee said 250, the criterion says 150",
        )

    def test_a_test_deleted_after_its_red_run_counts_as_changed(self) -> None:
        name = self.red_test()
        (self.root / name).unlink()

        self.assertIn("%s (missing)" % name, self.refused("task", SLUG, "2", "accepted"))

    def test_a_reason_for_no_red_run_does_not_cover_a_changed_test(self) -> None:
        name = self.red_test()
        self.write(name, "test('rewritten to fit the code', () => {});\n")

        self.assertIn("(changed)", self.refused("task", SLUG, "2", "accepted", "--no-red", "nothing to pin"))

    def test_a_changed_frozen_contract_is_never_accepted(self) -> None:
        self.write("src/port.js", "export const port = 1;\n")
        self.hash_file("contract", "3", ["src/port.js"])
        self.write("src/port.js", "export const port = 2;\n")

        error = self.refused(
            "task", SLUG, "3", "accepted", "--deviation", "the port needed a field", "--no-red", "none",
        )

        self.assertIn("src/port.js (changed)", error)
        self.assertIn("frozen contract", error)

    def test_an_intact_contract_stands_in_for_a_red_record(self) -> None:
        self.write("src/port.js", "export const port = 1;\n")
        self.hash_file("contract", "3", ["src/port.js"])

        self.done("task", SLUG, "3", "accepted")

        self.assertEqual(self.record()["tasks"]["3"]["red"], "contract")

    def test_a_hash_line_that_leaves_the_checkout_is_no_evidence(self) -> None:
        outside = self.root.parent / "outside.test.js"
        outside.write_text("test('elsewhere', () => {});\n", encoding="utf-8")
        digest = hashlib.sha256(outside.read_bytes()).hexdigest()
        (self.plan / "_red-2.sha256").write_text("%s  ../outside.test.js\n" % digest, encoding="utf-8")

        self.assertIn("../outside.test.js (outside)", self.refused("task", SLUG, "2", "accepted"))

    def test_a_hash_file_with_no_usable_line_is_no_evidence(self) -> None:
        (self.plan / "_red-2.sha256").write_text("\n", encoding="utf-8")
        self.assertIn("_red-2.sha256 (unreadable)", self.refused("task", SLUG, "2", "accepted"))

        (self.plan / "_red-2.sha256").write_text("OK test/late-fee.test.js\n", encoding="utf-8")
        self.assertIn("(unreadable)", self.refused("task", SLUG, "2", "accepted"))


    # --- the base a task starts from ---

    def test_a_task_keeps_the_base_of_its_start_while_it_is_in_flight(self) -> None:
        self.done("task", SLUG, "2", "started")
        base = self.record()["tasks"]["2"]["base"]
        self.assertEqual(self.git("cat-file", "-t", base).strip(), "tree")
        self.write("src/half.js", "export const half = true;\n")

        self.done("task", SLUG, "2", "blocked", "--note", "which rate?")
        self.assertEqual(self.record()["tasks"]["2"]["base"], base)
        self.done("task", SLUG, "2", "started")
        self.assertEqual(self.record()["tasks"]["2"]["base"], base)

        self.assertNotIn("src/half.js", self.git("ls-tree", "-r", "--name-only", base).splitlines())

    def test_a_task_started_again_after_acceptance_takes_a_base_that_holds_its_accepted_work(self) -> None:
        self.done("task", SLUG, "2", "started")
        first = self.record()["tasks"]["2"]["base"]
        name = self.red_test()
        self.done("task", SLUG, "2", "accepted")

        self.done("task", SLUG, "2", "started")

        again = self.record()["tasks"]["2"]["base"]
        self.assertNotEqual(again, first)
        self.assertIn(name, self.git("ls-tree", "-r", "--name-only", again).splitlines())

    def test_resume_measures_from_the_first_task_still_in_flight(self) -> None:
        self.done("phase", SLUG, "3")
        self.done("task", SLUG, "2", "started")
        self.write("src/two.js", "export const two = 2;\n")
        self.done("task", SLUG, "3", "started")
        self.write("src/three.js", "export const three = 3;\n")

        both = self.report()
        self.assertEqual(both["checkpoint"]["after"], "task 2 started")
        self.assertEqual(both["changed"]["files"], ["A src/three.js", "A src/two.js"])

        self.done("task", SLUG, "2", "accepted", "--no-red", "wiring only")
        one = self.report()
        self.assertEqual(one["checkpoint"]["after"], "task 3 started")
        self.assertEqual(one["changed"]["files"], ["A src/three.js"])

    # --- setting half-done work aside ---

    def leave_half_done_work(self) -> None:
        """Task 2 started over a tree that holds src/old.js, then left work behind and stopped."""
        self.write("src/old.js", "export const old = true;\n")
        self.done("phase", SLUG, "3")
        self.done("task", SLUG, "2", "started")
        self.write("src/fees/late-fee.js", "export const lateFee = () => 1;\n")
        self.write("src/a.js", "export const a = 'half done';\n")
        (self.root / "src" / "old.js").unlink()
        self.write("src/with space.js", "export const spaced = true;\n")
        self.red_test()
        self.write("docs/notes.md", "a person's own note\n")

    def patches(self) -> List[Path]:
        return sorted((self.root / ".git" / "pipeline-set-aside" / SLUG).glob("*.patch"))

    def test_set_aside_puts_the_named_files_back_and_keeps_them_as_a_patch(self) -> None:
        self.leave_half_done_work()
        staged = self.git("diff", "--cached", "--name-only")

        out = self.done("set-aside", SLUG, "2", "src", "test")

        self.assertFalse((self.root / "src" / "fees").exists())
        self.assertFalse((self.root / "src" / "with space.js").exists())
        self.assertFalse((self.root / "test").exists())
        self.assertEqual((self.root / "src" / "a.js").read_text(encoding="utf-8"), "export const a = 1;\n")
        self.assertEqual((self.root / "src" / "old.js").read_text(encoding="utf-8"), "export const old = true;\n")
        self.assertEqual((self.root / "docs" / "notes.md").read_text(encoding="utf-8"), "a person's own note\n")
        self.assertEqual(self.git("diff", "--cached", "--name-only"), staged)
        self.assertIn("A src/fees/late-fee.js", out)
        self.assertIn("M src/a.js", out)
        self.assertIn("D src/old.js", out)

        patches = self.patches()
        self.assertEqual(len(patches), 1)
        self.assertIn(str(patches[0]), out)
        self.git("apply", str(patches[0]))
        self.assertEqual(
            (self.root / "src" / "fees" / "late-fee.js").read_text(encoding="utf-8"),
            "export const lateFee = () => 1;\n",
        )
        self.assertEqual((self.root / "src" / "a.js").read_text(encoding="utf-8"), "export const a = 'half done';\n")
        self.assertFalse((self.root / "src" / "old.js").exists())
        self.assertTrue((self.root / "src" / "with space.js").is_file())
        self.assertTrue((self.root / "test" / "late-fee.test.js").is_file())

    def test_set_aside_forgets_the_task_and_moves_its_red_record_beside_the_patch(self) -> None:
        self.leave_half_done_work()

        self.done("set-aside", SLUG, "2", "src", "test")

        self.assertFalse((self.plan / "_red-2.sha256").exists())
        self.assertEqual(len(list(self.patches()[0].parent.glob("task-2-*.red.sha256"))), 1)
        record = self.record()
        self.assertNotIn("2", record["tasks"])
        self.assertEqual(record["set_aside"][0]["task"], "2")
        self.assertIn("src/fees/late-fee.js", record["set_aside"][0]["files"])
        self.assertIn("set aside: task 2", self.done("resume"))
        self.assertEqual(self.report()["changed"]["files"], ["A docs/notes.md"])

    def test_set_aside_takes_only_what_the_paths_name(self) -> None:
        self.leave_half_done_work()

        self.done("set-aside", SLUG, "2", "src/fees")

        self.assertFalse((self.root / "src" / "fees").exists())
        self.assertEqual((self.root / "src" / "a.js").read_text(encoding="utf-8"), "export const a = 'half done';\n")
        self.assertFalse((self.root / "src" / "old.js").exists())
        self.assertTrue((self.root / "test" / "late-fee.test.js").is_file())

    def test_set_aside_reads_a_path_from_the_directory_it_is_run_in(self) -> None:
        self.leave_half_done_work()

        result = self.run_script("set-aside", SLUG, "2", "fees/late-fee.js", cwd=self.root / "src")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "src" / "fees").exists())
        self.assertTrue((self.root / "src" / "with space.js").is_file())

    def test_set_aside_of_a_task_that_left_nothing_forgets_it(self) -> None:
        self.done("task", SLUG, "2", "started")

        self.assertIn("left nothing", self.done("set-aside", SLUG, "2", "src"))

        self.assertNotIn("2", self.record()["tasks"])
        self.assertEqual(self.patches(), [])

    def test_set_aside_refuses_what_is_not_half_done_work(self) -> None:
        self.leave_half_done_work()
        before = self.git("status", "--porcelain")
        record = (self.plan / "_progress.json").read_bytes()

        self.assertIn("name the paths", self.refused("set-aside", SLUG, "2"))
        self.assertIn("outside the checkout", self.refused("set-aside", SLUG, "2", "../elsewhere"))
        self.assertIn("plan directory", self.refused("set-aside", SLUG, "2", ".claude/plans/%s" % SLUG))
        self.assertIn("plan directory", self.refused("set-aside", SLUG, "2", "."))
        self.assertIn("not recorded", self.refused("set-aside", SLUG, "7", "src"))
        self.assertIn("not a task id", self.refused("set-aside", SLUG, "a/b", "src"))

        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual((self.plan / "_progress.json").read_bytes(), record)
        self.assertEqual(self.patches(), [])

    def test_set_aside_refuses_an_accepted_task(self) -> None:
        self.done("task", SLUG, "2", "started")
        self.red_test()
        self.done("task", SLUG, "2", "accepted")

        self.assertIn("its work stands", self.refused("set-aside", SLUG, "2", "test"))

        self.assertTrue((self.root / "test" / "late-fee.test.js").is_file())

    def test_set_aside_never_takes_a_file_of_the_frozen_contract(self) -> None:
        self.done("task", SLUG, "3", "started")
        self.write("src/port.js", "export const port = 1;\n")
        self.write("src/adapter.js", "export const adapter = 1;\n")
        self.hash_file("contract", "3", ["src/port.js"])

        self.assertIn("src/port.js", self.refused("set-aside", SLUG, "3", "src"))
        self.assertTrue((self.root / "src" / "adapter.js").is_file())

        self.done("set-aside", SLUG, "3", "src/adapter.js")
        self.assertFalse((self.root / "src" / "adapter.js").exists())
        self.assertTrue((self.root / "src" / "port.js").is_file())
        self.assertTrue((self.plan / "_contract-3.sha256").is_file())

    def test_set_aside_refuses_when_the_base_is_gone(self) -> None:
        self.leave_half_done_work()
        record = self.record()
        record["tasks"]["2"]["base"] = "0" * 40
        (self.plan / "_progress.json").write_text(json.dumps(record), encoding="utf-8")

        self.assertIn("no base checkpoint", self.refused("set-aside", SLUG, "2", "src"))

        self.assertTrue((self.root / "src" / "fees" / "late-fee.js").is_file())

    # --- resume ---

    def test_resume_finds_no_recorded_run(self) -> None:
        result = self.run_script("resume")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.strip(), "no recorded run")

        named = self.run_script("resume", SLUG)
        self.assertEqual(named.returncode, 1)
        self.assertEqual(named.stdout.strip(), "no recorded run for %s" % SLUG)

    def test_resume_takes_the_only_recorded_run_and_lists_several(self) -> None:
        self.done("phase", SLUG, "2")
        self.assertIn("plan: .claude/plans/%s" % SLUG, self.done("resume"))

        other = self.root / ".claude" / "plans" / "renewals"
        other.mkdir()
        self.done("phase", "renewals", "1")

        several = self.run_script("resume")
        self.assertEqual(several.returncode, 3)
        self.assertIn("%s  (phase 2 finished)" % SLUG, several.stdout)
        self.assertIn("renewals  (phase 1 finished)", several.stdout)
        self.assertEqual(self.report("renewals")["phase"], 1)

    def test_resume_reports_the_phase_the_tasks_and_what_changed_since_the_task_in_flight_started(self) -> None:
        self.done("phase", SLUG, "3")
        self.done("task", SLUG, "2", "started")
        self.red_test()
        self.done("task", SLUG, "2", "accepted")
        self.done("task", SLUG, "3", "started")
        self.done("task", SLUG, "4", "blocked", "--note", "is the cap per loan or per member?")
        self.write("src/b.js", "export const b = 1;\n")
        self.write("src/a.js", "export const a = 9;\n")
        self.write("test/renewal.test.js", "test('half written', () => {});\n")
        self.hash_file("red", "3", ["test/renewal.test.js"])

        report = self.report()

        self.assertEqual(report["phase"], 3)
        self.assertEqual(report["checkpoint"]["after"], "task 3 started")
        self.assertEqual(
            [(task["task"], task["status"]) for task in report["tasks"]],
            [("2", "accepted"), ("3", "started"), ("4", "blocked")],
        )
        self.assertEqual(report["tasks"][0]["red_now"], [])
        self.assertEqual(report["tasks"][1]["red_now"], [])
        self.assertIsNone(report["tasks"][2]["red_now"])
        self.assertEqual(report["tasks"][2]["note"], "is the cap per loan or per member?")
        self.assertEqual(report["changed"]["files"], ["M src/a.js", "A src/b.js", "A test/renewal.test.js"])

        text = self.done("resume", SLUG)
        self.assertIn("finished: phase 3 — the plan is approved", text)
        self.assertIn("changed since task 3 started", text)
        self.assertIn("  A src/b.js", text)
        self.assertNotIn(".claude/plans", text.split("changed since", 1)[1])

    def test_resume_reports_a_file_deleted_since_the_checkpoint(self) -> None:
        self.done("phase", SLUG, "3")
        (self.root / "src" / "a.js").unlink()

        self.assertEqual(self.report()["changed"]["files"], ["D src/a.js"])

    def test_resume_says_when_nothing_changed(self) -> None:
        self.done("phase", SLUG, "3")

        self.assertEqual(self.report()["changed"], {"known": True, "files": []})
        self.assertIn("nothing changed since phase 3 finished", self.done("resume"))

    def test_resume_flags_a_test_changed_after_its_task_was_accepted(self) -> None:
        name = self.red_test()
        self.done("task", SLUG, "2", "accepted")
        self.write(name, "test('weakened later', () => {});\n")

        self.assertEqual(self.report()["tasks"][0]["red_now"], ["%s (changed)" % name])
        self.assertIn("red CHANGED: %s (changed)" % name, self.done("resume"))

    def test_resume_names_a_checkpoint_that_is_gone_from_the_object_store(self) -> None:
        self.done("phase", SLUG, "3")
        record = self.record()
        record["checkpoint"]["tree"] = "0" * 40
        (self.plan / "_progress.json").write_text(json.dumps(record), encoding="utf-8")

        self.assertEqual(self.report()["changed"], {"known": False, "files": []})
        self.assertIn("no longer in the object store", self.done("resume"))

    def test_resume_writes_nothing_to_the_record_the_index_or_the_working_tree(self) -> None:
        self.done("phase", SLUG, "3")
        self.write("src/staged.js", "export const staged = true;\n")
        self.git("add", "src/staged.js")
        self.write("src/loose.js", "export const loose = true;\n")
        record = (self.plan / "_progress.json").read_bytes()
        status = self.git("status", "--porcelain")

        self.done("resume")
        self.done("resume", SLUG, "--json")

        self.assertEqual((self.plan / "_progress.json").read_bytes(), record)
        self.assertEqual(self.git("status", "--porcelain"), status)

    # --- unusable requests ---

    def test_unusable_requests_exit_2_with_the_cause(self) -> None:
        self.assertIn("not a plan slug", self.refused("phase", "../elsewhere", "1"))
        self.assertIn("no plan directory", self.refused("phase", "nowhere", "1"))
        self.assertIn("1 to 5", self.refused("phase", SLUG, "6"))
        self.assertIn("1 to 5", self.refused("phase", SLUG, "0"))
        self.assertIn("status", self.refused("task", SLUG, "2", "done"))
        self.assertIn("not a task id", self.refused("task", SLUG, "a/b", "started"))
        self.assertIn("no plan directory", self.refused("resume", "nowhere"))
        self.refused("phase", SLUG)
        self.refused("phase", SLUG, "three")
        self.refused("retreat", SLUG)

    def test_a_record_that_is_not_valid_is_refused_and_left_alone(self) -> None:
        for broken in ("{ not json", '{"version": 1}', '{"phase": 2, "tasks": {"2": {"status": "finished"}}}'):
            (self.plan / "_progress.json").write_text(broken, encoding="utf-8")

            self.refused("phase", SLUG, "3")
            self.refused("task", SLUG, "2", "started")
            self.refused("resume", SLUG)

            self.assertEqual((self.plan / "_progress.json").read_text(encoding="utf-8"), broken)

    def test_a_directory_that_is_not_a_checkout_is_refused(self) -> None:
        plain = Path(self.scratch.name).resolve() / "plain"
        (plain / ".claude" / "plans" / SLUG).mkdir(parents=True)

        self.assertIn("not a git checkout", self.refused("phase", SLUG, "1", cwd=plain))
        self.assertIn("not a git checkout", self.refused("--root", str(plain), "resume"))
        self.assertIn("not a directory", self.refused("--root", str(plain / "absent"), "resume"))

    def test_root_names_the_checkout_from_anywhere(self) -> None:
        result = self.run_script("--root", str(self.root), "phase", SLUG, "1", cwd=self.root.parent)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.record()["phase"], 1)

    def test_the_wrapper_runs_the_script(self) -> None:
        result = subprocess.run([str(WRAPPER), "resume"], cwd=str(self.root), capture_output=True, text=True)

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout.strip(), "no recorded run")

    def record_or_empty(self) -> Dict[str, Any]:
        path = self.plan / "_progress.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


if __name__ == "__main__":
    unittest.main()
