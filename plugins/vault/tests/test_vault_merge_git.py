#!/usr/bin/env python3
"""Integration tests of the vault merge drivers through real git, in temporary repositories.

Pinned: the attribute patterns name the files with spaces in them (`git check-attr`) and nothing
beside them; with the drivers registered as an installer registers them, two branches editing
neighbouring rows of a board merge cleanly under `git merge` — where git's own text merge conflicts —
and so do two clones under `git pull --rebase`, which swaps the sides; a level-three block in a file
whose name has spaces merges too; review stamps merge as a union; a generated-region conflict is
resolved and the note listed in the git dir's `vault-regenerate`. Fixtures are synthetic.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

import merge_support
from merge_support import git

BOARD = """# Board

## Now

- [ ] **#1 — Fix the invoice rounding** — billing
- [ ] **#2 — Totals are cached too long** — billing
- [ ] **Rename the export job** — no ticket yet

## Done

- [x] **#3 — Retire the old importer**
"""

ACTIONS = """# Deferred actions

## Open

### #1: check the rounding on the stand

Run the invoice report.

### #2: purge the test workspace

Remove it by its id.
"""

NOTE = """# billing

<!-- example:generated:start -->
| classes | 10 |
<!-- example:generated:end -->

## Purpose

Bills customers once a month.
"""

STAMPS = {"Modules/billing.md": {"src/Invoice.php": {"blob": "b1", "commit": "c1", "context": "x1"}}}


class GitIntegrationTests(merge_support.IsolatedGitTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.env = merge_support.git_env(self.home)
        self.repo = self.home / "vault"
        self.repo.mkdir()
        git(self.repo, self.env, "init", "-q", "-b", "main")
        merge_support.register_drivers(self.repo, self.env)
        self.write(self.repo, {
            ".gitattributes": merge_support.GITATTRIBUTES,
            "To DO.md": BOARD,
            "Deferred external actions.md": ACTIONS,
            "Modules/billing.md": NOTE,
            ".anchors.json": json.dumps({"version": 1, "notes": STAMPS}, indent=1, sort_keys=True) + "\n",
        })
        self.commit(self.repo, "start")

    @staticmethod
    def write(repo: Path, files: Dict[str, str]) -> None:
        for name, text in files.items():
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def commit(self, repo: Path, message: str) -> None:
        git(repo, self.env, "add", "-A")
        git(repo, self.env, "commit", "-q", "-m", message)

    def edit(self, repo: Path, name: str, old: str, new: str) -> None:
        path = repo / name
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def branch_edits(self) -> None:
        """Two branches off main, each editing a neighbouring row of the board."""
        git(self.repo, self.env, "checkout", "-q", "-b", "left")
        self.edit(self.repo, "To DO.md", "rounding** — billing", "rounding** — billing and tax")
        self.commit(self.repo, "left edits #1")
        git(self.repo, self.env, "checkout", "-q", "-b", "right", "main")
        self.edit(self.repo, "To DO.md", "too long** — billing", "too long** — billing, owner found")
        self.commit(self.repo, "right edits #2")
        git(self.repo, self.env, "checkout", "-q", "left")

    def test_the_attribute_patterns_name_the_files_with_spaces(self) -> None:
        expected = {
            "To DO.md": "vault-keyed", "Inbox.md": "vault-keyed", "Deferred external actions.md": "vault-keyed",
            "Decisions/Decisions MOC.md": "vault-keyed", ".anchors.json": "vault-stamps",
            "Modules/billing.md": "vault-generated", "Bridges/billing-export.md": "vault-generated",
            "Plugins/search.md": "vault-generated", "Journal/To DO.md": "unspecified",
            "Modules/old/billing.md": "unspecified", "Decisions/2026-01-01 a record.md": "unspecified",
        }
        for path, value in expected.items():
            done = git(self.repo, self.env, "check-attr", "merge", "--", path)
            self.assertEqual(done.stdout, "%s: merge: %s\n" % (path, value))

    def test_neighbouring_rows_edited_on_two_branches_merge_cleanly(self) -> None:
        self.branch_edits()

        merged = git(self.repo, self.env, "merge", "--no-edit", "right", check=False)

        self.assertEqual(merged.returncode, 0, merged.stdout + merged.stderr)
        board = (self.repo / "To DO.md").read_text(encoding="utf-8")
        self.assertIn("billing and tax", board)
        self.assertIn("owner found", board)
        self.assertEqual(git(self.repo, self.env, "status", "--porcelain").stdout, "")

    def test_without_the_drivers_the_same_branches_conflict(self) -> None:
        self.branch_edits()
        git(self.repo, self.env, "config", "--remove-section", "merge.vault-keyed")

        merged = git(self.repo, self.env, "merge", "--no-edit", "right", check=False)

        self.assertNotEqual(merged.returncode, 0)
        self.assertIn("<<<<<<<", (self.repo / "To DO.md").read_text(encoding="utf-8"))

    def test_two_clones_rebasing_onto_each_other_keep_both_edits(self) -> None:
        remote = self.home / "remote.git"
        git(self.home, self.env, "clone", "-q", "--bare", str(self.repo), str(remote))
        clones = []
        for name in ("one", "two"):
            clone = self.home / name
            git(self.home, self.env, "clone", "-q", str(remote), str(clone))
            merge_support.register_drivers(clone, self.env)
            clones.append(clone)
        one, two = clones
        self.edit(one, "To DO.md", "rounding** — billing", "rounding** — billing and tax")
        self.edit(one, "Deferred external actions.md", "Run the invoice report.", "Run the January report.")
        self.commit(one, "one")
        git(one, self.env, "push", "-q", "origin", "main")
        self.edit(two, "To DO.md", "too long** — billing", "too long** — billing, owner found")
        self.edit(two, "To DO.md", "## Done\n\n", "## Done\n\n- [x] **#4 — Shipped the export**\n")
        self.edit(two, "Deferred external actions.md", "Remove it by its id.", "Remove it by its exact id.")
        self.commit(two, "two")

        pulled = git(two, self.env, "pull", "--rebase", "-q", "origin", "main", check=False)

        self.assertEqual(pulled.returncode, 0, pulled.stdout + pulled.stderr)
        board = (two / "To DO.md").read_text(encoding="utf-8")
        self.assertEqual(board, BOARD.replace("rounding** — billing", "rounding** — billing and tax")
                         .replace("too long** — billing", "too long** — billing, owner found")
                         .replace("## Done\n\n", "## Done\n\n- [x] **#4 — Shipped the export**\n"))
        actions = (two / "Deferred external actions.md").read_text(encoding="utf-8")
        self.assertIn("January report", actions)
        self.assertIn("exact id", actions)
        history = git(two, self.env, "log", "--format=%s").stdout.split()
        self.assertEqual(history, ["two", "one", "start"])

    def test_review_stamps_from_two_branches_are_united(self) -> None:
        git(self.repo, self.env, "checkout", "-q", "-b", "left")
        self.write(self.repo, {".anchors.json": json.dumps({"version": 1, "notes": dict(
            STAMPS, **{"Modules/export.md": {"src/Export.php": {"blob": "b2", "commit": "c2", "context": "x2"}}})},
            indent=1, sort_keys=True) + "\n"})
        self.commit(self.repo, "left stamps")
        git(self.repo, self.env, "checkout", "-q", "-b", "right", "main")
        self.write(self.repo, {".anchors.json": json.dumps({"version": 1, "notes": dict(
            STAMPS, **{"Plugins/search.md": {"src/Index.php": {"blob": "b3", "commit": "c3", "context": "x3"}}})},
            indent=1, sort_keys=True) + "\n"})
        self.commit(self.repo, "right stamps")
        git(self.repo, self.env, "checkout", "-q", "left")

        merged = git(self.repo, self.env, "merge", "--no-edit", "right", check=False)

        self.assertEqual(merged.returncode, 0, merged.stdout + merged.stderr)
        notes = json.loads((self.repo / ".anchors.json").read_text(encoding="utf-8"))["notes"]
        self.assertEqual(sorted(notes), ["Modules/billing.md", "Modules/export.md", "Plugins/search.md"])

    def test_a_generated_region_conflict_is_resolved_and_the_note_listed(self) -> None:
        git(self.repo, self.env, "checkout", "-q", "-b", "left")
        self.edit(self.repo, "Modules/billing.md", "| 10 |", "| 11 |")
        self.commit(self.repo, "left facts")
        git(self.repo, self.env, "checkout", "-q", "-b", "right", "main")
        self.edit(self.repo, "Modules/billing.md", "| 10 |", "| 12 |")
        self.commit(self.repo, "right facts")
        git(self.repo, self.env, "checkout", "-q", "left")

        merged = git(self.repo, self.env, "merge", "--no-edit", "right", check=False)

        self.assertEqual(merged.returncode, 0, merged.stdout + merged.stderr)
        self.assertIn("| 12 |", (self.repo / "Modules/billing.md").read_text(encoding="utf-8"))
        listing = Path(git(self.repo, self.env, "rev-parse", "--absolute-git-dir").stdout.strip()) / "vault-regenerate"
        self.assertEqual(listing.read_text(encoding="utf-8"), "Modules/billing.md\n")

    def test_a_prose_conflict_in_a_generated_note_stops_the_merge(self) -> None:
        git(self.repo, self.env, "checkout", "-q", "-b", "left")
        self.edit(self.repo, "Modules/billing.md", "once a month", "every month")
        self.commit(self.repo, "left prose")
        git(self.repo, self.env, "checkout", "-q", "-b", "right", "main")
        self.edit(self.repo, "Modules/billing.md", "once a month", "each month")
        self.commit(self.repo, "right prose")
        git(self.repo, self.env, "checkout", "-q", "left")

        merged = git(self.repo, self.env, "merge", "--no-edit", "right", check=False)

        self.assertNotEqual(merged.returncode, 0)
        self.assertIn("<<<<<<< current", (self.repo / "Modules/billing.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    import unittest

    unittest.main()
