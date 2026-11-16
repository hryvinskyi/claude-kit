"""eval_plugins.py — the plugin set of an agent eval run, and whether the nested session loaded all of it.

Usage:
    eval_plugins.py closure --kit KIT PLUGIN...
    eval_plugins.py check --kit KIT (--transcript FILE | --copy DIR --session UUID) PLUGIN...

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

Output is JSON on standard output. Exit status: 0 the closure printed, or every plugin listed; 1 a
plugin's skills are missing from the listing, or the transcript holds no listing — the run is
discarded, never scored; 2 the input is unusable (an unknown plugin, an unreadable manifest, no
transcript file).
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
    try:
        text = transcript.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise Unusable(f"the transcript {transcript} cannot be read: {error}") from error
    names: Optional[Set[str]] = None
    for line in text.splitlines():
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


def check(kit: Path, named: Sequence[str], transcript: Path) -> Dict[str, object]:
    """The verdict on one run: ok when every plugin of the closure is in the transcript's listing."""
    if not transcript.is_file():
        raise Unusable(f"no transcript at {transcript}")
    plugins = closure(kit, named)
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
        result = check(kit, args.plugins, transcript)
    except Unusable as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["verdict"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
