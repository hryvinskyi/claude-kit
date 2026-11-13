#!/usr/bin/env python3
r"""vault_check.py — hold a project's knowledge vault to the code it describes. Global and project-agnostic.

Usage (anywhere inside the project, or with --root DIR):
    vault-check                # measure, print, carry the review stamps forward
    vault-check --check        # measure and print; write nothing
    vault-check --quiet        # as the default, printing only the summary line
    vault-check --brief        # the SessionStart lines: cached, refreshed detached
    vault-check --stamp NOTE…  # NOTE was reviewed: the code it cites is current

Exits 1 while a hard finding stands (never with --brief), 0 otherwise, and 0 when there is no vault.
One check runs per vault at a time: the detached --refresh gives way to a running one, every other
run waits for it up to LOCK_WAIT seconds and then exits 2 (the lock is free the moment its holder
exits, however it exits). A lock that cannot be taken at all — no flock(2), a state directory it
cannot write — is not waited for: a read-only --check runs without it, any run that would write
exits 2 and says why.

**Living notes** describe the code as it is: every note in a folder named for units of code —
Modules, Bridges, Plugins, Kernel, Packages, Services — the Runbooks, and the `00 …` overview at the
vault's top. Their prose is what follows a `<!-- …:generated:end -->` marker, or the whole note after
its frontmatter. A class name or repository path cited there in a code span that exists nowhere is a
HARD finding; a cited file that changed since the paragraph citing it was stamped is a SOFT one.

**Every note's** wikilinks must resolve, the way Obsidian resolves them (HARD). **Decision records**
are linted against the `YYYY-MM-DD slug.md` + `type: decision` template only in a vault whose records
overwhelmingly follow it: a vault with a convention of its own is not held to somebody else's.

A code span is read as a path when its first segment exists at the project root in any case, or
once did in the history of HEAD or the default branch, or — in a note named for a package — inside
that package (`packages/<note>/`, `plugins/<note>/`, `vendor/*/<note>/`, or a directory a configured
note-base rule derives from the note's name). Its segments are compared with the names on disk, so a
path cited in the wrong case is HARD even where the file system ignores case. `path::member` checks
the path, then the member: HARD when neither the file nor any other code names it (it may be
inherited). A class name is looked up, case-insensitively,
as a PHP file name in the repository, then as a whole word in its non-Markdown files, then as a PHP file
name under `vendor/`. A git-ignored path is machine state, never a finding.

**Note-base rules** add package layouts beyond those three. Each rule is one line,
`<regex> <path template>`: the regex must match a note's stem in full, and the template names the
directory, with `{1}`, `{2}`… standing for the regex's groups — for example
`([A-Z][A-Za-z0-9]*)_([A-Z][A-Za-z0-9]*) modules/{1}/{2}/`. Rules are read from the multi-valued git
config key `vault-check.noteBase` as git reads it in the vault, and from
`${XDG_CONFIG_HOME:-~/.config}/claude-kit/vault-check.conf`, one rule per line, `#` starting a comment
line. Both sources apply. A rule that does not parse is reported once per run and skipped.

Strike a name through when the sentence is about its retirement (~~`OldName`~~), write a PHP built-in
fully qualified (`\DateTimeImmutable`), write a convention with its wildcard (`packages/*/src/`). That
is the whole escape hatch: no exclusion list, no baseline.

A cited class or path is looked for in the work tree, then at the tip of the project's default branch
(`origin/HEAD`, else `main` or `master`, remote then local; HEAD when there is none of them). What
only the default branch holds is SOFT when the commit this branch shares with it (their merge base)
held it too — this branch removed it, and the session that did sees it — and no finding when the
merge base did not: the default branch added it after this branch left. Only what neither the work
tree nor the default branch holds is HARD.

Review stamps are anchored on the default branch's tree, read through git and never checked out, so
the branch a session is on never moves, resets or downgrades a stamp. A stamp records the blob the
reviewer saw — the work tree's copy, so a note reviewed on a branch records the branch's code — and
the default branch's tip. It is current while the default branch holds that blob, and its commit
moves up the first time it does; it turns the note SOFT once the default branch held the reviewed
blob and moved off it, when its commit is unknown to this clone and the blobs differ, or when the
default branch changed the file since its commit to anything but the reviewed blob; a review of
code the default branch has not reached, of a file it has not touched since, waits. A history that
cannot be read is one HARD finding naming how many cited files went unchecked.

Review stamps live in `.anchors.json` beside the notes when the vault is its own repository (or is
ignored by the project), otherwise under `~/.claude/state/vaults/<project>/`, with the brief's cache.
Nothing is written into a project's tracked tree.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vaultlib  # noqa: E402

TTL = int(os.environ.get("VAULT_CHECK_TTL", "1800"))
# A background check shares the machine with the work it describes: a quarter of the cores, at least two.
GREP_THREADS = max(2, (os.cpu_count() or 4) // 4)
LOCK_POLL = 1.0
# How long a run waits for another check of the same vault before it gives up with exit 2, so a holder
# that never ends cannot hang the session end that runs a check.
LOCK_WAIT = 300.0
# Paths per walk of the default branch's history, so a command line never grows past what a system takes.
HISTORY_BATCH = 100

GEN_END = re.compile(r"<!--\s*[\w.-]+:generated:end\s*-->")
LIVING_FOLDERS = ("Modules", "Bridges", "Plugins", "Kernel", "Packages", "Services", "Runbooks")
PACKAGE_FOLDERS = ("Modules", "Bridges", "Plugins", "Kernel", "Packages", "Services")
PRUNE = {".git", ".obsidian", ".qmd", ".trash", "node_modules"}
UNCHECKED = {"Templates"}

FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?^[ \t]*\1[ \t]*$", re.M | re.S)
STRUCK = re.compile(r"~~.+?~~", re.S)
SPAN = re.compile(r"`([^`\n]+)`")
NAME = re.compile(r"[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+")
# A path, then a line (`:48`, `:48-60`) or a member (`::read`, `::read()`, `::$items`), then an anchor.
PATH = re.compile(r"([^\s/:#`@\\]+(?:/[^\s:#`\\]+)+?)/?"
                  r"(?::\d+(?:-\d+)?|::\$?([A-Za-z_]\w*)(?:\(.*\))?)?(?:#\S*)?")
TEMPLATE_GROUP = re.compile(r"\{(\d+)\}")
NOTE_BASE_KEY = "vault-check.noteBase"
WIKILINK = re.compile(r"\[\[([^\]]*)\]\]")
DECISION_FILE = re.compile(r"(\d{4}-\d{2}-\d{2}) \S.*")
SUPERSEDED = re.compile(r"superseded by \[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")


# --- reading notes ------------------------------------------------------------


@dataclass
class Citations:
    """What one note's prose cites, each with the paragraphs that cite it."""

    names: dict[str, list[str]] = field(default_factory=dict)
    paths: dict[str, list[str]] = field(default_factory=dict)
    members: dict[tuple[str, str], list[str]] = field(default_factory=dict)  # (path, member) as cited


def prose_of(text: str) -> str:
    """The hand-written half of a note: after a generated end-marker, else after the frontmatter."""
    parts = GEN_END.split(text, maxsplit=1)
    if len(parts) == 2:
        return parts[1]
    return re.sub(r"\A---\n.*?\n---\n", "", text, count=1, flags=re.S)


def span_name(span: str) -> Optional[str]:
    """The class a code span names, or None (`\\Foo`, a PHP built-in written qualified, names none)."""
    s = span.strip()
    if s.startswith("\\") and "\\" not in s.lstrip("\\"):
        return None
    s = re.split(r"::|->|\(|:\d|\s", s, maxsplit=1)[0]
    s = re.split(r"\\+", s)[-1]
    if s.endswith(".php"):
        s = s[:-4]
    return s if NAME.fullmatch(s) else None


def span_path(span: str) -> Optional[str]:
    """A path-shaped code span without placeholders, or None; whether it names the repository is decided later."""
    m = PATH.fullmatch(span.strip())
    if not m:
        return None
    path = m.group(1)
    return None if re.search(r"[{}<>*$%|?\[\]…]", path) else path


def span_member(span: str) -> Optional[str]:
    """The member a path-shaped span names after `::` (`src/X.php::read()` → `read`), or None."""
    if span_path(span) is None:
        return None
    return PATH.fullmatch(span.strip()).group(2)


def paragraphs(text: str) -> list[str]:
    return [p for p in re.split(r"\n[ \t]*\n", text) if p.strip()]


def citations(prose: str) -> Citations:
    """Class names, path-shaped spans and the members those name, cited in code spans outside fences and strike-through."""
    found = Citations()
    for para in paragraphs(FENCE.sub("", prose)):
        for span in SPAN.findall(STRUCK.sub("", para)):
            name = span_name(span)
            if name:
                found.names.setdefault(name, []).append(para)
            path = span_path(span)
            if path:
                found.paths.setdefault(path, []).append(para)
                member = span_member(span)
                if member:
                    found.members.setdefault((path, member), []).append(para)
    return found


def context_hash(paras: list[str]) -> str:
    """A whitespace-insensitive fingerprint of the paragraphs citing one anchor."""
    unique = sorted({" ".join(p.split()) for p in paras})
    return hashlib.sha1("\n\n".join(unique).encode("utf-8")).hexdigest()[:16]


def wikilink_targets(text: str) -> list[str]:
    """Each wikilink's target, outside code; a link to a heading of the same note is skipped."""
    visible = SPAN.sub("", FENCE.sub("", text))
    targets: list[str] = []
    for raw in WIKILINK.findall(visible):
        if raw.startswith(("#", "^")):
            continue
        targets.append(re.split(r"[|#^]", raw, maxsplit=1)[0].rstrip("\\"))
    return targets


def link_resolves(target: str, stems: set[str], files: set[str]) -> bool:
    """Whether Obsidian would open something: it matches a file name, ignoring case (sets casefolded)."""
    if "\n" in target or not target.strip():
        return False
    name = target.strip().rsplit("/", 1)[-1].casefold()
    return name in stems or name in files or (name.endswith(".md") and name[:-3] in stems)


def frontmatter(text: str) -> Optional[dict[str, str]]:
    m = re.match(r"\A---\n(.*?)\n---\n", text, flags=re.S)
    if not m:
        return None
    pairs: dict[str, str] = {}
    for line in m.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() and not key.startswith((" ", "\t", "-")):
            pairs[key.strip()] = value.strip().strip("\"'")
    return pairs


def follows_dated_template(records: dict[str, str]) -> bool:
    """Whether a vault's decision records keep the dated template closely enough to be held to it."""
    if len(records) < 5:
        return False
    kept = sum(1 for name, text in records.items()
               if DECISION_FILE.fullmatch(name[:-3]) and (frontmatter(text) or {}).get("type") == "decision")
    return kept / len(records) >= 0.8


def lint_decision(filename: str, text: str, records: set[str]) -> list[str]:
    """What is wrong with a dated decision record's name and frontmatter, in the reader's words."""
    m = DECISION_FILE.fullmatch(filename[:-3] if filename.endswith(".md") else filename)
    if not m:
        return ["the file name is not `YYYY-MM-DD slug.md`"]
    fm = frontmatter(text)
    if fm is None:
        return ["it has no frontmatter"]
    problems: list[str] = []
    if fm.get("type") != "decision":
        problems.append(f"`type` is `{fm.get('type', '')}`, not `decision`")
    if fm.get("date") != m.group(1):
        problems.append(f"`date` is `{fm.get('date', '')}` but the file name says `{m.group(1)}`")
    if not fm.get("area"):
        problems.append("`area` is empty")
    status = fm.get("status", "")
    superseded = SUPERSEDED.fullmatch(status)
    if superseded:
        target = superseded.group(1).strip()
        if target not in records:
            problems.append(f"`status` is superseded by [[{target}]], which is not a record")
    elif status not in ("accepted", "amended"):
        problems.append(f"`status` is `{status}` — expected accepted, amended or superseded by [[record]]")
    return problems


@dataclass(frozen=True)
class NoteBase:
    """A package layout: a note whose stem the pattern matches in full lives at the template's directory."""

    pattern: re.Pattern
    template: str

    def base_for(self, stem: str) -> Optional[str]:
        """The directory this layout gives a note stem, or None when the stem is not of its shape."""
        match = self.pattern.fullmatch(stem)
        if match is None:
            return None
        return TEMPLATE_GROUP.sub(lambda group: match.group(int(group.group(1))), self.template)


def parse_note_base(line: str) -> tuple[Optional[NoteBase], str]:
    """Read one `<regex> <path template>` rule.

    The template is the last whitespace-separated field, so a regex may itself contain spaces.

    @param line The rule, without its comment marker or line ending.
    @return (the rule, "") when it parses, else (None, why it does not).
    """
    fields = line.strip().rsplit(None, 1)
    if len(fields) != 2:
        return None, "expected `<regex> <path template>`"
    source, template = fields
    try:
        pattern = re.compile(source)
    except re.error as error:
        return None, f"the regex does not compile ({error})"
    groups = [int(g) for g in TEMPLATE_GROUP.findall(template)]
    if any(g < 1 or g > pattern.groups for g in groups):
        return None, f"the template names a group the regex does not have ({pattern.groups} group(s))"
    if template.startswith("/") or ".." in Path(template).parts:
        return None, "the template must be a path inside the project"
    return NoteBase(pattern, template if template.endswith("/") else template + "/"), ""


def user_rules_file() -> Path:
    """The per-user rule file: `$XDG_CONFIG_HOME/claude-kit/vault-check.conf`, `~/.config` when unset."""
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "claude-kit" / "vault-check.conf"


def load_note_bases(vault_dir: Path) -> tuple[list[NoteBase], list[str]]:
    """The note-base rules that apply to a vault, and one problem line per rule that does not parse.

    @param vault_dir The vault directory; its git config is read as git reads it there.
    @return (the rules, in source order without repeats; the problems).
    """
    lines: list[tuple[str, str]] = []
    code, out = vaultlib.git_out(vault_dir, "config", "--get-all", NOTE_BASE_KEY, timeout=10)
    if code == 0:
        lines += [(f"git config {NOTE_BASE_KEY}", value) for value in out.splitlines() if value.strip()]
    problems: list[str] = []
    conf = user_rules_file()
    try:
        text = conf.read_text(encoding="utf-8") if conf.is_file() else ""
    except (OSError, UnicodeDecodeError) as error:
        text = ""
        problems.append(f"{conf} could not be read ({error.__class__.__name__}), so no rule from it applies")
    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() and not raw.lstrip().startswith("#"):
            lines.append((f"{conf}:{number}", raw))
    rules: list[NoteBase] = []
    seen: set[tuple[str, str]] = set()
    for origin, raw in lines:
        rule, why = parse_note_base(raw)
        if rule is None:
            problems.append(f"note-base rule `{raw.strip()}` ({origin}) is skipped: {why}")
        elif (rule.pattern.pattern, rule.template) not in seen:
            seen.add((rule.pattern.pattern, rule.template))
            rules.append(rule)
    return rules, problems


def package_bases(note: str, vendor_dirs: list[str], note_bases: Sequence[NoteBase] = ()) -> list[str]:
    """The directories a package note's relative paths may start from.

    @param note The note's path inside the vault.
    @param vendor_dirs The directories under the project's `vendor/`.
    @param note_bases The configured layouts beyond the built-in ones.
    @return The bases, the built-in ones first.
    """
    parts = Path(note).parts
    if not parts or parts[0] not in PACKAGE_FOLDERS:
        return []
    stem = Path(note).stem
    bases = [f"packages/{stem}/", f"plugins/{stem}/"]
    bases += [f"vendor/{v}/{stem}/" for v in vendor_dirs]
    for rule in note_bases:
        base = rule.base_for(stem)
        if base is not None and base not in bases:
            bases.append(base)
    return bases


def resolve_path(path: str, bases: list[str], exists: Callable[[str], bool]) -> Optional[str]:
    """The repository-relative path a cited path means (a class file may be cited without `.php`)."""
    for base in ["", *bases]:
        for candidate in (base + path, base + path + ".php"):
            if exists(candidate):
                return candidate
    return None


def homes_of(path: str, bases: list[str], root_entries: set[str], exists: Callable[[str], bool],
             existed: frozenset = frozenset(),
             in_vault: Callable[[str], bool] = lambda rel: False) -> list[str]:
    """The bases a path-shaped span is a claim about: "" for the project root, then the note's package bases.

    `text/plain` or `and/or` in prose is shaped like a path and names nothing here; a first segment
    at the project root — spelled in any case, or one the project's history held and has since
    removed (`existed`) — or inside the note's own package is what makes it a claim about the tree.
    A path inside the vault is no claim about the tree: its first segment is spelled exactly as an
    entry at the top of the vault and not exactly as one at the project root, and the whole path
    either exists inside the vault (`in_vault`) or has a note's shape, `<folder>/<name>.md`, which a
    note may cite before it is written (`Modules/crm.md`). Anything else under such a segment —
    `Plugins/x/src/Y.ts`, `Plugins/x/README.md` — is a claim about the tree, cited in the wrong case.
    """
    first = path.split("/", 1)[0]
    segments = path.rstrip("/").split("/")
    note_shaped = len(segments) == 2 and segments[1].endswith(".md")
    if first not in root_entries and in_vault(first) and (note_shaped or in_vault(path)):
        return []
    homes = [""] if first.casefold() in {e.casefold() for e in root_entries} or first in existed else []
    return homes + [base for base in bases if exists(base + first)]


def defines(path: Path, member: str) -> bool:
    """Whether a file names a member as a whole word; a directory, or a file that cannot be read, is not asked."""
    if not path.is_file():
        return True
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return True
    return re.search(r"(?<!\w)%s(?!\w)" % re.escape(member), text) is not None


# --- the repository -----------------------------------------------------------


def php_index_of(paths) -> dict[str, list[str]]:
    """Class name → the PHP files of that name among `paths`."""
    index: dict[str, list[str]] = {}
    for rel in sorted({p for p in paths if p.endswith(".php")}):
        index.setdefault(rel.rsplit("/", 1)[-1][:-4], []).append(rel)
    return index


class Disk:
    """The work tree's names as they are spelled, each directory listed once.

    `Path.exists()` answers yes for any spelling on a case-insensitive file system, so a path cited
    in the wrong case would pass for one that exists; every segment here is compared with the names
    its directory lists.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.listed: dict[str, Optional[list[str]]] = {}

    def names(self, directory: str) -> Optional[list[str]]:
        """What a directory of the work tree holds, or None when it is no directory."""
        if directory not in self.listed:
            try:
                self.listed[directory] = sorted(os.listdir(str(self.root / directory) if directory else str(self.root)))
            except OSError:
                self.listed[directory] = None
        return self.listed[directory]

    def spelled(self, rel: str, exact: bool = True) -> Optional[str]:
        """The path as the work tree spells it, or None when it holds no such path.

        Exact, every segment must be spelled as on disk; otherwise a segment matches in any case.
        """
        parts = [part for part in rel.split("/") if part not in ("", ".")]
        if not parts or ".." in parts:
            return None
        current = ""
        for part in parts:
            listed = self.names(current)
            if listed is None:
                return None
            if part not in listed:
                folded = [name for name in listed if name.casefold() == part.casefold()]
                if exact or not folded:
                    return None
                part = folded[0]
            current = f"{current}/{part}" if current else part
        return current

    def exists(self, rel: str) -> bool:
        return self.spelled(rel) is not None


class CodeSearchUnfinished(RuntimeError):
    """The search of the code for cited names did not cover the tree, so its silence proves nothing."""

    def __init__(self, code: int) -> None:
        super().__init__(f"git grep ended with {code}")
        self.code = code


class Repo:
    """Git and file-system reads against one project root."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def git(self, *args: str) -> tuple[int, str]:
        return vaultlib.git_out(self.root, *args)

    def is_git(self) -> bool:
        return self.git("rev-parse", "--is-inside-work-tree")[0] == 0

    def php_index(self) -> dict[str, list[str]]:
        """Class name → the repository's PHP files of that name, tracked or not yet."""
        _, out = self.git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.php")
        return php_index_of(filter(None, out.split("\0")))

    def words_in_code(self, names: set[str], tree: str = "") -> set[str]:
        """The casefolded names occurring as a whole word, in any case, in the non-Markdown files.

        The work tree is searched, or the tree of commit `tree` when one is named. The names are
        searched as written first, and only those not found are searched again in any case: git
        grep's cost under -i grows with the number of patterns (69 s against 8 s for 56 names over a
        143k-file tree), and a cited name is nearly always written as the code writes it.
        """
        found = self.grep_words(names, False, tree)
        return found | self.grep_words({n for n in names if n.casefold() not in found}, True, tree)

    def grep_words(self, names: set[str], any_case: bool, tree: str = "") -> set[str]:
        """The casefolded names found in the work tree, or in the tree of commit `tree` when one is named."""
        if not names:
            return set()
        fd, patterns = tempfile.mkstemp(suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write("\n".join(sorted(names)) + "\n")
            code, out = self.git("-c", f"grep.threads={GREP_THREADS}", "grep",
                                 *(["--untracked"] if not tree else []), "-I", "-h", "-o",
                                 *(["-i"] if any_case else []), "-w", "-F", "-f", patterns,
                                 *([tree] if tree else []), "--", ".", ":(exclude)*.md", ":(exclude)*.mdx")
        finally:
            os.unlink(patterns)
        # git grep answers 1 for "no match"; anything else, a timeout included, means the search never
        # covered the tree, and reading its empty output as "nothing found" would call every name gone.
        if code not in (0, 1):
            raise CodeSearchUnfinished(code)
        return {token.casefold() for token in out.split()}

    def words_in_vendor(self, names: set[str]) -> set[str]:
        """The casefolded names occurring as a whole word, in any case, in the files under `vendor/`.

        `vendor/` is ignored as a rule, so it is read as plain files rather than through git's index.
        """
        if not names or not (self.root / "vendor").is_dir():
            return set()
        fd, patterns = tempfile.mkstemp(suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write("\n".join(sorted(names)) + "\n")
            code, out = self.git("-c", f"grep.threads={GREP_THREADS}", "grep", "--no-index", "-I", "-h", "-o", "-i",
                                 "-w", "-F", "-f", patterns, "--", "vendor")
        finally:
            os.unlink(patterns)
        if code not in (0, 1):
            raise CodeSearchUnfinished(code)
        return {token.casefold() for token in out.split()}

    def ever_held(self, entries: set[str], refs: list[str]) -> set[str]:
        """Those top-level `entries` that some commit reachable from `refs` held; a history git cannot read holds none."""
        if not entries or not refs:
            return set()
        held: set[str] = set()
        ordered = sorted(entries)
        for start in range(0, len(ordered), HISTORY_BATCH):
            batch = ordered[start:start + HISTORY_BATCH]
            code, out = self.git("--literal-pathspecs", "log", "-z", "--format=", "--name-only", "--no-renames",
                                 *refs, "--", *batch)
            if code == 0:
                held.update(path.strip("\n").split("/", 1)[0] for path in out.split("\0") if path.strip("\n"))
        return held & entries

    def vendor_stems(self) -> set[str]:
        stems: set[str] = set()
        for _dirpath, _dirnames, filenames in os.walk(self.root / "vendor"):
            stems.update(f[:-4].casefold() for f in filenames if f.endswith(".php"))
        return stems

    def vendor_dirs(self) -> list[str]:
        vendor = self.root / "vendor"
        return sorted(d.name for d in vendor.iterdir() if d.is_dir()) if vendor.is_dir() else []

    def ignored(self, candidates: list[str]) -> bool:
        # Not -q: git accepts --quiet with a single pathname only, and refuses the whole call otherwise.
        code, out = self.git("check-ignore", "--no-index", "--", *candidates)
        return code == 0 and bool(out.strip())

    def commit_of(self, ref: str) -> str:
        """The commit a ref names, or "" when it names none here."""
        code, out = self.git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
        return out.strip() if code == 0 else ""

    def reference(self) -> str:
        """The commit review stamps are taken against: the tip of the project's default branch.

        The remote's default branch (`origin/HEAD`), else a remote branch, then a local one, named by
        `init.defaultBranch`, `main` or `master`; HEAD only when the project has none of them. It is
        read from git's refs, never from the work tree, so the branch a session is on moves no stamp.
        """
        code, out = self.git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
        candidates = [out.strip()] if code == 0 and out.strip() else []
        code, out = self.git("config", "--get", "init.defaultBranch")
        names = [name for name in dict.fromkeys([out.strip() if code == 0 else "", "main", "master"]) if name]
        candidates += [f"refs/remotes/origin/{name}" for name in names]
        candidates += [f"refs/heads/{name}" for name in names]
        for ref in [*candidates, "HEAD"]:
            commit = self.commit_of(ref)
            if commit:
                return commit
        return ""

    def tree(self, commit: str) -> tuple[dict[str, str], set[str]]:
        """(file path → blob, every path) of a commit's tree; the paths include its directories."""
        if not commit:
            return {}, set()
        _, out = self.git("ls-tree", "-r", "-t", "-z", "--full-tree", commit)
        blobs: dict[str, str] = {}
        paths: set[str] = set()
        for entry in filter(None, out.split("\0")):
            meta, _, path = entry.partition("\t")
            parts = meta.split()
            if len(parts) != 3:
                continue
            paths.add(path)
            if parts[1] == "blob":
                blobs[path] = parts[2]
        return blobs, paths

    def history_blobs(self, paths: set[str], reference: str) -> tuple[dict[str, set[str]], dict[str, int]]:
        """Every blob each path has held in the reference's history, read in a few walks of it.

        @return (path → its blobs, path → git's exit code for each path whose history was not read).
        """
        held: dict[str, set[str]] = {path: set() for path in paths}
        unread: dict[str, int] = {}
        ordered = sorted(paths)
        for start in range(0, len(ordered), HISTORY_BATCH):
            batch = ordered[start:start + HISTORY_BATCH]
            code, out = self.git("--literal-pathspecs", "log", "-z", "--format=", "--raw", "--no-abbrev",
                                 "--no-renames", reference, "--", *batch)
            if code != 0:
                unread.update((path, code) for path in batch)
                continue
            # A raw entry is `:<mode> <mode> <old blob> <new blob> <status>` and then its path, each
            # ended by a NUL; whatever stands between commits is skipped.
            fields = iter(out.split("\0"))
            for meta in fields:
                parts = meta.strip().split()
                if not meta.strip().startswith(":") or len(parts) != 5:
                    continue
                path = next(fields, "")
                if path in held:
                    held[path].update(blob for blob in parts[2:4] if blob.strip("0"))
        return held, unread

    def blobs_at(self, pairs: set[tuple[str, str]]) -> dict[tuple[str, str], str]:
        """(commit, path) → the blob that commit holds at that path, for those this clone can answer."""
        if not pairs:
            return {}
        ordered = sorted(pairs)
        try:
            proc = subprocess.run(["git", "-C", str(self.root), "cat-file", "--batch-check=%(objectname) %(objecttype)"],
                                  input="".join(f"{commit}:{path}\n" for commit, path in ordered),
                                  capture_output=True, text=True, timeout=180, env=vaultlib.git_env())
        except (OSError, subprocess.SubprocessError):
            return {}
        answers = proc.stdout.splitlines() if proc.returncode == 0 else []
        found: dict[tuple[str, str], str] = {}
        for pair, answer in zip(ordered, answers):
            parts = answer.split()
            if len(parts) == 2 and parts[1] == "blob":
                found[pair] = parts[0]
        return found

    def worktree_blob(self, path: str) -> Optional[str]:
        """The blob the work tree's copy of a file would be committed as; None when there is no copy."""
        if not (self.root / path).is_file():
            return None
        code, out = self.git("--literal-pathspecs", "hash-object", "--", path)
        return out.strip() if code == 0 and out.strip() else None

    def merge_base(self, reference: str) -> str:
        """The newest commit HEAD and the reference share, or "" when they share none."""
        if not reference:
            return ""
        code, out = self.git("merge-base", "HEAD", reference)
        return out.strip() if code == 0 else ""

    def commits_since(self, commit: str, path: str, reference: str) -> Optional[int]:
        if not commit or not reference:
            return None
        code, out = self.git("rev-list", "--count", f"{commit}..{reference}", "--", path)
        return int(out.strip()) if code == 0 and out.strip().isdigit() else None


# --- anchors ------------------------------------------------------------------


def anchors_for(cited: Citations, bases: list[str], index: dict[str, list[str]],
                blobs: dict[str, str]) -> dict[str, str]:
    """File path → context hash for every committed file a living note cites.

    A class name counts only when it resolves to one file — within the note's own package first —
    because an anchor on a guess would flag the wrong prose.
    """
    grouped: dict[str, list[str]] = {}
    for name, paras in cited.names.items():
        candidates = index.get(name, [])
        mine = [c for c in candidates if bases and c.startswith(tuple(bases))]
        if mine:
            candidates = mine
        if len(candidates) == 1:
            grouped.setdefault(candidates[0], []).extend(paras)
    for path, paras in cited.paths.items():
        resolved = resolve_path(path, bases, lambda rel: rel in blobs)
        if resolved:
            grouped.setdefault(resolved, []).extend(paras)
    return {path: context_hash(paras) for path, paras in grouped.items() if path in blobs}


class StampHistory:
    """What carrying the stamps forward asks of the project's history.

    This base knows nothing beyond the stamps themselves: the reviewer saw the reference's blob,
    every blob was reached, every commit is known and no commit's content can be read.
    """

    def seen(self, path: str, reference_blob: str) -> str:
        """The blob a reviewer of `path` is looking at now."""
        return reference_blob

    def reached(self, path: str, blob: str) -> bool:
        """Whether the default branch's history of `path` ever held `blob`."""
        return True

    def known(self, commit: str) -> bool:
        """Whether this clone has the commit."""
        return True

    def blob_at(self, commit: str, path: str) -> Optional[str]:
        """The blob `commit` holds at `path`, or None when this clone cannot say."""
        return None

    def changed_since(self, commit: str, path: str) -> bool:
        """Whether the default branch changed `path` in a commit `commit` does not hold."""
        return False


class GitStampHistory(StampHistory):
    """The project's history as git answers it, read in batches before the stamps are carried."""

    def __init__(self, repo: Repo, reference: str, stamps: dict, blobs: dict[str, str]) -> None:
        self.repo = repo
        entries = [(path, entry) for notes in stamps.values() if isinstance(notes, dict)
                   for path, entry in notes.items() if isinstance(entry, dict) and path in blobs]
        moved = {path for path, entry in entries if entry.get("blob") != blobs[path]}
        self.reference = reference
        self.history, self.unread = repo.history_blobs(moved, reference) if moved and reference else ({}, {})
        self.contents = repo.blobs_at({(str(entry.get("commit", "")), path) for path, entry in entries
                                       if entry.get("blob") == blobs[path] and entry.get("commit")
                                       and entry.get("commit") != reference})
        self.commits: dict[str, bool] = {}
        self.copies: dict[str, Optional[str]] = {}

    def seen(self, path: str, reference_blob: str) -> str:
        if path not in self.copies:
            self.copies[path] = self.repo.worktree_blob(path)
        return self.copies[path] or reference_blob

    def reached(self, path: str, blob: str) -> bool:
        return blob in self.history.get(path, set())

    def known(self, commit: str) -> bool:
        if commit not in self.commits:
            self.commits[commit] = bool(commit) and bool(self.repo.commit_of(commit))
        return self.commits[commit]

    def blob_at(self, commit: str, path: str) -> Optional[str]:
        return self.contents.get((commit, path))

    def changed_since(self, commit: str, path: str) -> bool:
        return bool(self.repo.commits_since(commit, path, self.reference))


def reconcile(current: dict[str, dict[str, str]], stamps: dict, blobs: dict[str, str], reference: str,
              restamp: set[str], history: Optional[StampHistory] = None
              ) -> tuple[dict, list[tuple[str, str, str]]]:
    """Carry the stamps forward and name every anchor whose file moved under unchanged prose.

    `blobs` is the reference commit's tree. An anchor is (re-)stamped when it is new, when the
    paragraphs citing it changed, or when its note is being stamped: with the blob the reviewer saw
    (the work tree's copy, so a review on a branch records the branch's code) and the reference as
    its commit. Otherwise it keeps its stamp, and against the reference's blob it is:

    - current when the blobs are the same; its commit moves up to the reference the first time the
      reference holds the reviewed blob, so a later change is counted from there;
    - stale when the default branch once held the reviewed blob and has moved off it; when the
      stamp's commit is unknown to this clone, so there is nothing to tell it by but the blobs; or
      when the default branch changed the file since the stamp's commit to something other than the
      reviewed blob — a branch changed again before it merged, or one that never will;
    - waiting otherwise: the review is of code the default branch has not reached and the default
      branch has not touched the file since — a branch not merged yet — and the stamp is left as it is.
    """
    history = history or StampHistory()
    carried: dict = {}
    stale: list[tuple[str, str, str]] = []
    for note in sorted(current):
        previous = stamps.get(note) if isinstance(stamps.get(note), dict) else {}
        entries: dict = {}
        for path in sorted(current[note]):
            context = current[note][path]
            before = previous.get(path)
            if not isinstance(before, dict) or before.get("context") != context or note in restamp:
                entries[path] = {"blob": history.seen(path, blobs[path]), "commit": reference, "context": context}
                continue
            entries[path] = before
            blob, commit = before.get("blob"), str(before.get("commit", ""))
            if blob == blobs[path]:
                if commit != reference and history.blob_at(commit, path) != blob:
                    entries[path] = {**before, "commit": reference}
            elif (history.reached(path, str(blob)) or not history.known(commit)
                  or history.changed_since(commit, path)):
                stale.append((note, path, commit))
        if entries:
            carried[note] = entries
    return carried, stale


# --- measuring ----------------------------------------------------------------


@dataclass
class Finding:
    level: str  # HARD | SOFT
    note: str
    message: str
    removed: bool = False  # a SOFT one: cites what this branch removed and the default branch still has


@dataclass
class Report:
    living: int = 0
    names: int = 0
    anchors: int = 0
    findings: list[Finding] = field(default_factory=list)
    config_problems: list[str] = field(default_factory=list)

    @property
    def hard(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "HARD"]

    @property
    def soft_notes(self) -> list[str]:
        return sorted({f.note for f in self.findings if f.level == "SOFT"})

    @property
    def stale_notes(self) -> list[str]:
        """The notes citing code that changed under them, which a review and `--stamp` settle."""
        return sorted({f.note for f in self.findings if f.level == "SOFT" and not f.removed})

    @property
    def removed_notes(self) -> list[str]:
        """The notes citing what this branch removed, which only a change of the prose settles."""
        return sorted({f.note for f in self.findings if f.removed})


def vault_files(vault: Path) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(vault):
        dirnames[:] = sorted(d for d in dirnames if d not in PRUNE)
        base = Path(dirpath).relative_to(vault)
        found += [base / f for f in sorted(filenames)]
    return sorted(found)


def is_living(rel: Path) -> bool:
    parts = rel.parts
    if len(parts) == 2 and parts[0] in LIVING_FOLDERS:
        return True
    return len(parts) == 1 and parts[0].startswith("00 ") and rel.suffix == ".md"


def normalise_note(arg: str, living: set[str]) -> Optional[str]:
    rel = arg.replace("\\", "/")
    if rel in living:
        return rel
    if f"{rel}.md" in living:
        return f"{rel}.md"
    for known in living:
        if rel.endswith("/" + known):
            return known
    by_stem = [n for n in living if Path(n).stem == Path(rel).stem]
    return by_stem[0] if len(by_stem) == 1 else None


def stamps_file(vault: vaultlib.Vault) -> Path:
    return vault.machine_file(".anchors.json")


def load_stamps(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    notes = data.get("notes") if isinstance(data, dict) else None
    return notes if isinstance(notes, dict) else {}


def render_stamps(notes: dict) -> str:
    """The text of a stamps file holding `notes`, laid out the one way every writer of it agrees on."""
    return json.dumps({"version": 1, "notes": notes}, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def save_stamps(path: Path, notes: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(render_stamps(notes), encoding="utf-8")
    tmp.replace(path)


def measure(vault: vaultlib.Vault, write: bool, restamp: Optional[set[str]] = None) -> Report:
    """Read the vault against its project; with write, carry the stamps forward."""
    report = Report()
    repo = Repo(vault.root)
    files = vault_files(vault.path)
    notes = [p for p in files if p.suffix == ".md"]
    stems = {p.stem.casefold() for p in notes}
    names = {p.name.casefold() for p in files}
    texts = {p.as_posix(): (vault.path / p).read_text(encoding="utf-8", errors="replace")
             for p in notes if p.parts[0] not in UNCHECKED}

    decision_texts = {Path(rel).name: text for rel, text in texts.items()
                      if Path(rel).parts[0] == "Decisions" and len(Path(rel).parts) == 2
                      and not re.search(r"MOC|README", Path(rel).name, re.I)}
    lint_records = follows_dated_template(decision_texts)
    records = {name[:-3] for name in decision_texts}

    for rel, text in texts.items():
        for target in wikilink_targets(text):
            if not link_resolves(target, stems, names):
                shown = " ".join(target.split())
                why = ("is wrapped across lines, which Obsidian does not read as a link" if "\n" in target
                       else "resolves to no note or file in the vault")
                report.findings.append(Finding("HARD", rel, f"[[{shown}]] {why}"))
        if lint_records and Path(rel).name in decision_texts:
            for problem in lint_decision(Path(rel).name, text, records):
                report.findings.append(Finding("HARD", rel, f"decision record: {problem}"))

    living = {rel: citations(prose_of(text)) for rel, text in texts.items() if is_living(Path(rel))}
    report.living = len(living)
    if not repo.is_git():
        return report

    # What a note cites is looked for in the work tree, then in the default branch's tree. What only
    # the default branch holds was either removed by this branch — SOFT, so the session that removed
    # it sees it — or added to the default branch after this branch left it, which is no finding:
    # the commit both share (their merge base) tells the two apart. Only what neither holds is HARD.
    reference = repo.reference()
    ref_blobs, ref_paths = repo.tree(reference)
    ref_index = php_index_of(ref_blobs)
    shared: dict[str, tuple[str, dict[str, list[str]], set[str]]] = {}

    def at_base() -> tuple[str, dict[str, list[str]], set[str]]:
        """(the merge base of HEAD and the reference, its PHP index, its paths), read once when needed."""
        if "base" not in shared:
            base = repo.merge_base(reference)
            base_blobs, base_paths = (ref_blobs, ref_paths) if base == reference else repo.tree(base)
            shared["base"] = (base, php_index_of(base_blobs), base_paths)
        return shared["base"]
    vendor_dirs = repo.vendor_dirs()
    note_bases, report.config_problems = load_note_bases(vault.path)
    root_entries = {p.name for p in vault.root.iterdir()} | {p.split("/", 1)[0] for p in ref_paths}
    vault_disk = Disk(vault.path)

    def in_vault(rel: str) -> bool:
        """Whether a path exists inside the vault as spelled, every link followed staying inside it."""
        spelled = vault_disk.spelled(rel)
        return spelled is not None and vaultlib.strictly_inside(vault.path, vault.path / spelled)
    bases = {rel: package_bases(rel, vendor_dirs, note_bases) for rel in living}
    disk = Disk(vault.root)
    ref_spelling = {path.casefold(): path for path in sorted(ref_paths)}

    def here(rel: str) -> bool:
        return disk.exists(rel)

    def anywhere(rel: str) -> bool:
        return here(rel) or rel.rstrip("/") in ref_paths

    def in_base(rel: str) -> bool:
        return rel.rstrip("/") in at_base()[2]

    def spelling(rel: str) -> Optional[str]:
        """How the work tree or the default branch spells a path cited in any case."""
        return disk.spelled(rel, exact=False) or ref_spelling.get(rel.rstrip("/").casefold())

    def in_any_case(rel: str) -> bool:
        return anywhere(rel) or spelling(rel) is not None

    # A first segment found nowhere now may be a directory the project removed: the history of HEAD
    # and of the default branch tells it from a word shaped like a path (`text/plain`).
    folded_root = {entry.casefold() for entry in root_entries}
    absent = {path.split("/", 1)[0] for c in living.values() for path in c.paths} - {".", ".."}
    absent = {first for first in absent if first.casefold() not in folded_root}
    refs = [ref for ref in dict.fromkeys(["HEAD", reference]) if ref and repo.commit_of(ref)]
    existed = frozenset(repo.ever_held(absent, refs))
    unseen_members: list[tuple[str, str, str, str]] = []  # (note, cited path, file, member)

    index = repo.php_index()
    cited: set[str] = set()
    for c in living.values():
        cited.update(c.names)
    report.names = len(cited)
    known = {name.casefold() for name in index}
    missing = {n for n in cited if n.casefold() not in known}
    removed: set[str] = set()
    try:
        found = repo.words_in_code(missing)
        missing = {n for n in missing if n.casefold() not in found}
        if missing:
            vendored = repo.vendor_stems()
            missing = {n for n in missing if n.casefold() not in vendored}
        indexed = {name.casefold() for name in ref_index}
        on_reference = {n for n in missing if n.casefold() in indexed}
        if reference and missing - on_reference:
            found = repo.words_in_code(missing - on_reference, reference)
            on_reference |= {n for n in missing if n.casefold() in found}
        missing -= on_reference
        if on_reference:
            base, base_index, _ = at_base()
            indexed = {name.casefold() for name in base_index}
            removed = {n for n in on_reference if n.casefold() in indexed}
            if base and on_reference - removed:
                found = repo.words_in_code(on_reference - removed, base)
                removed |= {n for n in on_reference if n.casefold() in found}
    except CodeSearchUnfinished as unfinished:
        # One honest finding instead of one false one per name: the names stay unchecked, not gone.
        reason = "did not finish in time" if unfinished.code == vaultlib.TIMED_OUT else f"failed ({unfinished.code})"
        report.findings.append(Finding(
            "HARD", vault.rel, f"the search of the code for {len(missing)} cited name(s) {reason}, so none of them "
                               "was checked — keep large untracked trees out of it (.git/info/exclude) and run again"))
        missing = set()
        removed = set()

    for rel in sorted(living):
        for name in sorted(set(living[rel].names) & missing):
            report.findings.append(Finding(
                "HARD", rel, f"`{name}` appears nowhere in the code — correct the prose, "
                             f"or strike it through as history: ~~`{name}`~~"))
        for name in sorted(set(living[rel].names) & removed):
            report.findings.append(Finding(
                "SOFT", rel, f"`{name}` is gone from this branch while the default branch still has it — correct "
                             f"the prose if this branch removes it, or strike it through: ~~`{name}`~~", removed=True))
        for cited_path in sorted(living[rel].paths):
            homes = homes_of(cited_path, bases[rel], root_entries, in_any_case, existed, in_vault)
            if not homes:
                continue
            resolved = resolve_path(cited_path, bases[rel], here)
            if resolved is not None:
                members = sorted(member for path, member in living[rel].members if path == cited_path)
                unseen_members += [(rel, cited_path, resolved, member)
                                   for member in members if not defines(vault.root / resolved, member)]
                continue
            if resolve_path(cited_path, bases[rel], anywhere) is not None:
                if resolve_path(cited_path, bases[rel], in_base) is not None:
                    report.findings.append(Finding(
                        "SOFT", rel, f"`{cited_path}` is gone from this branch while the default branch still has "
                                     f"it — correct the prose if this branch removes it", removed=True))
                continue
            # Asked only where the path could live — a base under an ignored vendor/ must not excuse it.
            if repo.ignored([base + cited_path for base in homes]):
                continue
            misspelled = resolve_path(cited_path, bases[rel], lambda candidate: spelling(candidate) is not None)
            hint = f" as written — the tree spells it `{spelling(misspelled)}`" if misspelled else ""
            report.findings.append(Finding(
                "HARD", rel, f"`{cited_path}` does not exist{hint} — correct the prose, "
                             f"or strike it through as history"))

    # A member the cited file does not name may be inherited, so it is gone only when no code names it.
    if unseen_members:
        wanted = {member for *_, member in unseen_members}
        try:
            named = repo.words_in_code(wanted)
            named |= repo.words_in_vendor({member for member in wanted if member.casefold() not in named})
        except CodeSearchUnfinished as unfinished:
            reason = ("did not finish in time" if unfinished.code == vaultlib.TIMED_OUT
                      else f"failed ({unfinished.code})")
            report.findings.append(Finding(
                "HARD", vault.rel, f"the search of the code for {len(wanted)} cited member(s) {reason}, so none of "
                                   "them was checked — keep large untracked trees out of it (.git/info/exclude) and "
                                   "run again"))
            unseen_members, named = [], set()
        for note, cited_path, resolved, member in unseen_members:
            if member.casefold() not in named:
                report.findings.append(Finding(
                    "HARD", note, f"`{cited_path}::{member}` — `{member}` appears neither in `{resolved}` nor "
                                  f"anywhere else in the code — correct the prose, or strike it through as history"))

    current = {rel: anchors_for(c, bases[rel], ref_index, ref_blobs) for rel, c in living.items()}
    report.anchors = sum(len(a) for a in current.values())
    target = stamps_file(vault)
    stamps = load_stamps(target)
    history = GitStampHistory(repo, reference, stamps, ref_blobs)
    carried, stale = reconcile(current, stamps, ref_blobs, reference, restamp or set(), history)
    if history.unread:
        # One honest finding instead of a silence: these stamps were not checked, not found current.
        codes = ", ".join(str(code) for code in sorted(set(history.unread.values())))
        report.findings.append(Finding(
            "HARD", vault.rel, f"the default branch's history of {len(history.unread)} cited file(s) could not be "
                               f"read (git log ended with {codes}), so the stamps on them were not checked — "
                               "run again"))

    by_note: dict[str, list[tuple[str, str]]] = {}
    for note, path, commit in stale:
        by_note.setdefault(note, []).append((path, commit))
    for note in sorted(by_note):
        shown = []
        for path, commit in by_note[note][:5]:
            count = repo.commits_since(commit, path, reference)
            shown.append(f"`{path}`" + (f" ({count} commit{'s' if count != 1 else ''})" if count else ""))
        more = f" and {len(by_note[note]) - 5} more" if len(by_note[note]) > 5 else ""
        report.findings.append(Finding(
            "SOFT", note, f"cites code that changed since it last described it: {', '.join(shown)}{more} "
                          f"— review, then `vault-check --stamp \"{note}\"`"))

    if write and carried != stamps:
        save_stamps(target, carried)
    return report


# --- output -------------------------------------------------------------------


def render(report: Report, quiet: bool) -> list[str]:
    lines = [f"vault-check: {problem}" for problem in report.config_problems]
    lines += [] if quiet else [f"{f.level}  {f.note}: {f.message}" for f in report.findings]
    lines.append(f"vault-check: {report.living} living notes · {report.names} cited names · "
                 f"{report.anchors} anchors · {len(report.hard)} hard · "
                 f"{len(report.soft_notes)} note(s) to review")
    return lines


def brief_lines(report: Report) -> list[str]:
    """What the SessionStart brief shows: nothing at all when the vault is clean."""
    lines: list[str] = []
    if report.hard:
        notes = len({f.note for f in report.hard})
        lines.append(f"[VAULT] {len(report.hard)} hard finding(s) in {notes} note(s) — prose citing code "
                     f"that no longer exists, a broken link or a malformed decision · "
                     f"vault-check")
    if report.stale_notes:
        lines.append(f"[VAULT] {len(report.stale_notes)} note(s) cite code that changed since they "
                     f"described it — review, then --stamp · vault-check")
    if report.removed_notes:
        lines.append(f"[VAULT] {len(report.removed_notes)} note(s) cite code this branch removed and the default "
                     f"branch still has — correct the prose before it merges · vault-check")
    if report.config_problems:
        lines.append(f"[VAULT] {len(report.config_problems)} note-base rule problem(s) — a rule that does not "
                     f"parse is skipped · vault-check")
    return lines


def write_cache(vault: vaultlib.Vault, lines: list[str]) -> None:
    cache = vault.state / "vault-check.txt"
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    tmp.replace(cache)


def brief(vault: vaultlib.Vault) -> None:
    """Print the cached lines, refreshing detached when they are stale."""
    cache = vault.state / "vault-check.txt"
    fresh = cache.is_file() and (time.time() - cache.stat().st_mtime) < TTL
    if not fresh:
        vaultlib.spawn([str(Path(__file__).resolve()), "--refresh", "--root", str(vault.root)], vault.root)
    if not cache.is_file():
        print("[VAULT] not checked yet — checking in the background, it lands in the next brief")
        return
    text = cache.read_text(encoding="utf-8").rstrip()
    if text:
        print(text)
        if not fresh:
            measured = datetime.fromtimestamp(cache.stat().st_mtime, timezone.utc)
            hours = int((datetime.now(timezone.utc) - measured).total_seconds() // 3600)
            print(f"(vault check above measured {hours}h ago; refreshing now)")


def main(argv: list[str]) -> int:
    root = argv[argv.index("--root") + 1] if "--root" in argv and argv.index("--root") + 1 < len(argv) else None
    if vaultlib.disabled():
        return 0
    vault = vaultlib.locate(root)
    if "--brief" in argv:
        if vault:
            brief(vault)
        return 0
    if vault is None:
        print("vault-check: this project keeps no vault — nothing to check")
        return 0

    restamp: set[str] = set()
    if "--stamp" in argv:
        living = {p.as_posix() for p in vault_files(vault.path) if p.suffix == ".md" and is_living(p)}
        for arg in argv[argv.index("--stamp") + 1:]:
            if arg.startswith("--"):
                break
            note = normalise_note(arg, living)
            if note is None:
                print(f"vault-check: {arg} is not a living note of this vault", file=sys.stderr)
                return 2
            restamp.add(note)
        if not restamp:
            print("vault-check: --stamp needs the notes that were reviewed", file=sys.stderr)
            return 2

    write = "--check" not in argv or bool(restamp)
    lock = vault.state / "vault-check.lock"
    held, why = vaultlib.attempt(lock)
    if held is None and why is None and "--refresh" in argv:
        return 0
    deadline = time.monotonic() + LOCK_WAIT
    while held is None and why is None:
        if time.monotonic() >= deadline:
            print(f"vault-check: another check of this vault has held {lock} for over {int(LOCK_WAIT)}s — "
                  "nothing was measured; run again once it ends", file=sys.stderr)
            return 2
        time.sleep(LOCK_POLL)
        held, why = vaultlib.attempt(lock)
    if held is None and write:
        print(f"vault-check: the check's lock cannot be taken ({why}), so nothing was measured, stamped or "
              "cached; vault-check --check reads the vault without it", file=sys.stderr)
        return 2
    # Past this point either the lock is held, or this is a read-only --check, which writes nothing a
    # concurrent check could lose.
    try:
        report = measure(vault, write=write, restamp=restamp)
        if write:
            write_cache(vault, brief_lines(report))
        if "--refresh" not in argv:
            print("\n".join(render(report, quiet="--quiet" in argv)))
            if restamp:
                print(f"stamped: {', '.join(sorted(restamp))}")
    finally:
        if held is not None:
            held.release()
    return 1 if report.hard else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
