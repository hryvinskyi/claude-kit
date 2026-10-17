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
run waits for it (a lock older than ten minutes is taken over).

**Living notes** describe the code as it is: every note in a folder named for units of code —
Modules, Bridges, Plugins, Kernel, Packages, Services — the Runbooks, and the `00 …` overview at the
vault's top. Their prose is what follows a `<!-- …:generated:end -->` marker, or the whole note after
its frontmatter. A class name or repository path cited there in a code span that exists nowhere is a
HARD finding; a cited file that changed since the paragraph citing it was stamped is a SOFT one.

**Every note's** wikilinks must resolve, the way Obsidian resolves them (HARD). **Decision records**
are linted against the `YYYY-MM-DD slug.md` + `type: decision` template only in a vault whose records
overwhelmingly follow it: a vault with a convention of its own is not held to somebody else's.

A code span is read as a path when its first segment exists at the project root, or — in a note named
for a package — inside that package (`packages/<note>/`, `plugins/<note>/`, `vendor/*/<note>/`, or a
directory a configured note-base rule derives from the note's name). A class name is looked up, case-insensitively,
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

Review stamps live in `.anchors.json` beside the notes when the vault is its own repository (or is
ignored by the project), otherwise under `~/.claude/state/vaults/<project>/`, with the brief's cache.
Nothing is written into a project's tracked tree.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
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

GEN_END = re.compile(r"<!--\s*[\w.-]+:generated:end\s*-->")
LIVING_FOLDERS = ("Modules", "Bridges", "Plugins", "Kernel", "Packages", "Services", "Runbooks")
PACKAGE_FOLDERS = ("Modules", "Bridges", "Plugins", "Kernel", "Packages", "Services")
PRUNE = {".git", ".obsidian", ".qmd", ".trash", "node_modules"}
UNCHECKED = {"Templates"}

FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?^[ \t]*\1[ \t]*$", re.M | re.S)
STRUCK = re.compile(r"~~.+?~~", re.S)
SPAN = re.compile(r"`([^`\n]+)`")
NAME = re.compile(r"[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+")
PATH = re.compile(r"([^\s/:#`@\\]+(?:/[^\s:#`\\]+)+?)/?(?::\d+(?:-\d+)?)?(?:#\S*)?")
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


def paragraphs(text: str) -> list[str]:
    return [p for p in re.split(r"\n[ \t]*\n", text) if p.strip()]


def citations(prose: str) -> Citations:
    """Class names and path-shaped spans cited in code spans, outside fences and strike-through."""
    found = Citations()
    for para in paragraphs(FENCE.sub("", prose)):
        for span in SPAN.findall(STRUCK.sub("", para)):
            name = span_name(span)
            if name:
                found.names.setdefault(name, []).append(para)
            path = span_path(span)
            if path:
                found.paths.setdefault(path, []).append(para)
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


def names_the_repository(path: str, bases: list[str], root_entries: set[str],
                         exists: Callable[[str], bool]) -> bool:
    """Whether a path-shaped span is about this repository at all: its first segment must exist somewhere.

    `text/plain` or `and/or` in prose is shaped like a path and names nothing here; a first segment
    at the project root, or inside the note's own package, is what makes it a claim about the tree.
    """
    first = path.split("/", 1)[0]
    return first in root_entries or any(exists(base + first) for base in bases)


# --- the repository -----------------------------------------------------------


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
        index: dict[str, list[str]] = {}
        for rel in sorted(set(filter(None, out.split("\0")))):
            index.setdefault(rel.rsplit("/", 1)[-1][:-4], []).append(rel)
        return index

    def words_in_code(self, names: set[str]) -> set[str]:
        """The casefolded names occurring as a whole word, in any case, in the non-Markdown files.

        The names are searched as written first, and only those not found are searched again in any
        case: git grep's cost under -i grows with the number of patterns (69 s against 8 s for 56
        names over a 143k-file tree), and a cited name is nearly always written as the code writes it.
        """
        found = self.grep_words(names, any_case=False)
        return found | self.grep_words({n for n in names if n.casefold() not in found}, any_case=True)

    def grep_words(self, names: set[str], any_case: bool) -> set[str]:
        if not names:
            return set()
        fd, patterns = tempfile.mkstemp(suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write("\n".join(sorted(names)) + "\n")
            code, out = self.git("-c", f"grep.threads={GREP_THREADS}", "grep", "--untracked", "-I", "-h", "-o",
                                 *(["-i"] if any_case else []), "-w", "-F", "-f", patterns,
                                 "--", ".", ":(exclude)*.md", ":(exclude)*.mdx")
        finally:
            os.unlink(patterns)
        # git grep answers 1 for "no match"; anything else, a timeout included, means the search never
        # covered the tree, and reading its empty output as "nothing found" would call every name gone.
        if code not in (0, 1):
            raise CodeSearchUnfinished(code)
        return {token.casefold() for token in out.split()}

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

    def head_blobs(self) -> dict[str, str]:
        _, out = self.git("ls-tree", "-r", "-z", "HEAD")
        blobs: dict[str, str] = {}
        for entry in filter(None, out.split("\0")):
            meta, _, path = entry.partition("\t")
            parts = meta.split()
            if len(parts) == 3 and parts[1] == "blob":
                blobs[path] = parts[2]
        return blobs

    def head(self) -> str:
        code, out = self.git("rev-parse", "HEAD")
        return out.strip() if code == 0 else ""

    def commits_since(self, commit: str, path: str) -> Optional[int]:
        if not commit:
            return None
        code, out = self.git("rev-list", "--count", f"{commit}..HEAD", "--", path)
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


def reconcile(current: dict[str, dict[str, str]], stamps: dict, blobs: dict[str, str], head: str,
              restamp: set[str]) -> tuple[dict, list[tuple[str, str, str]]]:
    """Carry the stamps forward and name every anchor whose file moved under unchanged prose.

    An anchor is (re-)stamped at HEAD when it is new, when the paragraphs citing it changed, or when
    its note is being stamped; otherwise it keeps its stamp and is stale if the file's blob moved.
    """
    carried: dict = {}
    stale: list[tuple[str, str, str]] = []
    for note in sorted(current):
        previous = stamps.get(note) if isinstance(stamps.get(note), dict) else {}
        entries: dict = {}
        for path in sorted(current[note]):
            context = current[note][path]
            before = previous.get(path)
            if not isinstance(before, dict) or before.get("context") != context or note in restamp:
                entries[path] = {"blob": blobs[path], "commit": head, "context": context}
                continue
            entries[path] = before
            if before.get("blob") != blobs[path]:
                stale.append((note, path, str(before.get("commit", ""))))
        if entries:
            carried[note] = entries
    return carried, stale


# --- measuring ----------------------------------------------------------------


@dataclass
class Finding:
    level: str  # HARD | SOFT
    note: str
    message: str


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

    vendor_dirs = repo.vendor_dirs()
    note_bases, report.config_problems = load_note_bases(vault.path)
    root_entries = {p.name for p in vault.root.iterdir()}
    bases = {rel: package_bases(rel, vendor_dirs, note_bases) for rel in living}
    exists = lambda rel: (vault.root / rel).exists()  # noqa: E731

    index = repo.php_index()
    cited: set[str] = set()
    for c in living.values():
        cited.update(c.names)
    report.names = len(cited)
    known = {name.casefold() for name in index}
    missing = {n for n in cited if n.casefold() not in known}
    try:
        found = repo.words_in_code(missing)
    except CodeSearchUnfinished as unfinished:
        # One honest finding instead of one false one per name: the names stay unchecked, not gone.
        reason = "did not finish in time" if unfinished.code == vaultlib.TIMED_OUT else f"failed ({unfinished.code})"
        report.findings.append(Finding(
            "HARD", vault.rel, f"the search of the code for {len(missing)} cited name(s) {reason}, so none of them "
                               "was checked — keep large untracked trees out of it (.git/info/exclude) and run again"))
        missing = set()
        found = set()
    missing = {n for n in missing if n.casefold() not in found}
    if missing:
        vendored = repo.vendor_stems()
        missing = {n for n in missing if n.casefold() not in vendored}

    for rel in sorted(living):
        for name in sorted(set(living[rel].names) & missing):
            report.findings.append(Finding(
                "HARD", rel, f"`{name}` appears nowhere in the code — correct the prose, "
                             f"or strike it through as history: ~~`{name}`~~"))
        for cited_path in sorted(living[rel].paths):
            if not names_the_repository(cited_path, bases[rel], root_entries, exists):
                continue
            if resolve_path(cited_path, bases[rel], exists) is not None:
                continue
            # Asked only where the path could live — a base under an ignored vendor/ must not excuse it.
            first = cited_path.split("/", 1)[0]
            homes = [base for base in ["", *bases[rel]]
                     if (first in root_entries if base == "" else exists(base + first))]
            if repo.ignored([base + cited_path for base in homes]):
                continue
            report.findings.append(Finding(
                "HARD", rel, f"`{cited_path}` does not exist — correct the prose, "
                             f"or strike it through as history"))

    blobs = repo.head_blobs()
    current = {rel: anchors_for(c, bases[rel], index, blobs) for rel, c in living.items()}
    report.anchors = sum(len(a) for a in current.values())
    target = stamps_file(vault)
    stamps = load_stamps(target)
    carried, stale = reconcile(current, stamps, blobs, repo.head(), restamp or set())

    by_note: dict[str, list[tuple[str, str]]] = {}
    for note, path, commit in stale:
        by_note.setdefault(note, []).append((path, commit))
    for note in sorted(by_note):
        shown = []
        for path, commit in by_note[note][:5]:
            count = repo.commits_since(commit, path)
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
    if report.soft_notes:
        lines.append(f"[VAULT] {len(report.soft_notes)} note(s) cite code that changed since they "
                     f"described it — review, then --stamp · vault-check")
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
    held = vaultlib.take_lock(lock)
    if not held and "--refresh" in argv:
        return 0
    while not held:
        time.sleep(LOCK_POLL)
        held = vaultlib.take_lock(lock)
    try:
        report = measure(vault, write=write, restamp=restamp)
        if write:
            write_cache(vault, brief_lines(report))
        if "--refresh" not in argv:
            print("\n".join(render(report, quiet="--quiet" in argv)))
            if restamp:
                print(f"stamped: {', '.join(sorted(restamp))}")
    finally:
        lock.unlink(missing_ok=True)
    return 1 if report.hard else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
