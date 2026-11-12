#!/usr/bin/env python3
"""PreToolUse guard (Edit|Write): tech debt is fixed, never deferred.

The engineering standards (CLAUDE.standards.md §Architecture and tech debt)
say debt inside a change is fixed in that change, and never parked. Prose is
advisory; this turns the mechanical halves of the rule into a gate:

  1. A source-file edit may not ADD a deferral marker or a static-analysis
     suppression. Both are read as directives, never as substrings of a line:
       - a deferral marker is `TODO`/`FIXME`/`HACK`/`XXX` opening a comment, or
         a todo/fixme docblock tag anywhere in one;
       - a suppression is a directive opening a comment (those of
         PHP_CodeSniffer, ESLint, TypeScript, Biome, oxlint, TSLint,
         Stylelint, Deno, flake8, mypy, pylint, Bandit, ShellCheck, RuboCop
         and golangci-lint), or one after a `#` or `//` inside a comment, the
         way flake8 and mypy also read it; an annotation tag anywhere in a
         comment (PHPStan's ignore tags, Psalm's suppress tags, PHPMD's
         SuppressWarnings, PHP_CodeSniffer's codingStandardsIgnore tags);
         Sonar's NOSONAR anywhere in a comment; and two forms written as code:
         the SuppressWarnings attribute (`#[\\SuppressWarnings(...)]`) or
         annotation, and TypeScript's `as unknown as` double cast.
     A comment is what the file's language makes one (`//`, `#`, `/* */`,
     `<!-- -->`, `{# #}`, `--`), outside string literals (Python's triple
     quotes and backtick template literals carry over lines) and, in
     JavaScript, outside regular expression literals. In PHP, Python and Ruby
     `#` opens a comment anywhere outside a string (PHP's `#[` opens an
     attribute); elsewhere only where it starts a word. TypeScript's
     expect-error directive is allowed in test files only: a type-level test
     uses it to assert that code does NOT compile.
  2. A static-analysis baseline may only shrink, measured in what it ignores:
       - PHPStan's `.neon` baseline (`parameters.ignoreErrors` and nothing
         else) and `.php` baseline (`phpstan-baseline.php` …), and the
         `ignoreErrors` and `includes` of a PHPStan configuration
         (`phpstan.neon`, `phpstan.neon.dist`, `phpstan.dist.neon`): every
         (message, identifier, path) an entry names, with its `count` (none
         means every occurrence), and every file included;
       - ESLint's `eslint-suppressions.json`: every (file, rule) with its count;
       - a deptrac baseline (`deptrac.baseline.yaml` …), any XML baseline
         (`psalm-baseline.xml` …), and a JSON baseline named for a known tool
         or shaped as a suppression list (records of message/rule/identifier/
         count/occurrences, file → rule → count, lists of cycles): every entry
         it lists, with its `count`/`occurrences` where it gives one. Any
         other `*baseline*.json` (a size budget, say) holds values, not
         entries, and keeps the line rule: it may not gain lines.
     An edit is refused when any entry ignores more than before or a new one
     appears, whatever else it removes; and when the file, before or after,
     cannot be read in its format. A baseline the repository's HEAD tracks is
     judged against that version when the file is gone; a new baseline is
     allowed only where HEAD tracks none of its kind in the same directory.
     A PHPStan configuration that did not exist ignores nothing.

Only ADDED debt counts: the markers and suppressions of the new text are
compared, as a multiset, with those of the text it replaces (an Edit's
old_string, or the file a Write overwrites). Moving or re-indenting one that is
already there passes; a copy of it is a new one.

Scope is deliberately narrow:
  - only Edit/Write, only files with a source-code extension (prose, plans,
    vault notes and JSON never trigger the marker check),
  - nothing under the Claude config dir (~/.claude / $CLAUDE_CONFIG_DIR), under
    the plugin that ships this hook, or -- when that plugin sits in a
    marketplace clone (`<clone>/plugins/<name>` beside
    `<clone>/.claude-plugin/marketplace.json`) -- anywhere in that clone: the
    hooks, tests, rules and eval fixtures that describe or seed these markers
    must stay writable.

Every reader runs in time linear in its input, and a baseline line longer than
LINE_LIMIT is unreadable. Denial is exit 2: the message goes back to the model,
which fixes the debt instead of marking it. Fails open on an internal error — a
hook must never wedge a session — but a baseline it cannot read is refused,
never passed. Kill switch: CLAUDE_NO_DEBT_GUARD=1.
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter
from itertools import product
from typing import NamedTuple
from xml.etree import ElementTree

SOURCE_EXTENSIONS = {
    ".php", ".phtml", ".twig", ".inc",
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift", ".cs",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm",
    ".sh", ".bash", ".zsh", ".sql", ".css", ".scss", ".less", ".html", ".xml",
    ".yaml", ".yml", ".neon",
}

DEFERRAL_KIND = "deferral marker"
SUPPRESSION_KIND = "static-analysis suppression"


class Syntax(NamedTuple):
    """How a language writes its comments and string literals.

    `multiline` names the quotes whose strings run over lines; `hash_anywhere` says `#` opens a
    comment even inside a word; `hash_attribute` that `#[` opens an attribute; `regex_literals`
    that `/…/` in an operand position is a regular expression.
    """

    line: tuple
    blocks: tuple
    quotes: str
    multiline: tuple = ()
    hash_anywhere: bool = False
    hash_attribute: bool = False
    regex_literals: bool = False


C_LIKE = Syntax(("//",), (("/*", "*/"),), "\"'`", ("`",))
SCRIPT = Syntax(("//",), (("/*", "*/"),), "\"'`", ("`",), regex_literals=True)
COMPONENT = Syntax(("//",), (("/*", "*/"), ("<!--", "-->")), "\"'`", ("`",), regex_literals=True)
PHP = Syntax(("//", "#"), (("/*", "*/"),), "\"'", (), True, True)
PHTML = Syntax(("//", "#"), (("/*", "*/"), ("<!--", "-->")), "\"'", (), True, True)
PYTHON = Syntax(("#",), (), "\"'", ('"""', "'''"), True)
RUBY = Syntax(("#",), (), "\"'", (), True)
CSS = Syntax((), (("/*", "*/"),), "\"'")
SCSS = Syntax(("//",), (("/*", "*/"),), "\"'")
HASH = Syntax(("#",), (), "\"'")
SQL = Syntax(("--", "#"), (("/*", "*/"),), "\"'`")
MARKUP = Syntax((), (("<!--", "-->"),), "")
TWIG = Syntax((), (("{#", "#}"), ("<!--", "-->")), "")

SYNTAX = {".php": PHP, ".inc": PHP, ".phtml": PHTML, ".vue": COMPONENT, ".svelte": COMPONENT,
          ".py": PYTHON, ".rb": RUBY, ".css": CSS, ".scss": SCSS, ".less": SCSS, ".sql": SQL,
          ".html": MARKUP, ".xml": MARKUP, ".twig": TWIG}
SYNTAX.update(dict.fromkeys((".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"), SCRIPT))
SYNTAX.update(dict.fromkeys((".sh", ".bash", ".zsh", ".yaml", ".yml", ".neon"), HASH))
TYPESCRIPT_EXTENSIONS = {".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"}
# The words after which a `/` starts a regular expression rather than a division
REGEX_KEYWORDS = {"return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new",
                  "yield", "await", "instanceof"}
# The code characters after which a `/` starts a regular expression rather than a division; `<` and `>`
# are left out, since in JSX they open and close tags (`</div>`, `<p>a/b</p>`)
REGEX_AFTER = set("=(,:[!&|?{};+-*%~^")
# How much of a comment, from where a directive starts, the directive is compared by
KEY_LIMIT = 400

# What a comment's text opens with before its first word: the opener's own repeats and a docblock's star
COMMENT_LEAD = " \t*!/#"
# A comment opener inside a comment's text, where a second directive may start, as flake8 reads one
CHAINED_COMMENT = re.compile(r"(?:#|//)\s*")
# A docblock's continuation line, read as a comment when an Edit fragment starts inside the block
DOCBLOCK_LINE = re.compile(r"\s*\*(?!/)")
# A deferral marker opens a comment; upper-case only, so a comment saying "todos are loaded here" is prose
DEFERRAL_WORD = re.compile(r"(?:TODO|FIXME|HACK|XXX)\b")
# A tag is not part of a word, an e-mail address or a path
TAG_START = r"(?<![\w@.\-/\\])"
DEFERRAL_TAG = re.compile(TAG_START + r"@(?:todo|fixme)\b", re.I)
# A suppression directive opening a comment, or following a `#` inside one
DIRECTIVE = re.compile(
    r"@?codingStandardsIgnore(?:Line|Start|File)"
    r"|phpcs:(?:ignore|disable)"
    r"|eslint-disable"
    r"|@ts-(?:ignore|nocheck)"
    r"|biome-ignore"
    r"|oxlint-disable"
    r"|tslint:disable"
    r"|stylelint-disable"
    r"|deno-lint-ignore"
    r"|pylint:\s*disable"
    r"|rubocop:\s*disable"
    r"|nolint\b"
    r"|shellcheck\s+disable\b"
    r"|type:\s*ignore\b"
    r"|noqa\b"
    r"|nosec\b",
    re.I,
)
# An annotation tag that suppresses wherever it stands in a comment
SUPPRESSION_TAG = re.compile(
    TAG_START + r"@(?:phpstan-ignore|psalm-(?:suppress|ignore)|SuppressWarnings|codingStandardsIgnore(?:Line|Start|File))",
    re.I,
)
SONAR = re.compile(r"\bNOSONAR\b")
# The name a suppression written as code carries: PHP's attribute, Java's annotation
SUPPRESS_NAME = "SuppressWarnings"
# TypeScript's double cast, which silences the type checker the way a suppression does
DOUBLE_CAST = re.compile(r"\bas\s+unknown\s+as\b")

# `@ts-expect-error` asserts a compile error in a type-level test, and suppresses one anywhere else
TS_EXPECT_ERROR = re.compile(r"@ts-expect-error\b")
TEST_FILE = re.compile(
    r"\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$"
    r"|(?:^|/)(?:__tests__|tests?|type-?tests)/",
    re.I,
)
# The letters of a Python string prefix (`r'…'`, `rb'…'`, `f'…'`)
STRING_PREFIX_LETTERS = set("rRbBuUfF")

BASELINE = re.compile(
    r"baseline[^/]*\.(?:neon|xml|json)$"
    r"|^eslint-suppressions\.json$"
    r"|(?:deptrac|depfile)[^/]*baseline[^/]*\.ya?ml$"
    r"|(?:^phpstan[-_.][\w.-]*baseline[\w.-]*|baseline\.neon)\.php$",
    re.I,
)
ESLINT_SUPPRESSIONS = "eslint-suppressions.json"
PHPSTAN_CONFIG = re.compile(r"^phpstan(?:\.dist)?\.neon(?:\.dist)?$", re.I)
# A JSON baseline named for one of these tools lists suppressions, whatever its shape
SUPPRESSION_TOOL = re.compile(r"phpstan|psalm|phpmd|phpcs|deptrac|eslint", re.I)
# The fields that make a JSON record a suppression entry
SUPPRESSION_FIELDS = {"message", "rawMessage", "rule", "identifier", "count", "occurrences"}

# The largest baseline read, and its longest line; past either it is unreadable rather than parsed slowly
BASELINE_BYTE_LIMIT = 32 * 1024 * 1024
LINE_LIMIT = 65536
# How deeply a baseline may nest, and how many keys one PHPStan entry may expand into
NESTING_LIMIT = 64
ENTRY_KEY_LIMIT = 10000
# The keys whose integer value says how many times an entry applies
COUNT_KEYS = {"count", "occurrences"}
EVERY_OCCURRENCE = float("inf")
# How long one git command may take while a baseline is checked against HEAD
GIT_TIMEOUT = 5
# How deep the files a PHPStan configuration includes are followed
INCLUDE_DEPTH = 8


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


# ------------------------------------------------------------ markers and suppressions

_EVENTS = {}


def events(syntax: Syntax):
    """The pattern of everything that changes what the scanner is in: a quote, a comment opener."""
    if syntax not in _EVENTS:
        tokens = (list(syntax.line) + [opener for opener, _ in syntax.blocks] + list(syntax.quotes)
                  + list(syntax.multiline) + (["/"] if syntax.regex_literals else []))
        tokens = sorted(set(tokens), key=len, reverse=True)
        _EVENTS[syntax] = re.compile("|".join(re.escape(t) for t in tokens)) if tokens else None
    return _EVENTS[syntax]


def word_char(c: str) -> bool:
    return c.isalnum() or c == "_"


def apostrophe(line: str, at: int) -> bool:
    """Report whether the `'` at `at` is a word's apostrophe (`don't`), not a string's opening quote."""
    if at == 0 or not word_char(line[at - 1]):
        return False
    start = at
    while start > 0 and word_char(line[start - 1]) and at - start < 3:
        start -= 1
    prefix = line[start:at]
    if len(prefix) <= 2 and set(prefix) <= STRING_PREFIX_LETTERS and (start == 0 or not word_char(line[start - 1])):
        return False
    return True


def find_closer(line: str, start: int, closer: str, escapes: bool) -> int:
    """The index of `closer` at or after `start`, past backslash escapes when `escapes`; -1 when none."""
    if not escapes:
        return line.find(closer, start)
    i = start
    while i < len(line):
        if line[i] == "\\":
            i += 2
            continue
        if line.startswith(closer, i):
            return i
        i += 1
    return -1


def hash_comment(line: str, at: int, syntax: Syntax) -> bool:
    """Report whether the `#` at `at` opens a comment."""
    if syntax.hash_attribute and line.startswith("#[", at):
        return False
    return syntax.hash_anywhere or at == 0 or line[at - 1].isspace()


def regex_operand(tail: str) -> bool:
    """Report whether a `/` after this code (its last characters) starts a regular expression."""
    tail = tail.rstrip()
    if not tail or tail[-1] in REGEX_AFTER:
        return True
    end = len(tail)
    start = end
    while start > 0 and word_char(tail[start - 1]):
        start -= 1
    return start < end and tail[start:end] in REGEX_KEYWORDS and (start == 0 or not word_char(tail[start - 1]))


def regex_end(line: str, start: int) -> int:
    """The index after a regular expression literal whose body starts at `start`, flags included; -1 when
    the line does not close it."""
    i, in_class = start, False
    while i < len(line):
        c = line[i]
        if c == "\\":
            i += 2
            continue
        if in_class:
            in_class = c != "]"
        elif c == "[":
            in_class = True
        elif c == "/":
            i += 1
            while i < len(line) and line[i].isalpha():
                i += 1
            return i
        i += 1
    return -1


def scan_line(line: str, syntax: Syntax, state, docblock: bool = False):
    """Split one line into its comments' texts and its code, string and regex contents blanked.

    @param state    ("comment", closer) or ("string", closer) when the line starts inside a block
                    comment or a multi-line string, else None
    @param docblock read the line as a docblock continuation: a comment up to `*/`, never past the line
    @return (comment texts, code, the state the line ends in)
    """
    comments, code, i, tail = [], [], 0, ""
    # The quotes and the `/` a scan to the end of this line found unclosed: a later one is unclosed too
    unclosed = set()
    if state is None and docblock:
        state = ("comment", "*/")
    pattern = events(syntax)

    def emit(piece):
        nonlocal tail
        code.append(piece)
        tail = (tail + piece)[-24:]

    while i < len(line):
        if state is not None:
            kind, closer = state
            end = find_closer(line, i, closer, kind == "string")
            if end < 0:
                if kind == "comment":
                    comments.append(line[i:])
                else:
                    emit(" " * (len(line) - i))
                i = len(line)
                break
            if kind == "comment":
                comments.append(line[i:end])
            else:
                emit(" " * (end - i) + closer)
            i, state = end + len(closer), None
            continue
        m = pattern.search(line, i) if pattern else None
        if not m:
            emit(line[i:])
            break
        emit(line[i:m.start()])
        token, i = m.group(0), m.end()
        if token == "/":
            end = -1
            if "/" not in unclosed and regex_operand(tail):
                end = regex_end(line, i)
                if end < 0:
                    unclosed.add("/")
            if end < 0:
                emit(token)
            else:
                emit("/" + " " * (end - i))
                i = end
            continue
        if token in syntax.quotes or token in syntax.multiline:
            if token in unclosed or (token == "'" and apostrophe(line, m.start())):
                emit(token)
                continue
            end = find_closer(line, i, token, True)
            if end < 0:
                unclosed.add(token)
                emit(token)
                if token in syntax.multiline:
                    state = ("string", token)
                    emit(" " * (len(line) - i))
                    i = len(line)
                continue
            emit(token + " " * (end - i) + token)
            i = end + len(token)
            continue
        if token in syntax.line:
            if token == "#" and not hash_comment(line, m.start(), syntax):
                emit(token)
                continue
            comments.append(line[i:])
            break
        state = ("comment", dict(syntax.blocks)[token])
    if docblock and state == ("comment", "*/"):
        state = None
    return comments, "".join(code), state


def directive_key(text: str, at: int) -> str:
    """A directive as it is compared: from where it starts to the end of its comment (at most KEY_LIMIT
    characters), whitespace collapsed."""
    return " ".join(text[at:at + KEY_LIMIT].split())


def comment_debt(comment: str, type_test: bool):
    """The (kind, key) of every deferral marker and suppression one comment's text carries."""
    found, taken = [], set()
    body = len(comment) - len(comment.lstrip(COMMENT_LEAD))
    starts = {body} | {m.end() for m in CHAINED_COMMENT.finditer(comment)}
    for at in sorted(starts):
        if DEFERRAL_WORD.match(comment, at):
            found.append((DEFERRAL_KIND, directive_key(comment, at)))
        elif DIRECTIVE.match(comment, at) or (TS_EXPECT_ERROR.match(comment, at) and not type_test):
            found.append((SUPPRESSION_KIND, directive_key(comment, at)))
        else:
            continue
        taken.add(at)
    for kind, pattern in ((DEFERRAL_KIND, DEFERRAL_TAG), (SUPPRESSION_KIND, SUPPRESSION_TAG),
                          (SUPPRESSION_KIND, SONAR)):
        found += [(kind, directive_key(comment, m.start())) for m in pattern.finditer(comment)
                  if m.start() not in taken]
    return found


def code_suppression(code: str) -> bool:
    """Report whether code carries the SuppressWarnings attribute (`#[\\…\\SuppressWarnings`) or the
    annotation (the name right after an `@`)."""
    at = code.find(SUPPRESS_NAME)
    while at >= 0:
        end = at + len(SUPPRESS_NAME)
        if end == len(code) or not word_char(code[end]):
            if at > 0 and code[at - 1] == "@" and (at < 2 or not (word_char(code[at - 2]) or code[at - 2] in "$@")):
                return True
            start = at
            while start > 0 and (word_char(code[start - 1]) or code[start - 1] == "\\"):
                start -= 1
            while start > 0 and code[start - 1] in " \t":
                start -= 1
            if code[max(0, start - 2):start] == "#[":
                return True
        at = code.find(SUPPRESS_NAME, end)
    return False


def debt_occurrences(text: str, path: str, fragment: bool = False):
    """Count the deferral markers and suppressions a text carries in the language of `path`.

    @param fragment the text is an Edit fragment, which may start inside a docblock: its leading
                    `*` lines are read as the docblock's continuation
    @return (Counter of (kind, key), {(kind, key): the first line that carries it})
    """
    extension = os.path.splitext(path)[1].lower()
    syntax = SYNTAX.get(extension, C_LIKE)
    typescript = extension in TYPESCRIPT_EXTENSIONS
    type_test = bool(TEST_FILE.search(path.replace(os.sep, "/")))
    found, lines, state, leading = Counter(), {}, None, fragment
    for line in text.splitlines():
        docblock = leading and state is None and bool(DOCBLOCK_LINE.match(line))
        if not docblock and line.strip():
            leading = False
        comments, code, state = scan_line(line, syntax, state, docblock)
        hits = [hit for comment in comments for hit in comment_debt(comment, type_test)]
        if code_suppression(code) or (typescript and DOUBLE_CAST.search(code)):
            hits.append((SUPPRESSION_KIND, " ".join(line.split())))
        for hit in hits:
            found[hit] += 1
            lines.setdefault(hit, line.strip())
    return found, lines


def debt_added(old: str, new: str, path: str = "", fragment: bool = False):
    """Find the first deferral marker or suppression the new text carries more often than the old.

    @param old The text being replaced: an Edit's old_string, the file a Write overwrites, or "".
    @param new The text that replaces it.
    @param path The target file: its extension decides the comment syntax, and a test file may
                carry TypeScript's expect-error directive.
    @param fragment both texts are fragments of a file (an Edit's strings, an appended or inserted text)
    @return (kind, line) or None.
    """
    before, _ = debt_occurrences(old, path, fragment)
    after, lines = debt_occurrences(new, path, fragment)
    for hit, count in after.items():
        if count > before[hit]:
            return hit[0], lines[hit]
    return None


def write_debt(tool: str, ti: dict, current, path: str):
    """The first deferral marker or suppression an Edit or Write adds, as debt_added reports it.

    @param current the file's text before a Write, or None when it does not exist
    """
    if tool == "Write":
        return debt_added(current or "", ti.get("content") or "", path)
    return debt_added(ti.get("old_string") or "", ti.get("new_string") or "", path, fragment=True)


def added_lines(tool: str, ti: dict, current) -> list:
    """The lines an Edit or Write adds, for a caller that judges lines with debt_in: the new text's
    lines less one of each line the old text held, compared with surrounding whitespace trimmed."""
    if tool == "Write":
        old, new = (current or ""), ti.get("content") or ""
    else:
        old, new = ti.get("old_string") or "", ti.get("new_string") or ""
    held = Counter(line.strip() for line in old.splitlines())
    out = []
    for line in new.splitlines():
        if held[line.strip()] > 0:
            held[line.strip()] -= 1
        elif line.strip():
            out.append(line)
    return out


def debt_in(lines, path: str = ""):
    """The first deferral marker or suppression among lines that are all new to the file.

    @return (kind, line) or None.
    """
    return debt_added("", "\n".join(lines), path, fragment=True)


# ------------------------------------------------------------ baselines

class Unreadable(Exception):
    """A baseline whose content cannot be read in its format."""


def text_after(tool: str, ti: dict, current: str) -> str:
    """The file's text once the Write/Edit is applied."""
    if tool == "Write":
        return ti.get("content") or ""
    old, new = ti.get("old_string") or "", ti.get("new_string") or ""
    return current.replace(old, new) if ti.get("replace_all") else current.replace(old, new, 1)


def canonical(value) -> str:
    """A value as one comparable string."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


def as_count(value):
    """The count a value states (an integer, or the digits of a YAML/NEON scalar), else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def flat(node) -> bool:
    """Report whether a node is a non-empty mapping of scalars: one record of a baseline."""
    return isinstance(node, dict) and bool(node) and all(not isinstance(v, (dict, list)) for v in node.values())


def record_entry(record: dict, path: tuple, out: Counter) -> None:
    """Count one flat record: its fields name the entry, its count field how often it applies."""
    count, rest = None, {}
    for key, value in record.items():
        if key in COUNT_KEYS and as_count(value) is not None:
            count = as_count(value)
        else:
            rest[key] = value
    out[("entry", path, canonical(rest))] += 1 if count is None else count


def generic_entries(node, path: tuple, out: Counter, depth: int = 0) -> None:
    """Collect what a parsed JSON or YAML baseline lists: each scalar under its key path, each flat
    record with its count, and each nested list item as one whole entry. Empty containers list nothing."""
    if depth > NESTING_LIMIT:
        raise Unreadable("nested deeper than %d levels" % NESTING_LIMIT)
    if flat(node):
        record_entry(node, path, out)
    elif isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, (dict, list)):
                generic_entries(value, path + (str(key),), out, depth + 1)
            elif value is not None:
                out[("entry", path + (str(key),), canonical(value))] += 1
    elif isinstance(node, list):
        for item in node:
            if flat(item):
                record_entry(item, path, out)
            elif item is not None and item != [] and item != {}:
                out[("entry", path, canonical(item))] += 1
    elif node is not None:
        out[("entry", path, canonical(node))] += 1


def suppression_shaped(node, depth: int = 0) -> bool:
    """Report whether parsed JSON is shaped as a suppression list: records naming a message, rule,
    identifier or count; file → rule → {count}; or a list of cycles (lists of names)."""
    if depth > NESTING_LIMIT:
        return False
    if isinstance(node, list):
        items = [item for item in node if item is not None]
        if items and all(isinstance(item, list) and all(not isinstance(x, (dict, list)) for x in item)
                         for item in items):
            return True
        if items and all(isinstance(item, dict) and SUPPRESSION_FIELDS & set(item) for item in items):
            return True
        return any(suppression_shaped(item, depth + 1) for item in items if isinstance(item, (dict, list)))
    if isinstance(node, dict):
        counted = [rules for rules in node.values() if isinstance(rules, dict)]
        if counted and len(counted) == len(node) and any(counted) and all(
                flat(entry) and as_count(entry.get("count")) is not None
                for rules in counted for entry in rules.values()):
            return True
        return any(suppression_shaped(v, depth + 1) for v in node.values() if isinstance(v, (dict, list)))
    return False


def json_entries(text: str) -> Counter:
    """What a JSON baseline ignores (ESLint's suppressions file included: file → rule → count)."""
    if not text.strip():
        return Counter()
    try:
        data = json.loads(text)
    except ValueError as error:
        raise Unreadable("not valid JSON: %s" % error)
    out = Counter()
    generic_entries(data, (), out)
    return out


def read_by_lines(name: str, before: str) -> bool:
    """Report whether a baseline is judged by its line count: a JSON one that names no known tool
    and is no suppression list, whose values are not entries to compare."""
    lower = name.lower()
    if not lower.endswith(".json") or lower == ESLINT_SUPPRESSIONS or SUPPRESSION_TOOL.search(name):
        return False
    try:
        return not suppression_shaped(json.loads(before))
    except (ValueError, RecursionError):
        return True


def xml_entries(text: str):
    """What an XML baseline ignores: each leaf element under its chain of ancestors (tag and
    attributes), with its text; an element with an `occurrences`/`count` attribute is a counted
    entry whether or not it holds children.

    @return (Counter of entries, the set of element chains that held children)
    """
    if not text.strip():
        return Counter(), set()
    if re.search(r"<!(?:DOCTYPE|ENTITY)", text, re.I):
        raise Unreadable("an XML document type declaration is not read")
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise Unreadable("not well-formed XML: %s" % error)
    out, containers = Counter(), set()

    def walk(element, chain, depth):
        if depth > NESTING_LIMIT:
            raise Unreadable("nested deeper than %d levels" % NESTING_LIMIT)
        attributes = tuple(sorted((k, v) for k, v in element.attrib.items()
                                  if k not in COUNT_KEYS and "version" not in k.lower()))
        here = chain + ((element.tag, attributes),)
        counts = [as_count(v) for k, v in element.attrib.items() if k in COUNT_KEYS]
        count = next((c for c in counts if c is not None), None)
        children = list(element)
        if count is not None:
            out[("xml-count", here, "" if children else (element.text or "").strip())] += count
        if children:
            containers.add(here)
            for child in children:
                walk(child, here, depth + 1)
        elif depth > 0 and count is None:
            out[("xml", here, (element.text or "").strip())] += 1

    walk(root, (), 0)
    return out, containers


# ---- a reader for the block YAML and NEON that baselines are written in

FLOW_STOP = ",[]{}"
# A quoted string, or a `#` that starts a word: the first such `#` outside a string opens a comment
STRING_OR_COMMENT = re.compile(r"""'[^']*'|"(?:[^"\\]|\\.)*"|(?<!\S)#""")
SINGLE_QUOTED = re.compile(r"'(?:[^']|'')*'")
DOUBLE_QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"')
FENCES = ("'''", '"""')


def strip_comment(line: str) -> str:
    """The line without its `#` comment: a `#` that starts a word, outside quotes."""
    if "#" not in line:
        return line.rstrip()
    for m in STRING_OR_COMMENT.finditer(line):
        if m.group(0) == "#":
            return line[:m.start()].rstrip()
    return line.rstrip()


def block_lines(text: str):
    """The (indent, content) of every line that holds something, comments taken off; a `'''` or `\"\"\"`
    string running over lines becomes one single-quoted value."""
    out, raws, i = [], text.splitlines(), 0
    while i < len(raws):
        raw = raws[i]
        i += 1
        if len(raw) > LINE_LIMIT:
            raise Unreadable("a line longer than %d characters" % LINE_LIMIT)
        content = strip_comment(raw)
        if not content.strip():
            continue
        stripped = content.lstrip(" \t")
        indent = len(content) - len(stripped)
        fence = next((f for f in FENCES if stripped.endswith(f)), None)
        head = stripped[:-3].rstrip() if fence else ""
        if fence and (head == "" or head == "-" or head.endswith(":")):
            body = []
            while i < len(raws) and raws[i].strip() != fence:
                body.append(raws[i].strip())
                i += 1
            if i >= len(raws):
                raise Unreadable("a multi-line string that does not close")
            i += 1
            value = "'" + "\n".join(body).replace("'", "''") + "'"
            stripped = (head + " " + value) if head else value
        out.append((indent, stripped))
    return out


def sequence_item(content: str) -> bool:
    """Report whether a line opens a sequence item (`- x`, or a bare `-`)."""
    return content == "-" or content.startswith("- ") or content.startswith("-\t")


def key_colon(text: str, start: int, stops: str) -> int:
    """The index of the first `:` at or after `start` that ends a key (followed by whitespace or the
    end), -1 when one of `stops` or the end comes first."""
    i = start
    while i < len(text):
        c = text[i]
        if c == ":" and (i + 1 == len(text) or text[i + 1] in " \t"):
            return i
        if c in stops:
            return -1
        i += 1
    return -1


def mapping_entry(content: str):
    """Split `key: value` into (key, value text); None when the line is no mapping entry."""
    if not content:
        return None
    if content[0] in "'\"":
        try:
            key, end = quoted(content, 0)
        except Unreadable:
            return None
        if not content.startswith(":", end) or not (end + 1 == len(content) or content[end + 1] in " \t"):
            return None
        return key, content[end + 1:].strip()
    if content[0] in "[]{},#:" or sequence_item(content):
        return None
    colon = key_colon(content, 0, "#")
    if colon < 0:
        return None
    key = content[:colon].rstrip()
    return (key, content[colon + 1:].strip()) if key else None


def quoted(text: str, at: int):
    """Read the quoted string at `at`: (its raw content, the index after its closing quote)."""
    m = (SINGLE_QUOTED if text[at] == "'" else DOUBLE_QUOTED).match(text, at)
    if not m:
        raise Unreadable("an unterminated string")
    return m.group(0)[1:-1], m.end()


def quoted_scalar(text: str) -> bool:
    """Report whether the text is one quoted string and nothing else (`'#^a: b$#'` is no mapping)."""
    if text[:1] not in "'\"":
        return False
    try:
        _, end = quoted(text, 0)
    except Unreadable:
        return False
    return not text[end:].strip()


def scalar(text: str, depth: int = 0):
    """Read an inline value: a quoted string (its raw content), a flow list or mapping, or a bare word."""
    text = text.strip()
    if text[:1] in "|>":
        raise Unreadable("a block scalar is not read")
    if text[:1] in "[{'\"":
        value, end = flow_value(text, 0, depth)
        if text[end:].strip():
            raise Unreadable("text after an inline value: %r" % text[end:][:60])
        return value
    return text


def flow_key(text: str, at: int):
    """Read the key of an inline mapping entry at `at`: (key, index after its `:`)."""
    at = skip_space(text, at)
    if at < len(text) and text[at] in "'\"":
        key, end = quoted(text, at)
        end = skip_space(text, end)
        if not text.startswith(":", end):
            raise Unreadable("an inline mapping entry without a key")
        return key, end + 1
    colon = key_colon(text, at, ",[]{}'\"")
    if colon < 0 or not text[at:colon].strip():
        raise Unreadable("an inline mapping entry without a key")
    return text[at:colon].strip(), colon + 1


def flow_value(text: str, at: int, depth: int):
    """Read an inline `[…]` list, `{…}` mapping, quoted string or bare word at `at`: (value, index after it)."""
    if depth > NESTING_LIMIT:
        raise Unreadable("nested deeper than %d levels" % NESTING_LIMIT)
    at = skip_space(text, at)
    if at >= len(text):
        raise Unreadable("an inline value ends early")
    if text[at] in "'\"":
        return quoted(text, at)
    if text[at] not in "[{":
        end = at
        while end < len(text) and text[end] not in FLOW_STOP:
            end += 1
        return text[at:end].strip(), end
    closing, mapping = ("]", False) if text[at] == "[" else ("}", True)
    items, values, at = {}, [], at + 1
    while True:
        at = skip_space(text, at)
        if at < len(text) and text[at] == closing:
            return (items if mapping else values), at + 1
        if mapping:
            key, at = flow_key(text, at)
            items[key], at = flow_value(text, at, depth + 1)
        else:
            value, at = flow_value(text, at, depth + 1)
            values.append(value)
        at = skip_space(text, at)
        if at < len(text) and text[at] == ",":
            at += 1
        elif at >= len(text) or text[at] != closing:
            raise Unreadable("an inline list or mapping that does not close")


def parse_block(lines: list, i: int, depth: int = 0):
    """Read the node whose first line is lines[i], at that line's indent: (node, index after it)."""
    if depth > NESTING_LIMIT:
        raise Unreadable("nested deeper than %d levels" % NESTING_LIMIT)
    if sequence_item(lines[i][1]):
        return parse_sequence(lines, i, depth)
    return parse_mapping(lines, i, depth)


def parse_sequence(lines: list, i: int, depth: int):
    """Read the `- item` lines at lines[i]'s indent: (list, index after them)."""
    indent, items = lines[i][0], []
    while i < len(lines) and lines[i][0] == indent and sequence_item(lines[i][1]):
        content = lines[i][1]
        rest = content[1:].lstrip(" \t")
        if not rest:
            i += 1
            if i < len(lines) and lines[i][0] > indent:
                node, i = parse_block(lines, i, depth + 1)
            else:
                node = None
        elif rest[:1] not in "[{" and not quoted_scalar(rest) and mapping_entry(rest) is not None:
            lines[i] = (indent + len(content) - len(rest), rest)
            node, i = parse_mapping(lines, i, depth + 1)
        else:
            node, i = scalar(rest, depth), i + 1
        items.append(node)
    return items, i


def parse_mapping(lines: list, i: int, depth: int):
    """Read the `key: value` lines at lines[i]'s indent: (dict, index after them)."""
    indent, out = lines[i][0], {}
    while i < len(lines) and lines[i][0] == indent and not sequence_item(lines[i][1]):
        entry = mapping_entry(lines[i][1])
        if entry is None:
            raise Unreadable("a line that is neither a key nor a list item: %r" % lines[i][1][:60])
        key, rest = entry
        i += 1
        if rest:
            value = scalar(rest, depth)
        elif i < len(lines) and lines[i][0] > indent:
            value, i = parse_block(lines, i, depth + 1)
        elif i < len(lines) and lines[i][0] == indent and sequence_item(lines[i][1]):
            value, i = parse_sequence(lines, i, depth + 1)
        else:
            value = None
        out[key] = value
    return out, i


def parse_document(lines: list):
    """Read a whole block document; a line left over (an indent that fits nothing) is unreadable."""
    if not lines:
        return None
    lines = list(lines)
    node, i = parse_block(lines, 0)
    if i != len(lines):
        raise Unreadable("a line whose indentation fits nothing above it: %r" % lines[i][1][:60])
    return node


def yaml_entries(text: str) -> Counter:
    """What a YAML baseline (deptrac's) ignores: every entry it lists."""
    out = Counter()
    generic_entries(parse_document(block_lines(text)), (), out)
    return out


# ---- PHPStan: entries of message, identifier, path and count

def phpstan_values(entry: dict, single: str, plural: str) -> list:
    """The values an ignoreErrors entry gives under its singular and plural key."""
    out = []
    for key in (single, plural):
        value = entry.get(key)
        if value is None:
            continue
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, (dict, list)):
                raise Unreadable("%s holds a nested value" % key)
            out.append(str(item))
    return out


def phpstan_entries(items) -> Counter:
    """What an ignoreErrors list ignores: every (message, identifier, path) an entry names, with its
    count; an entry without a count ignores every occurrence."""
    out = Counter()
    if items is None:
        return out
    if not isinstance(items, list):
        raise Unreadable("ignoreErrors is not a list")
    for item in items:
        if isinstance(item, str):
            item = {"message": item}
        if not isinstance(item, dict):
            raise Unreadable("an ignoreErrors entry is neither a message nor a mapping")
        messages = ([("message", m) for m in phpstan_values(item, "message", "messages")]
                    + [("rawMessage", m) for m in phpstan_values(item, "rawMessage", "rawMessages")]) or [None]
        identifiers = phpstan_values(item, "identifier", "identifiers") or [None]
        paths = phpstan_values(item, "path", "paths") or [None]
        if len(messages) * len(identifiers) * len(paths) > ENTRY_KEY_LIMIT:
            raise Unreadable("an ignoreErrors entry names too many combinations")
        count = item.get("count")
        weight = EVERY_OCCURRENCE if count is None else as_count(count)
        if weight is None:
            raise Unreadable("an ignoreErrors count that is not a number: %r" % (count,))
        for key in product(messages, identifiers, paths):
            out[("phpstan",) + key] += weight
    return out


def include_entries(node) -> Counter:
    """The files an `includes` list brings in, each an entry: what they ignore is not read here."""
    out = Counter()
    for item in ([] if node is None else node if isinstance(node, list) else [node]):
        if isinstance(item, (dict, list)):
            raise Unreadable("an includes entry that is not a file name")
        out[("include", str(item))] += 1
    return out


def block_after(lines: list, i: int, indent: int) -> int:
    """The index after the lines that belong to the key at `indent` whose value starts at lines[i]."""
    end = i
    while end < len(lines) and (lines[end][0] > indent or (lines[end][0] == indent and sequence_item(lines[end][1]))):
        end += 1
    return end


def neon_entries(text: str) -> Counter:
    """What a PHPStan configuration ignores: its `ignoreErrors` lists, block or flow style, and the
    files its top-level `includes` brings in. The rest of the file is not read; an `ignoreErrors`
    in a form not read here is unreadable."""
    lines, out, i = block_lines(text), Counter(), 0
    while i < len(lines):
        indent, content = lines[i]
        entry = mapping_entry(content)
        i += 1
        if entry is None:
            if "ignoreErrors" in content:
                raise Unreadable("ignoreErrors written in a form this guard does not read")
            continue
        key, rest = entry
        if key != "ignoreErrors" and not (key == "includes" and indent == 0):
            if "ignoreErrors" in rest:
                node = scalar(rest)
                if not isinstance(node, dict) or "ignoreErrors" not in node:
                    raise Unreadable("ignoreErrors written in a form this guard does not read")
                out.update(phpstan_entries(node["ignoreErrors"]))
            continue
        if rest:
            node = scalar(rest)
        else:
            end = block_after(lines, i, indent)
            node = parse_document(lines[i:end]) if end > i else None
            i = end
        out.update(phpstan_entries(node) if key == "ignoreErrors" else include_entries(node))
    return out


def neon_baseline_entries(text: str) -> Counter:
    """What a PHPStan NEON baseline ignores; it holds `parameters.ignoreErrors` and nothing else, so
    an `includes` or another parameter in it is unreadable rather than unread."""
    document = parse_document(block_lines(text))
    if document is None:
        return Counter()
    if not isinstance(document, dict) or set(document) - {"parameters"}:
        raise Unreadable("a PHPStan baseline holds parameters.ignoreErrors and nothing else")
    parameters = document.get("parameters")
    if parameters is None:
        return Counter()
    if not isinstance(parameters, dict) or set(parameters) - {"ignoreErrors"}:
        raise Unreadable("a PHPStan baseline holds parameters.ignoreErrors and nothing else")
    return phpstan_entries(parameters.get("ignoreErrors"))


PHP_ENTRY = re.compile(r"\$ignoreErrors\s*\[\s*\]\s*=\s*(?:\[|array\s*\()")
PHP_TERM = re.compile(r"""'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|__DIR__|-?\d+""")
# The statements of the frame PHPStan writes around a PHP baseline's entries
PHP_FRAME = (
    re.compile(r"<\?php\b"),
    re.compile(r"declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;"),
    re.compile(r"\$ignoreErrors\s*=\s*(?:\[\s*\]|array\s*\(\s*\))\s*;"),
    re.compile(r"return\s*\[\s*['\"]parameters['\"]\s*=>\s*\[\s*['\"]ignoreErrors['\"]\s*=>\s*\$ignoreErrors"
               r"\s*(?:,\s*)?\]\s*(?:,\s*)?\]\s*;"),
)


def skip_space(text: str, at: int) -> int:
    """The index of the first character at or after `at` that is no whitespace."""
    while at < len(text) and text[at].isspace():
        at += 1
    return at


def skip_php_gap(text: str, at: int) -> int:
    """The index of the first character at or after `at` that is neither whitespace nor a PHP comment.

    A line comment that holds `?>` is unreadable: PHP ends the comment there and runs what follows.
    """
    while at < len(text):
        if text[at].isspace():
            at += 1
        elif text.startswith("//", at) or (text[at] == "#" and not text.startswith("#[", at)):
            end = text.find("\n", at)
            end = len(text) if end < 0 else end
            if "?>" in text[at:end]:
                raise Unreadable("`?>` ends a comment and runs what follows it")
            at = end
        elif text.startswith("/*", at):
            end = text.find("*/", at + 2)
            if end < 0:
                raise Unreadable("a comment that does not close")
            at = end + 2
        else:
            break
    return at


def php_frame(text: str) -> bool:
    """Report whether the text left beside the entries is PHPStan's frame and comments, nothing else."""
    at = 0
    while True:
        at = skip_php_gap(text, at)
        if at >= len(text):
            return True
        for statement in PHP_FRAME:
            m = statement.match(text, at)
            if m:
                at = m.end()
                break
        else:
            return False


def php_value(text: str, at: int):
    """Read one entry value: strings, numbers and __DIR__ joined by `.`: (value, index after it)."""
    terms = []
    while True:
        term = PHP_TERM.match(text, skip_php_gap(text, at))
        if not term:
            raise Unreadable("an entry value that is not a string, a number or __DIR__")
        terms.append(term.group(0))
        at = skip_php_gap(text, term.end())
        if not text.startswith(".", at):
            break
        at += 1
    if len(terms) == 1 and re.fullmatch(r"-?\d+", terms[0]):
        return int(terms[0]), at
    if len(terms) == 1 and terms[0][:1] in "'\"":
        return terms[0][1:-1], at
    return " . ".join(terms), at


def php_array(text: str, at: int, closing: str):
    """Read the `'key' => value, …` pairs of one entry up to its closing bracket and `;`: (dict, index after)."""
    out = {}
    while True:
        at = skip_php_gap(text, at)
        if text.startswith(closing, at):
            at = skip_php_gap(text, at + 1)
            if not text.startswith(";", at):
                raise Unreadable("an entry that does not end with `;`")
            return out, at + 1
        key = PHP_TERM.match(text, at)
        if not key or key.group(0)[:1] not in "'\"":
            raise Unreadable("an entry key that is not a string")
        at = skip_php_gap(text, key.end())
        if not text.startswith("=>", at):
            raise Unreadable("an entry key without `=>`")
        out[key.group(0)[1:-1]], at = php_value(text, at + 2)
        at = skip_php_gap(text, at)
        if text.startswith(",", at):
            at += 1
        elif not text.startswith(closing, at):
            raise Unreadable("an entry whose pairs are not separated by `,`")


def php_entries(text: str) -> Counter:
    """What a PHPStan PHP baseline ignores: each `$ignoreErrors[] = [...]` entry; anything else in
    the file beyond the generated frame is unreadable."""
    items, kept, at = [], [], 0
    for m in PHP_ENTRY.finditer(text):
        if m.start() < at:
            raise Unreadable("an entry inside another entry")
        kept.append(text[at:m.start()])
        closing = "]" if text[m.end() - 1] == "[" else ")"
        entry, at = php_array(text, m.end(), closing)
        items.append(entry)
    kept.append(text[at:])
    if not php_frame("".join(kept)):
        raise Unreadable("PHP beyond `$ignoreErrors[] = [...]` entries and the generated frame")
    return phpstan_entries(items)


def baseline_entries(name: str, text: str):
    """Read what a baseline ignores, by its format.

    @return (Counter of entries, the set of XML element chains that held children)
    @throws Unreadable when the text cannot be read in that format
    """
    if len(text) > BASELINE_BYTE_LIMIT:
        raise Unreadable("larger than %d MB" % (BASELINE_BYTE_LIMIT // (1024 * 1024)))
    lower = name.lower()
    try:
        if lower.endswith(".json"):
            return json_entries(text), set()
        if lower.endswith(".xml"):
            return xml_entries(text)
        if lower.endswith(".php"):
            return php_entries(text), set()
        if lower.endswith((".yaml", ".yml")):
            return yaml_entries(text), set()
        if PHPSTAN_CONFIG.search(name):
            return neon_entries(text), set()
        return neon_baseline_entries(text), set()
    except RecursionError:
        raise Unreadable("nested too deeply")


def describe(entry: tuple) -> str:
    """One entry, briefly, for a denial."""
    if entry[0] == "phpstan":
        message, identifier, path = entry[1:]
        parts = ["%s %s" % message] if message is not None else []
        if identifier is not None:
            parts.append("identifier " + identifier)
        parts.append("path " + (path if path is not None else "(any)"))
        text = ", ".join(parts)
    elif entry[0] == "include":
        text = "includes " + entry[1]
    elif entry[0] in ("xml", "xml-count"):
        text = "/".join(tag for tag, _ in entry[1]) + (": " + entry[2] if entry[2] else "")
    else:
        text = "/".join(entry[1]) + (": " if entry[1] else "") + entry[2]
    return text if len(text) <= 200 else text[:197] + "..."


def growth(before, after, include_reason=None):
    """The first entry the new baseline ignores more often than the old one, with a note on why, else None.

    An XML element that held children before and holds none now, with no count, is a shrunk
    container, not an entry. A new include is growth only when `include_reason` gives a reason for it
    (the file it names ignores something, is a baseline, or cannot be read); without the function every
    new include is.

    @return (entry, note) or None
    """
    old, containers = before
    new, _ = after
    for entry, count in new.items():
        if entry[0] == "xml" and entry[2] == "" and entry[1] in containers:
            continue
        if count <= old.get(entry, 0):
            continue
        if entry[0] == "include" and include_reason is not None:
            why = include_reason(entry[1])
            if why is None:
                continue
            return entry, ", which " + why
        return entry, ""
    return None


def include_reason(directory: str, name: str, depth: int = 0, seen=None):
    """Why a file a PHPStan configuration includes may ignore errors, else None.

    @param directory where the including file lies: a relative name is read from there
    @return "ignores errors", "is a baseline", "cannot be read …" (and through what it includes in turn)
    """
    seen = set() if seen is None else seen
    if "%" in name:
        return "names a parameter this guard cannot resolve"
    if depth > INCLUDE_DEPTH:
        return "includes files nested deeper than %d levels" % INCLUDE_DEPTH
    target = os.path.normpath(os.path.join(directory, name))
    if target in seen:
        return None
    seen.add(target)
    base = os.path.basename(target)
    if BASELINE.search(base):
        return "is a baseline"
    if not base.lower().endswith((".neon", ".neon.dist")):
        return "cannot be read: it is not a NEON file"
    text = existing_text(target)
    if text is None:
        return "cannot be read"
    try:
        if len(text) > BASELINE_BYTE_LIMIT:
            raise Unreadable("larger than %d MB" % (BASELINE_BYTE_LIMIT // (1024 * 1024)))
        entries = neon_entries(text)
    except (Unreadable, RecursionError) as error:
        return "cannot be read (%s)" % error
    for entry in entries:
        if entry[0] == "phpstan":
            return "ignores errors"
    for entry in entries:
        if entry[0] == "include":
            why = include_reason(os.path.dirname(target), entry[1], depth + 1, seen)
            if why is not None:
                return "includes %s, which %s" % (entry[1], why)
    return None


def ignore_verdict(name: str, current, after: str, label: str, includes=None):
    """Why an edit leaves a baseline ignoring more than before, or unreadable; None when it does not.

    @param current  the file's text before the edit, or None when it does not exist yet
    @param label    how the denial names the file
    @param includes judges a new include by the file it names (see growth)
    """
    try:
        before = baseline_entries(name, current) if current is not None else (Counter(), set())
    except Unreadable as error:
        return ("%s cannot be read as it stands (%s), so whether this edit grows it cannot be checked; "
                "edit it by hand, or bring it back to the format its tool writes" % (label, error))
    try:
        new = baseline_entries(name, after)
    except Unreadable as error:
        return ("this edit leaves %s in a form this guard cannot read (%s), so whether it grows cannot be "
                "checked; keep the format its tool writes" % (label, error))
    grown = growth(before, new, includes)
    if grown is not None:
        entry, note = grown
        return "this edit grows %s: it ignores more than before -- %s%s" % (label, describe(entry), note)
    return None


# ---- what the repository's HEAD holds

def git_output(args: list, cwd: str):
    """Run git in `cwd`: its output, or None when it answers that it cannot (not a repository, no such
    file at HEAD).

    @throws Unreadable when git cannot be run or does not answer in time
    """
    try:
        done = subprocess.run(["git", "-C", cwd] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        raise Unreadable("git could not be asked what HEAD holds: %s" % error)
    return done.stdout if done.returncode == 0 else None


def repository_of(path: str):
    """(the repository's root, the path relative to it with `/`), or None outside a repository."""
    directory = os.path.dirname(os.path.abspath(path))
    while not os.path.isdir(directory):
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent
    root = git_output(["rev-parse", "--show-toplevel"], directory)
    if not root:
        return None
    root = os.path.realpath(root.decode("utf-8", "replace").strip())
    real = os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(path))), os.path.basename(path))
    relative = os.path.relpath(real, root)
    if relative.startswith(".."):
        return None
    return root, relative.replace(os.sep, "/")


def head_text(path: str):
    """The text HEAD holds at `path`, or None when HEAD tracks no file there (or there is no repository)."""
    found = repository_of(path)
    if found is None:
        return None
    root, relative = found
    blob = git_output(["show", "HEAD:" + relative], root)
    return None if blob is None else blob.decode("utf-8", "ignore")


def baseline_tracked(path: str) -> bool:
    """Report whether `path` is a static-analysis baseline the repository's HEAD tracks: deleting or
    moving it would let it be written back with more in it."""
    return bool(BASELINE.search(os.path.basename(path))) and head_text(path) is not None


def baseline_kind(name: str) -> str:
    """Which tool a baseline belongs to, as far as its name tells."""
    lower = name.lower()
    if lower == ESLINT_SUPPRESSIONS:
        return "eslint"
    if lower.endswith((".neon", ".php")):
        return "phpstan"
    if lower.endswith(".xml"):
        return "xml"
    if lower.endswith((".yaml", ".yml")):
        return "deptrac"
    return lower


def tracked_sibling(path: str, name: str):
    """A baseline of the same kind HEAD tracks in the directory of `path`, else None."""
    found = repository_of(path)
    if found is None:
        return None
    root, relative = found
    directory = relative.rpartition("/")[0]
    listing = git_output(["ls-tree", "--name-only", "-z", "HEAD", (directory + "/") if directory else "."], root)
    kind = baseline_kind(name)
    for entry in (listing or b"").decode("utf-8", "replace").split("\0"):
        other = entry.rpartition("/")[2]
        if other and BASELINE.search(other) and baseline_kind(other) == kind:
            return entry
    return None


def line_growth(tool: str, ti: dict, before: str, after: str) -> bool:
    """Report whether an edit gives a file more lines than it takes away."""
    if tool == "Write":
        return len(after.splitlines()) > len(before.splitlines())
    return len((ti.get("new_string") or "").splitlines()) > len((ti.get("old_string") or "").splitlines())


def baseline_verdict(tool: str, ti: dict, current, name: str = "", path: str = ""):
    """Why the edit grows a static-analysis baseline or leaves it unreadable, else None.

    @param path the file, when known: a baseline HEAD tracks there is the measure of one that is
                gone, and a new one may not join a tracked one of its kind in its directory
    """
    label = "the static-analysis baseline " + name
    try:
        before = current if current is not None or not path else head_text(path)
        if before is None:
            sibling = tracked_sibling(path, name) if path else None
            if sibling is not None:
                return ("this edit creates %s beside %s, a baseline of the same kind the repository tracks; the "
                        "second-baseline rule refuses it, since a second baseline can ignore what the first no "
                        "longer does. A copy kept for reference belongs under var/ or outside the project, not "
                        "beside the baseline" % (label, sibling))
            return None
    except Unreadable as error:
        return "%s cannot be checked against what the repository tracks (%s)" % (label, error)
    after = text_after(tool, ti, before)
    if read_by_lines(name, before):
        if line_growth(tool, ti, before, after):
            return ("this edit grows %s: it adds lines to a baseline whose values this guard does not read "
                    "as entries" % label)
        return None
    return ignore_verdict(name, before, after, label)


def baseline_growth(tool: str, ti: dict, current, name: str = "") -> bool:
    """True when the edit leaves a baseline ignoring more than it did, or in a form that cannot be read."""
    return baseline_verdict(tool, ti, current, name) is not None


def baseline_ignores_nothing(path: str) -> bool:
    """Report whether the baseline at `path` can be read and ignores nothing: removing it widens nothing.

    A file that is missing, unreadable, no baseline, or a baseline whose values are not read as
    entries (see read_by_lines) does not qualify.
    """
    name = os.path.basename(path)
    text = existing_text(path)
    if not BASELINE.search(name) or text is None:
        return False
    try:
        if read_by_lines(name, text):
            return False
        entries, _ = baseline_entries(name, text)
    except Unreadable:
        return False
    return not entries


def config_verdict(tool: str, ti: dict, current, name: str, path: str = ""):
    """Why the edit adds to the ignoreErrors or includes of a PHPStan configuration, else None.

    A new include is judged by the file it names, read from the configuration's directory.
    """
    label = "the ignoreErrors and includes of the PHPStan configuration " + name
    before = current
    if before is None and path:
        try:
            before = head_text(path)
        except Unreadable as error:
            return "%s cannot be checked against what the repository tracks (%s)" % (label, error)
    directory = os.path.dirname(os.path.abspath(path)) if path else ""

    def judged(included: str):
        return include_reason(directory, included)

    return ignore_verdict(name, before, text_after(tool, ti, before or ""), label, judged if path else None)


def deny_baseline(why: str) -> int:
    print(
        f"BLOCKED by debt_guard.py (guards plugin): {why}. The engineering standards "
        "(CLAUDE.standards.md §PHP static analysis, §JavaScript and TypeScript static analysis): the "
        "baseline only shrinks — fix the reported errors at the project's level, or report them as "
        "unfixable and explain why.",
        file=sys.stderr,
    )
    return 2


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
            why = baseline_verdict(tool, ti, current, name, path)
            return deny_baseline(why) if why else 0
        if PHPSTAN_CONFIG.search(name):
            why = config_verdict(tool, ti, current, name, path)
            if why:
                return deny_baseline(why)
        if ext not in SOURCE_EXTENSIONS:
            return 0
        hit = write_debt(tool, ti, current, path)
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
