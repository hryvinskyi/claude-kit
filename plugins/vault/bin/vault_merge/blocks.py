"""Line-item Markdown read as an ordered list of blocks, and written back byte for byte.

A document is cut into blocks, each made of whole lines kept exactly as they were read (line
endings and trailing spaces included):

- **front matter**: a `---` line at the very top through the next `---` line;
- **an inbox entry**: a `<!-- session:<id> … -->` line through its `<!-- /session -->` line;
- **a heading**: one `#`…`######` line — except level three, which is a block of its own made of the
  heading and its body, up to the next heading of level one to three outside a code fence;
- **an item**: a line starting with `- ` at column 0 (`- [ ] ` and `- [x] ` included), with every
  following line indented by two spaces or a tab, and blank lines that are followed by one;
- **text**: every other run of lines, a column-0 code fence included whole.

Every block but text carries an identity, its *key*. A repeated key is numbered from its second
occurrence on (`key#2`, `key#3`). Text has no identity of its own: a merge places it by the block it
follows. Every block also knows its *section*: the key of the nearest heading above it of a lower
level (any heading, for a block that is not one).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

LINE = re.compile(r"[^\n]*\n|[^\n]+\Z")
HEADING = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*$")
ITEM = re.compile(r"^- (?:\[[ xX]\] )?(.*)$")
BOLD = re.compile(r"^\*\*(.+?)\*\*")
REF = re.compile(r"(?<![\w./-])((?:[\w.-]+/[\w.-]+)?#\d+)(?!\w)")
ENTRY_OPEN = re.compile(r"^<!--\s*session:([^\s>]+?)(?:\s+[^>]*?)?\s*-->\s*$")
ENTRY_CLOSE = re.compile(r"^<!--\s*/session\s*-->\s*$")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
TEXT_KEY_LENGTH = 120

FRONT_MATTER = "front matter"
ENTRY = "entry"
HEADING_LINE = "heading"
SECTION = "section"
ITEM_KIND = "item"
TEXT = "text"


class ParseError(ValueError):
    """The input cannot be read as blocks without changing a byte of it."""


def content(line: str) -> str:
    """A line without its terminator."""
    if line.endswith("\r\n"):
        return line[:-2]
    if line.endswith("\n") or line.endswith("\r"):
        return line[:-1]
    return line


def normalise(text: str) -> str:
    """Whitespace collapsed to single spaces, lower-cased: the form a key is compared in."""
    return " ".join(text.split()).lower()


def is_blank(line: str) -> bool:
    return content(line).strip() == ""


def is_indented(line: str) -> bool:
    body = content(line)
    return (body.startswith("  ") or body.startswith("\t")) and body.strip() != ""


@dataclass
class Block:
    """Whole lines of a document with what a merge needs to know about them."""

    kind: str
    lines: List[str]
    ident: str = ""
    level: int = 0
    key: str = ""
    section: Optional[str] = None

    @property
    def raw(self) -> str:
        return "".join(self.lines)

    @property
    def body(self) -> str:
        """The block's text without its final line terminator, so the last line of a file that
        lacks one compares equal to the same line followed by more."""
        return content(self.raw) if self.raw.endswith("\n") else self.raw

    @property
    def keyed(self) -> bool:
        return self.kind != TEXT


@dataclass
class Document:
    """A document's blocks in order, with how its lines end."""

    blocks: List[Block] = field(default_factory=list)
    eol: str = "\n"
    final_newline: bool = True

    def text(self) -> str:
        return serialise(self.blocks, self.eol, self.final_newline)


# --- readers: each recognises one kind of block at a line, or declines -------------------------


class Reader:
    """Recognises one kind of block starting at line `at`; returns the end (exclusive) and the
    block, or None to let the next reader try."""

    def read(self, lines: Sequence[str], at: int) -> Optional[Tuple[int, Block]]:
        raise NotImplementedError


class FrontMatterReader(Reader):
    def read(self, lines: Sequence[str], at: int) -> Optional[Tuple[int, Block]]:
        if at != 0 or content(lines[0]) != "---":
            return None
        for end in range(1, len(lines)):
            if content(lines[end]) in ("---", "..."):
                return end + 1, Block(FRONT_MATTER, list(lines[: end + 1]), ident="front-matter")
        return None


class EntryReader(Reader):
    def read(self, lines: Sequence[str], at: int) -> Optional[Tuple[int, Block]]:
        opened = ENTRY_OPEN.match(content(lines[at]))
        if not opened:
            return None
        end = at + 1
        while end < len(lines):
            line = content(lines[end])
            if ENTRY_CLOSE.match(line):
                end += 1
                break
            if ENTRY_OPEN.match(line):
                break
            end += 1
        return end, Block(ENTRY, list(lines[at:end]), ident="session:" + opened.group(1))


class HeadingReader(Reader):
    """A heading line; a level-three heading takes its body with it."""

    BLOCK_LEVEL = 3

    def read(self, lines: Sequence[str], at: int) -> Optional[Tuple[int, Block]]:
        found = HEADING.match(content(lines[at]))
        if not found:
            return None
        level = len(found.group(1))
        ident = "h%d:%s" % (level, normalise(found.group(2)))
        if level != self.BLOCK_LEVEL:
            return at + 1, Block(HEADING_LINE, [lines[at]], ident=ident, level=level)
        end = at + 1
        fence: Optional[str] = None
        while end < len(lines):
            line = content(lines[end])
            fence = fence_state(line, fence)
            if fence is None:
                nested = HEADING.match(line)
                if nested and len(nested.group(1)) <= self.BLOCK_LEVEL:
                    break
            end += 1
        return end, Block(SECTION, list(lines[at:end]), ident=ident, level=level)


class ItemReader(Reader):
    def read(self, lines: Sequence[str], at: int) -> Optional[Tuple[int, Block]]:
        found = ITEM.match(content(lines[at]))
        if not found:
            return None
        end = at + 1
        while end < len(lines):
            if is_indented(lines[end]):
                end += 1
                continue
            if not is_blank(lines[end]):
                break
            ahead = end
            while ahead < len(lines) and is_blank(lines[ahead]):
                ahead += 1
            if ahead < len(lines) and is_indented(lines[ahead]):
                end = ahead
                continue
            break
        return end, Block(ITEM_KIND, list(lines[at:end]), ident=item_ident(found.group(1)))


READERS: Tuple[Reader, ...] = (FrontMatterReader(), EntryReader(), HeadingReader(), ItemReader())


def fence_state(line: str, fence: Optional[str]) -> Optional[str]:
    """The code fence open after `line`, given the one open before it (None: none open)."""
    found = FENCE.match(line)
    if fence is None:
        return found.group(1) if found else None
    if found and found.group(1)[0] == fence[0] and len(found.group(1)) >= len(fence) \
            and line.strip() == found.group(1):
        return None
    return fence


def fence_end(lines: Sequence[str], at: int) -> int:
    """The end (exclusive) of a column-0 code fence opening at `at`, or `at + 1` if none opens."""
    fence = fence_state(content(lines[at]), None)
    if fence is None:
        return at + 1
    end = at + 1
    while end < len(lines):
        fence = fence_state(content(lines[end]), fence)
        end += 1
        if fence is None:
            break
    return end


def item_ident(rest: str) -> str:
    """An item's identity: the first issue reference in its leading bold span, with its repository
    when it names one; else that bold span's text; else the start of the item's text."""
    bold = BOLD.match(rest)
    if bold:
        ref = REF.search(bold.group(1))
        if ref:
            return "ref:" + ref.group(1).lower()
        return "bold:" + normalise(bold.group(1))
    return "text:" + normalise(rest)[:TEXT_KEY_LENGTH]


# --- documents --------------------------------------------------------------------------------


def parse(text: str) -> Document:
    """Cut `text` into blocks. Raises ParseError if the blocks would not give the text back."""
    lines = LINE.findall(text)
    if "".join(lines) != text:
        raise ParseError("the lines read do not add up to the input")
    blocks: List[Block] = []
    pending: List[str] = []
    at = 0
    while at < len(lines):
        found = next((got for got in (reader.read(lines, at) for reader in READERS) if got), None)
        if found is None:
            end = fence_end(lines, at)
            pending.extend(lines[at:end])
            at = end
            continue
        if pending:
            blocks.append(Block(TEXT, pending))
            pending = []
        at, block = found
        blocks.append(block)
    if pending:
        blocks.append(Block(TEXT, pending))
    number(blocks)
    place(blocks)
    document = Document(blocks, eol=line_ending(lines), final_newline=text.endswith("\n") or not text)
    if document.text() != text:
        raise ParseError("the blocks do not give the input back")
    return document


def number(blocks: Sequence[Block]) -> None:
    """Give every keyed block its key: its identity, numbered from the second occurrence on."""
    seen: dict = {}
    for block in blocks:
        if not block.keyed:
            continue
        count = seen.get(block.ident, 0) + 1
        seen[block.ident] = count
        block.key = block.ident if count == 1 else "%s#%d" % (block.ident, count)


def place(blocks: Sequence[Block]) -> None:
    """Give every block its section: the key of the nearest heading above it of a lower level."""
    stack: List[Tuple[int, str]] = []
    for block in blocks:
        if block.level:
            while stack and stack[-1][0] >= block.level:
                stack.pop()
            block.section = stack[-1][1] if stack else None
            stack.append((block.level, block.key))
        else:
            block.section = stack[-1][1] if stack else None


def line_ending(lines: Sequence[str]) -> str:
    """The terminator of the first terminated line; a file with none is written with `\\n`."""
    for line in lines:
        if line.endswith("\r\n"):
            return "\r\n"
        if line.endswith("\n"):
            return "\n"
    return "\n"


def serialise(blocks: Sequence[Block], eol: str, final_newline: bool) -> str:
    """The blocks' lines joined, every block but the last ending in a terminator, and the last
    ending in one exactly when `final_newline` says so."""
    parts: List[str] = []
    for index, block in enumerate(blocks):
        raw = block.raw
        if index < len(blocks) - 1 and raw and not raw.endswith("\n"):
            raw += eol
        parts.append(raw)
    text = "".join(parts)
    if final_newline and text and not text.endswith("\n"):
        text += eol
    elif not final_newline and text.endswith("\n"):
        text = text[: -2] if text.endswith("\r\n") else text[:-1]
    return text
