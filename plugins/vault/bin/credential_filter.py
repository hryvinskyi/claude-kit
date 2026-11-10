"""credential_filter — whether a file about to be committed to a vault looks like it carries a credential.

A file is held for its name, or for what a commit would add to it. Each answer is a reason class a
person can act on (`named like a credentials file`, `looks like an access token`, …) and never the
value: what this module returns may be printed and logged.

The shapes are the common ones, chosen so that ordinary prose passes: a note that discusses token
formats in words, shows a token truncated (`ghp_…`), or names a placeholder (`<your token>`,
`${DB_PASSWORD}`, `changeme`) is not held. A value pattern never starts inside a word, so `sk-` does
not match the end of `task-`; a key counts only where a key stands — at the start of a line, in code,
or as the last word of a label (`staging db password:`) — so `the same pass: docs/x.png` is prose; and a
value of words is a phrase, while words with a digit or a symbol among them are a passphrase.
"""
from __future__ import annotations

import base64
import math
import os
import re
from collections import Counter
from typing import Callable, Iterable, Optional

NAMED_LIKE_CREDENTIALS = "named like a credentials file"
PRIVATE_KEY = "looks like a private key"
ACCESS_TOKEN = "looks like an access token"
ACCESS_KEY = "looks like a cloud access key"
SIGNED_TOKEN = "looks like a signed token (JWT)"
BEARER = "looks like a bearer token"
URI_PASSWORD = "looks like a password inside a URI"
ASSIGNED_SECRET = "looks like a secret assigned to a value"

# --- by name ------------------------------------------------------------------

ENV_TEMPLATES = frozenset({".env.example", ".env.dist", ".env.sample", ".env.template"})
KEY_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx")
KEY_PAIRS = re.compile(r"id_(?:rsa|ed25519|ecdsa|dsa)")
EXACT_NAMES = frozenset({".netrc", ".pgpass", "credentials.json"})


def named_like_credentials(path: str) -> bool:
    """Whether a file's base name alone says it holds a credential.

    An environment file is, its committed templates are not; a key pair's private half is, its
    `.pub` is not. A name containing `secret` is, except a Markdown note, whose title may only
    discuss one and whose lines are read like any other file's.
    """
    name = os.path.basename(path).lower()
    if name == ".env" or (name.startswith(".env.") and name not in ENV_TEMPLATES):
        return True
    if name.endswith(KEY_SUFFIXES) or name in EXACT_NAMES:
        return True
    if KEY_PAIRS.match(name) and not name.endswith(".pub"):
        return True
    return "secret" in name and not name.endswith(".md")


# --- by value -----------------------------------------------------------------

# What stands in for a value rather than being one: a mask, an ellipsis, a `<slot>` or `{template}`
# anywhere in it, a whole-value reference (`%NAME%`, `[a slot]`, a `[[wikilink]]` to a note; `$NAME` is
# `REFERENCE`), a format directive, or a word saying so. Matched against the whole value, case aside; a literal that merely
# starts with `$`, `%` or `[` is no reference.
PLACEHOLDER = re.compile(
    r"\*+|.*\*\*\*.*|.*(?:\.\.\.|…).*|.*<[^>]*>.*|.*\{[^}]*\}.*|<.*|\{.*"
    r"|%[A-Za-z_]\w*%|\[[\w .-]*\]|\[\[[^\[\]]+\]\]|.*%(?:\([^)]*\))?s.*"
    r"|.*redacted.*|.*change[_-]?me.*|.*example.*|.*placeholder.*|your[_-].*|xxx.*",
    re.I | re.S)
# A value that reads as a word or a sentence in lower case or capitalised, a number, an identifier in
# camel or Pascal case, a dotted name, code (a call, `->`, `::`), the name of an environment variable,
# or an absolute or home-relative path: what prose and code put after `password:` when they hold none.
NOT_A_SECRET = re.compile(
    r"[A-Z]?[a-z _-]+|\d+|[a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+"
    r"|.*(?:\(|->|::).*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|(?:~|\.{1,2})?/[\w./-]*")
SHORTEST = 8
# `$NAME`, or `$NAME/a/path`: a variable whose name reads as one — an environment variable's, a word,
# an identifier.
REFERENCE = re.compile(r"\$(?P<name>[A-Za-z_]\w*)(?:/[\w./-]*)?")
ENVIRONMENT_NAME = re.compile(r"[A-Z_][A-Z0-9_]*")
# Generated key material: long, unbroken, letters and digits mixed in among each other, and varied
# enough to be no word; a slug of words and a date, or a UUID, is an identifier.
KEY_MATERIAL = re.compile(r"[A-Za-z0-9+/=_.~-]{20,}")
KEY_MATERIAL_BITS = 3.0
KEY_MATERIAL_MIXES = 3
LETTER_BESIDE_DIGIT = re.compile(r"(?=[A-Za-z]\d|\d[A-Za-z])")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
# Words in any script, joined by spaces and the punctuation a sentence uses; no digit, no symbol.
PHRASE = re.compile(r"[^\W\d_]+(?:[\s.,:;!?()'’\"-]+[^\W\d_]+)*[.,:;!?)'’\"]*")


def stands_in(value: str) -> bool:
    """Whether a value as written stands in for a secret rather than being one.

    Quotes around it aside; a value of words — letters, spaces and a sentence's punctuation — is a
    phrase, never a secret, while one that holds a digit or a symbol among its words is a passphrase.
    A sentence's closing punctuation is dropped only after the placeholder check, so a trailing
    ellipsis still marks one.
    """
    quoted = value.strip().strip("'\"`").strip()
    if PLACEHOLDER.fullmatch(quoted) is not None:
        return True
    if re.search(r"\s", quoted):
        return PHRASE.fullmatch(quoted) is not None or NOT_A_SECRET.fullmatch(quoted) is not None
    reference = REFERENCE.fullmatch(quoted)
    if reference is not None:
        name = reference.group("name")
        return ENVIRONMENT_NAME.fullmatch(name) is not None or NOT_A_SECRET.fullmatch(name) is not None
    bare = quoted.rstrip(".,:;!?)")
    return len(bare) < SHORTEST or NOT_A_SECRET.fullmatch(bare) is not None


def key_material(value: str) -> bool:
    """Whether a value reads as generated key material rather than a name, a path or a word."""
    bare = value.strip().strip("'\"`").rstrip(".,:;!?)")
    if stands_in(bare) or KEY_MATERIAL.fullmatch(bare) is None or UUID.fullmatch(bare) is not None:
        return False
    if len(LETTER_BESIDE_DIGIT.findall(bare)) < KEY_MATERIAL_MIXES:
        return False
    bits = -sum(n / len(bare) * math.log2(n / len(bare)) for n in Counter(bare).values())
    return bits >= KEY_MATERIAL_BITS


def token_stands_in(token: str) -> bool:
    """Whether a token-shaped match is a documented sample or a mask: it says so, or repeats a few characters."""
    lowered = token.lower()
    if "example" in lowered or "xxxx" in lowered or "redacted" in lowered:
        return True
    body = re.sub(r"^[A-Za-z]+[_-]", "", token)
    return len(set(body)) <= 3


def live(token: str) -> bool:
    """Whether a token-shaped match is a real value."""
    return not token_stands_in(token)


def generated(token: str) -> bool:
    """Whether a match of a loose shape is a real value: one that mixes in digits, as a slug of words does not."""
    return live(token) and re.search(r"\d", token) is not None


PUBLIC_PEM = re.compile(r"CERTIFICATE|PUBLIC")


def private_pem(encoded: str) -> bool:
    """Whether a base64-encoded PEM block is a private one; a certificate or a public key is not."""
    head = encoded[:len(encoded) // 4 * 4]
    try:
        decoded = base64.b64decode(head).decode("ascii", "replace")
    except ValueError:
        return True
    return live(encoded) and PUBLIC_PEM.search(decoded.split("\n", 1)[0]) is None


# Each shape, the reason it is held for, and what tells a real value from a sample of the shape.
TOKENS = (
    (re.compile(r"(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_-])xox[abpr]-[A-Za-z0-9-]{10,}"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{16,}"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}"), ACCESS_TOKEN, generated),
    (re.compile(r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])"), ACCESS_TOKEN, live),
    (re.compile(r"(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Za-z])"), ACCESS_KEY, live),
    (re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), SIGNED_TOKEN,
     live),
    (re.compile(r"(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/=]{20,}"), PRIVATE_KEY, private_pem),
)
BEARER_HEADER = re.compile(r"\bauthorization\s*[:=]\s*[\"']?bearer\s+(?P<value>[^\s\"']{20,})", re.I)
# A scheme starts where no scheme character precedes it; the user may be empty, as a password-only URI has it.
URI = re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*://[^\s:/@]*:(?P<value>[^\s@/]+)@")

KEY = r"(?P<key>[A-Za-z_][A-Za-z0-9_.-]*)"
# The operator, with whatever closes the key (a quote, a backtick, bold, a bracket) before it and opens
# the value after it.
OPERATOR = r"[\"'`*\]]*[ \t]*(?:=>|[:=](?![:=]))[ \t]*[*`]*[ \t]*"
# The value is read ahead without being consumed, so the next key on the line — a query string's — is found too.
VALUE = r"(?=(?P<value>\"[^\"]*\"|'[^']*'|[^\s\"'`,;&]+))"
# `key: value`, `KEY=value`, `"key": "value"`, `'key' => 'value'`, `--key=value`, and the key bold or
# in backticks as a note writes it. A key is one word standing where a key stands: at the start of the
# line (after a list, quote or heading marker, or `export`), after a bracket or a separator, as a
# query-string parameter, as a command-line flag, or opened by a quote, a backtick, bold or `$`. A word
# in the middle of a sentence followed by a colon is prose.
ASSIGNMENT = re.compile(
    r"(?:^[ \t]*(?:(?:[-*+>]|\d+[.)]|#{1,6})[ \t]+)*(?:export[ \t]+)?|[(\[{,;|][ \t]*|[?&]|(?:^|(?<=\s))--?"
    r"|(?<=\s)(?=[\"'`*$])|(?<=[\"'`]))[\"'`*$]*" + KEY + OPERATOR + VALUE)
# `KEY=value` anywhere a word may stand, the `=` hugged on both sides as only code and shells write it.
INLINE = re.compile(r"(?<=\s)" + KEY + r"=(?![=>])" + VALUE)
# `--key value`: a flag whose value follows it as the next word.
FLAG = re.compile(r"(?:^|(?<=\s))--?" + KEY + r"[ \t]+(?!-)" + VALUE)
# A label ending in the word `key` — `deploy key:`, `API key =` — set to a value.
KEY_LABEL = re.compile(r"(?<=\s)[Kk][Ee][Yy]" + OPERATOR + VALUE)
# A label ending in a secret word — `staging db password:`, `**Admin password**:`, `GitHub token =` —
# set to a value, as a note writes a credential down.
SECRET_LABEL = re.compile(r"(?<=\s)(?P<key>password|passwd|passphrase|secret|token)" + OPERATOR + VALUE, re.I)
# A label ending in `pass` — `SSH pass:` — is a credential only where its value closes the line or a
# list of fields; `the first pass: <name> was …` is a sentence about a pass.
PASS_LABEL = re.compile(r"(?<=\s)(?P<key>pass)" + OPERATOR + VALUE
                        + r"(?:\"[^\"]*\"|'[^']*'|[^\s\"'`,;&]+(?![^\s\"'`,;&]))[`*]*[ \t]*(?:$|[,;|/(])", re.I)

SECRET_WORDS = ("password", "passwd", "passphrase", "secret", "token", "apikey", "api_key", "api-key",
                "privatekey", "private_key", "private-key", "accesskey", "access_key", "access-key")
JOINED_PASS = re.compile(r"(?:^|_)pass(?:_|$)")
CAMEL_PASS = re.compile(r"[a-z0-9]Pass$")
KEY_SEGMENT = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")
NAMES_A_SECRET = "secret"
NAMES_A_KEY = "key"
PRIVATE_KEY_BEGIN = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")
KEY_BODY = re.compile(r"[A-Za-z0-9+/=]{40,}")
INLINE_KEY_BODY = re.compile(r"(?:\\r|\\n|\s)+[A-Za-z0-9+/]{40,}")


def names(key: str) -> Optional[str]:
    """What an assignment's key names: a secret, a key, or neither.

    A secret is named by a secret word anywhere in the key, or by `pass` as the whole key, joined by
    `_`, or closing a camel-case key (`DB_PASS`, `pass_word`, `smtpPass`). A key is named by a last
    word `key`, or `key` followed by `data` (`SIGNING_KEY`, `deploy-key`, `client-key-data`), unless
    the key is a public one; since a key is also an index or a column, only generated key material
    counts as one set to a value.
    """
    lowered = key.lower()
    if any(word in lowered for word in SECRET_WORDS):
        return NAMES_A_SECRET
    if JOINED_PASS.search(lowered) or CAMEL_PASS.search(key):
        return NAMES_A_SECRET
    segments = [segment.lower() for segment in KEY_SEGMENT.findall(key)]
    if "public" in segments:
        return None
    if segments[-1:] == ["key"] or segments[-2:] == ["key", "data"]:
        return NAMES_A_KEY
    return None


def assigned_secret(key: Optional[str], value: str) -> bool:
    """Whether a key set to a value holds a credential: a secret not stood in for, or key material."""
    named = NAMES_A_KEY if key is None else names(key)
    if named == NAMES_A_SECRET:
        return not stands_in(value)
    return named == NAMES_A_KEY and key_material(value)


def private_key(lines: list[str], at: int, match: "re.Match[str]") -> bool:
    """Whether a private-key header opens a key: base64 follows it, on its line or within the next few."""
    if INLINE_KEY_BODY.match(lines[at], match.end()):
        return True
    return any(KEY_BODY.fullmatch(line.strip()) for line in lines[at + 1:at + 5])


def line_reason(line: str) -> Optional[str]:
    """Why one added line looks like it carries a credential; None when it does not."""
    for pattern, reason, real in TOKENS:
        if any(real(m.group(0)) for m in pattern.finditer(line)):
            return reason
    if any(not stands_in(m.group("value")) for m in BEARER_HEADER.finditer(line)):
        return BEARER
    if any(not stands_in(m.group("value")) for m in URI.finditer(line)):
        return URI_PASSWORD
    for pattern in (ASSIGNMENT, INLINE, FLAG, SECRET_LABEL, PASS_LABEL):
        if any(assigned_secret(m.group("key"), m.group("value")) for m in pattern.finditer(line)):
            return ASSIGNED_SECRET
    if any(assigned_secret(None, m.group("value")) for m in KEY_LABEL.finditer(line)):
        return ASSIGNED_SECRET
    return None


def content_reason(lines: list[str]) -> Optional[str]:
    """Why the lines a commit would add look like they carry a credential; None when they do not."""
    for at, line in enumerate(lines):
        header = PRIVATE_KEY_BEGIN.search(line)
        if header and private_key(lines, at, header):
            return PRIVATE_KEY
        reason = line_reason(line)
        if reason is not None:
            return reason
    return None


def why_held(path: str, added: Callable[[], Optional[Iterable[str]]]) -> Optional[str]:
    """Why a file may not be committed, or None when it may.

    `added` yields what the commit would add to the file, read only when the name has not already
    decided; None from it means the lines could not be read, which never counts as clean.
    """
    if named_like_credentials(path):
        return NAMED_LIKE_CREDENTIALS
    lines = added()
    if lines is None:
        return "could not be read"
    return content_reason(list(lines))
