#!/usr/bin/env python3
"""Tests for bin/vault_search.py.

qmd itself is replaced by a recorder, so what is pinned is the order of business: a project without an
index gets one in its own tree, excluded from git locally and never through a tracked file; the
collection covers the vault with a context for each folder that exists; a project whose index already
covers the vault is left alone; and a refresh never creates an index nobody asked for.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
import vault_search as vs  # noqa: E402
import vaultlib  # noqa: E402


class FakeQmd:
    def __init__(self, listing: str = "") -> None:
        self.calls: list[list[str]] = []
        self.listing = listing

    def __call__(self, args: list[str], cwd: Optional[Path] = None, timeout: int = 120,
                 env: Optional[dict] = None) -> tuple[int, str]:
        self.calls.append(args[1:])
        if args[1:] == ["init"]:
            (Path(cwd) / ".qmd").mkdir(exist_ok=True)
            (Path(cwd) / ".qmd" / "index.yml").write_text("collections: {}\n")
        if args[1:] == ["collection", "list"]:
            return 0, self.listing
        return 0, ""


class SearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = os.environ.get("CLAUDE_VAULT_STATE")
        os.environ["CLAUDE_VAULT_STATE"] = tempfile.mkdtemp()
        self.root = Path(tempfile.mkdtemp()).resolve() / "My Shop"
        (self.root / ".claude" / "kb" / "Decisions").mkdir(parents=True)
        (self.root / ".claude" / "kb" / "Journal").mkdir()
        (self.root / ".claude" / "kb" / "To DO.md").write_text("## Now\n")
        subprocess.run(["git", "-C", str(self.root), "init", "-q"], check=True)
        self.vault = vaultlib.locate(self.root)

    def tearDown(self) -> None:
        if self.saved is None:
            os.environ.pop("CLAUDE_VAULT_STATE", None)
        else:
            os.environ["CLAUDE_VAULT_STATE"] = self.saved

    def test_a_project_without_an_index_gets_one_of_its_own_excluded_locally(self) -> None:
        fake = FakeQmd()
        with unittest.mock.patch.object(vaultlib, "run", fake):
            self.assertTrue(vs.ensure(self.vault, "qmd"))
        name = "my-shop"
        self.assertEqual(fake.calls[0], ["init"])  # no index yet, so there is nothing to ask for its collections
        self.assertIn(["collection", "add", str(self.vault.path), "--name", name, "--mask", "**/*.md"], fake.calls)
        contexts = [c[2] for c in fake.calls if c[:2] == ["context", "add"]]
        self.assertEqual(contexts, [f"qmd://{name}", f"qmd://{name}/Decisions", f"qmd://{name}/Journal"])
        self.assertEqual(fake.calls[-1], ["embed"])
        self.assertIn(".qmd/", (self.root / ".git" / "info" / "exclude").read_text().splitlines())
        self.assertEqual(subprocess.run(["git", "-C", str(self.root), "status", "--porcelain"],
                                        capture_output=True, text=True).stdout.count(".qmd"), 0)

    def test_an_index_that_already_covers_the_vault_is_left_alone(self) -> None:
        (self.root / ".qmd").mkdir()
        (self.root / ".qmd" / "index.yml").write_text("x: 1\n")
        fake = FakeQmd(listing="Collections (1):\n\nmy-shop (qmd://my-shop/)\n  Pattern: **/*.md\n")
        with unittest.mock.patch.object(vaultlib, "run", fake):
            self.assertFalse(vs.ensure(self.vault, "qmd"))
        self.assertEqual(fake.calls, [["collection", "list"]])

    def test_a_refresh_brings_an_index_up_to_date_and_never_creates_one(self) -> None:
        fake = FakeQmd()
        with unittest.mock.patch.object(vaultlib, "run", fake):
            vs.refresh(self.vault, "qmd")
            self.assertEqual(fake.calls, [])
            (self.root / ".qmd").mkdir()
            (self.root / ".qmd" / "index.yml").write_text("x: 1\n")
            vs.refresh(self.vault, "qmd")
        self.assertEqual(fake.calls, [["update"], ["embed"], ["cleanup"]])

    def test_the_local_exclude_is_written_once(self) -> None:
        self.assertTrue(vs.exclude_locally(self.root, ".qmd/"))
        self.assertTrue(vs.exclude_locally(self.root, ".qmd/"))
        self.assertEqual((self.root / ".git" / "info" / "exclude").read_text().splitlines().count(".qmd/"), 1)
        self.assertFalse(vs.exclude_locally(Path(tempfile.mkdtemp()), ".qmd/"))


if __name__ == "__main__":
    unittest.main()
