#!/usr/bin/env python3
"""Tests for the plugin's hooks and commands as Claude Code and a shell run them.

`hooks/session_brief.sh`, `hooks/journal_nudge.py` and the `bin/` commands are started as separate
processes with `HOME` pointed at an empty directory, so a pass proves they find the vault, its tools and
the board queue through the plugin and the environment alone — nothing under a real `~/.claude` is read.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
BRIEF = PLUGIN / "hooks" / "session_brief.sh"
NUDGE = PLUGIN / "hooks" / "journal_nudge.py"
NODE_DIR = str(Path(shutil.which("node") or "/usr/bin/node").parent)


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)


class HookTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.project = self.tmp / "project"
        (self.project / "kb" / "Decisions").mkdir(parents=True)
        (self.project / "kb" / "Journal").mkdir()
        (self.project / "kb" / "To DO.md").write_text("## Now\n- [ ] ship the thing\n## Next\n", encoding="utf-8")
        self.env = {"HOME": str(self.home), "PATH": f"{NODE_DIR}:/usr/bin:/bin", "CLAUDE_VAULT_NO_SPAWN": "1",
                    "CLAUDE_VAULT_STATE": str(self.tmp / "state")}

    def run_file(self, args: list[str], stdin: str = "") -> subprocess.CompletedProcess:
        return subprocess.run(args, input=stdin, capture_output=True, text=True, env=self.env,
                              cwd=str(self.project), timeout=60)

    def queue_stub(self, answer: str) -> Path:
        stub = self.tmp / "queue" / "board-queue"
        stub.parent.mkdir()
        stub.write_text(f'#!/bin/sh\nprintf \'%s\\n\' "$*" > "{self.tmp}/queue-args"\nprintf \'{answer}\\n\'\n',
                        encoding="utf-8")
        stub.chmod(0o755)
        return stub

    def test_the_brief_finds_the_vault_through_the_plugin_and_names_its_commands(self) -> None:
        brief = self.run_file([str(BRIEF)])

        self.assertEqual(brief.returncode, 0, brief.stderr)
        self.assertIn("=== Knowledge-vault brief (kb/) ===", brief.stdout)
        self.assertIn("[NOW]  ship the thing", brief.stdout)
        self.assertIn("commands: /vault:todo /vault:decision /vault:journal /vault:wiki-sync", brief.stdout)
        self.assertIn("[VAULT] no copy off this machine", brief.stdout, "the capture brief ran from the plugin")

    def test_the_brief_leaves_a_project_with_its_own_session_start_hook_alone(self) -> None:
        (self.project / ".claude").mkdir()
        (self.project / ".claude" / "settings.json").write_text('{"hooks": {"SessionStart": []}}', encoding="utf-8")

        brief = self.run_file([str(BRIEF)])

        self.assertEqual((brief.returncode, brief.stdout), (0, ""))

    def test_the_brief_asks_the_board_queue_command_about_this_repository(self) -> None:
        git(self.project, "init", "-q")
        git(self.project, "remote", "add", "origin", "git@github.com:Example-Org/Example-Repo.git")
        self.env["BOARD_QUEUE_CLI"] = str(self.queue_stub("[BOARD QUEUE] queued 1"))

        brief = self.run_file([str(BRIEF)])

        self.assertIn("[BOARD QUEUE] queued 1", brief.stdout)
        self.assertEqual((self.tmp / "queue-args").read_text(encoding="utf-8"),
                         "brief --repo example-org/example-repo\n")

    def test_the_brief_finds_the_board_queue_command_on_the_search_path(self) -> None:
        git(self.project, "init", "-q")
        git(self.project, "remote", "add", "origin", "https://github.com/example-org/example-repo")
        stub = self.queue_stub("[BOARD QUEUE] held 2")
        self.env["PATH"] = f"{stub.parent}:{self.env['PATH']}"

        self.assertIn("[BOARD QUEUE] held 2", self.run_file([str(BRIEF)]).stdout)

    def test_the_brief_stays_quiet_about_a_queue_that_is_not_installed(self) -> None:
        git(self.project, "init", "-q")
        git(self.project, "remote", "add", "origin", "https://github.com/example-org/example-repo")

        brief = self.run_file([str(BRIEF)])

        self.assertEqual(brief.returncode, 0, brief.stderr)
        self.assertNotIn("BOARD QUEUE", brief.stdout)

    def transcript(self, edits: int) -> Path:
        path = self.tmp / "transcript.jsonl"
        line = {"message": {"content": [{"type": "tool_use", "name": "Edit", "input": {}}]}}
        path.write_text("\n".join(json.dumps(line) for _ in range(edits)) + "\n", encoding="utf-8")
        return path

    def nudge(self, edits: int) -> subprocess.CompletedProcess:
        session = f"test-{uuid.uuid4()}"
        self.addCleanup(lambda: Path(f"/tmp/claude-journal-nudge-{session}").unlink(missing_ok=True))
        payload = {"session_id": session, "cwd": str(self.project),
                   "transcript_path": str(self.transcript(edits))}
        return self.run_file(["python3", str(NUDGE)], stdin=json.dumps(payload))

    def test_the_nudge_finds_the_vault_through_the_plugin_and_offers_the_journal_command(self) -> None:
        nudged = self.nudge(edits=6)

        self.assertEqual(nudged.returncode, 0, nudged.stderr)
        decision = json.loads(nudged.stdout)
        self.assertEqual(decision["decision"], "block")
        self.assertIn("/vault:journal", decision["reason"])
        self.assertIn("kb/Journal/", decision["reason"])

    def test_the_nudge_stays_quiet_after_little_work(self) -> None:
        self.assertEqual(self.nudge(edits=2).stdout, "")


class CommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.project = self.tmp / "project"
        (self.project / "kb" / "Decisions").mkdir(parents=True)
        (self.project / "kb" / "To DO.md").write_text("## Now\n", encoding="utf-8")
        self.env = {"HOME": str(self.tmp), "PATH": "/usr/bin:/bin", "CLAUDE_VAULT_NO_SPAWN": "1",
                    "CLAUDE_VAULT_STATE": str(self.tmp / "state")}

    def command(self, name: str, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([str(PLUGIN / "bin" / name), *args], capture_output=True, text=True,
                              env=self.env, cwd=str(self.project), timeout=60)

    def test_find_vault_prints_the_vault_and_answers_none_outside_one(self) -> None:
        self.assertEqual(self.command("find-vault").stdout, "kb\n")
        self.assertEqual(self.command("find-vault", str(self.tmp)).returncode, 1)

    def test_vault_check_measures_the_vault(self) -> None:
        checked = self.command("vault-check", "--check")

        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertIn("vault-check: ", checked.stdout)

    def test_vault_capture_prints_the_brief_lines(self) -> None:
        self.assertIn("[VAULT] no copy off this machine", self.command("vault-capture", "--brief").stdout)

    def test_vault_search_does_nothing_without_its_search_engine(self) -> None:
        searched = self.command("vault-search", "ensure")

        self.assertEqual((searched.returncode, searched.stdout), (0, ""), searched.stderr)

    def test_a_command_reached_through_a_link_still_finds_its_siblings(self) -> None:
        link = self.tmp / "links" / "find-vault"
        link.parent.mkdir()
        os.symlink(PLUGIN / "bin" / "find-vault", link)

        found = subprocess.run([str(link)], capture_output=True, text=True, env=self.env,
                               cwd=str(self.project), timeout=60)

        self.assertEqual(found.stdout, "kb\n", found.stderr)


if __name__ == "__main__":
    unittest.main()
