"""eval_plugins.py — the plugin set of an agent eval run, and whether the nested session loaded all of it.

Usage:
    eval_plugins.py closure --kit KIT PLUGIN...
    eval_plugins.py check --kit KIT (--transcript FILE | --copy DIR --session UUID) [--agent NAME] PLUGIN...

closure prints the directory of every plugin the run must pass with --plugin-dir, one per line: the
plugins named and, recursively, every plugin their .claude-plugin/plugin.json lists under
"dependencies". Claude Code drops a plugin whose dependency is not enabled, without an error, so a
run that passes a plugin without its dependencies runs without it. A dependency is a plugin name, or
an object with a "name"; a "name@marketplace" form is read as its name. Each dependency comes before
the plugins that need it, and the order is otherwise the order the plugins were named.

check reads the nested session's transcript and says whether it listed every skill it was meant to:
for each plugin of the same closure, every skill under skills/ (named by its SKILL.md front matter
"name", or its directory) and every command under commands/, as <plugin>:<name>, except those whose
front matter sets disable-model-invocation: true, which a session never lists. The listing is the
union of the "names" of every skill_listing attachment in the transcript. The transcript is FILE, or
<config>/projects/<slug>/<UUID>.jsonl, where <config> is $CLAUDE_CONFIG_DIR or ~/.claude and <slug> is
the real path of DIR with every character other than a letter or a digit replaced by "-" — the file a
`claude -p --session-id UUID` session started in DIR writes. A plugin that ships no skill and no
command cannot be confirmed by the listing; it is reported as unverifiable and does not fail the check.

An agent whose definition's "tools" leaves out Skill, written on one line as a comma list or a
[flow] list, or whose "disallowedTools" so written names it whole (Skill, not Skill(<name>)), is
never sent a listing, so the listing cannot confirm its run. With --agent naming such an agent (as
<plugin>:<agent>, its definition under <kit>/plugins/<plugin>/agents/), the check looks instead for
the definition's first line of prose in the session's system prompt (its prompt_snapshot and
api-request-shape records). Finding it confirms the agent's plugin and, since Claude Code drops a
plugin whose dependency is not enabled, every plugin that plugin depends on: those are reported as
loaded. Any other plugin with skills or commands is reported as unreachable, because an agent with
no Skill tool cannot use them; it does not fail the check. Not finding the definition discards the
run. An agent that has the Skill tool, one whose "tools" is absent or written in any other form (a
block list, a comment, a continued line), and a bare name (a user-scope or project agent) are
checked by the listing as above.

Output is JSON on standard output. Exit status: 0 the closure printed, or every plugin listed; 1 a
plugin's skills are missing from the listing, the transcript holds no listing, or an agent with no
Skill tool is not in the system prompt — the run is discarded, never scored; 2 the input is unusable
(an unknown plugin, a <plugin>:<agent> with no definition in the kit or no prose in it, an
unreadable manifest, no transcript file or one that cannot be read).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set


class Unusable(Exception):
    """The input cannot be used: the run cannot be planned or checked from it."""


def plugin_dir(kit: Path, name: str) -> Path:
    """The directory of the plugin NAME in the kit, which must hold a .claude-plugin/plugin.json."""
    directory = kit / "plugins" / name
    if not (directory / ".claude-plugin" / "plugin.json").is_file():
        raise Unusable(f"no plugin '{name}' in {kit}/plugins (no .claude-plugin/plugin.json)")
    return directory


def dependencies(kit: Path, name: str) -> List[str]:
    """The plugin names NAME's manifest lists under "dependencies"."""
    manifest = plugin_dir(kit, name) / ".claude-plugin" / "plugin.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Unusable(f"{manifest} cannot be read as JSON: {error}") from error
    if not isinstance(data, dict):
        raise Unusable(f"{manifest} is not a JSON object")
    declared = data.get("dependencies", [])
    if not isinstance(declared, list):
        raise Unusable(f"{manifest}: \"dependencies\" is not a list")
    names: List[str] = []
    for entry in declared:
        if isinstance(entry, dict):
            entry = entry.get("name")
        if not isinstance(entry, str) or not entry:
            raise Unusable(f"{manifest}: a dependency has no plugin name")
        names.append(entry.split("@", 1)[0])
    return names


def closure(kit: Path, named: Sequence[str]) -> List[str]:
    """NAMED and every plugin they depend on, recursively; each dependency before what needs it."""
    ordered: List[str] = []
    visiting: Set[str] = set()

    def visit(name: str, path: List[str]) -> None:
        if name in ordered:
            return
        if name in visiting:
            raise Unusable("dependency cycle: " + " -> ".join(path + [name]))
        visiting.add(name)
        for dependency in dependencies(kit, name):
            visit(dependency, path + [name])
        visiting.discard(name)
        ordered.append(name)

    for name in named:
        visit(name, [])
    return ordered


def front_matter(text: str) -> Dict[str, str]:
    """The top-level scalar keys of a Markdown file's front matter."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    keys: Dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if match:
            keys[match.group(1)] = match.group(2).strip("'\"")
    return keys


def expected_names(kit: Path, name: str) -> List[str]:
    """The <plugin>:<name> entries a session that loaded the plugin NAME lists."""
    directory = plugin_dir(kit, name)
    found: List[str] = []
    for skill in sorted((directory / "skills").glob("*/SKILL.md")):
        meta = front_matter(skill.read_text(encoding="utf-8"))
        if meta.get("disable-model-invocation", "").lower() != "true":
            found.append(f"{name}:{meta.get('name') or skill.parent.name}")
    for command in sorted((directory / "commands").glob("*.md")):
        meta = front_matter(command.read_text(encoding="utf-8"))
        if meta.get("disable-model-invocation", "").lower() != "true":
            found.append(f"{name}:{command.stem}")
    return found


def transcript_path(copy: str, session: str) -> Path:
    """The transcript a session with id SESSION, started in the directory COPY, writes."""
    config = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(copy))
    return config / "projects" / slug / f"{session}.jsonl"


def listed_names(transcript: Path) -> Optional[Set[str]]:
    """The union of every skill_listing attachment's names, or None when the transcript holds none."""
    names: Optional[Set[str]] = None
    for line in read_transcript(transcript).splitlines():
        if "skill_listing" not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        attachment = entry.get("attachment") if isinstance(entry, dict) else None
        if not isinstance(attachment, dict) or attachment.get("type") != "skill_listing":
            continue
        names = names if names is not None else set()
        listed = attachment.get("names")
        if isinstance(listed, list):
            names.update(n for n in listed if isinstance(n, str))
        else:
            content = attachment.get("content")
            if isinstance(content, str):
                names.update(re.findall(r"^- ([^\s:]+(?::[^\s:]+)?):", content, re.M))
    return names


def front_matter_list(text: str, key: str) -> Optional[List[str]]:
    """The entries of the front-matter key KEY when it is written on one line, as a comma scalar or a
    [flow] list ("[]" is an empty list). None when the front matter does not set KEY, or sets it in any
    other form: an empty value, a comment, a value continued or a block list on the lines below."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return None
        match = re.match(rf"^{re.escape(key)}:(.*)$", line)
        if not match:
            continue
        value = match.group(1).strip()
        following = lines[index + 1] if index + 1 < len(lines) else ""
        if not value or "#" in value or following[:1] in (" ", "\t"):
            return None
        if value.startswith("["):
            if not value.endswith("]"):
                return None
            value = value[1:-1]
        entries = [entry.strip().strip("'\"") for entry in value.split(",")]
        return [entry for entry in entries if entry]
    return None


def names_skill(tools: Sequence[str]) -> bool:
    """Whether an allow list grants the Skill tool, whole or narrowed as Skill(...)."""
    return any(tool == "Skill" or tool.startswith("Skill(") for tool in tools)


def read_transcript(transcript: Path) -> str:
    """The transcript's text, or Unusable when it cannot be read."""
    try:
        return transcript.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise Unusable(f"the transcript {transcript} cannot be read: {error}") from error


def opening_without_skills(kit: Path, agent: str) -> Optional[str]:
    """The first line of prose of AGENT's definition when it has no Skill tool, else None. A bare
    name (a user-scope or project agent, which the kit does not hold) is None: its run is checked by
    the listing."""
    plugin, _, name = agent.partition(":")
    if not plugin or not name:
        return None
    definition = plugin_dir(kit, plugin) / "agents" / f"{name}.md"
    try:
        text = definition.read_text(encoding="utf-8")
    except OSError as error:
        raise Unusable(f"no definition of the agent '{agent}' at {definition}: {error}") from error
    tools = front_matter_list(text, "tools")
    disallowed = front_matter_list(text, "disallowedTools") or []
    if (tools is None or names_skill(tools)) and "Skill" not in disallowed:
        return None
    body = text.split("\n---", 1)[-1] if text.startswith("---") else text
    for line in body.splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "---")):
            return line
    raise Unusable(f"the definition {definition} has no prose to find in a system prompt")


def system_prompt_holds(transcript: Path, opening: str) -> bool:
    """Whether a prompt_snapshot or api-request-shape record of the transcript carries OPENING."""
    for line in read_transcript(transcript).splitlines():
        if "prompt_snapshot" not in line and "api-request-shape" not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        texts: List[object] = []
        attachment = entry.get("attachment")
        if isinstance(attachment, dict) and attachment.get("type") == "prompt_snapshot":
            prompt = attachment.get("systemPrompt")
            texts.extend(prompt if isinstance(prompt, list) else [prompt])
        shape = entry.get("shape") if entry.get("type") == "api-request-shape" else None
        if isinstance(shape, dict) and isinstance(shape.get("system"), list):
            texts.extend(part.get("text") for part in shape["system"] if isinstance(part, dict))
        if any(isinstance(text, str) and opening in text for text in texts):
            return True
    return False


def check_by_definition(kit: Path, plugins: List[str], agent: str, opening: str, transcript: Path) -> Dict[str, object]:
    """The verdict on a run of an agent with no Skill tool: ok when its definition reached the session."""
    found = system_prompt_holds(transcript, opening)
    loaded = closure(kit, [agent.partition(":")[0]])
    report: Dict[str, object] = {}
    for name in plugins:
        expected = len(expected_names(kit, name))
        if name in loaded:
            status = "loaded" if found else "missing"
        else:
            status = "unreachable" if expected else "unverifiable"
        report[name] = {"status": status, "expected": expected, "missing": []}
    result: Dict[str, object] = {"verdict": "ok" if found else "discard", "transcript": str(transcript), "plugins": report}
    result["reason"] = (
        f"{agent} has no Skill tool, so no listing is sent; its definition "
        + ("is in the session's system prompt" if found else "is not in the session's system prompt")
    )
    return result


def check(kit: Path, named: Sequence[str], transcript: Path, agent: Optional[str] = None) -> Dict[str, object]:
    """The verdict on one run: ok when every plugin of the closure is in the transcript's listing, or,
    for an AGENT with no Skill tool, when its definition is in the session's system prompt."""
    if not transcript.is_file():
        raise Unusable(f"no transcript at {transcript}")
    plugins = closure(kit, named)
    opening = opening_without_skills(kit, agent) if agent else None
    if agent and opening is not None:
        return check_by_definition(kit, plugins, agent, opening, transcript)
    listed = listed_names(transcript)
    report: Dict[str, object] = {}
    verdict = "ok"
    for name in plugins:
        expected = expected_names(kit, name)
        if not expected:
            report[name] = {"status": "unverifiable", "expected": 0, "missing": []}
            continue
        missing = [n for n in expected if listed is None or n not in listed]
        report[name] = {"status": "missing" if missing else "listed", "expected": len(expected), "missing": missing}
        if missing:
            verdict = "discard"
    if listed is None:
        verdict = "discard"
    result: Dict[str, object] = {"verdict": verdict, "transcript": str(transcript), "plugins": report}
    if listed is None:
        result["reason"] = "the transcript holds no skill_listing attachment"
    return result


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(prog="eval_plugins.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("closure", "check"):
        sub = commands.add_parser(command)
        sub.add_argument("--kit", required=True, help="the kit clone")
        sub.add_argument("plugins", nargs="+", help="plugin names, as under <kit>/plugins/")
        if command == "check":
            sub.add_argument("--transcript", help="the nested session's .jsonl transcript")
            sub.add_argument("--copy", help="the directory the nested session ran in")
            sub.add_argument("--session", help="the --session-id the nested session ran with")
            sub.add_argument("--agent", help="the agent the run started, by its registered name: <plugin>:<agent>, or a bare name")
    args = parser.parse_args(argv)
    kit = Path(args.kit)
    try:
        if args.command == "closure":
            for name in closure(kit, args.plugins):
                print(plugin_dir(kit, name).resolve())
            return 0
        if args.transcript:
            transcript = Path(args.transcript)
        elif args.copy and args.session:
            transcript = transcript_path(args.copy, args.session)
        else:
            raise Unusable("check needs --transcript, or --copy and --session")
        result = check(kit, args.plugins, transcript, args.agent)
    except Unusable as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["verdict"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
