"""The `keyed` driver: line-item Markdown merged row by row, each row matched by its key.

Rules, in base/current/incoming terms (see `driver`):

- Each block's key is read in the base's terms first. Blocks sharing one identity (several rows
  naming one ticket) are matched to the base's by the same text, then the same first line, then in
  order, so a row added or removed among them does not shift the others onto each other.
- A side that deleted key K and added key K' of the same kind, in the same section, directly after
  the same keyed block, edited K: K' is read as K. Without this, editing the title of a row that
  has no issue reference would read as a deletion and an addition, and any change on the other side
  would leave a silent duplicate.
- Text has no key of its own: it is read as the text after the keyed block it follows. A run that
  lost its place (the block before it was deleted or added) is matched to a base run of the same
  section with the same text, or to the only unmatched one there.
- Per key, the section and the text are merged three-way, each on its own: unchanged on both sides
  keeps it; changed on one side takes that side; deleted on one side and unchanged on the other
  deletes it; deleted on one side and changed on the other keeps the changed one.
- A key whose text changed differently on both sides is merged line-wise by `git merge-file` when
  that merges it without a conflict (two edits to different lines of one multi-line row). Otherwise
  — and when its section changed differently on both sides, or it was added on both sides with
  different text — the current version is kept and the incoming one put directly after it, after
  the line ANNOTATION. Added
  on both sides with the same text, it is kept once. Text changed on both sides is merged
  line-wise by `git merge-file`; each conflict there becomes the annotation, the current lines and
  the incoming lines.
- Order: the current side's order is the frame. A block the incoming side contributes (a new row,
  a row it moved to another section, a row it kept that the current side deleted) goes directly
  after the nearest block before it, in the incoming order, that the result keeps in the same
  section — else at the start of that section, else after the nearest block before it at all.
- The current side's line ending is the result's. The result ends in a newline when the side that
  changed that says so.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple, TypeVar

from vault_merge import blocks as md
from vault_merge.driver import Driver, MergeInput, Outcome, trivial
from vault_merge.gitmerge import PARSE_MARKER_SIZE, Git, Hunk, split_conflicts

ANNOTATION = "<!-- vault-merge: two versions of this row; keep one -->"
START = "^"
AFTER = "~after:"
CURRENT = "current"
INCOMING = "incoming"

T = TypeVar("T")
TextMerge = Callable[[str, str, str, str], Tuple[List[str], int]]


@dataclass
class Version:
    """One version's blocks, each with its key and section in the base's terms."""

    blocks: List[md.Block]
    keys: List[str]
    sections: List[Optional[str]]

    def __post_init__(self) -> None:
        self.index: Dict[str, int] = {key: at for at, key in enumerate(self.keys)}

    def entry(self, key: str) -> Optional["Entry"]:
        at = self.index.get(key)
        if at is None:
            return None
        return Entry(self.sections[at], self.blocks[at].body, self.blocks[at])


@dataclass(frozen=True)
class Entry:
    """One key in one version: its section, its text without the final line ending, its block."""

    section: Optional[str]
    body: str
    block: md.Block


@dataclass
class Placed:
    """Blocks the result keeps under one key, and the section they belong to."""

    key: str
    blocks: List[md.Block]
    section: Optional[str]


def three(base: T, current: T, incoming: T) -> Tuple[T, str, bool]:
    """A three-way choice of one value: the value, the side it came from, and whether both sides
    changed it differently (the current value is returned then)."""
    if current == incoming or incoming == base:
        return current, CURRENT, False
    if current == base:
        return incoming, INCOMING, False
    return current, CURRENT, True


def base_version(document: md.Document) -> Version:
    """The base's blocks under their own keys; text under the keyed block it follows."""
    keys: List[str] = []
    last = START
    for block in document.blocks:
        keys.append(block.key if block.keyed else AFTER + last)
        if block.keyed:
            last = block.key
    return Version(document.blocks, keys, [block.section for block in document.blocks])


def side_version(base: Version, document: md.Document) -> Version:
    """A side's blocks under the base's keys, renamed rows and displaced text matched."""
    blocks = document.blocks
    keys = [""] * len(blocks)
    sections: List[Optional[str]] = [None] * len(blocks)
    canon: Dict[str, str] = {}
    used: Set[str] = set()
    matched = match_identities(base, blocks)
    renames = RenameIndex(base, set(matched.values()))

    last = START
    for at, block in enumerate(blocks):
        sections[at] = canon.get(block.section, block.section) if block.section is not None else None
        if not block.keyed:
            continue
        key = matched.get(at) or renames.take(block, sections[at], last) or fresh(block.key, base, used)
        canon[block.key] = key
        used.add(key)
        keys[at] = key
        last = key

    displaced: List[int] = []
    last = START
    for at, block in enumerate(blocks):
        if block.keyed:
            last = keys[at]
            continue
        keys[at] = AFTER + last
        if keys[at] in base.index and not base.blocks[base.index[keys[at]]].keyed and keys[at] not in used:
            used.add(keys[at])
        else:
            displaced.append(at)
    for at in displaced:
        found = displaced_text(base, blocks[at], sections[at], used,
                               sum(1 for other in displaced if sections[other] == sections[at]))
        keys[at] = found or fresh(keys[at], base, used)
        used.add(keys[at])
    return Version(blocks, keys, sections)


def match_identities(base: Version, blocks: Sequence[md.Block]) -> Dict[int, str]:
    """A side's keyed blocks (by position) matched to the base keys of the same identity. Within a
    repeated identity — several rows naming one ticket — a block is matched to the base block with
    the same text first, then to one with the same first line, then the rest in order, so adding or
    removing one such row does not shift its siblings onto each other."""
    groups: Dict[str, List[int]] = {}
    for at, block in enumerate(base.blocks):
        if block.keyed:
            groups.setdefault(block.ident, []).append(at)
    mine: Dict[str, List[int]] = {}
    for at, block in enumerate(blocks):
        if block.keyed and block.ident in groups:
            mine.setdefault(block.ident, []).append(at)
    matched: Dict[int, str] = {}
    for ident, left in mine.items():
        free = list(groups[ident])
        for same in (lambda block: block.body, first_line):
            unmatched = []
            for at in left:
                hit = next((theirs for theirs in free if same(base.blocks[theirs]) == same(blocks[at])), None)
                if hit is None:
                    unmatched.append(at)
                else:
                    matched[at] = base.blocks[hit].key
                    free.remove(hit)
            left = unmatched
        for at, theirs in zip(left, free):
            matched[at] = base.blocks[theirs].key
    return matched


def first_line(block: md.Block) -> str:
    """A block's first line, normalised, an item's check box left out."""
    line = md.content(block.lines[0])
    item = md.ITEM.match(line)
    return md.normalise(item.group(1) if item else line)


class RenameIndex:
    """The base's keyed blocks no block of a side was matched to, by the keyed block before them."""

    def __init__(self, base: Version, own: Set[str]) -> None:
        self.base = base
        self.by_previous: Dict[str, List[int]] = {}
        last = START
        for at, block in enumerate(base.blocks):
            if not block.keyed:
                continue
            if block.key not in own:
                self.by_previous.setdefault(last, []).append(at)
            last = block.key

    def take(self, block: md.Block, section: Optional[str], previous: str) -> Optional[str]:
        """The base key `block` replaces, removed from the index, or None."""
        for at in self.by_previous.get(previous, []):
            candidate = self.base.blocks[at]
            if candidate.kind == block.kind and candidate.level == block.level \
                    and self.base.sections[at] == section:
                self.by_previous[previous].remove(at)
                return candidate.key
        return None


def displaced_text(base: Version, block: md.Block, section: Optional[str], used: Set[str],
                   displaced_here: int) -> Optional[str]:
    """The base text run a displaced run is: one with the same text in the same section, or the
    only unmatched run of that section when this is the only displaced run there."""
    candidates = [key for at, key in enumerate(base.keys)
                  if not base.blocks[at].keyed and key not in used and base.sections[at] == section]
    for key in candidates:
        if base.blocks[base.index[key]].body == block.body:
            return key
    if len(candidates) == 1 and displaced_here == 1:
        return candidates[0]
    return None


def fresh(key: str, base: Version, used: Set[str]) -> str:
    """`key`, or a variant of it, that names nothing in the base and nothing already taken."""
    candidate, count = key, 1
    while candidate in base.index or candidate in used:
        count += 1
        candidate = "%s@%d" % (key, count)
    return candidate


class RowMerge:
    """The three-way merge of three versions already keyed alike."""

    def __init__(self, base: Version, current: Version, incoming: Version, eol: str,
                 text_merge: TextMerge) -> None:
        self.base, self.current, self.incoming = base, current, incoming
        self.eol = eol
        self.text_merge = text_merge
        self.twins = 0

    def run(self) -> List[md.Block]:
        decided: Dict[str, Tuple[Optional[Placed], str]] = {}
        for key in list(self.current.keys) + list(self.incoming.keys):
            if key not in decided:
                decided[key] = self.decide(key)
        result = [placed for placed, side in (decided[key] for key in self.current.keys)
                  if placed is not None and side == CURRENT]
        for at, key in enumerate(self.incoming.keys):
            placed, side = decided[key]
            if placed is None or side != INCOMING:
                continue
            anchor = self.anchor(result, at, placed.section)
            position = 0 if anchor is None else \
                next(index for index, kept in enumerate(result) if kept.key == anchor) + 1
            result.insert(position, placed)
        return [block for placed in result for block in placed.blocks]

    def decide(self, key: str) -> Tuple[Optional[Placed], str]:
        base, current, incoming = (self.base.entry(key), self.current.entry(key),
                                   self.incoming.entry(key))
        if current is not None and incoming is not None:
            if base is None:
                if current.body == incoming.body:
                    return Placed(key, [current.block], current.section), CURRENT
                return self.both(key, None, current, incoming), CURRENT
            section, section_from, section_clash = three(base.section, current.section, incoming.section)
            _, body_from, body_clash = three(base.body, current.body, incoming.body)
            if body_clash and not section_clash and current.block.keyed:
                lines, conflicts = self.text_merge(base.block.raw, current.block.raw, incoming.block.raw,
                                                   self.eol)
                if not conflicts:
                    return Placed(key, [replace(current.block, lines=lines)], section), section_from
            if section_clash or body_clash:
                return self.both(key, base, current, incoming), CURRENT
            block = incoming.block if body_from == INCOMING else current.block
            return Placed(key, [block], section), section_from
        for side, entry in ((CURRENT, current), (INCOMING, incoming)):
            if entry is None:
                continue
            if base is not None and (entry.section, entry.body) == (base.section, base.body):
                return None, side
            return Placed(key, [entry.block], entry.section), side
        return None, CURRENT

    def both(self, key: str, base: Optional[Entry], current: Entry, incoming: Entry) -> Placed:
        """Both sides changed one key differently."""
        if current.block.keyed:
            self.twins += 1
            note = md.Block(md.TEXT, [ANNOTATION + self.eol])
            return Placed(key, [current.block, note, incoming.block], current.section)
        lines, conflicts = self.text_merge(base.block.raw if base else "", current.block.raw,
                                           incoming.block.raw, self.eol)
        self.twins += conflicts
        return Placed(key, [md.Block(md.TEXT, lines)], current.section)

    def anchor(self, result: Sequence[Placed], at: int, section: Optional[str]) -> Optional[str]:
        kept = {placed.key: placed for placed in result}
        before = self.incoming.keys[:at][::-1]
        for key in before:
            placed = kept.get(key)
            if placed is not None and (placed.section == section or key == section):
                return key
        if section is not None and section in kept:
            return section
        return next((key for key in before if key in kept), None)


class KeyedDriver(Driver):
    """Merges line-item Markdown row by row."""

    def __init__(self, git: Git) -> None:
        self.git = git

    def merge(self, given: MergeInput) -> Outcome:
        quick = trivial(given)
        if quick is not None:
            return quick
        base, current, incoming = (md.parse(data.decode("utf-8"))
                                   for data in (given.base, given.current, given.incoming))
        base_keys = base_version(base)
        rows = RowMerge(base_keys, side_version(base_keys, current), side_version(base_keys, incoming),
                        current.eol, self.text_merge)
        merged = rows.run()
        final_newline, _, _ = three(base.final_newline if given.base else current.final_newline,
                                    current.final_newline, incoming.final_newline)
        text = md.serialise(merged, current.eol, final_newline)
        notes = []
        if rows.twins:
            notes.append("%s: %d %s two versions; keep one of each (look for '%s')" % (
                given.path or "the file", rows.twins, "row has" if rows.twins == 1 else "rows have",
                ANNOTATION))
        return Outcome(text.encode("utf-8"), True, notes)

    def text_merge(self, base: str, current: str, incoming: str, eol: str) -> Tuple[List[str], int]:
        """Three texts merged line-wise; each conflict becomes the annotation, the current lines and
        the incoming lines. Returns the lines and the number of conflicts."""
        def ended(text: str) -> bytes:
            return (text if not text or text.endswith("\n") else text + eol).encode("utf-8")

        merged, _ = self.git.merge_file(ended(current), ended(base), ended(incoming),
                                        marker_size=PARSE_MARKER_SIZE)
        lines: List[str] = []
        conflicts = 0
        for segment in split_conflicts(merged.decode("utf-8")):
            if isinstance(segment, Hunk):
                conflicts += 1
                lines.append(ANNOTATION + eol)
                lines.extend(segment.current)
                lines.extend(segment.incoming)
            else:
                lines.append(segment)
        return lines, conflicts
