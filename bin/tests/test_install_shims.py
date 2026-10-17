#!/usr/bin/env python3
"""Tests for bin/install-shims.sh.

Each test builds a kit clone in a temporary directory from this clone's real commands (the vault
plugin's `bin/`, the board-queue plugin's `bin/` and `lib/`, the installer and its template), points
`HOME` at a fresh directory, installs, and then runs the shims the way a scheduled job or a project
script does: by absolute path, from another directory. Node is a recording stand-in, so nothing here
needs the queue's dependencies.

Run from the kit root: python3 -m unittest discover -s bin/tests
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent.parent
SHIMS = ("board-queue", "board-queue-mcp", "find-vault", "vault-check", "vault-capture", "vault-search")


def fake_clone(where: Path) -> Path:
    """A kit clone holding the real commands, with the queue's dependency directory present."""
    clone = where / "kit"
    (clone / "bin").mkdir(parents=True)
    for name in ("install-shims.sh", "shim.sh.template"):
        shutil.copy2(KIT / "bin" / name, clone / "bin" / name)
    shutil.copytree(KIT / "plugins" / "vault" / "bin", clone / "plugins" / "vault" / "bin")
    for part in ("bin", "lib"):
        shutil.copytree(KIT / "plugins" / "board-queue" / part, clone / "plugins" / "board-queue" / part)
    (clone / "plugins" / "board-queue" / "node_modules").mkdir()
    return clone


class InstallShimsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.clone = fake_clone(self.tmp)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.shims = self.home / ".local" / "bin"
        self.node_dir = self.tmp / "node-bin"
        self.node_dir.mkdir()
        recorder = self.node_dir / "node"
        recorder.write_text('#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$RECORD_TO"\n',
                            encoding="utf-8")
        recorder.chmod(0o755)
        self.env = {"HOME": str(self.home), "PATH": f"{self.node_dir}:/usr/bin:/bin",
                    "RECORD_TO": str(self.tmp / "record")}

    def install(self, *args: str, clone: Path | None = None) -> subprocess.CompletedProcess:
        script = (clone or self.clone) / "bin" / "install-shims.sh"
        return subprocess.run([str(script), *args], capture_output=True, text=True, env=self.env,
                              cwd=str(self.tmp), timeout=60)

    def run_shim(self, name: str, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([str(self.shims / name), *args], capture_output=True, text=True, env=self.env,
                              cwd=str(cwd or self.tmp), timeout=60)

    def project_with_vault(self) -> Path:
        project = self.tmp / "project"
        (project / "kb" / "Decisions").mkdir(parents=True)
        (project / "kb" / "To DO.md").write_text("## Now\n", encoding="utf-8")
        return project

    def test_every_shim_is_written_and_runs_the_clones_copy(self) -> None:
        done = self.install()

        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for name in SHIMS:
            self.assertTrue(os.access(self.shims / name, os.X_OK), name)
        project = self.project_with_vault()
        found = self.run_shim("find-vault", str(project))
        self.assertEqual((found.returncode, found.stdout), (0, "kb\n"), found.stderr)
        checked = self.run_shim("vault-check", "--check", "--root", str(project))
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertIn("vault-check:", checked.stdout)

    def test_the_queue_shims_reach_the_queue_entry_points_in_the_clone(self) -> None:
        self.install()
        queue_bin = self.clone / "plugins" / "board-queue" / "bin"

        self.assertEqual(self.run_shim("board-queue", "status", "--json").returncode, 0)
        self.assertEqual((self.tmp / "record").read_text(encoding="utf-8").splitlines(),
                         [str(queue_bin / "board-queue.ts"), "status", "--json"])
        self.assertEqual(self.run_shim("board-queue-mcp").returncode, 0)
        self.assertEqual((self.tmp / "record").read_text(encoding="utf-8").splitlines(),
                         [str(queue_bin / "board-queue-mcp.ts")])

    def test_a_second_run_changes_nothing(self) -> None:
        self.install()
        before = {name: (self.shims / name).stat().st_mtime_ns for name in SHIMS}

        again = self.install()

        self.assertEqual(again.returncode, 0)
        self.assertNotIn("write ", again.stdout)
        self.assertEqual({name: (self.shims / name).stat().st_mtime_ns for name in SHIMS}, before)

    def test_another_clone_re_points_the_shims(self) -> None:
        self.install()
        other = fake_clone(self.tmp / "other")

        moved = self.install(clone=other)

        self.assertEqual(moved.returncode, 0, moved.stdout)
        self.assertIn("re-point find-vault", moved.stdout)
        self.assertIn(str(other / "plugins" / "vault" / "bin" / "find-vault"),
                      (self.shims / "find-vault").read_text(encoding="utf-8"))

    def test_a_file_it_did_not_write_is_left_alone_and_the_run_refuses(self) -> None:
        self.shims.mkdir(parents=True)
        mine = self.shims / "find-vault"
        mine.write_text("#!/bin/sh\necho mine\n", encoding="utf-8")

        refused = self.install()

        self.assertEqual(refused.returncode, 1)
        self.assertIn(f"{mine} exists and was not written by this script", refused.stdout)
        self.assertEqual(mine.read_text(encoding="utf-8"), "#!/bin/sh\necho mine\n")
        self.assertTrue((self.shims / "vault-check").is_file(), "the other shims are still written")

    def test_check_reports_what_is_missing_and_passes_once_installed(self) -> None:
        missing = self.install("--check")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("would write find-vault", missing.stdout)
        self.assertFalse(self.shims.exists(), "a check writes nothing")

        self.install()
        self.assertEqual(self.install("--check").returncode, 0)

    def test_a_clone_missing_a_command_is_refused(self) -> None:
        (self.clone / "plugins" / "vault" / "bin" / "vault-search").unlink()

        refused = self.install()

        self.assertEqual(refused.returncode, 1)
        self.assertIn("vault-search: the clone has no executable", refused.stdout)

    def test_it_says_when_the_directory_is_not_on_the_search_path(self) -> None:
        self.assertIn("is not on PATH", self.install().stdout)
        self.env["PATH"] = f"{self.shims}:{self.env['PATH']}"
        self.assertNotIn("is not on PATH", self.install().stdout)

    def test_another_directory_can_be_named(self) -> None:
        self.env["SHIM_DIR"] = str(self.tmp / "elsewhere")

        self.assertEqual(self.install().returncode, 0)
        self.assertTrue((self.tmp / "elsewhere" / "board-queue").is_file())
        self.assertFalse(self.shims.exists())

    def test_uninstall_removes_only_its_own_shims(self) -> None:
        self.install()
        (self.shims / "find-vault").write_text("#!/bin/sh\necho mine\n", encoding="utf-8")

        removed = self.install("--uninstall")

        self.assertEqual(removed.returncode, 0)
        self.assertEqual(sorted(p.name for p in self.shims.iterdir()), ["find-vault"])


if __name__ == "__main__":
    unittest.main()
