#!/usr/bin/env python3
"""Tests for bin/vaultlib.py.

The vault's mode decides whether a global tool may ever write next to a project's notes, or touch a
project's history at all, so every mode is built for real in a throwaway directory: a vault outside
any repository, one a project neither versions nor ignores, one it versions, one it ignores, and one
that is a repository of its own.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
import vaultlib  # noqa: E402


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def make_project(with_git: bool = True) -> Path:
    root = Path(tempfile.mkdtemp()).resolve()
    vault = root / ".claude" / "kb"
    (vault / "Decisions").mkdir(parents=True)
    (vault / "To DO.md").write_text("## Now\n")
    if with_git:
        git(root, "init", "-q", "-b", "main")
        git(root, "config", "user.email", "tests@example.com")
        git(root, "config", "user.name", "Tests")
        git(root, "config", "commit.gpgsign", "false")
    return root


class StateIsolated(unittest.TestCase):
    def setUp(self) -> None:
        self.state = str(Path(tempfile.mkdtemp()).resolve())
        self.saved = os.environ.get("CLAUDE_VAULT_STATE")
        os.environ["CLAUDE_VAULT_STATE"] = self.state

    def tearDown(self) -> None:
        if self.saved is None:
            os.environ.pop("CLAUDE_VAULT_STATE", None)
        else:
            os.environ["CLAUDE_VAULT_STATE"] = self.saved


class ModeTests(StateIsolated):
    def test_a_vault_outside_any_repository_keeps_its_machine_files_in_state(self) -> None:
        root = make_project(with_git=False)
        vault = vaultlib.locate(root)
        self.assertEqual((vault.path, vault.mode), (root / ".claude" / "kb", "no-git"))
        self.assertEqual(vault.machine_file("Inbox.md"), Path(self.state) / vault.slug / "Inbox.md")

    def test_a_vault_the_project_neither_versions_nor_ignores_is_untracked(self) -> None:
        vault = vaultlib.locate(make_project())
        self.assertEqual(vault.mode, "untracked")
        self.assertTrue(str(vault.machine_file(".anchors.json")).startswith(self.state))

    def test_a_vault_the_project_versions_never_holds_a_machine_file(self) -> None:
        root = make_project()
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "the vault")
        vault = vaultlib.locate(root)
        self.assertEqual(vault.mode, "tracked")
        self.assertFalse(str(vault.machine_file("Inbox.md")).startswith(str(root)))

    def test_a_vault_the_project_ignores_holds_its_machine_files(self) -> None:
        root = make_project()
        (root / ".gitignore").write_text("/.claude/kb/\n")
        vault = vaultlib.locate(root)
        self.assertEqual(vault.mode, "ignored")
        self.assertEqual(vault.machine_file("Inbox.md"), root / ".claude" / "kb" / "Inbox.md")

    def test_a_vault_that_is_a_repository_of_its_own_holds_its_machine_files(self) -> None:
        root = make_project()
        git(root / ".claude" / "kb", "init", "-q")
        vault = vaultlib.locate(root)
        self.assertEqual(vault.mode, "own-repo")
        self.assertEqual(vault.machine_file(".anchors.json"), root / ".claude" / "kb" / ".anchors.json")

    def test_a_subdirectory_finds_its_projects_vault(self) -> None:
        root = make_project()
        (root / "src" / "deep").mkdir(parents=True)
        self.assertEqual(vaultlib.locate(root / "src" / "deep").root, root)

    def test_a_project_without_a_vault_has_none(self) -> None:
        self.assertIsNone(vaultlib.locate(tempfile.mkdtemp()))
        self.assertIsNone(vaultlib.locate("/nonexistent/place"))


class OwnershipLockAndDisplayTests(StateIsolated):
    def test_a_project_with_its_own_hook_for_the_event_is_left_to_it(self) -> None:
        root = Path(tempfile.mkdtemp())
        (root / ".claude").mkdir()
        (root / ".claude" / "settings.json").write_text('{"hooks": {"SessionEnd": []}}')
        self.assertTrue(vaultlib.project_owns(root, "SessionEnd"))
        self.assertFalse(vaultlib.project_owns(root, "SessionStart"))
        self.assertFalse(vaultlib.project_owns(Path(tempfile.mkdtemp()), "SessionEnd"))

    def test_a_lock_is_exclusive_until_it_goes_stale(self) -> None:
        lock = Path(tempfile.mkdtemp()) / "nested" / "x.lock"
        self.assertTrue(vaultlib.take_lock(lock, stale=600))
        self.assertFalse(vaultlib.take_lock(lock, stale=600))
        old = time.time() - 1000
        os.utime(lock, (old, old))
        self.assertTrue(vaultlib.take_lock(lock, stale=600))

    def test_a_path_is_shown_relative_inside_the_project_and_home_anchored_outside_it(self) -> None:
        root = Path(tempfile.mkdtemp()).resolve()
        vault = vaultlib.Vault(root=root, path=root / "kb", mode="no-git")
        self.assertEqual(vault.shown(root / "kb" / "Inbox.md"), "kb/Inbox.md")
        self.assertEqual(vault.shown(Path.home() / ".claude" / "x"), "~/.claude/x")

    def test_the_kill_switches_are_read_from_the_environment(self) -> None:
        os.environ["CLAUDE_NO_VAULT_TOOLS"] = "1"
        os.environ["CLAUDE_VAULT_NO_SPAWN"] = "1"
        try:
            self.assertTrue(vaultlib.disabled())
            self.assertFalse(vaultlib.spawning_allowed())
        finally:
            os.environ.pop("CLAUDE_NO_VAULT_TOOLS")
            os.environ.pop("CLAUDE_VAULT_NO_SPAWN")
        self.assertFalse(vaultlib.disabled())


if __name__ == "__main__":
    unittest.main()
