#!/usr/bin/env python3
"""PreToolUse hook: no plan file and no PHP or JS/TS source edit lands until the rubric was loaded.

`/pipeline:feature`, `pipeline:devils-advocate`, `pipeline:feature-implementer`
and the engineering standards (CLAUDE.standards.md §Architecture and tech debt)
all instruct "load the architecture skill first" in prose, and prose is
advisory — the model routinely decides it already knows the lenses and writes
the plan, or fixes the debt, from memory. This turns the instruction into a
gate: a Write/Edit is denied unless THIS session's transcript already shows the
rubric being loaded, when the target is

  - a plan file under `.claude/plans/`,
  - a PHP source file (`.php`, outside vendor/, var/, cache dirs and test
    directories) — rubric: the clean-architecture-php skill, or
  - a JavaScript/TypeScript source file (`.js .mjs .cjs .jsx .ts .mts .cts
    .tsx`, outside node_modules/, build output, test files, declaration files,
    minified files and tool configs) — rubric: the clean-architecture-js skill.

Two core skills, one rule each, published by the `architecture` plugin as
`architecture:clean-architecture-php` and `architecture:clean-architecture-js`.
A skill counts as loaded after a `Skill` tool call for it (namespaced or bare),
or a Read/Bash/Grep that names its SKILL.md or its
references/implementer-checklist.md (agents whose tool list excludes Skill; the
implementer's cut of the rubric). Files are recognised by their
`<skill directory>/…` suffix, so a plugin cache (with its version segment), a
marketplace clone, a `--plugin-dir` checkout and a user skill directory all
count. Merely mentioning the skill directory (`ls`, `git log`) does not count,
and one skill never stands in for another.

Loading SKILL.md alone is not loading the skill — a session that read only the
main file shipped a closed value object in a module's published data contract
with no extension point, exactly what the references would have caught. So the
gate also requires the references the target needs, each as a Read/Bash/Grep
that names `<skill>/references/<name>.md`:

  PHP source   solid.md; ddd.md in a domain directory (Api/Data, Model, Entity,
               Domain, ValueObject, Aggregate).
  JS/TS source solid.md and javascript.md; react.md for a .jsx/.tsx file, under
               a tsconfig that sets `jsx`, or anywhere in a project whose
               package.json depends on React while no stack is detected;
               typescript.md for .ts/.tsx/.mts/.cts; ddd.md in a domain directory
               (domain, model, entities, value-objects).
  Plan file    each skill the plan needs: the PHP skill on a PHP project
               (composer.json); the JS skill on a JS project (package.json or
               tsconfig.json and no composer.json), and on a PHP project whose
               plan directory names JS/TS files or browser machinery. JS host
               reference for plans: react.md when the plan names .jsx/.tsx files
               or a project with no detected stack depends on React,
               javascript.md when there is no host.

Stack declarations. A stack plugin declares its framework in a `stack.json` it
owns and copies it, at SessionStart, into this session's registry:
`<state>/sessions/<session id>/stacks/<stack>.json`, where `<state>` is
$CLAUDE_KIT_STATE_DIR, or `${XDG_STATE_HOME:-~/.local/state}/claude-kit`. The
session id is read from the transcript path (`<id>.jsonl`, or
`<id>/subagents/agent-*.jsonl` for a subagent), so a subagent finds the
registry of the session that spawned it. A declaration only adds requirements:

  {
    "stack": "<plugin name, also the Skill namespace>",
    "detect": {
      "composer_type_prefixes": ["…"],  a composer.json `type` starting so
      "composer_requires": ["…"],       a require/require-dev name containing it
      "root_paths": ["…", "…/"]         at the PHP project root; "/" = directory
    },
    "browser_markers": ["…"],           words that make a PHP plan order JS work
    "domain_dirs": {"php": ["…"], "js": ["…"]},
    "requires": {                       "<skill dir>/SKILL.md" or "<skill dir>/<ref>.md"
      "php_source": [], "js_source": [], "plan_php": [], "plan_js": []
    }
  }

Detection keeps one order for every declaration at once: the composer.json
files above the target are walked nearest first, and the first one any
declaration matches decides; only when none does are the root paths tried.
Every declaration matching at that step applies (a union). Browser markers and
domain directories of every registered declaration apply on every project, the
way the core's own words do. A missing, unreadable or malformed declaration is
skipped, and the core rules run as if no stack were installed.

The denial names exactly the files still missing, and tells the model to read
each reference from the base directory the Skill tool reports for the skill.

A subagent's turns are recorded in its own file, `<session
id>/subagents/agent-*.jsonl`, but its PreToolUse hooks are handed the PARENT's
`<session id>.jsonl` — so reading only `transcript_path` cannot see the Skill
call the subagent just made, and `pipeline:devils-advocate` (the agent this gate
exists for) got stuck in a load-retry-blocked loop. Hence the whole family is scanned:
the given transcript, its parent, and the session's subagent transcripts.

Denial is exit 2: the message goes back to the model, which loads the rubric and
retries. Kill switch: CLAUDE_NO_PLAN_SKILL_GATE=1.
"""
import glob
import json
import os
import re
import sys
from dataclasses import dataclass

RUBRIC_PLUGIN = "architecture"  # the plugin that publishes both core skills
PHP_SKILL = "clean-architecture-php"
JS_SKILL = "clean-architecture-js"
SKILLS = (PHP_SKILL, JS_SKILL)
# What stands in for SKILL.md: the implementer's cut of the rubric
SKILL_EQUIVALENTS = {"SKILL.md", "implementer-checklist.md"}

PHP_DOMAIN_DIRS = {"Api/Data", "Model", "Entity", "Domain", "ValueObject", "ValueObjects", "Aggregate", "Aggregates"}
JS_DOMAIN_DIRS = {"domain", "Domain", "model", "models", "entities", "entity", "value-objects", "valueObjects", "value_objects"}

# Directories whose PHP is not the project's own source: nothing to design there
PHP_SKIPPED_DIRS = {"vendor", "var", "cache", "generated", "node_modules", "tests", "test", "Test", "Tests", "spec"}
# The same for JS/TS: every flavour of test directory — judged below the cwd as well, because a
# test suite is often a package of its own (a Playwright project with its own package.json) —
# and, below the file's own project root, dependencies, build output and caches
JS_TEST_DIRS = {
    "tests", "test", "Test", "Tests", "__tests__", "__mocks__", "__fixtures__", "spec",
    "e2e", "cypress", "playwright", ".storybook",
}
JS_SKIPPED_DIRS = JS_TEST_DIRS | {
    "node_modules", "bower_components", "vendor", "dist", "build", "out", "coverage", "storybook-static",
    ".next", ".nuxt", ".svelte-kit", ".cache", "cache", "var", "generated", "tmp",
}
# Build output and served copies addressed by their place in the project, not by a directory name
JS_SKIPPED_PREFIXES = (("pub", "static"), ("pub", "build"), ("public", "build"), ("public", "assets"),
                       ("public", "bundles"), ("lib", "web"))
JS_EXTENSIONS = {".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"}
TS_EXTENSIONS = {".ts", ".mts", ".cts", ".tsx"}
JSX_EXTENSIONS = {".jsx", ".tsx"}
# Files with a JS extension that are tests, types, bundles or tool configuration rather than source
JS_NON_SOURCE = re.compile(
    r"\.(?:test|spec|test-d|spec-d|stories|story|e2e|cy)\.[cm]?[jt]sx?$"
    r"|\.d\.[cm]?ts$"
    r"|\.min\.[cm]?js$"
    r"|.\.config\.[cm]?[jt]s$"
    r"|^(?:requirejs-config|gruntfile|gulpfile|karma\.conf|\.eslintrc|\.prettierrc|\.stylelintrc|\.babelrc)\.[cm]?[jt]s$"
    r"|^webpack\.[\w.-]+\.[cm]?js$",
    re.I,
)
REACT_PACKAGES = {
    "react", "react-dom", "next", "preact", "@preact/preset-vite", "@vitejs/plugin-react",
    "@vitejs/plugin-react-swc", "@symfony/ux-react", "@remix-run/react", "gatsby", "react-native", "expo",
}
TSCONFIG_JSX = re.compile(r'"jsx"\s*:\s*"[^"]+"')
# A plan orders JS/TS work when it names such files or the browser machinery that runs them;
# a registered stack adds the spellings of its own machinery
JS_IN_PLAN = re.compile(
    r"[\w@/.-]+\.(?:m?js|cjs|jsx|tsx?|mts|cts)\b"
    r"|\b(?:package|tsconfig(?:\.\w+)?)\.json\b"
    r"|\b(?:TypeScript|react_component)\b"
)
JSX_IN_PLAN = re.compile(r"[\w@/.-]+\.(?:jsx|tsx)\b")
PLAN_TEXT_LIMIT = 2_000_000  # bytes of sibling plan files read to decide what a plan orders

# The per-session registry of stack declarations
STATE_DIR_ENV = "CLAUDE_KIT_STATE_DIR"
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
STACK_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
REQUIRED_FILE = re.compile(r"^([A-Za-z0-9_][\w.-]*)/([\w.-]+\.md)$")
REQUIREMENT_KINDS = ("php_source", "js_source", "plan_php", "plan_js")
DECLARATION_LIMIT = 64_000  # bytes; a declaration is a short list of words
REGISTRY_LIMIT = 16  # declarations read per session


@dataclass(frozen=True)
class Stack:
    """One registered stack declaration, normalised.

    `requires` maps each target kind to the "<skill dir>/<file>" keys it adds;
    `skills` are the skill directories those keys name.
    """
    name: str
    composer_type_prefixes: tuple
    composer_requires: tuple
    root_paths: tuple
    browser_markers: tuple
    php_domain_dirs: frozenset
    js_domain_dirs: frozenset
    requires: dict
    skills: frozenset

    def matches_composer(self, data: dict) -> bool:
        """Report whether a parsed composer.json belongs to this stack (its type or a required package)."""
        kind = str(data.get("type", ""))
        if any(kind.startswith(prefix) for prefix in self.composer_type_prefixes):
            return True
        names = []
        for key in ("require", "require-dev"):
            section = data.get(key)
            if isinstance(section, dict):
                names.extend(str(name) for name in section)
        return any(fragment in name for fragment in self.composer_requires for name in names)

    def matches_root(self, root: str) -> bool:
        """Report whether one of the root paths exists at the project root ("x/" must be a directory)."""
        for relative in self.root_paths:
            target = os.path.join(root, *relative.rstrip("/").split("/"))
            if os.path.isdir(target) if relative.endswith("/") else os.path.exists(target):
                return True
        return False

    def required(self, kind: str) -> set:
        """The rubric files this stack adds for one target kind."""
        return set(self.requires.get(kind, ()))


def words(value) -> tuple:
    """A declaration field that must be a list of non-empty strings; anything else is an error."""
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError("expected a list of strings")
    return tuple(item.strip() for item in value)


def parse_declaration(data):
    """Normalise one stack declaration.

    @param data The parsed JSON of a `stack.json`.
    @return A Stack, or None when the declaration is malformed (it is then ignored whole).
    """
    try:
        if not isinstance(data, dict) or not STACK_NAME.match(str(data.get("stack", ""))):
            return None
        detect = data.get("detect") or {}
        domains = data.get("domain_dirs") or {}
        requires = data.get("requires") or {}
        if not all(isinstance(part, dict) for part in (detect, domains, requires)):
            return None
        normalised = {}
        skills = set()
        for kind in REQUIREMENT_KINDS:
            keys = words(requires.get(kind))
            for key in keys:
                match = REQUIRED_FILE.match(key)
                if not match:
                    return None
                skills.add(match.group(1))
            normalised[kind] = frozenset(keys)
        root_paths = words(detect.get("root_paths"))
        if any(path.startswith("/") or ".." in path.split("/") for path in root_paths):
            return None
        return Stack(
            name=data["stack"],
            composer_type_prefixes=words(detect.get("composer_type_prefixes")),
            composer_requires=words(detect.get("composer_requires")),
            root_paths=root_paths,
            browser_markers=words(data.get("browser_markers")),
            php_domain_dirs=frozenset(words(domains.get("php"))),
            js_domain_dirs=frozenset(words(domains.get("js"))),
            requires=normalised,
            skills=frozenset(skills - set(SKILLS)),
        )
    except ValueError:
        return None


def state_dir() -> str:
    """The base of the per-session registry: $CLAUDE_KIT_STATE_DIR, else the XDG state home's claude-kit."""
    override = os.environ.get(STATE_DIR_ENV, "")
    if os.path.isabs(override):
        return override
    xdg = os.environ.get("XDG_STATE_HOME", "")
    base = xdg if os.path.isabs(xdg) else os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "claude-kit")


def session_of(transcript_path: str):
    """The session a transcript belongs to: `<id>.jsonl`, or `<id>/subagents/agent-*.jsonl`.

    @return The session id, or None when the path does not name one safely.
    """
    if not transcript_path:
        return None
    directory, base = os.path.split(transcript_path)
    if os.path.basename(directory) == "subagents":
        session = os.path.basename(os.path.dirname(directory))
    else:
        session = base[: -len(".jsonl")] if base.endswith(".jsonl") else base
    return session if SAFE_SEGMENT.match(session) else None


def registered_stacks(transcript_path: str) -> tuple:
    """The stack declarations the session's stack plugins registered at SessionStart.

    Fails open: an absent registry, an unreadable or malformed declaration is skipped.
    @return Stacks ordered by name, at most one per name.
    """
    session = session_of(transcript_path)
    if session is None:
        return ()
    directory = os.path.join(state_dir(), "sessions", session, "stacks")
    try:
        names = sorted(name for name in os.listdir(directory) if name.endswith(".json"))
    except OSError:
        return ()
    stacks = {}
    for name in names[:REGISTRY_LIMIT]:
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as fh:
                stack = parse_declaration(json.loads(fh.read(DECLARATION_LIMIT)))
        except Exception:
            continue
        if stack is not None and stack.name not in stacks:
            stacks[stack.name] = stack
    return tuple(stacks[name] for name in sorted(stacks))


def skill_owners(stacks) -> dict:
    """Map every skill directory the gate knows to the plugin that publishes it."""
    owners = {skill: RUBRIC_PLUGIN for skill in SKILLS}
    for stack in stacks:
        for skill in stack.skills:
            owners.setdefault(skill, stack.name)
    return owners


def rubric_file_pattern(skills):
    """SKILL.md or a reference of one of `skills`, named as a path suffix in a Read/Bash/Grep call."""
    alternatives = "|".join(re.escape(skill) for skill in sorted(skills, key=len, reverse=True))
    return re.compile(r"(?<![\w.-])(" + alternatives + r")/(?:(SKILL\.md)|references/([\w.-]+\.md))\b")


def browser_pattern(stacks):
    """The registered stacks' browser markers as one word-bounded pattern, or None when there are none."""
    markers = sorted({marker for stack in stacks for marker in stack.browser_markers}, key=len, reverse=True)
    if not markers:
        return None
    return re.compile(r"\b(?:" + "|".join(re.escape(marker) for marker in markers) + r")\b")


def related_transcripts(transcript_path: str) -> list:
    """List the transcripts that could hold this session's load of the rubric.

    @param transcript_path Path the hook was handed — a session or subagent JSONL.
    @return Existing paths: the given one, its parent session, and that session's subagents.
    """
    directory, base = os.path.split(transcript_path)
    paths = [transcript_path]
    if os.path.basename(directory) == "subagents":
        session_dir = os.path.dirname(directory)
        paths.append(f"{session_dir}.jsonl")
    else:
        session_dir = os.path.join(directory, base[: -len(".jsonl")] if base.endswith(".jsonl") else base)
    paths.extend(sorted(glob.glob(os.path.join(session_dir, "subagents", "*.jsonl"))))
    seen = []
    for path in paths:
        if path not in seen and os.path.isfile(path):
            seen.append(path)
    return seen


def skill_called(value, skills=SKILLS) -> str:
    """The rubric skill a Skill tool call loads, or "" when it loads another one.

    @param value The call's `skill` argument (a name, possibly "plugin:name" or "/name").
    @param skills The skill directories the gate recognises.
    """
    name = str(value or "").strip().lstrip("/").split(":")[-1]
    return name if name in skills else ""


def loaded_files(path: str, skills=SKILLS):
    """Collect the rubric files one transcript shows being loaded.

    @param path Path to a JSONL transcript.
    @param skills The skill directories the gate recognises.
    @return Set of "<skill>/<basename>": "<skill>/SKILL.md" for a Skill call or a read of
            SKILL.md, "<skill>/<name>.md" for each reference read; None when unreadable.
    """
    found = set()
    rubric_file = rubric_file_pattern(skills)
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if not any(skill in line for skill in skills):  # cheap filter: transcripts run to tens of MB
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                content = (entry.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for item in content:
                    if not isinstance(item, dict) or item.get("type") != "tool_use":
                        continue
                    name = item.get("name")
                    args = item.get("input") or {}
                    if not isinstance(args, dict):
                        continue
                    if name == "Skill":
                        skill = skill_called(args.get("skill"), skills)
                        if skill:
                            found.add(f"{skill}/SKILL.md")
                    if name in ("Read", "Bash", "Grep"):
                        for skill, main, ref in rubric_file.findall(json.dumps(args)):
                            found.add(f"{skill}/{main or ref}")
    except OSError:
        return None  # unreadable — never block on what cannot be proven absent
    return found


def loaded_in(transcript_path: str, skills=SKILLS):
    """Collect what this session — main turn or subagents — loaded of the rubrics.

    @param transcript_path Path to the transcript the hook was handed.
    @param skills The skill directories the gate recognises.
    @return Set of "<skill>/<basename>" loaded, with each skill's implementer checklist also
            counting as its SKILL.md; None when nothing can be proven (missing or unreadable
            transcript) — the caller must not block then.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return None  # cannot prove absence — never block on a missing transcript
    found = set()
    for path in related_transcripts(transcript_path):
        files = loaded_files(path, skills)
        if files is None:
            return None
        found |= files
    for skill in skills:
        if any(f"{skill}/{equivalent}" in found for equivalent in SKILL_EQUIVALENTS):
            found.add(f"{skill}/SKILL.md")
    return found


def ancestors(cwd: str, path: str, limit: int = 40):
    """Yield the target's directory and its parents, nearest first."""
    directory = os.path.dirname(os.path.abspath(os.path.join(cwd, path)))
    for _ in range(limit):
        yield directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return
        directory = parent


def read_json(path: str) -> dict:
    """Parse a JSON file into a dict; anything unreadable or not an object is an empty dict."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def stacks_of(root, cwd: str, path: str, stacks) -> tuple:
    """Detect the target's stacks among the registered declarations.

    The composer.json files above the target are walked nearest first, and the first one any
    declaration matches decides; only when none does are the root paths of the PHP project tried.
    Every declaration matching at the deciding step applies.

    @param root The PHP project root (nearest composer.json), or None.
    @param stacks The registered declarations.
    @return The matching Stacks; empty when no stack can be told.
    """
    if not stacks:
        return ()
    for directory in ancestors(cwd, path):
        composer = os.path.join(directory, "composer.json")
        if os.path.isfile(composer):
            data = read_json(composer)
            found = tuple(stack for stack in stacks if stack.matches_composer(data))
            if found:
                return found
    if root:
        return tuple(stack for stack in stacks if stack.matches_root(root))
    return ()


def depends_on_react(cwd: str, path: str, root) -> bool:
    """Report whether a package.json between the target and its project root depends on React.

    React-compatible runtimes (Preact, Next, the Vite React plugin, a server framework's React
    bundle) count.
    """
    for directory in ancestors(cwd, path):
        data = read_json(os.path.join(directory, "package.json"))
        names = set()
        for key in ("dependencies", "devDependencies", "peerDependencies"):
            section = data.get(key)
            if isinstance(section, dict):
                names |= set(section)
        if names & REACT_PACKAGES:
            return True
        if root and os.path.abspath(directory) == os.path.abspath(root):
            return False
    return False


def tsconfig_sets_jsx(cwd: str, path: str, root) -> bool:
    """Report whether the nearest tsconfig.json above the target (within the project) compiles JSX."""
    for directory in ancestors(cwd, path):
        tsconfig = os.path.join(directory, "tsconfig.json")
        if os.path.isfile(tsconfig):
            try:
                with open(tsconfig, encoding="utf-8", errors="ignore") as fh:
                    return bool(TSCONFIG_JSX.search(fh.read()))
            except OSError:
                return False
        if root and os.path.abspath(directory) == os.path.abspath(root):
            return False
    return False


def nearest_root(cwd: str, path: str, markers):
    """The nearest directory above the target holding one of `markers`.

    A relative target lies under the cwd, so the cwd's own project is found by the walk;
    a file outside the cwd belongs to whatever project encloses it, never to the cwd's.

    @return A directory, or None when the file belongs to no such project.
    """
    for directory in ancestors(cwd, path):
        if any(os.path.isfile(os.path.join(directory, marker)) for marker in markers):
            return directory
    return None


def project_root(cwd: str, path: str):
    """The PHP project the target belongs to: the nearest composer.json above the file."""
    return nearest_root(cwd, path, ("composer.json",))


def own_parts(root: str, cwd: str, path: str) -> list:
    """The target's path relative to its project root, split into parts.

    Directory names are judged relative to the project root, so a project that
    lives under /var or /tmp is not mistaken for its own cache directory.
    """
    absolute = os.path.abspath(os.path.join(cwd, path))
    return os.path.relpath(absolute, root).replace(os.sep, "/").split("/")


def is_php_source(root: str, cwd: str, path: str) -> bool:
    """Report whether the path is the project's own PHP source (not vendor, cache or tests)."""
    if not path.lower().endswith(".php"):
        return False
    return not (PHP_SKIPPED_DIRS & set(own_parts(root, cwd, path)[:-1]))


def is_js_source(root: str, cwd: str, path: str) -> bool:
    """Report whether the path is the project's own JS/TS source.

    Not source: dependencies (node_modules anywhere), build output and served copies,
    caches, test files and directories, declaration files, minified files, tool configs.
    """
    name = os.path.basename(path)
    if os.path.splitext(name)[1].lower() not in JS_EXTENSIONS or JS_NON_SOURCE.search(name):
        return False
    if "node_modules" in os.path.abspath(os.path.join(cwd, path)).split(os.sep):
        return False
    parts = own_parts(root, cwd, path)
    if JS_SKIPPED_DIRS & set(parts[:-1]):
        return False
    below_cwd = own_parts(cwd, cwd, path)
    if below_cwd[0] != ".." and JS_TEST_DIRS & set(below_cwd[:-1]):
        return False
    return not any(tuple(parts[: len(prefix)]) == prefix for prefix in JS_SKIPPED_PREFIXES)


def in_domain_dir(path: str, domain_dirs) -> bool:
    """Report whether the target sits in one of the domain directories (nested ones included)."""
    directories = path.split("/")[:-1]
    return bool(domain_dirs & set(directories)) or any("/" in d and d in "/".join(directories) for d in domain_dirs)


def stack_requirements(stacks, kind: str) -> set:
    """The rubric files the detected stacks add for one target kind."""
    required = set()
    for stack in stacks:
        required |= stack.required(kind)
    return required


def php_source_requirements(detected, registered, path: str) -> set:
    """The rubric files a PHP source write needs.

    @param detected The stacks the target belongs to.
    @param registered Every registered stack: their domain directories apply everywhere.
    """
    required = {f"{PHP_SKILL}/SKILL.md", f"{PHP_SKILL}/solid.md"} | stack_requirements(detected, "php_source")
    domain_dirs = PHP_DOMAIN_DIRS.union(*(stack.php_domain_dirs for stack in registered))
    if in_domain_dir(path, domain_dirs):
        required.add(f"{PHP_SKILL}/ddd.md")
    return required


def js_source_requirements(detected, registered, react: bool, path: str) -> set:
    """The rubric files a JS/TS source write needs.

    @param detected The stacks hosting the target.
    @param registered Every registered stack: their domain directories apply everywhere.
    """
    required = {f"{JS_SKILL}/SKILL.md", f"{JS_SKILL}/solid.md", f"{JS_SKILL}/javascript.md"}
    required |= stack_requirements(detected, "js_source")
    if react:
        required.add(f"{JS_SKILL}/react.md")
    if os.path.splitext(path)[1].lower() in TS_EXTENSIONS:
        required.add(f"{JS_SKILL}/typescript.md")
    if in_domain_dir(path, JS_DOMAIN_DIRS.union(*(stack.js_domain_dirs for stack in registered))):
        required.add(f"{JS_SKILL}/ddd.md")
    return required


def plan_text(cwd: str, path: str, text) -> str:
    """What the plan says: the text being written plus every file already in the plan's directory."""
    chunks = [text or ""]
    directory = os.path.dirname(os.path.abspath(os.path.join(cwd, path)))
    budget = PLAN_TEXT_LIMIT
    for sibling in sorted(glob.glob(os.path.join(directory, "*.md"))):
        try:
            with open(sibling, encoding="utf-8", errors="ignore") as fh:
                chunk = fh.read(budget)
        except OSError:
            continue
        chunks.append(chunk)
        budget -= len(chunk)
        if budget <= 0:
            break
    return "\n".join(chunks)


def orders_js(said: str, registered) -> bool:
    """Report whether a PHP project's plan text names JS/TS files or browser machinery."""
    if JS_IN_PLAN.search(said):
        return True
    markers = browser_pattern(registered)
    return bool(markers and markers.search(said))


def plan_requirements(cwd: str, path: str, text, registered=()) -> set:
    """The rubric files a plan write needs: each skill the plan needs, with its stack or host skill.

    @param registered Every registered stack.
    """
    php_root = project_root(cwd, path)
    js_root = nearest_root(cwd, path, ("package.json", "tsconfig.json"))
    detected = stacks_of(php_root, cwd, path, registered) if php_root else ()
    required = set()
    if php_root:
        required.add(f"{PHP_SKILL}/SKILL.md")
        required |= stack_requirements(detected, "plan_php")
    said = plan_text(cwd, path, text) if (php_root or js_root) else ""
    needs_js = bool(js_root and not php_root) or bool(php_root and orders_js(said, registered))
    if not needs_js:
        return required
    required.add(f"{JS_SKILL}/SKILL.md")
    hosts = stack_requirements(detected, "plan_js")
    if JSX_IN_PLAN.search(said) or (not detected and js_root and depends_on_react(cwd, path, js_root)):
        hosts.add(f"{JS_SKILL}/react.md")
    return required | (hosts or {f"{JS_SKILL}/javascript.md"})


def is_plan_file(path: str) -> bool:
    return "/.claude/plans/" in path or path.startswith(".claude/plans/")


def missing_for(cwd: str, path: str, transcript_path: str, text=None):
    """Decide what a write to `path` still lacks of the rubric.

    Shared with bash_guard.py, which sees the same writes made through the shell.

    @param cwd The hook's working directory.
    @param path The target file (any separator).
    @param transcript_path The transcript the hook was handed.
    @param text The text being written, when visible (plan files use it to tell what they order).
    @return (what the target is, set of missing "<skill>/<basename>", the plugin publishing each
            skill directory) when the write must be refused; None when the target is out of
            scope, nothing can be proven about the session, or everything required was loaded.
    """
    path = path.replace(os.sep, "/")
    extension = os.path.splitext(path)[1].lower()
    plan = is_plan_file(path)
    if not (plan or extension == ".php" or extension in JS_EXTENSIONS):
        return None
    registered = registered_stacks(transcript_path)
    if plan:
        what, required = "a plan file", plan_requirements(cwd, path, text, registered)
    elif extension == ".php":
        root = project_root(cwd, path)
        if root is None or not is_php_source(root, cwd, path):
            return None  # not a PHP project, or not its own source — the rubric does not apply
        detected = stacks_of(root, cwd, path, registered)
        what, required = "PHP source", php_source_requirements(detected, registered, path)
    else:
        root = nearest_root(cwd, path, ("package.json", "tsconfig.json", "composer.json"))
        if root is None or not is_js_source(root, cwd, path):
            return None  # no project around it, or not its own source
        php_root = project_root(cwd, path)
        detected = stacks_of(php_root, cwd, path, registered) if php_root else ()
        react = (extension in JSX_EXTENSIONS or tsconfig_sets_jsx(cwd, path, root)
                 or (not detected and depends_on_react(cwd, path, root)))
        what, required = "JavaScript/TypeScript source", js_source_requirements(detected, registered, react, path)
    if not required:
        return None
    owners = skill_owners(registered)
    loaded = loaded_in(transcript_path, tuple(owners))
    if loaded is None:
        return None
    missing = required - loaded
    if not missing:
        return None
    return (what, missing, owners)


def denial(what: str, missing, owners=None) -> str:
    """The message handed back to the model when a write is refused.

    @param owners The plugin publishing each skill directory; a core skill defaults to its own.
    """
    owners = owners or {}
    wanted = []

    def order(key):
        skill, name = key.split("/", 1)
        return (owners.get(skill, RUBRIC_PLUGIN) != RUBRIC_PLUGIN, skill, name != "SKILL.md", name)

    for key in sorted(missing, key=order):
        skill, name = key.split("/", 1)
        plugin = owners.get(skill, RUBRIC_PLUGIN)
        if name == "SKILL.md" and skill in SKILLS:
            wanted.append(f"the {skill} skill itself: call the Skill tool with `{plugin}:{skill}` (or, "
                          f"without that tool, Read SKILL.md or references/implementer-checklist.md in the "
                          f"{skill} skill directory of the `{plugin}` plugin)")
        elif name == "SKILL.md":
            wanted.append(f"the {skill} skill: call the Skill tool with `{plugin}:{skill}` (or, without that "
                          f"tool, Read SKILL.md in the {skill} skill directory of the `{plugin}` plugin)")
        else:
            wanted.append(f"Read {skill}/references/{name}")
    return (
        f"Blocked: {what} may not be written before the architecture rubric is loaded, "
        f"and this session is missing:\n  - " + "\n  - ".join(wanted) + "\n"
        f"Read each reference from the skill's own directory: the base directory the Skill tool reports "
        f"when it loads the skill, followed by references/<name>.md.\n"
        f"Load them, apply their lenses to this change, then retry. The engineering standards "
        f"(CLAUDE.standards.md §Architecture and tech debt): every structural change and every debt fix "
        f"goes through the rubric — SKILL.md alone is not the rubric, and recalling the lenses from "
        f"memory does not satisfy this gate.\n"
    )


def written_text(tool_input: dict):
    """The text a Write/Edit/MultiEdit call puts into the file, when it shows it."""
    if "content" in tool_input:
        return tool_input.get("content")
    if "new_string" in tool_input:
        return tool_input.get("new_string")
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        return "\n".join(str(e.get("new_string", "")) for e in edits if isinstance(e, dict))
    return None


def main() -> int:
    if os.environ.get("CLAUDE_NO_PLAN_SKILL_GATE"):
        return 0
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") not in ("Write", "Edit", "MultiEdit"):
        return 0
    tool_input = data.get("tool_input") or {}
    path = tool_input.get("file_path") or ""
    if not path:
        return 0
    try:
        verdict = missing_for(data.get("cwd") or os.getcwd(), path, data.get("transcript_path") or "",
                              written_text(tool_input))
    except Exception:
        return 0  # fail open: a broken gate must not wedge the session
    if verdict is None:
        return 0
    sys.stderr.write(denial(*verdict))
    return 2


if __name__ == "__main__":
    sys.exit(main())
