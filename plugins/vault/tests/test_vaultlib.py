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
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"
sys.path.insert(0, str(BIN))
import vaultlib  # noqa: E402

# A process that takes a lock, says so, and keeps it until it is killed or its time is up.
HOLDER = """
import sys, time
sys.path.insert(0, sys.argv[1])
import vaultlib
from pathlib import Path
held = vaultlib.claim(Path(sys.argv[2]))
print("held" if held else "busy", flush=True)
time.sleep(float(sys.argv[3]))
"""

# A process that waits for a common start, then takes the lock four times; each turn proves it is
# alone by creating a marker no other holder may have, and records an overlap when it is not.
RACER = """
import os, sys, time
sys.path.insert(0, sys.argv[1])
import vaultlib
from pathlib import Path
lock, work, start = Path(sys.argv[2]), Path(sys.argv[3]), float(sys.argv[4])
time.sleep(max(0.0, start - time.time()))
for _ in range(4):
    with vaultlib.holding(lock, wait=60.0, poll=0.005) as held:
        if held is None:
            sys.exit(3)
        try:
            fd = os.open(str(work / "inside"), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            (work / "overlap").write_text("x")
            continue
        time.sleep(0.02)
        os.close(fd)
        os.unlink(str(work / "inside"))
        with open(str(work / "turns"), "a") as fh:
            fh.write("%d\\n" % os.getpid())
"""


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


def resolver(prints: str) -> Path:
    """A stand-in for find-vault.sh that names whatever vault it is told to, however wrong."""
    script = Path(tempfile.mkdtemp()) / "find-vault.sh"
    script.write_text("#!/bin/sh\nprintf '%s\\n' " + "'" + prints.replace("'", "'\\''") + "'\n")
    script.chmod(0o755)
    return script


class ConfinementTests(StateIsolated):
    """A vault lies strictly inside its project, whatever the resolver says, and a project's own
    repository is never taken for the vault's."""

    def test_the_project_root_or_a_place_outside_it_is_never_a_vault(self) -> None:
        root = make_project()
        sibling = root.parent / (root.name + "-sibling")
        (sibling / "Decisions").mkdir(parents=True)
        git(sibling, "init", "-q")
        os.symlink(str(sibling), str(root / "elsewhere"))
        os.symlink(".", str(root / "self"))
        os.symlink("..", str(root / "up"))
        for named in (".", "./", "..", "../" + sibling.name, str(sibling), str(root), "elsewhere", "self", "up",
                      ".claude/../.."):
            with self.subTest(named=named), unittest.mock.patch.object(vaultlib, "FIND_VAULT", resolver(named)):
                self.assertIsNone(vaultlib.locate(root))

    def test_a_vault_inside_the_project_is_still_found_through_a_link_that_stays_inside(self) -> None:
        root = make_project()
        os.symlink(".claude/kb", str(root / "kb"))
        with unittest.mock.patch.object(vaultlib, "FIND_VAULT", resolver("kb")):
            vault = vaultlib.locate(root)
        self.assertEqual(vault.path, root / "kb")

    def test_a_work_tree_of_the_projects_own_repository_is_not_a_vault_of_its_own(self) -> None:
        root = make_project()
        (root / "README.md").write_text("x\n")
        git(root, "add", "README.md")
        git(root, "commit", "-q", "-m", "init")
        (root / ".claude" / "kb" / "To DO.md").unlink()
        (root / ".claude" / "kb" / "Decisions").rmdir()
        git(root, "worktree", "add", "-q", "-b", "notes", str(root / ".claude" / "kb"))
        (root / ".claude" / "kb" / "Decisions").mkdir()
        (root / ".claude" / "kb" / "To DO.md").write_text("## Now\n")
        self.assertNotEqual(vaultlib.locate(root).mode, "own-repo")

    def test_a_git_directory_git_cannot_read_does_not_make_a_vault_its_own_repository(self) -> None:
        root = make_project()
        (root / ".claude" / "kb" / ".git").mkdir()
        self.assertNotEqual(vaultlib.locate(root).mode, "own-repo")

    def test_a_linked_work_tree_of_a_separate_vault_repository_is_its_own_repository(self) -> None:
        root = make_project()
        shutil.rmtree(str(root / ".claude" / "kb"))
        notes = Path(tempfile.mkdtemp()).resolve() / "notes"
        notes.mkdir()
        git(notes, "init", "-q", "-b", "main")
        (notes / "To DO.md").write_text("## Now\n")
        (notes / "Decisions").mkdir()
        (notes / "Decisions" / "README.md").write_text("x\n")
        git(notes, "add", "-A")
        git(notes, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "notes")
        git(notes, "worktree", "add", "-q", "-b", "here", str(root / ".claude" / "kb"))
        self.assertEqual(vaultlib.locate(root).mode, "own-repo")

    def test_a_repository_named_by_the_environment_is_not_taken_for_the_one_a_path_names(self) -> None:
        root = make_project()
        git(root / ".claude" / "kb", "init", "-q")
        with unittest.mock.patch.dict(os.environ, {"GIT_DIR": str(root / ".git"),
                                                   "GIT_INDEX_FILE": str(root / ".git" / "index")}):
            vault = vaultlib.locate(root / ".claude")
            self.assertEqual((vault.root, vault.mode), (root, "own-repo"))
            code, top = vaultlib.git_out(vault.path, "rev-parse", "--show-toplevel")
        self.assertEqual(Path(top.strip()).resolve(), root / ".claude" / "kb")


class StateDirectoryTests(StateIsolated):
    def test_projects_whose_paths_differ_only_in_punctuation_keep_apart(self) -> None:
        base = Path(tempfile.mkdtemp()).resolve()
        for one, other in (("sites/shop.dk", "sites/shop-dk"), ("a/b-c", "a/b/c"), ("x y", "x_y")):
            with self.subTest(one=one, other=other):
                first = vaultlib.Vault(root=base / one, path=base / one / "kb", mode="no-git")
                second = vaultlib.Vault(root=base / other, path=base / other / "kb", mode="no-git")
                self.assertEqual(first.legacy_slug, second.legacy_slug, "the fixture must collide the old way")
                self.assertNotEqual(first.state, second.state)

    def test_a_state_directory_named_the_old_way_is_adopted_with_what_it_holds(self) -> None:
        root = Path(tempfile.mkdtemp()).resolve() / "shop.dk"
        vault = vaultlib.Vault(root=root, path=root / "kb", mode="no-git")
        legacy = Path(self.state) / vault.legacy_slug
        legacy.mkdir()
        (legacy / "Inbox.md").write_text("an entry\n")
        self.assertNotEqual(vault.state, legacy)
        self.assertEqual((vault.state / "Inbox.md").read_text(), "an entry\n")
        self.assertFalse(legacy.exists())
        self.assertEqual((vault.state / vaultlib.OWNER_FILE).read_text().strip(), str(root))

    def test_a_state_directory_another_project_claimed_is_left_to_it(self) -> None:
        base = Path(tempfile.mkdtemp()).resolve()
        first = vaultlib.Vault(root=base / "shop.dk", path=base / "shop.dk" / "kb", mode="no-git")
        second = vaultlib.Vault(root=base / "shop-dk", path=base / "shop-dk" / "kb", mode="no-git")
        legacy = Path(self.state) / first.legacy_slug
        legacy.mkdir()
        (legacy / "Inbox.md").write_text("the first project's entry\n")
        adopted = first.state
        self.assertTrue((adopted / "Inbox.md").is_file())
        legacy.mkdir()
        (legacy / vaultlib.OWNER_FILE).write_text(str(base / "elsewhere") + "\n")
        (legacy / "Inbox.md").write_text("a third project's entry\n")
        self.assertFalse((second.state / "Inbox.md").exists())
        self.assertEqual((legacy / "Inbox.md").read_text(), "a third project's entry\n")
        self.assertEqual((adopted / "Inbox.md").read_text(), "the first project's entry\n")


class OwnershipLockAndDisplayTests(StateIsolated):
    def test_a_project_with_its_own_hook_for_the_event_is_left_to_it(self) -> None:
        root = Path(tempfile.mkdtemp())
        (root / ".claude").mkdir()
        (root / ".claude" / "settings.json").write_text('{"hooks": {"SessionEnd": []}}')
        self.assertTrue(vaultlib.project_owns(root, "SessionEnd"))
        self.assertFalse(vaultlib.project_owns(root, "SessionStart"))
        self.assertFalse(vaultlib.project_owns(Path(tempfile.mkdtemp()), "SessionEnd"))

    def test_a_lock_is_exclusive_while_held_and_free_once_released(self) -> None:
        lock = Path(tempfile.mkdtemp()) / "nested" / "x.lock"
        held = vaultlib.claim(lock)
        self.assertIsNotNone(held)
        self.assertIsNone(vaultlib.claim(lock))
        old = time.time() - 100000
        os.utime(lock, (old, old))
        self.assertIsNone(vaultlib.claim(lock), "an old lock file is no reason to take a lock somebody holds")
        held.release()
        self.assertFalse(lock.exists())
        again = vaultlib.claim(lock)
        self.assertIsNotNone(again)
        again.release()

    def test_a_held_lock_is_waited_for_and_released_when_the_block_ends(self) -> None:
        lock = Path(tempfile.mkdtemp()) / "x.lock"
        first = vaultlib.holding(lock)
        self.assertIsNotNone(first.__enter__())
        waits: list = []

        def other_finishes(seconds: float) -> None:
            waits.append(seconds)
            first.__exit__(None, None, None)

        with vaultlib.holding(lock, wait=30.0, sleep=other_finishes) as held:
            self.assertIsNotNone(held)
            self.assertTrue(lock.exists())
        self.assertEqual(waits, [0.25])
        self.assertFalse(lock.exists())

    def test_a_lock_that_stays_taken_yields_none_once_the_wait_is_over(self) -> None:
        lock = Path(tempfile.mkdtemp()) / "x.lock"
        now = [0.0]

        def tick(seconds: float) -> None:
            now[0] += seconds

        with vaultlib.holding(lock):
            with vaultlib.holding(lock, wait=1.0, sleep=tick, clock=lambda: now[0]) as held:
                self.assertIsNone(held)
        self.assertEqual(now[0], 1.0)

    def test_a_holder_never_removes_a_lock_file_that_is_no_longer_its_own(self) -> None:
        lock = Path(tempfile.mkdtemp()) / "x.lock"
        with vaultlib.holding(lock) as held:
            self.assertIsNotNone(held)
            lock.unlink()
            lock.write_text("another process's lock")
        self.assertEqual(lock.read_text(), "another process's lock")

    def test_a_lock_whose_holder_was_killed_is_free(self) -> None:
        lock = Path(tempfile.mkdtemp()) / "x.lock"
        holder = subprocess.Popen([sys.executable, "-c", HOLDER, str(BIN), str(lock), "60"],
                                  stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "held")
            self.assertIsNone(vaultlib.claim(lock))
        finally:
            holder.kill()
            holder.wait()
            holder.stdout.close()
        self.assertTrue(lock.exists(), "a killed holder leaves its lock file behind")
        held = vaultlib.claim(lock)
        self.assertIsNotNone(held, "the lock of a process that died must not wait to go stale")
        held.release()

    def test_processes_racing_for_a_lock_left_behind_never_hold_it_at_once(self) -> None:
        work = Path(tempfile.mkdtemp())
        lock = work / "x.lock"
        lock.write_text("left behind by a process that died")
        old = time.time() - 100000
        os.utime(lock, (old, old))
        start = time.time() + 1.5
        racers = [subprocess.Popen([sys.executable, "-c", RACER, str(BIN), str(lock), str(work), str(start)])
                  for _ in range(8)]
        for racer in racers:
            self.assertEqual(racer.wait(timeout=120), 0)
        self.assertFalse((work / "overlap").exists(), "two processes held the lock at once")
        self.assertEqual(len((work / "turns").read_text().split()), 8 * 4)

    def test_a_waiter_that_read_the_lock_late_never_takes_it_from_its_new_holder(self) -> None:
        work = Path(tempfile.mkdtemp())
        lock = work / "x.lock"
        lock.write_text("left behind by a process that died")
        old = time.time() - 100000
        os.utime(lock, (old, old))
        real_stat, real_path_stat = os.stat, Path.stat
        read = threading.Event()

        def delayed(path, found):
            if threading.current_thread().name == "late" and str(path) == str(lock) and not read.is_set():
                read.set()
                time.sleep(0.5)  # descheduled between reading the lock and acting on what it read
            return found

        def stat(path, *args, **kwargs):
            return delayed(path, real_stat(path, *args, **kwargs))

        def path_stat(path, *args, **kwargs):
            return delayed(path, real_path_stat(path, *args, **kwargs))

        inside: list = []
        overlap: list = []
        turns: list = []

        def turn() -> None:
            with vaultlib.holding(lock, wait=10.0, poll=0.01) as held:
                if held is None:
                    return
                turns.append(threading.current_thread().name)
                if inside:
                    overlap.append(threading.current_thread().name)
                inside.append(1)
                time.sleep(0.8)
                inside.pop()

        with unittest.mock.patch.object(os, "stat", stat), unittest.mock.patch.object(Path, "stat", path_stat):
            late = threading.Thread(target=turn, name="late")
            late.start()
            read.wait(5)
            first = threading.Thread(target=turn, name="first")
            first.start()
            late.join()
            first.join()
        self.assertTrue(read.is_set())
        self.assertEqual(sorted(turns), ["first", "late"])
        self.assertEqual(overlap, [], "the lock was held twice at once")

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
