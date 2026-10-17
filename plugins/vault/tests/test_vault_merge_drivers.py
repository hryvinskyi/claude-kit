#!/usr/bin/env python3
"""Tests for the stamps and generated merge drivers and the vault-merge command (bin/vault_merge/).

Pinned: stamps merge per (note, file) — kept, one side's, the changed one over a deletion, dropped
when both changed it — and are written exactly as the vault check writes them; a generated note's
conflicts are resolved with the incoming side only when every one lies inside a region the clone's
markers delimit, and the note is then listed once in the git dir's `vault-regenerate`; the command
writes the merged file over %A and exits 0 or 1, falls back to git's text merge and its exit status
when a driver fails, refuses an unknown command, and `selfcheck` passes a file that comes back
byte-identical. Fixtures are synthetic.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path
from typing import Any, Dict, Tuple

import merge_support
import vault_check
from vault_merge import cli
from vault_merge.driver import MergeInput
from vault_merge.generated import REGENERATE, GeneratedDriver
from vault_merge.gitmerge import Git
from vault_merge.keyed import ANNOTATION
from vault_merge.stamps import StampsDriver


def stamp(blob: str, commit: str = "c1", context: str = "x1") -> Dict[str, str]:
    return {"blob": blob, "commit": commit, "context": context}


def stamps_file(notes: Dict[str, Any]) -> bytes:
    return vault_check.render_stamps(notes).encode("utf-8")


BASE_STAMPS = {
    "Modules/billing.md": {"src/Invoice.php": stamp("b1"), "src/Ledger.php": stamp("b2")},
    "Modules/export.md": {"src/Export.php": stamp("b3")},
}


class StampsTests(merge_support.IsolatedGitTestCase):
    def merge(self, current: Dict[str, Any], incoming: Dict[str, Any],
              base: Dict[str, Any] = BASE_STAMPS) -> Tuple[Dict[str, Any], bytes, list]:
        outcome = StampsDriver().merge(MergeInput(stamps_file(base), stamps_file(current), stamps_file(incoming),
                                                  ".anchors.json"))
        self.assertTrue(outcome.resolved)
        return json.loads(outcome.merged)["notes"], outcome.merged, outcome.notes

    def changed(self, note: str, path: str, value: Any) -> Dict[str, Any]:
        notes = json.loads(json.dumps(BASE_STAMPS))
        if value is None:
            del notes[note][path]
        else:
            notes.setdefault(note, {})[path] = value
        return notes

    def test_changes_to_different_entries_both_land(self) -> None:
        current = self.changed("Modules/billing.md", "src/Invoice.php", stamp("b1", "c2"))
        incoming = self.changed("Modules/export.md", "src/Export.php", stamp("b9", "c3"))
        notes, _, report = self.merge(current, incoming)
        self.assertEqual(notes["Modules/billing.md"]["src/Invoice.php"]["commit"], "c2")
        self.assertEqual(notes["Modules/export.md"]["src/Export.php"]["blob"], "b9")
        self.assertEqual(report, [])

    def test_the_union_of_new_entries_and_new_notes(self) -> None:
        current = self.changed("Modules/billing.md", "src/Tax.php", stamp("b4"))
        incoming = self.changed("Plugins/search.md", "src/Index.php", stamp("b5"))
        notes, _, _ = self.merge(current, incoming)
        self.assertIn("src/Tax.php", notes["Modules/billing.md"])
        self.assertIn("src/Index.php", notes["Plugins/search.md"])

    def test_an_entry_changed_differently_on_both_sides_is_dropped(self) -> None:
        current = self.changed("Modules/billing.md", "src/Invoice.php", stamp("b1", "c2"))
        incoming = self.changed("Modules/billing.md", "src/Invoice.php", stamp("b1", "c3"))
        notes, _, report = self.merge(current, incoming)
        self.assertNotIn("src/Invoice.php", notes["Modules/billing.md"])
        self.assertIn("src/Ledger.php", notes["Modules/billing.md"])
        self.assertEqual(len(report), 1)

    def test_an_entry_added_on_both_sides_differently_is_dropped_and_alike_is_kept(self) -> None:
        added = self.changed("Modules/billing.md", "src/Tax.php", stamp("b4"))
        notes, _, _ = self.merge(added, self.changed("Modules/billing.md", "src/Tax.php", stamp("b5")))
        self.assertNotIn("src/Tax.php", notes["Modules/billing.md"])
        notes, _, _ = self.merge(added, added)
        self.assertIn("src/Tax.php", notes["Modules/billing.md"])

    def test_a_deletion_against_no_change_deletes_and_against_a_change_keeps_the_change(self) -> None:
        deleted = self.changed("Modules/export.md", "src/Export.php", None)
        notes, _, _ = self.merge(deleted, self.changed("Modules/billing.md", "src/Tax.php", stamp("b4")))
        self.assertNotIn("Modules/export.md", notes, "a note left with no stamps is not written")
        changed = self.changed("Modules/export.md", "src/Export.php", stamp("b8", "c4"))
        for current, incoming in ((deleted, changed), (changed, deleted)):
            notes, _, _ = self.merge(current, incoming)
            self.assertEqual(notes["Modules/export.md"]["src/Export.php"]["blob"], "b8")

    def test_the_result_is_laid_out_by_the_vault_checks_writer(self) -> None:
        current = self.changed("Modules/billing.md", "src/Invoice.php", stamp("b1", "c2"))
        incoming = self.changed("Modules/export.md", "src/Export.php", stamp("b9", "c3"))
        notes, raw, _ = self.merge(current, incoming)
        self.assertEqual(raw, stamps_file(notes))

    def test_a_file_added_on_both_sides_merges_from_an_empty_base(self) -> None:
        outcome = StampsDriver().merge(MergeInput(b"", stamps_file({"a.md": {"x": stamp("1")}}),
                                                  stamps_file({"b.md": {"y": stamp("2")}}), ".anchors.json"))
        self.assertEqual(sorted(json.loads(outcome.merged)["notes"]), ["a.md", "b.md"])

    def test_a_version_that_is_not_a_stamps_file_is_refused(self) -> None:
        for broken in (b"{not json", b"[]", b'{"notes": {"a.md": []}}'):
            with self.assertRaises(ValueError):
                StampsDriver().merge(MergeInput(stamps_file(BASE_STAMPS), broken,
                                                stamps_file(self.changed("a.md", "x", stamp("1"))), ".anchors.json"))


NOTE = """---
type: module
---
# billing

<!-- example:generated:start -->
| Fact | Value |
|---|---|
| classes | 10 |
| routes | 4 |
<!-- example:generated:end -->

## Purpose

Bills customers once a month.

## Runbook

Rerun the invoice job.
"""


class GeneratedTests(merge_support.IsolatedGitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.repo = self.home / "vault"
        self.repo.mkdir()
        env = merge_support.git_env(self.home)
        merge_support.git(self.repo, env, "init", "-q")
        merge_support.git(self.repo, env, "config", "vault-merge.generatedBegin", merge_support.BEGIN)
        merge_support.git(self.repo, env, "config", "vault-merge.generatedEnd", merge_support.END)
        self.driver = GeneratedDriver(Git(self.repo))
        self.listing = self.repo / ".git" / REGENERATE

    def merge(self, current: str, incoming: str) -> Tuple[str, bool]:
        outcome = self.driver.merge(MergeInput(NOTE.encode(), current.encode(), incoming.encode(),
                                               "Modules/billing.md"))
        return outcome.merged.decode(), outcome.resolved

    def test_conflicts_inside_the_region_take_the_incoming_side_and_list_the_note(self) -> None:
        current = NOTE.replace("| 10 |", "| 11 |").replace("| 4 |", "| 5 |")
        incoming = NOTE.replace("| 10 |", "| 12 |").replace("| 4 |", "| 6 |")
        merged, resolved = self.merge(current, incoming)
        self.assertTrue(resolved)
        self.assertEqual(merged, incoming)
        self.assertEqual(self.listing.read_text(encoding="utf-8"), "Modules/billing.md\n")
        self.merge(current, incoming)
        self.assertEqual(self.listing.read_text(encoding="utf-8"), "Modules/billing.md\n", "listed once")

    def test_the_region_resolves_while_prose_edits_elsewhere_merge_cleanly(self) -> None:
        current = NOTE.replace("| 10 |", "| 11 |").replace("once a month", "on the first of the month")
        incoming = NOTE.replace("| 10 |", "| 12 |").replace("invoice job", "invoice job by hand")
        merged, resolved = self.merge(current, incoming)
        self.assertTrue(resolved)
        self.assertIn("| 12 |", merged)
        self.assertIn("on the first of the month", merged)
        self.assertIn("by hand", merged)

    def test_a_conflict_in_the_prose_is_left_to_a_person(self) -> None:
        current = NOTE.replace("| 10 |", "| 11 |").replace("once a month", "every month")
        incoming = NOTE.replace("| 10 |", "| 12 |").replace("once a month", "each month")
        merged, resolved = self.merge(current, incoming)
        self.assertFalse(resolved)
        self.assertIn("<<<<<<< current", merged)
        self.assertIn(">>>>>>> incoming", merged)
        self.assertFalse(self.listing.exists())

    def test_a_conflict_over_a_region_marker_is_left_to_a_person(self) -> None:
        current = NOTE.replace("| 4 |\n<!-- example:generated:end -->", "| 5 |\n<!--  example:generated:end  -->")
        incoming = NOTE.replace("| 4 |", "| 6 |")
        merged, resolved = self.merge(current, incoming)
        self.assertFalse(resolved)
        self.assertIn("<<<<<<< current", merged)

    def test_edits_on_either_side_of_an_untouched_marker_are_no_conflict(self) -> None:
        current = NOTE.replace("<!-- example:generated:end -->\n", "| owner | a |\n<!-- example:generated:end -->\n")
        incoming = NOTE.replace("<!-- example:generated:end -->\n", "<!-- example:generated:end -->\nNew prose.\n")
        merged, resolved = self.merge(current, incoming)
        self.assertTrue(resolved)
        self.assertIn("| owner | a |\n<!-- example:generated:end -->\nNew prose.\n", merged)
        self.assertFalse(self.listing.exists())

    def test_a_clean_merge_lists_nothing(self) -> None:
        merged, resolved = self.merge(NOTE.replace("| 10 |", "| 11 |"), NOTE.replace("invoice job", "job"))
        self.assertTrue(resolved)
        self.assertFalse(self.listing.exists())

    def test_the_diff3_conflict_style_is_read_too(self) -> None:
        self.git_config("[merge]\n\tconflictStyle = diff3\n")
        merged, resolved = self.merge(NOTE.replace("| 10 |", "| 11 |"), NOTE.replace("| 10 |", "| 12 |"))
        self.assertTrue(resolved)
        self.assertEqual(merged, NOTE.replace("| 10 |", "| 12 |"))

    def test_without_markers_in_the_config_the_driver_refuses(self) -> None:
        merge_support.git(self.repo, merge_support.git_env(self.home), "config", "--unset", "vault-merge.generatedEnd")
        with self.assertRaises(RuntimeError):
            self.merge(NOTE.replace("| 10 |", "| 11 |"), NOTE.replace("| 10 |", "| 12 |"))


class CommandTests(merge_support.IsolatedGitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.base, self.current, self.incoming = (self.home / name for name in ("O", "A", "B"))

    def run_command(self, *args: str) -> Tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(args), out=out, err=err)
        return code, out.getvalue(), err.getvalue()

    def versions(self, base: bytes, current: bytes, incoming: bytes) -> None:
        for path, data in ((self.base, base), (self.current, current), (self.incoming, incoming)):
            path.write_bytes(data)

    def test_a_merge_is_written_over_the_current_file(self) -> None:
        base = b"## Now\n\n- [ ] **#1 a**\n- [ ] **#2 b**\n"
        self.versions(base, base.replace(b"#1 a", b"#1 aa"), base.replace(b"#2 b", b"#2 bb"))
        code, _, err = self.run_command("keyed", str(self.base), str(self.current), str(self.incoming), "To DO.md")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.current.read_bytes(), b"## Now\n\n- [ ] **#1 aa**\n- [ ] **#2 bb**\n")
        self.assertEqual(sorted(p.name for p in self.home.iterdir() if p.name.startswith(".vault-merge")), [],
                         "no temporary file is left behind")

    def test_a_row_with_two_versions_is_reported_and_still_resolved(self) -> None:
        base = b"- [ ] **#1 a**\n"
        self.versions(base, b"- [ ] **#1 b**\n", b"- [ ] **#1 c**\n")
        code, _, err = self.run_command("keyed", str(self.base), str(self.current), str(self.incoming), "To DO.md")
        self.assertEqual(code, 0)
        self.assertIn("To DO.md: 1 row has two versions", err)
        self.assertIn(ANNOTATION.encode(), self.current.read_bytes())

    def test_a_driver_that_fails_falls_back_to_gits_text_merge_and_its_status(self) -> None:
        base = b"line one\nline two\n\xff\n"
        current, incoming = base.replace(b"two", b"2"), base.replace(b"two", b"zwei")
        self.versions(base, current, incoming)
        expected, conflicts = Git().merge_file(current, base, incoming)
        code, _, err = self.run_command("keyed", str(self.base), str(self.current), str(self.incoming), "To DO.md")
        self.assertEqual(code, conflicts)
        self.assertGreater(code, 0)
        self.assertEqual(self.current.read_bytes(), expected)
        self.assertIn("could not merge To DO.md (UnicodeDecodeError", err)

    def test_a_fallback_without_conflicts_exits_zero(self) -> None:
        base = b"{broken\nline two\nline three\nline four\n"
        self.versions(base, base.replace(b"two", b"2"), base.replace(b"four", b"4"))
        code, _, _ = self.run_command("stamps", str(self.base), str(self.current), str(self.incoming), ".anchors.json")
        self.assertEqual(code, 0)
        self.assertEqual(self.current.read_bytes(), b"{broken\nline 2\nline three\nline 4\n")

    def test_unknown_commands_and_wrong_arguments_are_refused(self) -> None:
        self.assertEqual(self.run_command("nope")[0], 2)
        self.assertEqual(self.run_command()[0], 2)
        self.assertEqual(self.run_command("keyed", "only-one")[0], 2)

    def test_selfcheck_passes_a_file_that_comes_back_identical(self) -> None:
        board = self.home / "To DO.md"
        board.write_bytes(b"# Board\r\n\r\n## Now\r\n- [ ] **#1 a**\r\n- [ ] **example-org/example-repo#1 b**\r\n"
                          b"- [ ] **#1 again**")
        code, out, _ = self.run_command("selfcheck", str(board))
        self.assertEqual(code, 0)
        self.assertIn("identical", out)
        self.assertIn("3 items · 2 distinct item keys (2 by issue reference, 1 of them repo-qualified", out)
        self.assertIn("1 keys repeated (1 extra rows)", out)

    def test_selfcheck_fails_a_file_it_cannot_read(self) -> None:
        broken = self.home / "Inbox.md"
        broken.write_bytes(b"\xff\xfe")
        code, out, _ = self.run_command("selfcheck", str(broken), str(self.home / "missing.md"))
        self.assertEqual(code, 1)
        self.assertEqual(out.count("FAIL"), 2)

    def test_the_command_runs_under_an_isolated_interpreter(self) -> None:
        board = self.home / "To DO.md"
        board.write_text("- [ ] **#1 a**\n", encoding="utf-8")
        done = subprocess.run([str(merge_support.COMMAND), "selfcheck", str(board)], capture_output=True,
                              text=True, timeout=60, cwd=str(self.home))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("identical", done.stdout)


if __name__ == "__main__":
    import unittest

    unittest.main()
