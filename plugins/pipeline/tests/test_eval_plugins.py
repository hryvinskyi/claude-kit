#!/usr/bin/env python3
"""Tests for bin/eval_plugins.py, run as the eval harness runs it: the script as a command, against a
fake kit and fake transcripts in a temporary directory, and its closure against this kit's own manifests.

What is pinned: the closure follows "dependencies" recursively and puts each dependency first, reads a
dependency given as an object or as name@marketplace, refuses an unknown plugin and a cycle; the check
passes a transcript that listed every plugin's skills and commands, discards one that is missing a
plugin (the case of a stack plugin passed without its own dependency) or that holds no listing, never
requires a command that disables model invocation, counts a plugin with nothing to list as
unverifiable, takes the union of several listings, and finds the transcript of a session from its
directory's real path and its session id. For an agent whose tools leave out Skill, which is never sent
a listing, the check passes the run when the definition's first line of prose is in the system prompt
(and confirms the agent's plugin with its dependencies), discards it when it is not, takes the definition
path only for tools written on one line without Skill (every other form goes to the listing), still asks for the listing of an agent that
has the Skill tool and of a bare name, and refuses a plugin agent it cannot find and a transcript it
cannot read.

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


def agent(kit: FakeKit, plugin: str, name: str, tools: Optional[str], prose: str) -> None:
    """An agent definition in PLUGIN whose front matter carries the TOOLS lines when given, and whose
    body is a heading, PROSE, a horizontal rule and a later section."""
    directory = kit.root / "plugins" / plugin / "agents"
    directory.mkdir(parents=True, exist_ok=True)
    tools_lines = f"{tools}\n" if tools is not None else ""
    (directory / f"{name}.md").write_text(
        f"---\nname: {name}\ndescription: an agent\n{tools_lines}---\n\n# {name}\n\n{prose}\n\n---\n\nLater section.\n"
    )


def headless(path: Path, system: str, as_shape: bool = False) -> Path:
    """A transcript of an --agent session with no listing, whose system prompt is SYSTEM."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if as_shape:
        record = {"type": "api-request-shape", "shape": {"system": [{"type": "text", "text": "SDK"}, {"type": "text", "text": system}]}}
    else:
        record = {"type": "attachment", "attachment": {"type": "prompt_snapshot", "systemPrompt": [system]}}
    lines = [json.dumps({"type": "agent-setting", "agentSetting": "runner:judge"}), json.dumps(record)]
    path.write_text("\n".join(lines) + "\n")
    return path


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


def runner_status(result: Dict[str, object]) -> object:
    """The status the check reported for the plugin "runner"."""
    plugins = result["plugins"]
    assert isinstance(plugins, dict)
    return plugins["runner"]["status"]


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

    def check_agent(self, path: Path, name: str, *plugins: str) -> Tuple[int, Dict[str, object], str]:
        status, out, err = run(
            ["check", "--kit", str(self.kit.root), "--transcript", str(path), "--agent", name, *plugins]
        )
        return status, (json.loads(out) if out.strip() else {}), err

    def test_passes_an_agent_with_no_skill_tool_whose_definition_reached_the_session(self) -> None:
        agent(self.kit, "runner", "judge", "tools: Read, Grep, Bash", "You judge findings someone else raised.")
        for as_shape in (False, True):
            with self.subTest(as_shape=as_shape):
                path = headless(self.sessions / f"judge-{as_shape}.jsonl", "# judge\n\nYou judge findings someone else raised.\n\n---\n\nLater section.", as_shape)
                status, result, err = self.check_agent(path, "runner:judge", "runner", "hooks", "stack")
                self.assertEqual(0, status, err)
                self.assertEqual("ok", result["verdict"])
                plugins = result["plugins"]
                assert isinstance(plugins, dict)
                self.assertEqual("loaded", plugins["runner"]["status"])
                self.assertEqual("loaded", plugins["core"]["status"])
                self.assertEqual("unreachable", plugins["stack"]["status"])
                self.assertEqual("unreachable", plugins["docs"]["status"])
                self.assertEqual("unverifiable", plugins["hooks"]["status"])

    def test_looks_for_the_first_line_of_prose_not_the_heading_or_a_later_section(self) -> None:
        agent(self.kit, "runner", "judge", "tools: Read, Bash", "You judge findings someone else raised.")
        for system in ("# judge\n\nAnother agent's prose.", "Some other agent.\n\nLater section."):
            with self.subTest(system=system):
                path = headless(self.sessions / f"wrong-{len(system)}.jsonl", system)
                status, result, _ = self.check_agent(path, "runner:judge", "runner")
                self.assertEqual(1, status)
                self.assertEqual("discard", result["verdict"])

    def test_discards_an_agent_with_no_skill_tool_whose_definition_is_not_in_the_prompt(self) -> None:
        agent(self.kit, "runner", "judge", "tools: Read, Grep, Bash", "You judge findings someone else raised.")
        path = headless(self.sessions / "general.jsonl", "You are a general-purpose agent.")
        status, result, _ = self.check_agent(path, "runner:judge", "runner")
        self.assertEqual(1, status)
        self.assertEqual("discard", result["verdict"])
        plugins = result["plugins"]
        assert isinstance(plugins, dict)
        self.assertEqual("missing", plugins["runner"]["status"])
        self.assertIn("not in the session's system prompt", str(result["reason"]))

    def test_reads_every_way_a_definition_writes_its_tools(self) -> None:
        prose = "You review plans."
        by_listing, by_definition = True, False
        cases = {
            "comma-skill": ("tools: Read, Skill", by_listing),
            "narrowed-skill": ("tools: Read, Skill(review)", by_listing),
            "flow-skill": ("tools: [Read, Skill]", by_listing),
            "no-tools-line": (None, by_listing),
            "comma-none": ("tools: Read, Bash", by_definition),
            "flow-none": ("tools: [Read, Bash]", by_definition),
            "flow-empty": ("tools: []", by_definition),
            "disallowed": ("disallowedTools: Skill", by_definition),
            "disallowed-over-tools": ("tools: Read, Skill\ndisallowedTools: [Skill]", by_definition),
            "disallowed-one-skill": ("tools: Read, Skill\ndisallowedTools: Skill(docs)", by_listing),
            "disallowed-block": ("disallowedTools:\n  - Skill", by_listing),
            "empty-tools": ("tools:", by_listing),
            "block": ("tools:\n  - Read\n  - Bash", by_listing),
            "block-unindented": ("tools:\n- Read\n- Bash", by_listing),
            "comment-on-key": ("tools:  # what it may use\n  - Read\n  - Bash", by_listing),
            "comma-commented": ("tools: Read, Bash  # no skills", by_listing),
            "flow-commented": ("tools: [Read, Bash]  # no skills", by_listing),
            "folded": ("tools: Read,\n  Bash", by_listing),
            "flow-over-lines": ("tools: [Read,\n  Bash]", by_listing),
            "flow-unclosed": ("tools: [Read, Bash", by_listing),
        }
        listing = ["core:rubric-php", "core:rubric-js", "runner:evals", "runner:review"]
        for name, (tools, listed_first) in cases.items():
            with self.subTest(name=name):
                agent(self.kit, "runner", name, tools, prose)
                path = headless(self.sessions / f"{name}.jsonl", f"# {name}\n\n{prose}")
                status, result, err = self.check_agent(path, f"runner:{name}", "runner")
                if listed_first:
                    self.assertEqual(1, status)
                    self.assertIn("skill_listing", str(result["reason"]))
                    listed = transcript(self.sessions / f"listed-{name}.jsonl", listing)
                    status, result, err = self.check_agent(listed, f"runner:{name}", "runner")
                    self.assertEqual(0, status, err)
                    self.assertEqual("listed", runner_status(result))
                else:
                    self.assertEqual(0, status, err)
                    self.assertEqual("loaded", runner_status(result))

    def test_checks_a_bare_agent_name_by_its_listing(self) -> None:
        listed = transcript(self.sessions / "bare.jsonl", ["core:rubric-php", "core:rubric-js", "runner:evals", "runner:review"])
        status, result, err = self.check_agent(listed, "judge", "runner")
        self.assertEqual(0, status, err)
        self.assertEqual("listed", runner_status(result))
        silent = headless(self.sessions / "bare-silent.jsonl", "text")
        status, result, _ = self.check_agent(silent, "judge", "runner")
        self.assertEqual(1, status)
        self.assertIn("skill_listing", str(result["reason"]))

    def test_refuses_a_plugin_agent_it_cannot_find(self) -> None:
        path = headless(self.sessions / "any.jsonl", "text")
        status, _, err = self.check_agent(path, "runner:absent", "runner")
        self.assertEqual(2, status)
        self.assertIn("runner:absent", json.loads(err)["error"])

    def test_refuses_a_transcript_it_cannot_read(self) -> None:
        agent(self.kit, "runner", "judge", "tools: Read", "You judge findings someone else raised.")
        path = headless(self.sessions / "locked.jsonl", "You judge findings someone else raised.")
        path.chmod(0)
        try:
            for name in ("runner:judge", "judge"):
                with self.subTest(name=name):
                    status, _, err = self.check_agent(path, name, "runner")
                    self.assertEqual(2, status, err)
                    self.assertIn("cannot be read", json.loads(err)["error"])
        finally:
            path.chmod(0o600)

    def test_refuses_a_transcript_that_does_not_exist(self) -> None:
        status, _, err = self.check(self.sessions / "absent.jsonl", "core")
        self.assertEqual(2, status)
        self.assertIn("absent.jsonl", json.loads(err)["error"])


if __name__ == "__main__":
    unittest.main()
