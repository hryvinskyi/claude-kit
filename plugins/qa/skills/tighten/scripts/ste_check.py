#!/usr/bin/env python3
"""ste_check.py — measure a text against the countable limits of Simplified Technical English.

Usage:
    python3 ste_check.py [--profile light|standard|strict] [--procedure] [--lang auto|en|other] [--gate] [FILE]

The text is Markdown or plain text, read from FILE or, with no FILE, from standard input.

Measured in every profile, in every language that puts spaces between its words:

    a sentence     at most 25 words, and at most 20 when it gives an instruction
    a paragraph    at most 6 sentences (a list item is measured the same way)
    a semicolon    none

`--procedure` says that the whole text is instructions, so every sentence has the 20-word limit.
Without it, a sentence of 21 to 25 words is reported for review, and only when it looks like an
instruction: it sits in a numbered list item or it starts with a command.

Words are counted as ASD-STE100 counts them (Issue 9, rules 8.4 to 8.7), carried over to Markdown. A
code span, a link address and a quotation count as one word each. Text in parentheses counts as one
word of its sentence and is measured as a sentence of its own, so a parenthesis cannot hide a long
sentence. A hyphenated word counts as one word. A colon that ends a block (the line above a vertical
list) ends its sentence. Fenced code, front matter, headings, tables, HTML comments and link
definitions are not prose and are skipped; so is a block made only of `key: value` lines, apart from
its semicolons.

In English text the standard and strict profiles also report contractions (to fix) and, for review:
progressive and perfect verb forms, a passive with a modal verb or a named agent, an "-ing" form
after a preposition, and inflated words that have a plain equivalent. The strict profile adds, for
review, every other "-ing" form and the dictionary entries that go against everyday English. A
review line is a pattern match. It can be wrong, and the reader of the report decides.

Not measured: nouns in a row, word choice beyond the short lists below, and meaning.

Output: a first line with the profile, the language and the totals; one line per finding, `fix` or
`review`, with the line number in the input and the start of the sentence; a last line that starts
with `result:`. The word total of the first line counts a code span and a link address as one word
each, so the same count of a source and of its rewrite can be compared.

Exit status: 0 when the report is printed; 2 when the input cannot be read or an option is wrong.
With `--gate`, 1 when at least one line says `fix`, for a caller that reads the status and not the
report.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import List, NamedTuple, Optional, Sequence, Tuple

INSTRUCTION_WORDS = 20
DESCRIPTION_WORDS = 25
PARAGRAPH_SENTENCES = 6

SPAN = chr(0xE000)   # stands for a code span, a link address or a quotation: one word
PAREN = chr(0xE001)  # stands for text in parentheses: one word

FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
HEADING = re.compile(r"^\s{0,3}#{1,6}(\s|$)")
UNDERLINE = re.compile(r"^\s{0,3}(=+|-+)\s*$")
RULE = re.compile(r"^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$")
ITEM = re.compile(r"^\s*(?:[-*+]|(\d{1,9})[.)])\s+(?:\[[ xX]\]\s+)?(.*)$")
TABLE_ROW = re.compile(r"^\s*\|")
TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$")
QUOTE_MARK = re.compile(r"^\s{0,3}(?:>\s?)+")
ALERT = re.compile(r"^\[![A-Za-z]+\]\s*$")
LINK_DEFINITION = re.compile(r"^\s{0,3}\[[^\]]+\]:\s+\S")
KEY_VALUE = re.compile(r"^\S[^:\n]{0,40}:\s+\S")

SENTENCE_END = re.compile(r"(\.{3}|[.!?…]+)([\"'’”»)\]]*)(\s+|$)")
WORD_BEFORE = re.compile(r"([^\W\d_]+(?:\.[^\W\d_]+)*)$")
PARENTHESIS = re.compile(r"(?<![^\s(\[{«“\"'])\(([^()]{1,600})\)")

# A full stop after one of these does not end a sentence.
ABBREVIATIONS = frozenset((
    "e.g", "i.e", "vs", "cf", "approx", "incl", "excl", "mr", "mrs", "ms", "dr", "prof", "fig", "eq",
    "напр", "див", "рис", "табл", "вул", "тис", "млн", "млрд", "грн",
))
# After one of these it ends a sentence only when no digit follows.
BEFORE_A_NUMBER = frozenset(("no", "p", "pp", "vol", "sec", "ch", "ст", "с", "п", "стор"))
# After one of these it ends a sentence only when no lower-case letter follows.
MID_SENTENCE = frozenset(("etc", "a.m", "p.m", "ін", "т.д", "т.п", "т.ін"))

ENGLISH_COMMON = frozenset((
    "the", "and", "of", "to", "is", "a", "in", "that", "it", "for", "with", "on", "are", "as", "this",
    "be", "not", "or", "you", "can",
))

COMMANDS = frozenset((
    "add", "apply", "ask", "attach", "build", "call", "change", "check", "choose", "clear", "click",
    "close", "commit", "configure", "connect", "copy", "create", "delete", "deploy", "disable", "do",
    "download", "edit", "enable", "enter", "examine", "export", "find", "give", "go", "import",
    "install", "keep", "leave", "let", "make", "move", "obey", "open", "paste", "press", "pull", "push",
    "put", "read", "record", "release", "remove", "rename", "replace", "restart", "review", "run",
    "save", "select", "send", "set", "start", "stop", "switch", "tell", "turn", "type", "update",
    "upload", "use", "verify", "wait", "write",
))
BEFORE_A_COMMAND = frozenset(("then", "next", "now", "first", "finally", "always", "never", "please", "also"))
CONDITION = frozenset(("if", "when", "after", "before", "once", "while", "until", "to", "for"))
COMMAND_SUFFIX = re.compile(r"(?:іть|їть|йте|ьте|рте|вте|жте|чте|ште|щте|бте|пте|мте)$")
BEFORE_A_COMMAND_UK = frozenset(("не", "потім", "далі", "спочатку", "тепер", "завжди", "ніколи", "також"))

CONTRACTION = re.compile(
    r"\b(?:[A-Za-z]+n['’]t|[A-Za-z]+['’](?:re|ve|ll|d|m)"
    r"|(?:it|that|there|here|what|who|where|how|let|he|she)['’]s)\b",
    re.IGNORECASE,
)

BE = r"(?:am|is|are|was|were|be|been|being)"
ADVERB = r"(?:(?:not|also|still|now|currently|already|just|never|always|only|[a-z]+ly)\s+)?"
IRREGULAR = (
    r"(?:been|done|made|sent|set|run|built|written|given|taken|seen|shown|known|found|kept|held|left"
    r"|lost|put|read|sold|told|paid|gone|come|become|begun|chosen|broken|driven|drawn|fallen|forgotten"
    r"|frozen|got|gotten|grown|hidden|led|meant|met|shut|spent|stuck|thrown|understood|worn|won"
    r"|withdrawn|brought|bought|caught|taught|thought|cut|hit|let|split|spread|reset|sought|bound|fed"
    r"|laid|rebuilt|rewritten|overwritten|overridden)"
)
PARTICIPLE = rf"([a-z]+ed|{IRREGULAR})"
NOT_A_PARTICIPLE = frozenset((
    "need", "speed", "feed", "seed", "indeed", "embed", "bed", "red", "shed", "exceed", "proceed",
    "succeed", "hundred", "weed", "breed", "bleed", "greed", "deed", "reed", "heed",
))
NOT_A_VERB_FORM = frozenset((
    "something", "nothing", "anything", "everything", "thing", "string", "king", "ring", "spring",
    "sibling", "during", "morning", "evening", "missing", "pending", "existing", "following",
    "remaining", "outstanding", "interesting", "willing", "ceiling", "wing", "sting", "bring", "sing",
    "padding", "warning", "meaning", "wording", "spelling", "heading", "setting", "listing", "mapping",
    "training", "beginning", "ending", "meeting", "timing", "pricing", "billing",
))

PROGRESSIVE = re.compile(rf"\b{BE}\s+{ADVERB}([a-z]+ing)\b", re.IGNORECASE)
PERFECT = re.compile(rf"\b(?:has|have|had|having)\s+{ADVERB}{PARTICIPLE}\b", re.IGNORECASE)
PASSIVE_WITH_AGENT = re.compile(rf"\b{BE}\s+{ADVERB}{PARTICIPLE}\b(?:\s+[\w-]+){{0,3}}?\s+by\b", re.IGNORECASE)
PASSIVE_WITH_MODAL = re.compile(
    rf"\b(?:must|should|can|could|may|might|will|would|shall|cannot|needs? to|ha(?:s|ve) to)\s+(?:not\s+)?be\s+"
    rf"{ADVERB}{PARTICIPLE}\b",
    re.IGNORECASE,
)
ING_AFTER_PREPOSITION = re.compile(
    r"\b(?:after|before|by|when|while|without|upon|instead of)\s+(?:[a-z]+ly\s+)?([a-z]+ing)\b", re.IGNORECASE
)
ING_FORM = re.compile(r"\b([a-z]{2,}ing)\b", re.IGNORECASE)

# Inflated wording with a plain equivalent: reported in the standard and strict profiles.
PLAIN_WORDS: Tuple[Tuple[str, str], ...] = (
    (r"\butili[sz](?:e|es|ed|ing)\b", '"use"'),
    (r"\bcommenc(?:e|es|ed|ing)\b", '"start"'),
    (r"\binitiat(?:e|es|ed|ing)\b", '"start"'),
    (r"\bterminat(?:e|es|ed|ing)\b", '"stop"'),
    (r"\bprior to\b", '"before"'),
    (r"\bsubsequent to\b", '"after"'),
    (r"\bin order to\b", '"to"'),
    (r"\bin the event (?:that|of)\b", '"if"'),
    (r"\bdue to the fact that\b", '"because"'),
    (r"\bat this point in time\b", '"now"'),
)
# Dictionary entries that go against everyday English: reported in the strict profile.
STRICT_WORDS: Tuple[Tuple[str, str], ...] = (
    (r"\b(?:ensur(?:e|es|ed|ing)|verif(?:y|ies|ied|ying)|confirm(?:s|ed|ing)?|check(?:s|ed|ing)?\s+that)\b",
     '"make sure"'),
    (r"\babout\s+\d", '"approximately": "about" is approved only as "concerned with"'),
    (r"\bfollow(?:s|ed|ing)?\s+(?:the|these|those|all)\s+(?:[\w-]+\s+)?(?:instructions?|steps?|procedures?|rules?)\b",
     '"obey" or "do": "follow" means "come after"'),
    (r"\bbeg(?:in|ins|an|un)\b", '"start"'),
    (r"\bacceptable\b", '"permitted"'),
    (r"\bcarr(?:y|ies|ied|ying) out\b", '"do"'),
    (r"\b(?:conduct|execut|perform)(?:e|s|es|ed|ing)?\s+(?:a|an|the)\s+(?:[\w-]+\s+)?(?:tests?|checks?|procedures?)\b",
     '"do"'),
    (r"(?:^|\b(?:to|must|then|and|not|please)\s+)test\s+(?:the|a|an|that|it|this|each|every|all)\b",
     '"do a test": "test" is a noun only'),
)


class Block(NamedTuple):
    line: int      # the line number of its first line in the input
    text: str      # its lines, joined by a line break
    item: bool     # a list item
    ordered: bool  # a numbered list item


class Finding(NamedTuple):
    line: int
    fix: bool
    text: str


def read_blocks(text: str) -> List[Block]:
    """The prose of a Markdown text: its paragraphs and list items, with what is not prose left out."""
    text = re.sub(r"<!--.*?-->", lambda found: "\n" * found.group(0).count("\n"), text, flags=re.DOTALL)
    lines = text.split("\n")
    start = 0
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() in ("---", "..."):
                start = index + 1
                break

    blocks: List[Block] = []
    current: List[str] = []
    first, item, ordered = 0, False, False
    fence = ""
    in_table = False

    def close() -> None:
        if current:
            blocks.append(Block(first, "\n".join(current), item, ordered))
            current.clear()

    for number, raw in enumerate(lines[start:], start + 1):
        opened = FENCE.match(raw)
        if fence:
            closes = opened and opened.group(1)[0] == fence[0] and len(opened.group(1)) >= len(fence)
            if closes and not opened.group(2).strip():
                fence = ""
            continue
        if opened:
            close()
            fence, in_table = opened.group(1), False
            continue
        line = QUOTE_MARK.sub("", raw)
        stripped = line.strip()
        if not stripped:
            close()
            in_table = False
            continue
        if in_table:
            if "|" in line:
                continue
            in_table = False
        if "|" in line and TABLE_RULE.match(line):
            if current:
                current.pop()  # the line above was the header row
            close()
            in_table = True
            continue
        if TABLE_ROW.match(line):
            close()
            in_table = True
            continue
        if HEADING.match(line) or ALERT.match(stripped) or LINK_DEFINITION.match(line):
            close()
            continue
        if UNDERLINE.match(line) and current and not item:
            current.clear()  # the paragraph above is a heading
            continue
        if RULE.match(line):
            close()
            continue
        found = ITEM.match(line)
        if found:
            close()
            first, item, ordered = number, True, found.group(1) is not None
            current.append(found.group(2))
            continue
        if not current:
            first, item, ordered = number, False, False
        current.append(stripped)
    close()
    return blocks


def _keep_lines(found: "re.Match[str]", stand_in: str) -> str:
    """A stand-in for a matched span that keeps its line breaks, so line numbers stay true."""
    span = found.group(0)
    closing = span[-2:-1] if len(span) > 2 and span[-2] in ".!?" else ""
    return stand_in + closing + "\n" * span.count("\n")


def inline(text: str) -> str:
    """A block's text with Markdown markup removed and each one-word span replaced by a stand-in."""
    text = re.sub(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)", SPAN, text)
    text = re.sub(r"!\[[^\]]*\]\([^)\s]*(?:\s+\"[^\"]*\")?\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)\s]*(?:\s+\"[^\"]*\")?\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\[[^\]]*\]", r"\1", text)
    text = re.sub(r"<(?:https?://|mailto:)[^>\s]+>", SPAN, text)
    text = re.sub(r"https?://[^\s<>]*[^\s<>.,:;!?)\]'\"]", SPAN, text)
    text = re.sub(r"</?[A-Za-z][^>]*>", " ", text)
    text = re.sub(r"&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);", " ", text)
    text = re.sub(r"\*\*|__|~~", "", text)
    return re.sub(r"(?<![\w*])[*_](?=[^\s*_])|(?<=[^\s*_])[*_](?![\w*])", "", text)


def lift_quotations(text: str) -> str:
    """Each quotation replaced by a one-word stand-in; a full stop inside its closing mark is kept."""
    text = re.sub(r"“[^“”]{1,300}”", lambda found: _keep_lines(found, SPAN), text)
    text = re.sub(r"«[^«»]{1,300}»", lambda found: _keep_lines(found, SPAN), text)
    if text.count('"') % 2 == 0:
        text = re.sub(r'"[^"]{1,300}"', lambda found: _keep_lines(found, SPAN), text)
    return text


def lift_parentheses(text: str, line: int) -> Tuple[str, List[Tuple[int, str]]]:
    """Text in parentheses replaced by a one-word stand-in, and each lifted text with its line."""
    lifted: List[Tuple[int, str]] = []
    while True:
        found = PARENTHESIS.search(text)
        if not found:
            return text, lifted
        lifted.append((line + text[: found.start()].count("\n"), found.group(1)))
        text = text[: found.start()] + PAREN + "\n" * found.group(0).count("\n") + text[found.end():]


def _ends_sentence(text: str, found: "re.Match[str]") -> bool:
    following = text[found.end(): found.end() + 4]
    stops = found.group(1)
    if stops in ("...", "…"):
        return not following[:1].islower()
    before = WORD_BEFORE.search(text[: found.start()])
    word = before.group(1).lower() if before else ""
    if word in ABBREVIATIONS:
        return False
    if word in BEFORE_A_NUMBER and following[:1].isdigit():
        return False
    if word in MID_SENTENCE and following[:1].islower():
        return False
    if word == "т" and following.lower().startswith(("д.", "п.", "ін.")):
        return False
    if word in ("д", "п", "ін") and re.search(r"т\.\s?$", text[: before.start()] if before else ""):
        return not following[:1].islower()
    return True


def split_sentences(text: str) -> List[Tuple[int, str]]:
    """The sentences of a text, each with the offset of its first character."""
    sentences: List[Tuple[int, str]] = []
    start = 0
    for found in SENTENCE_END.finditer(text):
        if found.start() < start or not _ends_sentence(text, found):
            continue
        _append_sentence(sentences, text, start, found.end(2))
        start = found.end()
    _append_sentence(sentences, text, start, len(text))
    return sentences


def _append_sentence(sentences: List[Tuple[int, str]], text: str, start: int, end: int) -> None:
    piece = text[start:end]
    if piece.strip():
        sentences.append((start + len(piece) - len(piece.lstrip()), piece.strip()))


def words(text: str) -> List[str]:
    """The words of a text. A stand-in is a word; a token with no letter or digit is not."""
    return [token for token in text.split() if SPAN in token or PAREN in token or any(c.isalnum() for c in token)]


def detect_language(prose: str) -> str:
    tokens = re.findall(r"[^\W\d_]+", prose.lower())
    if not tokens:
        return "other"
    latin = sum(1 for token in tokens if ord(token[0]) < 0x250)
    if latin * 2 < len(tokens):
        return "other"
    common = sum(1 for token in tokens if token in ENGLISH_COMMON)
    return "en" if common * 12 >= len(tokens) else "other"


def looks_like_instruction(sentence: str, ordered: bool, english: bool) -> bool:
    if ordered:
        return True
    tokens = re.findall(r"[^\W\d_]+(?:['’][^\W\d_]+)?|,", sentence)
    if not tokens:
        return False

    def is_command(position: int) -> bool:
        if position >= len(tokens):
            return False
        lowered = tokens[position].lower()
        if lowered in (BEFORE_A_COMMAND if english else BEFORE_A_COMMAND_UK):
            return is_command(position + 1)
        return lowered in COMMANDS if english else bool(COMMAND_SUFFIX.search(lowered))

    if is_command(0):
        return True
    first = tokens[0].lower()
    opens_with_condition = first in CONDITION if english else first in ("якщо", "коли", "після", "перед", "щоб")
    if opens_with_condition and "," in tokens:
        return is_command(tokens.index(",") + 1)
    return False


def excerpt(sentence: str) -> str:
    shown = sentence.replace(SPAN, "`…`").replace(PAREN, "(…)").split()
    return '"' + " ".join(shown[:9]) + ("…" if len(shown) > 9 else "") + '"'


def _verb_notes(sentence: str, strict: bool) -> List[str]:
    notes: List[str] = []
    seen: List[Tuple[int, int]] = []

    def add(found: "re.Match[str]", label: str, word: str, excluded: frozenset) -> None:
        if word.lower() in excluded or word.isupper():  # a word in capitals is a label, not a verb form
            return
        if any(found.start() < end and start < found.end() for start, end in seen):
            return
        seen.append((found.start(), found.end()))
        notes.append(f'{label} "{" ".join(found.group(0).split())}"')

    for found in PASSIVE_WITH_MODAL.finditer(sentence):
        add(found, "passive", found.group(1), NOT_A_PARTICIPLE)
    for found in PASSIVE_WITH_AGENT.finditer(sentence):
        add(found, "passive", found.group(1), NOT_A_PARTICIPLE)
    for found in PERFECT.finditer(sentence):
        add(found, "perfect", found.group(1), NOT_A_PARTICIPLE)
    for found in PROGRESSIVE.finditer(sentence):
        add(found, "progressive", found.group(1), NOT_A_VERB_FORM)
    for found in ING_AFTER_PREPOSITION.finditer(sentence):
        add(found, '"-ing" form after a preposition', found.group(1), NOT_A_VERB_FORM)
    if strict:
        for found in ING_FORM.finditer(sentence):
            add(found, '"-ing" form (strict: only in a technical name)', found.group(1), NOT_A_VERB_FORM)
    return notes


def _word_notes(sentence: str, strict: bool) -> List[str]:
    tables = PLAIN_WORDS + (STRICT_WORDS if strict else ())
    notes: List[str] = []
    for pattern, instead in tables:
        found = re.search(pattern, sentence, re.IGNORECASE)
        if found:
            notes.append(f'"{" ".join(found.group(0).split())}": write {instead}')
    return notes


def check(text: str, profile: str, procedure: bool, lang: str) -> Tuple[str, List[Finding]]:
    """The first line of the report and the findings of a text."""
    blocks = read_blocks(text)
    cleaned = [inline(block.text) for block in blocks]
    language = detect_language(" ".join(cleaned)) if lang == "auto" else lang
    english = language == "en"
    wording = english and profile in ("standard", "strict")
    strict = profile == "strict"
    limit = INSTRUCTION_WORDS if procedure else DESCRIPTION_WORDS
    findings: List[Finding] = []
    sentence_total = 0

    def measure(line: int, sentence: str, ordered: bool, in_parentheses: bool) -> None:
        count = len(words(sentence))
        where = "text in parentheses" if in_parentheses else "sentence"
        if count > limit:
            other = "" if procedure else f", or {INSTRUCTION_WORDS} for an instruction"
            findings.append(Finding(line, True, f"long {where}, {count} words (the limit is {limit}{other}): {excerpt(sentence)}"))
        elif count > INSTRUCTION_WORDS and looks_like_instruction(sentence, ordered, english):
            findings.append(Finding(
                line, False,
                f"{count} words (the limit is {INSTRUCTION_WORDS} if this {where} gives an instruction): {excerpt(sentence)}",
            ))
        if ";" in sentence:
            findings.append(Finding(line, True, f"semicolon: {excerpt(sentence)}"))
        if not wording:
            return
        for found in CONTRACTION.finditer(sentence):
            findings.append(Finding(line, True, f'contraction "{found.group(0)}": {excerpt(sentence)}'))
        for note in _verb_notes(sentence, strict) + _word_notes(sentence, strict):
            findings.append(Finding(line, False, f"{note}: {excerpt(sentence)}"))

    for block, body in zip(blocks, cleaned):
        source_lines = body.split("\n")
        if len(source_lines) > 1 and all(KEY_VALUE.match(source_line) for source_line in source_lines):
            for offset, source_line in enumerate(source_lines):
                if ";" in source_line:
                    findings.append(Finding(block.line + offset, True, f"semicolon: {excerpt(source_line)}"))
            continue
        body, lifted = lift_parentheses(lift_quotations(body), block.line)
        sentences = split_sentences(body)
        sentence_total += len(sentences)
        if len(sentences) > PARAGRAPH_SENTENCES:
            what = "list item" if block.item else "paragraph"
            findings.append(Finding(
                block.line, True,
                f"long {what}, {len(sentences)} sentences (the limit is {PARAGRAPH_SENTENCES}): {excerpt(sentences[0][1])}",
            ))
        for offset, sentence in sentences:
            measure(block.line + body[:offset].count("\n"), sentence, block.ordered, False)
        for line, inner in lifted:
            for _, sentence in split_sentences(inner):
                measure(line, sentence, False, True)

    name = "English" if english else "not English (the limits only)"
    totals = (
        _counted(sentence_total, "sentence"),
        _counted(sum(1 for block in blocks if not block.item), "paragraph"),
        _counted(sum(len(words(body)) for body in cleaned), "word"),
    )
    head = f"ste-check: {profile} profile, {name}, {', '.join(totals)}"
    return head, sorted(findings, key=lambda finding: finding.line)


def _counted(count: int, noun: str) -> str:
    return f"{count} {noun}" + ("" if count == 1 else "s")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ste_check.py",
        description="Measure a text against the countable limits of Simplified Technical English.",
    )
    parser.add_argument("file", nargs="?", help="Markdown or plain text; standard input when absent")
    parser.add_argument("--profile", choices=("light", "standard", "strict"), default="standard")
    parser.add_argument("--procedure", action="store_true", help="every sentence is an instruction: 20 words")
    parser.add_argument("--lang", choices=("auto", "en", "other"), default="auto")
    parser.add_argument("--gate", action="store_true", help="exit with status 1 when a line says fix")
    args = parser.parse_args(argv)

    try:
        if args.file:
            text = Path(args.file).read_text(encoding="utf-8")
        elif sys.stdin.isatty():
            parser.error("no FILE given and nothing on standard input")
        else:
            text = sys.stdin.buffer.read().decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        print(f"ste_check.py: {error}", file=sys.stderr)
        return 2

    head, findings = check(text, args.profile, args.procedure, args.lang)
    lines = [head]
    for finding in findings:
        lines.append(f"{'fix   ' if finding.fix else 'review'}  line {finding.line}: {finding.text}")
    to_fix = sum(1 for finding in findings if finding.fix)
    to_review = len(findings) - to_fix
    if not findings:
        lines.append("result: inside the limits")
    else:
        lines.append(f"result: {to_fix or 'nothing'} to fix, {to_review or 'nothing'} to review")
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    return 1 if to_fix and args.gate else 0


if __name__ == "__main__":
    sys.exit(main())
