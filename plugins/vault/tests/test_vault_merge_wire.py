#!/usr/bin/env python3
"""Tests of `vault-merge wire` and `vault-merge unwire`, run as an installer runs them, on real clones.

Pinned: a check writes nothing and says what is pending; wiring registers the three drivers and the
region markers, writes and commits the attributes only when asked and only when the vault has none,
and a second run finds nothing to do; a vault whose attributes differ, whose keyed file would not
survive the driver, which is mid-merge, or which is not a clone's top is refused with nothing
changed; a generated assignment without markers is refused; a clone wired this way merges two
branches that edit neighbouring rows of the board cleanly — git consumes the configuration — and
unwiring removes the configuration and only the attributes it was given. Fixtures are synthetic.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Dict, List

import merge_support
from merge_support import BEGIN, COMMAND, END, GITATTRIBUTES, git

BOARD = """# Board

## Now

- [ ] **#1 — Fix the invoice rounding** — billing
- [ ] **#2 — Totals are cached too long** — billing

## Done
"""
NOTE = """# Billing

<!-- example:generated:start -->
classes: 3
<!-- example:generated:end -->

Prose.
"""


class WireTests(merge_support.IsolatedGitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.env: Dict[str, str] = dict(os.environ)
        self.vault = self.home / "vault"
        self.vault.mkdir()
        git(self.vault, self.env, "init", "-q", "-b", "main")
        (self.vault / "To DO.md").write_text(BOARD, encoding="utf-8")
        (self.vault / "Modules").mkdir()
        (self.vault / "Modules" / "Billing.md").write_text(NOTE, encoding="utf-8")
        (self.vault / ".anchors.json").write_text("{}\n", encoding="utf-8")
        git(self.vault, self.env, "add", "-A")
        git(self.vault, self.env, "commit", "-q", "-m", "seed")
        self.attributes = self.home / "gitattributes"
        self.attributes.write_text(GITATTRIBUTES, encoding="utf-8")

    def run_wire(self, *args: str, command: str = "wire") -> subprocess.CompletedProcess:
        return subprocess.run([str(COMMAND), command, "--vault", str(self.vault), *args], capture_output=True,
                              text=True, env=self.env, timeout=120)

    def wire_args(self, *extra: str) -> List[str]:
        return ["--command", str(COMMAND), "--attributes", str(self.attributes), "--commit",
                "--generated-begin", BEGIN, "--generated-end", END,
                "--expect", "To DO.md=keyed", "--expect", ".anchors.json=stamps",
                "--expect", "Modules/Billing.md=generated", *extra]

    def local_config(self) -> str:
        return git(self.vault, self.env, "config", "--local", "--list").stdout

    def head(self) -> str:
        return git(self.vault, self.env, "rev-parse", "HEAD").stdout.strip()

    def test_a_check_writes_nothing_and_reports_what_is_pending(self) -> None:
        before = (self.head(), self.local_config())

        done = self.run_wire("--check", *self.wire_args())

        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("would write .gitattributes and commit it", done.stdout)
        self.assertIn("would set merge.vault-keyed.driver", done.stdout)
        self.assertIn('check-attr merge -- "To DO.md": vault-keyed', done.stdout)
        self.assertEqual((self.head(), self.local_config()), before)
        self.assertFalse((self.vault / ".gitattributes").exists())

    def test_wiring_registers_the_drivers_commits_the_attributes_and_a_second_run_changes_nothing(self) -> None:
        done = self.run_wire(*self.wire_args())

        self.assertEqual(done.returncode, 0, done.stdout)
        get = lambda key: git(self.vault, self.env, "config", "--local", "--get", key).stdout.strip()
        self.assertEqual(get("merge.vault-keyed.driver"), "'%s' keyed %%O %%A %%B %%P" % COMMAND)
        self.assertEqual(get("merge.vault-stamps.name"), "vault-merge stamps")
        self.assertEqual(get("vault-merge.generatedBegin"), BEGIN)
        self.assertEqual((self.vault / ".gitattributes").read_text(encoding="utf-8"), GITATTRIBUTES)
        self.assertEqual(git(self.vault, self.env, "status", "--porcelain").stdout, "")
        after = (self.head(), self.local_config())

        again = self.run_wire("--check", *self.wire_args())
        rerun = self.run_wire(*self.wire_args())

        self.assertEqual(again.returncode, 0, again.stdout)
        self.assertEqual(rerun.returncode, 0, rerun.stdout)
        self.assertIn("nothing to change", rerun.stdout)
        self.assertEqual((self.head(), self.local_config()), after)

    def test_without_commit_a_vault_without_attributes_gets_the_drivers_and_no_file(self) -> None:
        done = self.run_wire("--command", str(COMMAND), "--attributes", str(self.attributes),
                             "--generated-begin", BEGIN, "--generated-end", END)

        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertIn("carries no .gitattributes yet", done.stdout)
        self.assertFalse((self.vault / ".gitattributes").exists())
        self.assertIn("merge.vault-keyed.driver=", self.local_config())

    def test_attributes_that_differ_are_refused_and_nothing_changes(self) -> None:
        (self.vault / ".gitattributes").write_text("/To[[:space:]]DO.md merge=union\n", encoding="utf-8")
        before = self.local_config()

        done = self.run_wire(*self.wire_args())

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("differs from the one given", done.stdout)
        self.assertEqual(self.local_config(), before)
        self.assertEqual((self.vault / ".gitattributes").read_text(encoding="utf-8"),
                         "/To[[:space:]]DO.md merge=union\n")

    def test_a_keyed_file_that_does_not_read_back_is_refused(self) -> None:
        (self.vault / "To DO.md").write_bytes(b"## Now\n- [ ] \xff broken\n")
        git(self.vault, self.env, "commit", "-q", "-am", "unreadable")
        before = self.local_config()

        done = self.run_wire(*self.wire_args())

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("the keyed driver must not merge it", done.stdout)
        self.assertEqual(self.local_config(), before)
        self.assertFalse((self.vault / ".gitattributes").exists())

    def test_generated_assignments_without_markers_are_refused(self) -> None:
        (self.vault / ".gitattributes").write_text(GITATTRIBUTES, encoding="utf-8")

        done = self.run_wire("--command", str(COMMAND))

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("are not both set", done.stdout)

    def test_a_vault_in_the_middle_of_a_merge_is_refused(self) -> None:
        git_dir = Path(git(self.vault, self.env, "rev-parse", "--absolute-git-dir").stdout.strip())
        (git_dir / "MERGE_HEAD").write_text(self.head() + "\n", encoding="utf-8")

        done = self.run_wire(*self.wire_args())

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("in the middle of a merge", done.stdout)

    def conflicting(self) -> str:
        """A commit on a side branch whose row edit conflicts with the one now on main."""
        git(self.vault, self.env, "checkout", "-q", "-b", "side")
        (self.vault / "To DO.md").write_text(BOARD.replace("\n", " (side)\n", 1), encoding="utf-8")
        git(self.vault, self.env, "commit", "-q", "-am", "side")
        side = self.head()
        git(self.vault, self.env, "checkout", "-q", "main")
        (self.vault / "To DO.md").write_text(BOARD.replace("\n", " (main)\n", 1), encoding="utf-8")
        git(self.vault, self.env, "commit", "-q", "-am", "main")
        return side

    def test_a_vault_in_the_middle_of_a_cherry_pick_or_a_revert_is_refused(self) -> None:
        side = self.conflicting()
        self.assertNotEqual(git(self.vault, self.env, "cherry-pick", side, check=False).returncode, 0)
        done = self.run_wire(*self.wire_args())
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("in the middle of a cherry-pick", done.stdout)
        self.assertNotIn("merge.vault-keyed", self.local_config())
        git(self.vault, self.env, "cherry-pick", "--abort")

        (self.vault / "To DO.md").write_text(BOARD.replace("\n", " (again)\n", 1), encoding="utf-8")
        git(self.vault, self.env, "commit", "-q", "-am", "again")
        self.assertNotEqual(git(self.vault, self.env, "revert", "--no-edit", "HEAD~1", check=False).returncode, 0)
        done = self.run_wire(*self.wire_args())
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("in the middle of a revert", done.stdout)
        self.assertNotIn("merge.vault-keyed", self.local_config())

    def test_a_directory_below_the_top_is_refused(self) -> None:
        done = subprocess.run([str(COMMAND), "wire", "--vault", str(self.vault / "Modules"), *self.wire_args()],
                              capture_output=True, text=True, env=self.env, timeout=120)

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("is not the top of a git repository", done.stdout)

    def test_a_missing_command_is_pending_in_a_check_and_refused_when_applying(self) -> None:
        missing = str(self.home / "bin" / "vault-merge")
        args = ["--command", missing, "--generated-begin", BEGIN, "--generated-end", END]

        checked = self.run_wire("--check", *args)
        applied = self.run_wire(*args)

        self.assertEqual(checked.returncode, 1, checked.stdout)
        self.assertEqual(applied.returncode, 2, applied.stdout)
        self.assertNotIn("merge.vault-keyed", self.local_config())

    def test_a_wired_clone_merges_neighbouring_row_edits_where_git_alone_conflicts(self) -> None:
        self.assertEqual(self.run_wire(*self.wire_args()).returncode, 0)
        git(self.vault, self.env, "checkout", "-q", "-b", "other")
        board = BOARD.replace("Fix the invoice rounding** — billing", "Fix the invoice rounding** — billing, alice")
        (self.vault / "To DO.md").write_text(board, encoding="utf-8")
        git(self.vault, self.env, "commit", "-q", "-am", "theirs")
        git(self.vault, self.env, "checkout", "-q", "main")
        board = BOARD.replace("cached too long** — billing", "cached too long** — billing, bob")
        (self.vault / "To DO.md").write_text(board, encoding="utf-8")
        git(self.vault, self.env, "commit", "-q", "-am", "ours")

        merged = git(self.vault, self.env, "merge", "-q", "--no-edit", "other", check=False)

        self.assertEqual(merged.returncode, 0, merged.stdout + merged.stderr)
        text = (self.vault / "To DO.md").read_text(encoding="utf-8")
        self.assertIn("billing, alice", text)
        self.assertIn("billing, bob", text)

    def test_unwire_removes_the_configuration_and_only_the_attributes_it_was_given(self) -> None:
        self.assertEqual(self.run_wire(*self.wire_args()).returncode, 0)

        checked = self.run_wire("--check", "--attributes", str(self.attributes), command="unwire")
        done = self.run_wire("--attributes", str(self.attributes), command="unwire")

        self.assertEqual(checked.returncode, 1, checked.stdout)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertNotIn("vault-merge", self.local_config())
        self.assertNotIn("merge.vault-", self.local_config())
        self.assertFalse((self.vault / ".gitattributes").exists())
        self.assertEqual(git(self.vault, self.env, "status", "--porcelain").stdout, "")

    def test_unwire_leaves_attributes_it_was_not_given(self) -> None:
        (self.vault / ".gitattributes").write_text("*.md merge=union\n", encoding="utf-8")

        done = self.run_wire("--attributes", str(self.attributes), command="unwire")

        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertTrue((self.vault / ".gitattributes").exists())
