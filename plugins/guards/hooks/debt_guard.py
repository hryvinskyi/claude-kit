#!/usr/bin/env python3
"""PreToolUse guard (Edit|Write): tech debt is fixed, never deferred.

The engineering standards (CLAUDE.standards.md §Architecture and tech debt)
say debt inside a change is fixed in that change, and never parked. Prose is
advisory; this turns the two mechanical halves of the rule into a gate:

  1. A source-file edit may not ADD a deferral marker (`// TODO`, `# FIXME`,
     `/* HACK`, `@todo` …) or a static-analysis suppression (`@phpstan-ignore`,
     `@psalm-suppress`, `phpcs:ignore`, `eslint-disable`, `@ts-ignore`,
     `@ts-expect-error`, `biome-ignore`, `oxlint-disable`, `stylelint-disable`,
     `# noqa`, `# type: ignore`, `pylint: disable`, `rubocop:disable`,
     `//nolint`, `@SuppressWarnings` …). `@ts-expect-error` is allowed in test
     files only: a type-level test uses it to assert that code does NOT compile.
  2. A static-analysis baseline (`*baseline*.neon`, `psalm-baseline*.xml`,
     `*baseline*.json`, ESLint's `eslint-suppressions.json`) may only shrink.
     Creating one where none exists is allowed; every later edit must remove at
     least as many lines as it adds — and for ESLint's file, no rule's count in
     any file may rise and no new file or rule may appear (its entries are
     counts, so the file can grow without growing a line).

Only ADDED text counts: for an Edit, the lines of new_string that were not in
old_string; for a Write over an existing file, the lines not already in it.
Moving or rewording a marker that is already there passes — the rule is about
leaving new debt behind, not about touching old debt.

Scope is deliberately narrow:
  - only Edit/Write, only files with a source-code extension (prose, plans,
    vault notes and JSON never trigger it),
  - nothing under the Claude config dir (~/.claude / $CLAUDE_CONFIG_DIR), under
    the plugin that ships this hook, or -- when that plugin sits in a
    marketplace clone (`<clone>/plugins/<name>` beside
    `<clone>/.claude-plugin/marketplace.json`) -- anywhere in that clone: the
    hooks, tests, rules and eval fixtures that describe or seed these markers
    must stay writable.

Denial is exit 2: the message goes back to the model, which fixes the debt
instead of marking it. Fails open on any internal error — a hook must never
wedge a session. Kill switch: CLAUDE_NO_DEBT_GUARD=1.
"""
import json
import os
import re
import sys

SOURCE_EXTENSIONS = {
    ".php", ".phtml", ".twig", ".inc",
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift", ".cs",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm",
    ".sh", ".bash", ".zsh", ".sql", ".css", ".scss", ".less", ".html", ".xml",
    ".yaml", ".yml", ".neon",
}

# A deferral marker is the word after a comment opener (`//`, `#`, `/*`, `*`,
# `<!--`, `--`, `{#`, `;`), or a docblock tag anywhere. Upper-case only for the
# bare words, so `// todos are loaded here` and `$todo` are not markers.
DEFERRAL = re.compile(r"(?://|#|/\*|\*|<!--|--|\{#|;)\s*(?:TODO|FIXME|HACK|XXX)\b")
DOCBLOCK_TAG = re.compile(r"@(?:todo|fixme)\b", re.I)

SUPPRESSION = re.compile(
    r"@phpstan-ignore"
    r"|@psalm-(?:suppress|ignore)"
    r"|phpcs:(?:ignore|disable)"
    r"|phpmd\.\w+|@SuppressWarnings"
    r"|eslint-disable"
    r"|@ts-(?:ignore|nocheck)"
    r"|biome-ignore"
    r"|oxlint-disable"
    r"|tslint:disable"
    r"|stylelint-disable"
    r"|deno-lint-ignore"
    r"|#\s*noqa\b"
    r"|#\s*type:\s*ignore\b"
    r"|pylint:\s*disable"
    r"|#\s*nosec\b"
    r"|rubocop:disable"
    r"|//\s*nolint\b",
    re.I,
)

BASELINE = re.compile(r"(?:baseline[^/]*\.(?:neon|xml|json)|^eslint-suppressions\.json)$", re.I)
ESLINT_SUPPRESSIONS = "eslint-suppressions.json"

# `@ts-expect-error` asserts a compile error in a type-level test, and suppresses one anywhere else
TS_EXPECT_ERROR = re.compile(r"@ts-expect-error\b")
TEST_FILE = re.compile(
    r"\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$"
    r"|(?:^|/)(?:__tests__|tests?|type-?tests)/",
    re.I,
)


def config_dir() -> str:
    """Resolve the Claude config directory whose contents this guard leaves alone."""
    return os.path.realpath(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"))


def own_tree() -> str:
    """The directory this hook ships in: its marketplace clone, else its plugin."""
    plugin = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    clone = os.path.dirname(os.path.dirname(plugin))
    if os.path.basename(os.path.dirname(plugin)) == "plugins" and os.path.isfile(
        os.path.join(clone, ".claude-plugin", "marketplace.json")
    ):
        return clone
    return plugin


def exempt(path: str) -> bool:
    """Report whether the path lies where markers are content: the config dir or this hook's own tree."""
    real = os.path.realpath(path)
    for root in {config_dir(), os.path.realpath(os.path.expanduser("~/.claude")), own_tree()}:
        if real == root or real.startswith(root + os.sep):
            return True
    return False


def existing_text(path: str):
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            return fh.read()
    except OSError:
        return None


def added_lines(tool: str, ti: dict, current):
    """Lines the tool call introduces that the file did not already contain."""
    if tool == "Write":
        new_lines = (ti.get("content") or "").splitlines()
        old_lines = set(current.splitlines()) if current is not None else set()
    else:
        new_lines = (ti.get("new_string") or "").splitlines()
        old_lines = set((ti.get("old_string") or "").splitlines())
    return [ln for ln in new_lines if ln.strip() and ln not in old_lines]


def debt_in(lines, path=""):
    """Find the first deferral marker or suppression among the added lines.

    @param lines The lines the write adds.
    @param path The target file; a test file may carry `@ts-expect-error`.
    @return (kind, line) or None.
    """
    type_test = bool(TEST_FILE.search(path.replace(os.sep, "/")))
    for ln in lines:
        if DEFERRAL.search(ln) or DOCBLOCK_TAG.search(ln):
            return "deferral marker", ln.strip()
        if SUPPRESSION.search(ln):
            return "static-analysis suppression", ln.strip()
        if TS_EXPECT_ERROR.search(ln) and not type_test:
            return "static-analysis suppression", ln.strip()
    return None


def suppression_counts(text: str):
    """Read ESLint's bulk-suppressions file into {(file, rule): count}; None when it is not that shape."""
    try:
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    counts = {}
    for file, rules in data.items():
        if not isinstance(rules, dict):
            return None
        for rule, entry in rules.items():
            count = entry.get("count") if isinstance(entry, dict) else None
            if not isinstance(count, int):
                return None
            counts[(file, rule)] = count
    return counts


def text_after(tool: str, ti: dict, current: str) -> str:
    """The file's text once the Write/Edit is applied."""
    if tool == "Write":
        return ti.get("content") or ""
    old, new = ti.get("old_string") or "", ti.get("new_string") or ""
    return current.replace(old, new) if ti.get("replace_all") else current.replace(old, new, 1)


def baseline_growth(tool: str, ti: dict, current, name: str = "") -> bool:
    """True when the edit leaves a baseline bigger than it was.

    ESLint's suppressions file is judged by its counts; every other baseline by its lines.
    """
    if current is None:
        return False  # creating the first baseline is allowed
    if name.lower() == ESLINT_SUPPRESSIONS:
        before, after = suppression_counts(current), suppression_counts(text_after(tool, ti, current))
        if before is not None and after is not None:
            return any(count > before.get(key, 0) for key, count in after.items())
    if tool == "Write":
        return len((ti.get("content") or "").splitlines()) > len(current.splitlines())
    added = len((ti.get("new_string") or "").splitlines())
    removed = len((ti.get("old_string") or "").splitlines())
    return added > removed


def main() -> int:
    if os.environ.get("CLAUDE_NO_DEBT_GUARD"):
        return 0
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    tool = data.get("tool_name", "")
    if tool not in ("Edit", "Write"):
        return 0
    ti = data.get("tool_input", {}) or {}
    path = ti.get("file_path", "")
    if not path or exempt(path):
        return 0
    name = os.path.basename(path)
    ext = os.path.splitext(name)[1].lower()
    try:
        current = existing_text(path)
        if BASELINE.search(name):
            if baseline_growth(tool, ti, current, name):
                print(
                    "BLOCKED by debt_guard.py (guards plugin): this edit grows a static-analysis "
                    "baseline. The engineering standards (CLAUDE.standards.md §PHP static analysis, "
                    "§JavaScript and TypeScript static analysis): the baseline only shrinks — fix the "
                    "reported errors at the project's level, or report them as unfixable and explain why.",
                    file=sys.stderr,
                )
                return 2
            return 0
        if ext not in SOURCE_EXTENSIONS:
            return 0
        hit = debt_in(added_lines(tool, ti, current), path)
    except Exception:
        return 0  # fail open: a broken guard must not wedge the session
    if hit:
        kind, line = hit
        print(
            f"BLOCKED by debt_guard.py (guards plugin): this edit adds a {kind} to a source file:\n"
            f"    {line}\n"
            "The engineering standards (CLAUDE.standards.md §Architecture and tech debt): debt inside "
            "the change is fixed "
            "in the change, never marked for later and never silenced. Fix it now; if it is "
            "outside the blast radius, leave the code as it was and name the debt in your "
            "final message and on the vault's TODO board instead.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
