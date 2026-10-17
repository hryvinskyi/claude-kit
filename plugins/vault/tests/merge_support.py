"""Shared by the vault_merge tests: the plugin's bin/ on the import path, the command git runs, and
git kept away from this machine's own configuration."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict
from unittest import mock

BIN = Path(__file__).resolve().parent.parent / "bin"
if str(BIN) not in sys.path:
    sys.path.insert(0, str(BIN))
COMMAND = BIN / "vault-merge"

GITATTRIBUTES = """/To[[:space:]]DO.md merge=vault-keyed
/Inbox.md merge=vault-keyed
/Deferred[[:space:]]external[[:space:]]actions.md merge=vault-keyed
/Decisions/Decisions[[:space:]]MOC.md merge=vault-keyed
/.anchors.json merge=vault-stamps
/Modules/*.md merge=vault-generated
/Bridges/*.md merge=vault-generated
/Plugins/*.md merge=vault-generated
"""
BEGIN = r"<!--\s*example:generated:start\s*-->"
END = r"<!--\s*example:generated:end\s*-->"


def git_env(home: Path) -> Dict[str, str]:
    """An environment in which git reads no global or system configuration and no hook's repository."""
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("GIT_") and key not in ("HOME", "XDG_CONFIG_HOME")}
    env.update({"HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(home / "gitconfig"),
                "GIT_AUTHOR_NAME": "Tests", "GIT_AUTHOR_EMAIL": "tests@example.com",
                "GIT_COMMITTER_NAME": "Tests", "GIT_COMMITTER_EMAIL": "tests@example.com"})
    return env


def git(cwd: Path, env: Dict[str, str], *args: str, check: bool = True) -> subprocess.CompletedProcess:
    done = subprocess.run(["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True, timeout=60)
    if check and done.returncode != 0:
        raise AssertionError("git %s failed: %s%s" % (" ".join(args), done.stdout, done.stderr))
    return done


def register_drivers(repo: Path, env: Dict[str, str]) -> None:
    """The three drivers and the region markers, as an installer registers them in a clone."""
    for name in ("keyed", "stamps", "generated"):
        git(repo, env, "config", "merge.vault-%s.name" % name, "vault-merge %s" % name)
        git(repo, env, "config", "merge.vault-%s.driver" % name, "'%s' %s %%O %%A %%B %%P" % (COMMAND, name))
    git(repo, env, "config", "vault-merge.generatedBegin", BEGIN)
    git(repo, env, "config", "vault-merge.generatedEnd", END)


class IsolatedGitTestCase(unittest.TestCase):
    """Every git the code under test runs reads the configuration this test writes, nothing else."""

    def setUp(self) -> None:
        super().setUp()
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.home = Path(holder.name).resolve()
        (self.home / "gitconfig").write_text("", encoding="utf-8")
        patched = mock.patch.dict(os.environ, git_env(self.home), clear=True)
        patched.start()
        self.addCleanup(patched.stop)

    def git_config(self, text: str) -> None:
        """The global configuration every git run in this test reads."""
        (self.home / "gitconfig").write_text(text, encoding="utf-8")
