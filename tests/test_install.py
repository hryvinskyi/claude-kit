#!/usr/bin/env python3
"""Tests for install.sh, run the way a person runs it, in a fake home directory.

Each test copies this clone into a temporary directory and runs its installer with `HOME` pointing at
a fresh directory and a search path whose `claude`, `npm` and `node` are stand-ins: `claude` keeps
marketplaces and plugins in a JSON file and logs every call, `npm ci` writes the hidden lockfile a
real install leaves, `node` reports the major version a test chooses. Nothing reaches the network or
this machine's own configuration.

Run from the kit root: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional

KIT = Path(__file__).resolve().parent.parent
FAKES = Path(__file__).resolve().parent / "fakes"
PLUGINS = ["architecture", "pipeline", "qa", "guards", "vault", "board-queue"]
SHIMS = ["board-queue", "board-queue-mcp", "find-vault", "vault-check", "vault-capture", "vault-search", "vault-merge"]

NPM = """#!/bin/sh
# npm ci --prefix DIR …: leaves the hidden lockfile a real install writes, and logs the call.
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
[ "$1" = ci ] && [ "$2" = --prefix ] || exit 1
mkdir -p "$3/node_modules"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["packages"].pop("", None); json.dump(d, open(sys.argv[2], "w"))' \\
  "$3/package-lock.json" "$3/node_modules/.package-lock.json"
"""
NODE = """#!/bin/sh
# node -p …: the major version the test chose; node --version: the same, spelled as node does.
case "$1" in
  -p) echo "$FAKE_NODE_MAJOR" ;;
  --version) echo "v$FAKE_NODE_MAJOR.0.0" ;;
  *) exit 1 ;;
esac
"""
MUTATING = (("plugin", "marketplace", "add"), ("plugin", "install"), ("plugin", "enable"))


def copy_kit(where: Path) -> Path:
    clone = where / "claude-kit"
    shutil.copytree(KIT, clone, symlinks=True,
                    ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__", ".DS_Store"))
    return clone


def snapshot(root: Path) -> Dict[str, bytes]:
    """Every file and link under `root`, by relative path, with its content or link target."""
    found: Dict[str, bytes] = {}
    for path in sorted(root.rglob("*")):
        key = str(path.relative_to(root))
        if path.is_symlink():
            found[key] = b"-> " + os.readlink(path).encode()
        elif path.is_file():
            found[key] = path.read_bytes()
    return found


class InstallTests(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.tmp = Path(holder.name).resolve()
        self.clone = copy_kit(self.tmp)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        shutil.copy2(FAKES / "claude", self.bin / "claude")
        for name, text in (("npm", NPM), ("node", NODE)):
            (self.bin / name).write_text(text, encoding="utf-8")
            (self.bin / name).chmod(0o755)
        self.state = self.tmp / "claude-state.json"
        self.claude_log = self.tmp / "claude.log"
        self.npm_log = self.tmp / "npm.log"
        self.env = {
            "HOME": str(self.home), "PATH": "%s:/usr/bin:/bin" % self.bin, "TMPDIR": str(self.tmp),
            "FAKE_CLAUDE_STATE": str(self.state), "FAKE_CLAUDE_LOG": str(self.claude_log),
            "FAKE_NPM_LOG": str(self.npm_log), "FAKE_NODE_MAJOR": "26", "PYTHONDONTWRITEBYTECODE": "1",
        }

    def install(self, *args: str, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
        return subprocess.run([str(self.clone / "install.sh"), *args], capture_output=True, text=True,
                              env=env or self.env, cwd=str(self.tmp), timeout=120)

    def claude_state(self) -> dict:
        return json.loads(self.state.read_text(encoding="utf-8")) if self.state.exists() else {}

    def claude_calls(self) -> List[List[str]]:
        if not self.claude_log.exists():
            return []
        return [line.split("\t") for line in self.claude_log.read_text(encoding="utf-8").splitlines()]

    def mutating_calls(self) -> List[List[str]]:
        return [call for call in self.claude_calls() if any(tuple(call[:len(m)]) == m for m in MUTATING)]

    def enabled(self) -> List[str]:
        return sorted(p["id"] for p in self.claude_state().get("plugins", []) if p["enabled"] and p["scope"] == "user")

    def policy_file(self) -> Path:
        return self.home / ".config" / "claude-kit" / "policies.toml"

    def test_a_check_in_a_fresh_home_reports_every_step_and_writes_nothing(self) -> None:
        done = self.install("--check")

        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        out = done.stdout
        for expected in ("would write board-queue", "would run npm ci", "would add %s as the marketplace claude-kit" % self.clone,
                         "would install and enable vault@claude-kit", "would add @", "would write %s" % self.policy_file()):
            self.assertIn(expected, out)
        self.assertEqual(snapshot(self.home), {})
        self.assertEqual(self.mutating_calls(), [])
        self.assertFalse((self.clone / "plugins" / "board-queue" / "node_modules").exists())

    def test_install_does_every_step_and_a_second_run_changes_nothing(self) -> None:
        done = self.install()

        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for name in SHIMS:
            self.assertTrue(os.access(self.home / ".local" / "bin" / name, os.X_OK), name)
        self.assertTrue((self.clone / "plugins" / "board-queue" / "node_modules" / ".package-lock.json").is_file())
        self.assertEqual(self.claude_state()["marketplaces"][0]["path"], str(self.clone))
        self.assertEqual(self.enabled(), sorted("%s@claude-kit" % p for p in PLUGINS))
        self.assertIn(["plugin", "marketplace", "add", str(self.clone), "--scope", "user"], self.claude_calls())
        self.assertIn(["plugin", "install", "board-queue@claude-kit", "--scope", "user"], self.claude_calls())
        memory = (self.home / ".claude" / "CLAUDE.md").read_text(encoding="utf-8")
        self.assertEqual(memory.count("CLAUDE.standards.md"), 1)
        policies = self.policy_file().read_text(encoding="utf-8")
        self.assertIn("forbid_assistant_commit_trailers = false\n", policies)
        self.assertIn("github_rest_only = false\n", policies)
        home_after, kit_after = snapshot(self.home), snapshot(self.clone)
        self.claude_log.unlink()
        self.npm_log.unlink()

        checked = self.install("--check")
        again = self.install()

        self.assertEqual(checked.returncode, 0, checked.stdout)
        self.assertIn("RESULT: everything is installed.", checked.stdout)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(self.mutating_calls(), [])
        self.assertFalse(self.npm_log.exists())
        self.assertEqual(snapshot(self.home), home_after)
        self.assertEqual(snapshot(self.clone), kit_after)

    def test_a_policy_file_that_exists_is_never_overwritten(self) -> None:
        self.policy_file().parent.mkdir(parents=True)
        self.policy_file().write_text("forbid_assistant_commit_trailers = true\n", encoding="utf-8")

        done = self.install()

        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.policy_file().read_text(encoding="utf-8"), "forbid_assistant_commit_trailers = true\n")

    def test_a_disabled_plugin_is_enabled_rather_than_installed_again(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        state = self.claude_state()
        for plugin in state["plugins"]:
            if plugin["id"] == "qa@claude-kit":
                plugin["enabled"] = False
        self.state.write_text(json.dumps(state), encoding="utf-8")
        self.claude_log.unlink()

        checked = self.install("--check")
        done = self.install()

        self.assertEqual(checked.returncode, 1)
        self.assertIn("would enable qa@claude-kit", checked.stdout)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertEqual(self.mutating_calls(), [["plugin", "enable", "qa@claude-kit", "--scope", "user"]])

    def test_a_marketplace_of_the_same_name_from_elsewhere_is_refused(self) -> None:
        elsewhere = copy_kit(self.tmp / "other")
        self.state.write_text(json.dumps({"marketplaces": [{"name": "claude-kit", "source": "directory",
                                                            "path": str(elsewhere)}], "plugins": []}), encoding="utf-8")

        checked = self.install("--check")
        done = self.install()

        self.assertEqual(checked.returncode, 2, checked.stdout)
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("already comes from %s" % elsewhere, done.stdout)
        self.assertEqual(self.mutating_calls(), [])
        self.assertFalse((self.home / ".claude" / "CLAUDE.md").exists())

    def test_node_is_required_only_when_board_queue_is_chosen(self) -> None:
        self.env["FAKE_NODE_MAJOR"] = "24"

        without = self.install("--plugins", "architecture,qa")
        refused = self.install("--check")

        self.assertEqual(without.returncode, 0, without.stdout + without.stderr)
        self.assertEqual(self.enabled(), ["architecture@claude-kit", "qa@claude-kit"])
        self.assertNotIn("node", without.stdout.split("== Prerequisites")[1].split("==")[0])
        self.assertEqual(refused.returncode, 2, refused.stdout)
        self.assertIn("board-queue needs 26 or newer", refused.stdout)

    def test_a_plugin_the_marketplace_does_not_list_is_refused(self) -> None:
        done = self.install("--plugins", "architecture,nonesuch")

        self.assertEqual(done.returncode, 2)
        self.assertIn("lists no plugin named nonesuch", done.stderr)
        self.assertEqual(self.claude_calls(), [])

    def test_skip_npm_leaves_the_dependencies_alone(self) -> None:
        done = self.install("--skip-npm")

        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertFalse(self.npm_log.exists())
        self.assertIn("left alone (--skip-npm)", done.stdout)

    def test_standards_written_inline_refuse_the_import_and_stop_the_run(self) -> None:
        memory = self.home / ".claude" / "CLAUDE.md"
        memory.parent.mkdir()
        memory.write_text("# Mine\n\n## Tests run code\n\nInline.\n", encoding="utf-8")

        done = self.install()

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("cannot take the import as it is", done.stdout)
        self.assertEqual(memory.read_text(encoding="utf-8"), "# Mine\n\n## Tests run code\n\nInline.\n")
        self.assertFalse(self.policy_file().exists())

    def test_a_file_in_a_shims_place_that_the_kit_did_not_write_is_refused(self) -> None:
        mine = self.home / ".local" / "bin" / "find-vault"
        mine.parent.mkdir(parents=True)
        mine.write_text("#!/bin/sh\necho mine\n", encoding="utf-8")

        done = self.install()

        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("was not written by this script", done.stdout)
        self.assertEqual(mine.read_text(encoding="utf-8"), "#!/bin/sh\necho mine\n")
        self.assertEqual(self.mutating_calls(), [])


if __name__ == "__main__":
    unittest.main()
