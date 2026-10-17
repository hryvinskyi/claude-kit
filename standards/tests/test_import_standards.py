"""Runs import_standards.py against a throwaway home directory and a copy of the standards."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SCRIPT = HERE / "import_standards.py"
STANDARDS = HERE / "CLAUDE.standards.md"


class ImportStandardsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="import-standards-")).resolve()
        self.home = self.tmp / "home"
        (self.home / ".claude").mkdir(parents=True)
        self.kit = self.tmp / "kit clone" / "standards"
        self.kit.mkdir(parents=True)
        shutil.copy2(SCRIPT, self.kit / SCRIPT.name)
        shutil.copy2(STANDARDS, self.kit / STANDARDS.name)
        self.user_md = self.home / ".claude" / "CLAUDE.md"
        self.line = "@" + str(self.kit / STANDARDS.name).replace(" ", "\\ ")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp)

    def run_script(self, *args: str, script: Path | None = None, config_dir: Path | None = None) -> subprocess.CompletedProcess[str]:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
        env["HOME"] = str(self.home)
        if config_dir is not None:
            env["CLAUDE_CONFIG_DIR"] = str(config_dir)
        return subprocess.run(
            [sys.executable, "-I", str(script or self.kit / SCRIPT.name), *args],
            env=env, capture_output=True, text=True, check=False,
        )

    def test_creates_the_file_with_the_import_when_there_is_none(self) -> None:
        result = self.run_script()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(self.line + "\n", self.user_md.read_text(encoding="utf-8"))

    def test_appends_once_and_keeps_what_was_there(self) -> None:
        self.user_md.write_text("# Mine\n## Commits\nSign them.\n", encoding="utf-8")
        self.assertEqual(0, self.run_script().returncode)
        first = self.user_md.read_text(encoding="utf-8")
        self.assertEqual("# Mine\n## Commits\nSign them.\n\n" + self.line + "\n", first)
        second = self.run_script()
        self.assertEqual(0, second.returncode)
        self.assertIn("present", second.stdout)
        self.assertEqual(first, self.user_md.read_text(encoding="utf-8"))

    def test_writes_through_a_profile_link_and_keeps_the_link(self) -> None:
        real = self.home / ".claude" / "CLAUDE.md"
        real.write_text("# Mine\n", encoding="utf-8")
        profile = self.home / ".claude-other"
        profile.mkdir()
        (profile / "CLAUDE.md").symlink_to(real)
        self.assertEqual(0, self.run_script(config_dir=profile).returncode)
        self.assertTrue((profile / "CLAUDE.md").is_symlink())
        self.assertTrue(real.read_text(encoding="utf-8").endswith(self.line + "\n"))

    def test_follows_the_active_configuration_directory(self) -> None:
        profile = self.home / ".claude-other"
        profile.mkdir()
        self.assertEqual(0, self.run_script(config_dir=profile).returncode)
        self.assertEqual(self.line + "\n", (profile / "CLAUDE.md").read_text(encoding="utf-8"))
        self.assertFalse(self.user_md.exists())

    def test_refuses_when_the_standards_are_already_written_inline(self) -> None:
        inline = "# Mine\n## Tests run code\nEvery test runs code.\n"
        self.user_md.write_text(inline, encoding="utf-8")
        result = self.run_script()
        self.assertEqual(1, result.returncode)
        self.assertIn("twice", result.stdout)
        self.assertEqual(inline, self.user_md.read_text(encoding="utf-8"))

    def test_refuses_an_import_of_another_clone(self) -> None:
        other = "# Mine\n\n@/elsewhere/standards/CLAUDE.standards.md\n"
        self.user_md.write_text(other, encoding="utf-8")
        result = self.run_script()
        self.assertEqual(1, result.returncode)
        self.assertIn("/elsewhere/standards/CLAUDE.standards.md", result.stdout)
        self.assertEqual(other, self.user_md.read_text(encoding="utf-8"))

    def test_refuses_a_double_import(self) -> None:
        self.user_md.write_text(self.line + "\n" + self.line + "\n", encoding="utf-8")
        result = self.run_script()
        self.assertEqual(1, result.returncode)
        self.assertIn("2 times", result.stdout)

    def test_a_path_in_a_code_span_or_fence_is_no_import(self) -> None:
        self.user_md.write_text("See `" + self.line + "`.\n```\n" + self.line + "\n```\n", encoding="utf-8")
        self.assertEqual(1, self.run_script("--check").returncode)
        self.assertEqual(0, self.run_script().returncode)
        self.assertEqual(0, self.run_script("--check").returncode)

    def test_check_reports_without_writing(self) -> None:
        result = self.run_script("--check")
        self.assertEqual(1, result.returncode)
        self.assertIn("absent", result.stdout)
        self.assertFalse(self.user_md.exists())

    def test_a_clone_under_the_home_directory_is_imported_through_tilde(self) -> None:
        kit = self.home / "src" / "kit" / "standards"
        kit.mkdir(parents=True)
        shutil.copy2(SCRIPT, kit / SCRIPT.name)
        shutil.copy2(STANDARDS, kit / STANDARDS.name)
        result = self.run_script("--print-line", script=kit / SCRIPT.name)
        self.assertEqual("@~/src/kit/standards/CLAUDE.standards.md\n", result.stdout)

    def test_spaces_in_the_path_are_escaped(self) -> None:
        result = self.run_script("--print-line")
        self.assertEqual(self.line + "\n", result.stdout)
        self.assertIn("kit\\ clone", result.stdout)

    def test_unknown_arguments_are_refused(self) -> None:
        self.assertEqual(2, self.run_script("--force").returncode)
        self.assertFalse(self.user_md.exists())


if __name__ == "__main__":
    unittest.main()
