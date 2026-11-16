#!/usr/bin/env python3
"""Tests for bin/eval_plugins.py, run as the eval harness runs it: the script as a command, against a
fake kit and fake transcripts in a temporary directory, and its closure against this kit's own manifests.

What is pinned: the closure follows "dependencies" recursively and puts each dependency first, reads a
dependency given as an object or as name@marketplace, refuses an unknown plugin and a cycle; the check
passes a transcript that listed every plugin's skills and commands, discards one that is missing a
plugin (the case of a stack plugin passed without its own dependency) or that holds no listing, never
requires a command that disables model invocation, counts a plugin with nothing to list as
unverifiable, takes the union of several listings, and finds the transcript of a session from its
directory's real path and its session id.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

SCRIPT = Path(__file__).resolve().parent.parent / "bin" / "eval_plugins.py"
KIT = Path(__file__).resolve().parents[3]


def run(args: Sequence[str], env: Optional[Dict[str, str]] = None) -> Tuple[int, str, str]:
    """The script's exit status, standard output and standard error."""
    done = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        timeout=60,
    )
    return done.returncode, done.stdout, done.stderr


class FakeKit:
    """A kit clone in a temporary directory, with plugins written on demand."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def plugin(
        self,
        name: str,
        dependencies: Optional[List[object]] = None,
        skills: Sequence[str] = (),
        commands: Sequence[str] = (),
        hidden_commands: Sequence[str] = (),
    ) -> None:
        directory = self.root / "plugins" / name
        (directory / ".claude-plugin").mkdir(parents=True)
        manifest: Dict[str, object] = {"name": name}
        if dependencies is not None:
            manifest["dependencies"] = dependencies
        (directory / ".claude-plugin" / "plugin.json").write_text(json.dumps(manifest))
        for skill in skills:
            (directory / "skills" / skill).mkdir(parents=True)
            (directory / "skills" / skill / "SKILL.md").write_text(
                f"---\nname: {skill}\ndescription: >\n  a skill\n---\nbody\n"
            )
        for command in commands:
            (directory / "commands").mkdir(parents=True, exist_ok=True)
            (directory / "commands" / f"{command}.md").write_text("---\ndescription: a command\n---\nbody\n")
        for command in hidden_commands:
            (directory / "commands").mkdir(parents=True, exist_ok=True)
            (directory / "commands" / f"{command}.md").write_text(
                "---\ndescription: owner-run\ndisable-model-invocation: true\n---\nbody\n"
            )


def transcript(path: Path, *listings: Sequence[str]) -> Path:
    """A session transcript holding one skill_listing attachment per LISTINGS entry."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"type": "user", "message": {"role": "user", "content": "go"}})]
    for names in listings:
        lines.append(
            json.dumps(
                {
                    "type": "attachment",
                    "attachment": {
                        "type": "skill_listing",
                        "content": "".join(f"- {n}: text\n" for n in names),
                        "isInitial": True,
                        "names": list(names),
                    },
                }
            )
        )
    path.write_text("\n".join(lines) + "\n")
    return path


class ClosureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.kit = FakeKit(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def closure(self, *plugins: str) -> Tuple[int, List[str], str]:
        status, out, err = run(["closure", "--kit", str(self.kit.root), *plugins])
        return status, [Path(line).name for line in out.splitlines()], err

    def test_follows_dependencies_recursively_with_each_dependency_first(self) -> None:
        self.kit.plugin("core")
        self.kit.plugin("docs")
        self.kit.plugin("stack", dependencies=["core", "docs"])
        self.kit.plugin("runner", dependencies=["core"])
        self.kit.plugin("hooks")
        status, names, err = self.closure("runner", "hooks", "stack")
        self.assertEqual(0, status, err)
        self.assertEqual(["core", "runner", "hooks", "docs", "stack"], names)

    def test_reads_an_object_dependency_and_a_marketplace_suffix(self) -> None:
        self.kit.plugin("core")
        self.kit.plugin("docs")
        self.kit.plugin("stack", dependencies=[{"name": "core"}, "docs@some-marketplace"])
        status, names, err = self.closure("stack")
        self.assertEqual(0, status, err)
        self.assertEqual(["core", "docs", "stack"], names)

    def test_prints_absolute_plugin_directories(self) -> None:
        self.kit.plugin("core")
        status, out, err = run(["closure", "--kit", str(self.kit.root), "core"])
        self.assertEqual(0, status, err)
        printed = Path(out.strip())
        self.assertTrue(printed.is_absolute())
        self.assertTrue((printed / ".claude-plugin" / "plugin.json").is_file())

    def test_refuses_a_dependency_the_kit_does_not_hold(self) -> None:
        self.kit.plugin("stack", dependencies=["absent"])
        status, names, err = self.closure("stack")
        self.assertEqual(2, status)
        self.assertEqual([], names)
        self.assertIn("absent", json.loads(err)["error"])

    def test_refuses_a_cycle(self) -> None:
        self.kit.plugin("a", dependencies=["b"])
        self.kit.plugin("b", dependencies=["a"])
        status, _, err = self.closure("a")
        self.assertEqual(2, status)
        self.assertIn("cycle", json.loads(err)["error"])

    def test_this_kit_closes_every_plugin_over_its_own_dependencies(self) -> None:
        manifests = sorted((KIT / "plugins").glob("*/.claude-plugin/plugin.json"))
        self.assertTrue(manifests)
        for manifest in manifests:
            name = manifest.parent.parent.name
            with self.subTest(plugin=name):
                status, out, err = run(["closure", "--kit", str(KIT), name])
                self.assertEqual(0, status, err)
                names = [Path(line).name for line in out.splitlines()]
                self.assertEqual(name, names[-1])
                self.assertEqual(len(names), len(set(names)))
                for dependency in json.loads(manifest.read_text()).get("dependencies", []):
                    self.assertIn(dependency, names)
                    self.assertLess(names.index(dependency), names.index(name))


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.kit = FakeKit(root / "kit")
        self.kit.plugin("core", skills=["rubric-php", "rubric-js"])
        self.kit.plugin("docs", skills=["user-guide"])
        self.kit.plugin("stack", dependencies=["core", "docs"], skills=["stack-php"])
        self.kit.plugin("runner", dependencies=["core"], commands=["evals", "review"], hidden_commands=["feature"])
        self.kit.plugin("hooks")
        self.sessions = root / "sessions"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def check(self, path: Path, *plugins: str) -> Tuple[int, Dict[str, object], str]:
        status, out, err = run(["check", "--kit", str(self.kit.root), "--transcript", str(path), *plugins])
        return status, (json.loads(out) if out.strip() else {}), err

    def everything(self) -> List[str]:
        return [
            "core:rubric-php",
            "core:rubric-js",
            "docs:user-guide",
            "stack:stack-php",
            "runner:evals",
            "runner:review",
            "init",
        ]

    def test_passes_a_session_that_listed_every_plugin(self) -> None:
        path = transcript(self.sessions / "ok.jsonl", self.everything())
        status, result, err = self.check(path, "runner", "hooks", "stack")
        self.assertEqual(0, status, err)
        self.assertEqual("ok", result["verdict"])
        plugins = result["plugins"]
        assert isinstance(plugins, dict)
        self.assertEqual({"core", "docs", "stack", "runner", "hooks"}, set(plugins))
        self.assertEqual("unverifiable", plugins["hooks"]["status"])
        self.assertEqual("listed", plugins["runner"]["status"])
        self.assertEqual(2, plugins["runner"]["expected"])

    def test_discards_a_session_that_dropped_a_stack_plugin(self) -> None:
        dropped = [n for n in self.everything() if not n.startswith(("stack:", "docs:"))]
        path = transcript(self.sessions / "dropped.jsonl", dropped)
        status, result, _ = self.check(path, "runner", "hooks", "stack")
        self.assertEqual(1, status)
        self.assertEqual("discard", result["verdict"])
        plugins = result["plugins"]
        assert isinstance(plugins, dict)
        self.assertEqual(["stack:stack-php"], plugins["stack"]["missing"])
        self.assertEqual(["docs:user-guide"], plugins["docs"]["missing"])
        self.assertEqual("listed", plugins["core"]["status"])

    def test_discards_a_session_missing_one_skill_of_a_plugin(self) -> None:
        partial = [n for n in self.everything() if n != "core:rubric-js"]
        path = transcript(self.sessions / "partial.jsonl", partial)
        status, result, _ = self.check(path, "stack")
        self.assertEqual(1, status)
        plugins = result["plugins"]
        assert isinstance(plugins, dict)
        self.assertEqual(["core:rubric-js"], plugins["core"]["missing"])

    def test_discards_a_session_with_no_listing(self) -> None:
        path = transcript(self.sessions / "silent.jsonl")
        status, result, _ = self.check(path, "core")
        self.assertEqual(1, status)
        self.assertEqual("discard", result["verdict"])
        self.assertIn("skill_listing", str(result["reason"]))

    def test_takes_the_union_of_every_listing(self) -> None:
        names = self.everything()
        path = transcript(self.sessions / "two.jsonl", names[:3], names[3:])
        status, result, err = self.check(path, "runner", "stack")
        self.assertEqual(0, status, err)
        self.assertEqual("ok", result["verdict"])

    def test_reads_a_listing_that_carries_only_its_text(self) -> None:
        path = self.sessions / "text.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        content = "".join(f"- {n}: what it does: more\n" for n in self.everything())
        path.write_text(json.dumps({"type": "attachment", "attachment": {"type": "skill_listing", "content": content}}) + "\n")
        status, result, err = self.check(path, "runner", "stack")
        self.assertEqual(0, status, err)
        self.assertEqual("ok", result["verdict"])

    def test_finds_the_transcript_from_the_real_path_and_the_session_id(self) -> None:
        root = Path(self.tmp.name)
        real = root / "real" / "copy.dir"
        real.mkdir(parents=True)
        link = root / "link"
        link.symlink_to(root / "real")
        config = root / "config"
        slug = "".join(c if c.isalnum() else "-" for c in os.path.realpath(real))
        transcript(config / "projects" / slug / "1234-abcd.jsonl", self.everything())
        status, out, err = run(
            ["check", "--kit", str(self.kit.root), "--copy", str(link / "copy.dir"), "--session", "1234-abcd", "stack"],
            env={"CLAUDE_CONFIG_DIR": str(config)},
        )
        self.assertEqual(0, status, err)
        self.assertEqual("ok", json.loads(out)["verdict"])

    def test_refuses_a_transcript_that_does_not_exist(self) -> None:
        status, _, err = self.check(self.sessions / "absent.jsonl", "core")
        self.assertEqual(2, status)
        self.assertIn("absent.jsonl", json.loads(err)["error"])


if __name__ == "__main__":
    unittest.main()
