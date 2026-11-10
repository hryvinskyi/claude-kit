"""credential_filter — whether a file about to be committed to a vault looks like it carries a credential.

A file is held for its name, or for what a commit would add to it. Each answer is a reason class a
person can act on (`named like a credentials file`, `looks like an access token`, …) and never the
value: what this module returns may be printed and logged.

The shapes are the common ones, chosen so that ordinary prose passes: a note that discusses token
formats in words, shows a token truncated (`ghp_…`), or names a placeholder (`<your token>`,
`${DB_PASSWORD}`, `changeme`) is not held. A value pattern never starts inside a word, so `sk-` does
not match the end of `task-`.
"""
from __future__ import annotations

import os
import re
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
# anywhere in it, a `$reference`, a format directive, or a word saying so. Matched against the whole
# value, case aside.
PLACEHOLDER = re.compile(
    r"\*+|.*\*\*\*.*|.*(?:\.\.\.|…).*|.*<[^>]*>.*|.*\{[^}]*\}.*|<.*|\{.*|\[.*|\$.*|%.*|.*%(?:\([^)]*\))?s.*"
    r"|.*redacted.*|.*change[_-]?me.*|.*example.*|.*placeholder.*|your[_-].*|xxx.*",
    re.I | re.S)
# A value that reads as a word or a sentence in lower case, a number, an identifier in camel or Pascal
# case, a dotted name, code (a call, `->`, `::`), or the name of an environment variable: what prose
# and code put after `password:` when they hold none.
NOT_A_SECRET = re.compile(
    r"[a-z _-]+|\d+|[a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+"
    r"|.*(?:\(|->|::).*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+")
SHORTEST = 8


def stands_in(value: str) -> bool:
    """Whether a value as written stands in for a secret rather than being one.

    Quotes around it aside; a sentence's closing punctuation is dropped only after the placeholder
    check, so a trailing ellipsis still marks one.
    """
    quoted = value.strip().strip("'\"`").strip()
    if PLACEHOLDER.fullmatch(quoted) is not None:
        return True
    bare = quoted.rstrip(".,:;!?)")
    return len(bare) < SHORTEST or NOT_A_SECRET.fullmatch(bare) is not None


def token_stands_in(token: str) -> bool:
    """Whether a token-shaped match is a documented sample or a mask: it says so, or repeats a few characters."""
    lowered = token.lower()
    if "example" in lowered or "xxxx" in lowered or "redacted" in lowered:
        return True
    body = re.sub(r"^[A-Za-z]+[_-]", "", token)
    return len(set(body)) <= 3


TOKENS = (
    (re.compile(r"(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])"), ACCESS_TOKEN),
    (re.compile(r"(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}"), ACCESS_TOKEN),
    (re.compile(r"(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}"), ACCESS_TOKEN),
    (re.compile(r"(?<![A-Za-z0-9_-])xox[abpr]-[A-Za-z0-9-]{10,}"), ACCESS_TOKEN),
    (re.compile(r"(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{16,}"), ACCESS_TOKEN),
    (re.compile(r"(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}"), ACCESS_TOKEN),
    (re.compile(r"(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Za-z])"), ACCESS_KEY),
    (re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), SIGNED_TOKEN),
)
BEARER_HEADER = re.compile(r"\bauthorization\s*[:=]\s*[\"']?bearer\s+(?P<value>[^\s\"']{20,})", re.I)
# A scheme starts where no scheme character precedes it; the user may be empty, as a password-only URI has it.
URI = re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*://[^\s:/@]*:(?P<value>[^\s@/]+)@")
# `KEY=value`, `key: value`, `"key": "value"`, and the key bold or in backticks as a note writes it. The
# value is read ahead without being consumed, so the next key on the line — a query string's — is found too.
ASSIGNMENT = re.compile(
    r"(?<![A-Za-z0-9_.-])[\"'`*]*(?P<key>[A-Za-z_][A-Za-z0-9_.-]*)[\"'`*]*\s*[:=](?![:=])\s*[*`]*\s*"
    r"(?=(?P<value>\"[^\"]*\"|'[^']*'|[^\s\"'`,;&]+))")
SECRET_WORDS = ("password", "passwd", "passphrase", "secret", "token", "apikey", "api_key", "api-key",
                "privatekey", "private_key", "private-key", "accesskey", "access_key", "access-key")
SECRET_SEGMENTS = frozenset({"pass"})
KEY_SEGMENT = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")
PRIVATE_KEY_BEGIN = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")
KEY_BODY = re.compile(r"[A-Za-z0-9+/=]{40,}")
INLINE_KEY_BODY = re.compile(r"(?:\\r|\\n|\s)+[A-Za-z0-9+/]{40,}")


def secret_named(key: str) -> bool:
    """Whether an assignment's key names a secret: it contains a secret word, or `pass` is one of its words."""
    lowered = key.lower()
    if any(word in lowered for word in SECRET_WORDS):
        return True
    return any(segment.lower() in SECRET_SEGMENTS for segment in KEY_SEGMENT.findall(key))


def private_key(lines: list[str], at: int, match: "re.Match[str]") -> bool:
    """Whether a private-key header opens a key: base64 follows it, on its line or within the next few."""
    if INLINE_KEY_BODY.match(lines[at], match.end()):
        return True
    return any(KEY_BODY.fullmatch(line.strip()) for line in lines[at + 1:at + 5])


def line_reason(line: str) -> Optional[str]:
    """Why one added line looks like it carries a credential; None when it does not."""
    for pattern, reason in TOKENS:
        if any(not token_stands_in(m.group(0)) for m in pattern.finditer(line)):
            return reason
    if any(not stands_in(m.group("value")) for m in BEARER_HEADER.finditer(line)):
        return BEARER
    if any(not stands_in(m.group("value")) for m in URI.finditer(line)):
        return URI_PASSWORD
    for m in ASSIGNMENT.finditer(line):
        if secret_named(m.group("key")) and not stands_in(m.group("value")):
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
