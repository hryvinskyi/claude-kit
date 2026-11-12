"""decide.py — ask a decision model typed questions about a change, and read its answers as verdicts.

Usage:
    pipeline-decide status                                       # is it on, where, which kinds, the key
    pipeline-decide questions size                               # the sizing questions and their rule
    pipeline-decide size --state FILE                            # S, M or L for the change FILE describes
    pipeline-decide rules --diff FILE --rules FILE [--rules F]   # the review files' items over the diff
    pipeline-decide done --claims FILE --evidence FILE [...]     # a report's claims over the evidence

The model is any endpoint that serves the systemone API, `POST <base>/v1/systemone`: a hosted one such
as https://jev-ai.pro/api, or one on this machine. Nothing is sent anywhere until
CLAUDE_KIT_DECISION_URL names the base, so a project turns it off by setting it empty in its own
settings. CLAUDE_KIT_DECISION_KINDS limits what may be asked (size, rules, done; all when unset, none
when empty). CLAUDE_KIT_DECISION_MODEL picks the model, jev-latest by default.

The key lives in ~/.claude/secrets/decision-model.env (or the file CLAUDE_KIT_DECISION_KEY_FILE names),
readable by its owner alone, as DECISION_MODEL_API_KEY beside DECISION_MODEL_URL, the base the key
belongs to. It is sent only to that base — same scheme, host and port — so a base named by anyone
else, a project's settings included, never receives it. It travels in the Authorization header alone
and is never printed. A plain-HTTP base must be this machine, and is reached without any proxy; a
redirect is never followed.

What each kind sends: size, the state file; rules, the diff and the "Always check" items of the review
files; done, the claims and the evidence files. The claims file is a JSON list of claim texts, or an
object of id to a claim text or to {"claim": text, "evidence": [files]}: a claim that names its files is
asked over those alone, and one that names none over the --evidence files alone, so a red test run kept
as evidence for one claim never counts against another. Before anything is sent, a diff loses the files whose
name or content looks like a credential (a key file, an env or auth file, a database dump, a private
key block), and every text sent but the items written in the review files themselves has the values of
secret-looking lines withheld, each to its end (a password, secret, token or key — `APP_KEY`, not `key`
alone — given by assignment, by a setter such as define(), as an XML element or attribute, or as a
command's -u user:password; an Authorization, Cookie or API-key header and a bearer credential; the
userinfo of a URI; a private key block; a known token shape). A value that goes on over the next lines is
withheld there too: a YAML block scalar or nested map, a triple-quoted or unclosed string (for at most
64 lines), a list or an object, whose scalars are withheld to its closing bracket — its keys, and a value
whose key points at the secret (`"env": "DIBS_TOKEN"`), are kept. A review file's line holding only
`@name` includes a Markdown file of that name from its own directory — no path, no link out of it, no
name that looks like a credential, no private key inside — and its text goes through the same filter;
an include that is refused is named under "refused" and not sent. The answer counts what was dropped,
refused and withheld. The filter is a net, not a guarantee: what is not meant to leave the machine does
not go into a state, claims or evidence file.

Answers print as JSON on standard output. A probability of YES or more counts as yes, NO or less as no,
anything between — or no readable answer — as uncertain: the session settles an uncertain answer by
reading the code.

A run is bounded: one request waits at most CLAUDE_KIT_DECISION_TIMEOUT seconds for its whole answer (60),
the run at most CLAUDE_KIT_DECISION_BUDGET seconds from its start (300), and it makes at most
CLAUDE_KIT_DECISION_MAX_REQUESTS requests (40) of at most CLAUDE_KIT_DECISION_MAX_BYTES request-body bytes
in all (4000000). Each must be a positive number. A large input is asked batch by batch over every part —
the first batch of questions over all the parts before the second — so a bound that stops the run leaves
the fewest questions half asked. When the next request would pass a bound, or a request waits past its
time, nothing more is sent: "stopped" names the bound, and every question not asked over all its parts
answers "not_asked" unless an asked part already found it violated, contradicted or uncertain. Such a run
still exits 0; "requests", "bytes" and "planned" say what was sent and what the whole run would have sent.

Exit status: 0 answered, in whole or up to a bound; 3 off (no endpoint, or the kind is left out), nothing
sent; 4 the endpoint failed or answered something unreadable; 2 the input or the configuration is unusable.
"""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

YES = 0.85
NO = 0.15
DEFAULT_MODEL = "jev-latest"
# The bounds of one run: seconds one request waits for its whole answer, seconds the run takes from its
# start, requests it makes, and request-body bytes it sends.
TIMEOUT = 60
BUDGET = 300
MAX_REQUESTS = 40
MAX_BYTES = 4_000_000
# The API takes a body of 256000 bytes, and a state with its longest question must fit the model's
# context of 32k tokens; a state is held to an estimate of 20000 tokens, counted generously for text
# that is not ASCII.
STATE_TOKENS = 20_000
LINE_CHARS = 4_000
VALUE_CHARS = 1_024
STRING_LINES = 64
BODY_BYTES = 240_000
MAX_QUESTIONS = 64
KINDS = ("size", "rules", "done")
LEVELS = ("S", "M", "L")

# id, the level a yes raises the change to, the question.
SIZE_QUESTIONS: Tuple[Tuple[str, str, str], ...] = (
    ("seam", "L", "Does the change create or change a seam: an interface or port, a class or API another module "
                  "calls, a published contract, event or message, a service registration other code resolves, or "
                  "wiring between modules?"),
    ("state", "L", "Does the change touch persisted state or what a stored value means: an entity, a schema or "
                   "migration, a column, or a new flag, enum case, nullable or default that other code reads?"),
    ("risky", "L", "Is the change on a security or otherwise risky path: authentication, sessions, permissions, "
                   "tenancy, money, personal data, uploads, execution of input, cryptography or tokens, outbound "
                   "requests to a host taken from input, HTML or mail that prints user text, concurrency, retries "
                   "or idempotency?"),
    ("modules", "L", "Does the change span more than one module or package?"),
    ("open", "M", "Does the request leave a design decision open: a choice between approaches, where the code goes, "
                  "or a rule nobody has stated yet?"),
    ("logic", "M", "Does the change add or alter program logic (a branch, a state, a query, a computation) beyond "
                   "a small change of about thirty lines in at most three production files?"),
)
SIZE_RULE = "The level is the highest level among the questions answered yes, S when none is."

RULE_CRITERIA = {
    "violates": "The diff contains a line that breaks this rule.",
    "complies": "The diff touches what the rule is about and follows it.",
    "not_shown": "The diff does not show enough to judge this rule, or the rule is not about what it changes.",
}
CLAIM_CRITERIA = {
    "supported": "The evidence shows what the claim says.",
    "contradicted": "The evidence shows something the claim denies.",
    "not_shown": "The evidence does not address the claim.",
}

CREDENTIAL_PATH = re.compile(
    r"(^|/)("
    r"\.env(\.[^/]*)?|[^/]*\.env|\.envrc|env\.php|auth\.json|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.my\.cnf"
    r"|\.git-credentials|\.htpasswd|credentials(\.[^/]*)?|secrets?\.(ya?ml|json|php|toml|ini)"
    r"|id_(rsa|dsa|ecdsa|ed25519)[^/]*|authorized_keys|known_hosts|kubeconfig"
    r"|[^/]*\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|tfstate|tfvars|dump)(\.(gz|bz2|xz|zst|backup))?"
    r"|[^/]*(dump|backup)[^/]*\.sql(\.(gz|bz2|xz|zst))?"
    r")$"
    r"|(^|/)(secrets?|\.ssh|\.kube|\.docker|\.aws|\.gnupg)/")
KEY_BLOCK_BEGIN = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----")
KEY_BLOCK_END = re.compile(r"-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----")
TOKEN_SHAPES = re.compile(
    r"(?<![A-Za-z0-9_-])(?:(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}"
    r"|glpat-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|[sr]k_(?:live|test)_[A-Za-z0-9]{8,}"
    r"|sk-[A-Za-z0-9_-]{20,}|sk_[a-z0-9-]+_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}"
    r"|pypi-[A-Za-z0-9_-]{30,}|whsec_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})")
# The words that make a name a secret's name. `pass` and `key` are one only as a whole part that ends the
# name, never inside a word (`passed`, `bypass`, `monkey`); `secret_name` and `weak_pass` decide that.
SECRET_WORDS = (r"password|passwd|passphrase|pwd|pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key"
                r"|auth[_-]?key|credentials?|key")
STRONG_SECRET_WORDS = re.compile(r"(?i)password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key"
                                 r"|private[_-]?key|auth[_-]?key|credential")
NAME_PARTS = re.compile(r"[_.\-]+|(?<=[a-z0-9])(?=[A-Z])")
# `key` after a separator (`APP_KEY`, `encryption.key`, `signing-key`), not `signingKey`, `monkey`, or `key`
# alone, which names a map's or a loop's key far more often than a secret.
KEY_NAME = re.compile(r"(?i)[_.-]key$")
# A last part that makes the name about a secret rather than the secret: where it lives or comes from, what it
# is called, how long it lasts (`SECRET_KEY_FILE`, `TOKEN_URL`, `tokenEnv`, `TOKEN_SOURCE`, `ACCESS_KEY_ID`,
# `TOKEN_TTL`; inside an object, `"from": "env"`).
POINTER_PARTS = frozenset(("path", "file", "dir", "url", "uri", "env", "source", "from", "name", "type", "id",
                           "length", "ttl", "field", "header", "label"))
# A part before `key` that makes it a key of a table, a cache or a published pair, never a secret.
PUBLIC_KEY_PARTS = frozenset(("public", "primary", "foreign", "cache", "sort", "partition", "route", "lookup",
                              "idempotency", "unique", "composite", "row", "map", "translation", "i18n", "storage",
                              "index", "lock", "dedupe", "item", "object", "column", "message"))
VERSION = re.compile(
    r"(?i)[\^~]?(?:[<>]=?|=)?[ \t]*v?\d+\.\d+(?:\.\d+)?(?:-(?:alpha|beta|rc|dev|pre|preview|snapshot)(?:[.-]?\d+)*)?"
    r"(?:\+(?:build[.-]?)?\d+(?:\.\d+)*)?")
# A name holding a secret word and not a segment of a path (`node_modules/path-key`), a closing quote or bracket
# of a key (`"password"`, `['db_password']`), then one `=`, `:`, `:=` or `=>` (never `==`, `::` or `->`). The
# value is read from the rest of the line by `value_span`.
ASSIGNMENT_HEAD = re.compile(
    r"(?i)(?<![\w./-])(?P<name>[\w.-]{0,64}(?:%s)[\w.-]{0,64})(?P<close>[\"'`]?\]?)(?P<before>[ \t]{0,8})"
    r"(?<![=:!<>])(?P<sep>:=|=>|=|:)(?![=:>])(?P<after>[ \t]{0,8})" % SECRET_WORDS)
# A setter that takes the name as a quoted first argument: `define('DB_PASSWORD', '…')`, `putenv("TOKEN", …)`.
SETTER_HEAD = re.compile(
    r"(?i)\b(?:define|setenv|putenv|set|setparameter|setdefault)[ \t]*\([ \t]*([\"'])(?P<name>[\w.-]{1,128})\1"
    r"(?P<before>[ \t]*)(?P<sep>,)(?P<after>[ \t]*)")
XML_ELEMENT = re.compile(
    r"(?i)<(?P<name>[\w.:-]{0,64}(?:%s)[\w.:-]{0,64})>(?P<value>[^<\n]{1,1024})</(?P=name)>" % SECRET_WORDS)
# `<add key="ApiKey" value="…"/>`, `<property name="db.password" value="…"/>`.
KEY_VALUE_ATTRIBUTES = re.compile(
    r"(?i)\b(?:key|name)[ \t]*=[ \t]*([\"'])(?P<name>[^\"'\n]{1,128})\1[ \t]+value[ \t]*=[ \t]*([\"'])"
    r"(?P<value>[^\"'\n]*)\3")
CODE_WORDS = frozenset(("string", "str", "int", "integer", "bool", "boolean", "number", "float", "double", "bytes",
                        "none", "null", "nil", "true", "false", "undefined", "any", "void", "object", "array",
                        "mixed", "unknown", "never"))
CODE_PREFIXES = ("@", "%env(", "process.env", "os.environ", "getenv(", "env(", "this.", "self.", "this->")
# A reference to a variable: `$name` ended by what ends a variable, `${NAME}`, `$(command)`. `$ecr3t!` and
# `$2y$10$…` are not one.
VARIABLE = re.compile(r"\$(?:\{[^}\s]{1,128}\}|\(|[A-Za-z_]\w{0,63}(?=$|[\s;,)\]}.:\[/\"'`]|->|\?\?|\|\|))")
# The callee and opening parenthesis of a call; `is_call` reads what follows with a bracket scanner, so no
# pattern repeats over the arguments.
CALLEE = re.compile(r"(?:new[ \t]+|await[ \t]+)?[A-Za-z_\\][\w.:\\>-]{0,127}[ \t]*\(")
CALL_TRAILER = re.compile(r"(?:\??\.|->)\w{1,64}")
CALL_END = re.compile(r"[ \t;,)\]}]*")
ARGUMENTS_BELOW = re.compile(r"[ \t]*[{\[]?[ \t]*")
# A call whose arguments go on below and whose callee is a constructor or qualified: `new Account({ a,`,
# `re.compile(r"…"`. Each part is bounded and the separators are not word characters, so it cannot backtrack.
OPEN_CALL = re.compile(
    r"(?:new[ \t]+[A-Za-z_\\][\w\\]{0,127}|(?:await[ \t]+)?[A-Za-z_]\w{0,63}(?:(?:\.|::|->|\\)\w{1,63}){1,16})"
    r"[ \t]*\(")
# A value annotated with a type before it is given: `api_key: str = "…"`.
TYPED = re.compile(r"[A-Za-z_][\w\[\]., |?]{0,63}?[ \t]*=(?![=>])[ \t]*(?=\S)")
PLACEHOLDER = re.compile(
    r"(?i)|redacted|\[redacted\]|<redacted>|\[withheld\]|\*{3,}|x{3,}|\.{3}|…|<[^<>\n]{1,64}>"
    r"|\{\{?[ \t]*[A-Za-z_$][\w.$]{0,63}[ \t]*\}\}?|%[sd]|%\(\w{1,64}\)s")
# One scalar inside a list or an object: a key, bare or quoted (`user:`, `"from":`), a quoted string, or a
# bare word.
SCALAR = re.compile(r"(?P<key>[\w$.-]{1,128}|\"(?:[^\"\\\n]|\\.){0,128}\"|'(?:[^'\\\n]|\\.){0,128}')"
                    r"(?=[ \t]*:(?!:))|\"(?:[^\"\\\n]|\\.)*\"?|'(?:[^'\\\n]|\\.)*'?"
                    r"|`(?:[^`\\\n]|\\.)*`?|[^\s,:;=\[\]{}()\"'`]+")
# A bare word inside a list or an object that is code rather than a value: a qualified reference, a variable,
# or a constant's name.
CODE_REFERENCE = re.compile(r"(?:\.{3})?(?:[$#@]?[A-Za-z_]\w*(?:(?:\??\.|->|::)[A-Za-z_]\w*)+|\$[A-Za-z_]\w*"
                            r"|[A-Z][A-Z0-9]*_[A-Z0-9_]+)")
KEY_GAP = re.compile(r"[ \t]*:[ \t]*")
BLOCK_SCALAR = re.compile(r"[|>][+-]?[1-9]?[+-]?")
# A name a declaration introduces (`type AppTokenDeps = {`, `class TokenStore {`): a type, never a secret's.
DECLARED = re.compile(r"\b(?:type|interface|class|enum|struct|record|trait)[ \t]+$")
# A value made of words alone (`'pause'`, `schema_version`): under a name that is a secret's only by ending in
# `KEY`, the name of a key rather than a key.
WORDS_ONLY = re.compile(r"[A-Za-z][A-Za-z_.:-]{0,127}")
COMMENT_LINE = ("//", "/*", "*", "#")
LINE_START = re.compile(r"[+-]?[ \t]*(?:-[ \t]+)?")
COMMENT = re.compile(r"[ \t]+(?:#|//)")
SECRET_HEADER = re.compile(
    r"(?i)(?<![\w-])(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|private-token)"
    r"([\"']?[ \t]*:(?!:)[ \t]*)(\S.*)$")
BEARER = re.compile(r"(?i)\b(bearer|basic)([ \t]+)([A-Za-z0-9._~+/-]{12,}=*)")
# The userinfo of a URI, up to the last `@` before the host: `redis://:pw@host`, `amqp://user:p@ss@host`,
# `https://<token>@host`.
URI_USERINFO = re.compile(r"(?i)(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}://)([^\s/?#'\"<>()\[\]{}]{0,512})@")
PLAIN_USER = re.compile(r"[A-Za-z][A-Za-z._-]{0,31}[0-9]{0,4}")
COMMAND_USER = re.compile(
    r"(?<!\S)(?:-u|--user|--proxy-user)(?:[ \t]+|=)?([\"']?)(?P<user>[^\s:'\"]*):(?P<pw>[^\s'\"]+)")
MYSQL_PASSWORD = re.compile(
    r"(?<![\w-])(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,512}?(?<!\S)-p(?P<pw>[^\s'\"]\S*)")
WITHHELD = "[withheld]"
HTTP_HINTS = {
    401: "the key is missing or wrong",
    402: "the account has no credits left",
    422: "it refused the request as invalid",
    429: "too many requests; ask again later",
}


class Off(Exception):
    """Nothing may be asked: no endpoint, or the kind is left out."""


class Unusable(Exception):
    """The input or the configuration cannot be used."""


class Failed(Exception):
    """The endpoint failed, refused, or answered something unreadable."""


class TimedOut(Failed):
    """The endpoint gave no whole answer within the time the request was allowed."""


@dataclass(frozen=True)
class Limits:
    """The bounds of one run; see the module's description."""
    timeout: float
    budget: float
    max_requests: int
    max_bytes: int

    def as_json(self) -> Dict[str, float]:
        return {"timeout": self.timeout, "budget": self.budget, "max_requests": self.max_requests,
                "max_bytes": self.max_bytes}


@dataclass(frozen=True)
class Endpoint:
    url: str
    model: str
    key: Optional[str]
    key_file: Path
    key_note: str
    local: bool
    kinds: Tuple[str, ...]
    limits: Limits


class Meter:
    """What one run has sent and how long it has run, held to its limits: it tells the next request how
    long it may wait, or records the bound that stops it."""

    def __init__(self, limits: Limits, clock: Callable[[], float] = time.monotonic) -> None:
        self.limits = limits
        self.clock = clock
        self.started = clock()
        self.requests = 0
        self.bytes = 0
        self.stopped: Optional[Dict[str, object]] = None

    def allow(self, size: int) -> Optional[float]:
        """The seconds a request of `size` body bytes may wait for its answer, counted as sent; or None when a
        bound stops it, recorded in `stopped`."""
        limits = self.limits
        left = limits.budget - (self.clock() - self.started)
        if self.requests >= limits.max_requests:
            self.stop("requests", limits.max_requests, "CLAUDE_KIT_DECISION_MAX_REQUESTS",
                      "the run made the %d requests it may make" % limits.max_requests)
        elif self.bytes + size > limits.max_bytes:
            self.stop("bytes", limits.max_bytes, "CLAUDE_KIT_DECISION_MAX_BYTES",
                      "the next request would take the bytes sent past %d" % limits.max_bytes)
        elif left <= 0:
            self.stop("time", limits.budget, "CLAUDE_KIT_DECISION_BUDGET",
                      "the run used the %g seconds it may take" % limits.budget)
        else:
            self.requests += 1
            self.bytes += size
            return min(limits.timeout, left)
        return None

    def timed_out(self, waited: float) -> None:
        """Records the bound a request that had no answer within `waited` seconds ran into."""
        if waited < self.limits.timeout:
            self.stop("time", self.limits.budget, "CLAUDE_KIT_DECISION_BUDGET",
                      "the run used the %g seconds it may take" % self.limits.budget)
        else:
            self.stop("timeout", self.limits.timeout, "CLAUDE_KIT_DECISION_TIMEOUT",
                      "a request had no answer within %g seconds" % self.limits.timeout)

    def stop(self, bound: str, limit: float, setting: str, why: str) -> None:
        self.stopped = {"bound": bound, "limit": limit, "setting": setting, "why": why}


def bound(env: Dict[str, str], name: str, default: float, whole: bool) -> float:
    """The positive number setting `name` holds, or `default` when it is unset or empty."""
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw) if whole else float(raw)
    except ValueError:
        value = 0
    if not (math.isfinite(value) and value > 0):
        raise Unusable("%s must be a positive %s" % (name, "whole number" if whole else "number of seconds"))
    return value


def limits_of(env: Dict[str, str]) -> Limits:
    return Limits(timeout=bound(env, "CLAUDE_KIT_DECISION_TIMEOUT", TIMEOUT, False),
                  budget=bound(env, "CLAUDE_KIT_DECISION_BUDGET", BUDGET, False),
                  max_requests=int(bound(env, "CLAUDE_KIT_DECISION_MAX_REQUESTS", MAX_REQUESTS, True)),
                  max_bytes=int(bound(env, "CLAUDE_KIT_DECISION_MAX_BYTES", MAX_BYTES, True)))


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def origin(url: str) -> Optional[Tuple[str, str, int]]:
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return None
    return parts.scheme, parts.hostname.lower(), port


def read_secrets(path: Path) -> Dict[str, str]:
    """The KEY=VALUE lines of the key file; refused when anyone but its owner may read it."""
    try:
        mode = path.stat().st_mode
    except OSError:
        return {}
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise Unusable("%s can be read by other accounts on this machine; chmod 600 it" % path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise Unusable("cannot read %s: %s" % (path, error.strerror or error))
    values: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        name, sep, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if sep and value:
            values[name.strip()] = value
    return values


def endpoint(kind: Optional[str], env: Dict[str, str]) -> Endpoint:
    """The configured endpoint, refusing with Off when `kind` (or anything, for None) may not be asked."""
    base = env.get("CLAUDE_KIT_DECISION_URL", "").strip()
    if not base:
        raise Off("CLAUDE_KIT_DECISION_URL is not set, so nothing is sent")
    where = origin(base)
    if where is None:
        raise Unusable("CLAUDE_KIT_DECISION_URL is not an http(s) address")
    local = is_loopback(where[1])
    if where[0] == "http" and not local:
        raise Unusable("an endpoint over plain HTTP must be on this machine, and %s is not" % where[1])
    kinds = tuple(k.strip() for k in env.get("CLAUDE_KIT_DECISION_KINDS", ",".join(KINDS)).split(",") if k.strip())
    unknown = [k for k in kinds if k not in KINDS]
    if unknown:
        raise Unusable("CLAUDE_KIT_DECISION_KINDS names %s; the kinds are %s" % (", ".join(unknown), ", ".join(KINDS)))
    if kind is not None and kind not in kinds:
        raise Off("CLAUDE_KIT_DECISION_KINDS leaves out %s, so it is not asked" % kind)
    key_file = Path(env.get("CLAUDE_KIT_DECISION_KEY_FILE") or Path.home() / ".claude" / "secrets" / "decision-model.env")
    secrets = read_secrets(key_file)
    key = secrets.get("DECISION_MODEL_API_KEY")
    owner = secrets.get("DECISION_MODEL_URL", "")
    if not key:
        note = "absent"
    elif not owner:
        key, note = None, "not sent: the key file has no DECISION_MODEL_URL naming the base the key belongs to"
    elif origin(owner) != where:
        key, note = None, "not sent: the key belongs to %s, not to this endpoint" % owner
    else:
        note = "sent"
    model = env.get("CLAUDE_KIT_DECISION_MODEL", "").strip() or DEFAULT_MODEL
    return Endpoint(base.rstrip("/") + "/v1/systemone", model, key, key_file, note, local, kinds, limits_of(env))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the request to wherever it points; it is refused as an error instead."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


def scrub(text: str, key: Optional[str]) -> str:
    return text.replace(key, "***") if key else text


def request_body(ep: Endpoint, state: str, questions: Dict[str, dict]) -> bytes:
    """The body of one systemone request, as it is sent."""
    return json.dumps({"state": state, "model": ep.model, "questions": questions}).encode("utf-8")


def exchange(opener: urllib.request.OpenerDirector, request: urllib.request.Request, wait: float) -> bytes:
    """The whole response body to `request`, waited for at most `wait` seconds in all: the socket's timeout
    bounds each read alone, so an endpoint that trickles its answer is given up at that time like one that
    is silent. The request runs on a thread of its own that is left behind when it is given up."""
    outcome: List[object] = []

    def fetch() -> None:
        try:
            with opener.open(request, timeout=wait) as response:
                outcome.append(response.read())
        except Exception as error:  # handed to the caller, which reads it below
            outcome.append(error)

    worker = threading.Thread(target=fetch, daemon=True)
    worker.start()
    worker.join(wait)
    if not outcome:
        raise TimedOut("the endpoint gave no whole answer within %g seconds" % wait)
    if isinstance(outcome[0], Exception):
        raise outcome[0]
    return outcome[0] if isinstance(outcome[0], bytes) else b""


def ask(ep: Endpoint, body: bytes, wait: float) -> Tuple[Dict[str, object], Dict[str, int], str]:
    """One systemone request of `body`, waiting at most `wait` seconds: the answers by question id, the
    usage, and the model that answered."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if ep.key:
        headers["Authorization"] = "Bearer " + ep.key
    request = urllib.request.Request(ep.url, data=body, headers=headers, method="POST")
    handlers: List[urllib.request.BaseHandler] = [_NoRedirect()]
    if ep.local:
        handlers.append(urllib.request.ProxyHandler({}))
    try:
        payload = json.loads(exchange(urllib.request.build_opener(*handlers), request, wait).decode("utf-8"))
    except TimedOut:
        raise
    except urllib.error.HTTPError as error:
        hint = HTTP_HINTS.get(error.code) or ("it redirected, and a redirect is never followed: check the base URL"
                                              if 300 <= error.code < 400 else "an error")
        if error.code == 401:
            hint += " (the key is %s; DECISION_MODEL_API_KEY in %s)" % (ep.key_note, ep.key_file)
        raise Failed("the endpoint answered %d: %s" % (error.code, hint))
    except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            raise TimedOut("the endpoint gave no answer within %g seconds" % wait)
        detail = reason.strerror if isinstance(reason, OSError) and reason.strerror else type(reason).__name__
        raise Failed(scrub("the endpoint did not answer: %s" % detail, ep.key))
    except ValueError:
        raise Failed("the endpoint's answer is not JSON")
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        raise Failed("the endpoint's answer holds no answers")
    raw_usage = payload.get("usage")
    usage = {k: raw_usage[k] for k in ("input_tokens", "output_tokens")
             if isinstance(raw_usage, dict) and isinstance(raw_usage.get(k), int)}
    model = payload.get("model")
    named = isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", model) is not None
    return answers, usage, model if named else ep.model


def probability(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if 0.0 <= value <= 1.0 else None


def noul(answer: object) -> Optional[float]:
    return probability(answer.get("noul")) if isinstance(answer, dict) else None


def choice(answer: object, option: str) -> Optional[float]:
    if not isinstance(answer, dict) or not isinstance(answer.get("probabilities"), dict):
        return None
    return probability(answer["probabilities"].get(option))


def verdict(p: Optional[float]) -> str:
    if p is None:
        return "uncertain"
    return "yes" if p >= YES else "no" if p <= NO else "uncertain"


def add_usage(total: Dict[str, int], usage: Dict[str, int]) -> None:
    for name, count in usage.items():
        total[name] = total.get(name, 0) + count


def read_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise Unusable("cannot read %s: %s" % (path, error.strerror or error))


# -- what may leave the machine --------------------------------------------------------------------

@dataclass(frozen=True)
class Carry:
    """A withheld value that goes on over the next lines. `kind` is "indent" (a YAML block scalar or nested
    map: the lines indented deeper than `column`), "bracket" (a list or object `depth` brackets deep, until it
    closes), "quote" (a quoted string that has not closed, on lines indented deeper than `column`) or "triple"
    (a triple-quoted string, until `closer`). A string goes on for at most `left` more lines, so a quote that
    only looks like one opening, inside another string, does not hold back the rest of the text."""
    kind: str
    column: int
    closer: str = ""
    depth: int = 0
    left: int = STRING_LINES


def withhold(text: str) -> Tuple[str, int]:
    """The text with the values of secret-looking lines replaced, and how many lines were touched; a value
    that goes on over the next lines is withheld there too."""
    out: List[str] = []
    count = 0
    in_block = False
    carry: Optional[Carry] = None
    for line in text.splitlines(keepends=True):
        if in_block or KEY_BLOCK_BEGIN.search(line):
            in_block = not KEY_BLOCK_END.search(line)
            out.append(WITHHELD + "\n")
            count += 1
            carry = None
            continue
        changed: Optional[str] = None
        if carry is not None:
            changed, carry = carried_line(line, carry)
        if changed is None:
            changed, carry = scrub_line(line)
        if changed != line:
            count += 1
            if line.endswith("\n") and not changed.endswith("\n"):
                changed += "\n"
        out.append(changed)
    return "".join(out), count


def content_column(body: str) -> int:
    """Where a line's content starts: after one leading diff marker (`+`, `-`) and the indentation."""
    i = 1 if body[:1] in ("+", "-") else 0
    while i < len(body) and body[i] in " \t":
        i += 1
    return i


def carried_line(line: str, carry: Carry) -> Tuple[Optional[str], Optional[Carry]]:
    """A line inside a value that `carry` says goes on: the line with that value withheld and what goes on
    after it, or None when the value ended before this line, which is then read as any other."""
    body = line.rstrip("\r\n")
    end = line[len(body):]
    column = content_column(body)
    if not body[column:].strip():
        return line, carry
    if carry.kind == "indent":
        return (body[:column] + WITHHELD + end, carry) if column > carry.column else (None, None)
    if carry.kind == "quote" and column <= carry.column:
        return None, None
    if carry.kind == "bracket":
        if column < carry.column:
            return None, None
        if body[column:].startswith(COMMENT_LINE):
            return scrub_line(line)[0], carry
        closes, depth = close_of(body, column, carry.depth)
        if closes < 0:
            return body[:column] + withhold_scalars(body[column:]) + end, Carry("bracket", carry.column, depth=depth)
        tail, after = scrub_line(body[closes - 1:])
        return body[:column] + withhold_scalars(body[column:closes - 1]) + tail + end, after
    if carry.left <= 0:
        return None, None
    closer = body.find(carry.closer, column) if carry.kind == "triple" else string_close(body, column, carry.closer)
    if closer < 0:
        return body[:column] + WITHHELD + end, Carry(carry.kind, carry.column, carry.closer, left=carry.left - 1)
    tail, after = scrub_line(body[closer:])
    return body[:column] + WITHHELD + tail + end, after


def string_close(text: str, start: int, quote: str) -> int:
    """The index of the first `quote` from `start` that no backslash escapes, or -1."""
    i = start
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == quote:
            return i
        i += 1
    return -1


def close_of(text: str, start: int, depth: int) -> Tuple[int, int]:
    """Reading `text` from `start` with `depth` brackets open: the index just after the bracket that closes
    them all, or -1 and the depth still open when the text ends first. A quoted string is skipped whole."""
    i = start
    while i < len(text):
        char = text[i]
        if char in "\"'`":
            i = quoted_end(text, i)[0]
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if depth <= 0:
                return i + 1, 0
        i += 1
    return -1, depth


def name_parts(name: str) -> List[str]:
    """The parts of a name, split at `_`, `.`, `-` and camel case, lower-cased."""
    return [part.lower() for part in NAME_PARTS.split(name) if part]


def secret_name(name: str) -> bool:
    """Whether `name` names a secret: it holds a secret word, or `pass` or `key` ends it after a separator
    (`DB_PASS`, `smtp.pass`, `APP_KEY`) — unless its last part says it points at the secret
    instead (`SECRET_KEY_FILE`), or the part before `key` makes it a table's or a cache's (`PRIMARY_KEY`)."""
    parts = name_parts(name)
    if not parts or parts[-1] in POINTER_PARTS:
        return False
    if STRONG_SECRET_WORDS.search(name):
        return True
    if KEY_NAME.search(name.strip("-")):
        return len(parts) > 1 and parts[-2] not in PUBLIC_KEY_PARTS
    return len(parts) > 1 and parts[-1] == "pass" and re.search(r"[_.-]", name.strip("-")) is not None


def weak_pass(name: str) -> bool:
    """A name that is `pass` alone or after one camel-case word (`pass`, `PASS`, `--pass`, `dbPass`): a
    secret's in a query, an option or before a quoted value; a verdict, a label or a counter otherwise
    (`PASS = 3`, `*Pass:*`, `this.perPass = n`)."""
    parts = name_parts(name)
    return 0 < len(parts) <= 2 and parts[-1] == "pass" and not secret_name(name)


def is_placeholder(value: str) -> bool:
    """A value that stands in for a secret without being one: empty, `REDACTED`, `***`, `<…>`, `{name}`,
    `%s`."""
    return PLACEHOLDER.fullmatch(value.strip()) is not None


def kept_literal(quote: str, inner: str) -> bool:
    """A quoted literal that holds no secret: a placeholder, a version constraint (`^0.7.1`, `1.2.0-rc.1`), or a
    string that only interpolates a variable (`"$HOME/…"`, `"${token}"`)."""
    return (is_placeholder(inner) or VERSION.fullmatch(inner.strip()) is not None
            or (quote in "\"`" and VARIABLE.match(inner) is not None))


def is_call(value: str) -> bool:
    """Whether `value` is a call: a callee, its arguments to the matching parenthesis, then member accesses,
    further calls and indexes (`key(dir).path`, `make().a().b()`), then only closing punctuation; or a callee
    whose arguments go on below (`issue(`, `make({`). A bracket scanner reads the arguments, so the cost is in
    proportion to the length."""
    head = CALLEE.match(value)
    if head is None:
        return False
    if ARGUMENTS_BELOW.fullmatch(value, head.end()) is not None:
        return True
    pos = close_of(value, head.end(), 1)[0]
    while pos > 0:
        trailer = CALL_TRAILER.match(value, pos)
        if trailer is not None:
            pos = trailer.end()
            if value.startswith("(", pos):
                pos = close_of(value, pos + 1, 1)[0]
        elif value.startswith("[", pos):
            pos = close_of(value, pos + 1, 1)[0]
        else:
            break
    return pos > 0 and CALL_END.fullmatch(value, pos) is not None


def value_is_code(name: str, value: str, env_style: bool) -> bool:
    """An unquoted value that is a type, a literal, the name again, a variable, a call, a parenthesized
    expression or an arrow function, or another reference to code — not a secret. A call or a parenthesis is
    code only outside an environment line (`NAME=value`), where none runs."""
    word = re.match(r"[^\s,;)|\]}]*", value).group(0).strip("?[]").lower()
    last = re.split(r"[.-]", name)[-1].lower()
    a_file = re.search(r"\.(php|py|js|mjs|ts|tsx|jsx|rb|go|rs|java|kt|cs|twig|html|css|ya?ml|json|xml|md|txt|log|sh)$",
                       name, re.I) is not None
    if (word in CODE_WORDS or word == last or word.rsplit(".", 1)[-1] == last or word == name.lower() or a_file
            or value.startswith(CODE_PREFIXES)):
        return True
    if value.startswith("$"):
        return VARIABLE.match(value) is not None
    return not env_style and (value.startswith("(") or is_call(value) or OPEN_CALL.match(value) is not None)


def withhold_scalar(found: re.Match[str], key: Optional[str]) -> str:
    """One scalar of a list or an object under a secret's name, withheld unless it is a key, the value of a
    key that points at the secret rather than holding it (`"env": "DIBS_TOKEN"`), a literal that holds no
    secret, code, or punctuation."""
    text = found.group(0)
    if found.group("key") is not None:
        return text
    if key is not None:
        parts = name_parts(key.strip("\"'"))
        if parts and parts[-1] in POINTER_PARTS:
            return text
    if text[0] in "\"'`":
        closed = len(text) > 1 and text[-1] == text[0]
        if kept_literal(text[0], text[1:-1] if closed else text[1:]):
            return text
        return WITHHELD
    if (re.search(r"[A-Za-z0-9]", text) is None or text.lower() in CODE_WORDS or is_placeholder(text)
            or CODE_REFERENCE.fullmatch(text) is not None):
        return text
    return WITHHELD


def withhold_scalars(text: str) -> str:
    """The inside of a list or an object under a secret's name with its scalars withheld; a scalar right after
    a key and its `:` is that key's value."""
    out: List[str] = []
    pos = 0
    key: Optional[str] = None
    key_end = -1
    for found in SCALAR.finditer(text):
        owner = key if key_end >= 0 and KEY_GAP.fullmatch(text, key_end, found.start()) is not None else None
        out.append(text[pos:found.start()] + withhold_scalar(found, owner))
        pos = found.end()
        key, key_end = (found.group("key"), found.end()) if found.group("key") is not None else (None, -1)
    out.append(text[pos:])
    return "".join(out)


def quoted_end(text: str, start: int = 0, stop: Optional[int] = None) -> Tuple[int, bool]:
    """The index just after the string that opens at `start` in `text`, a backslash escaping the next
    character, and whether it closes before `stop` (the end of `text` by default); `stop` when it does not."""
    stop = len(text) if stop is None else min(stop, len(text))
    quote = text[start]
    i = start + 1
    while i < stop:
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == quote:
            return i + 1, True
        i += 1
    return stop, False


Span = Tuple[int, int, str]


def value_span(body: str, start: int, name: str, env_style: bool, column: int, line_key: bool,
               typed_ok: bool = True, names_a_key: bool = False) -> Tuple[Optional[Span], Optional[Carry]]:
    """The value that opens at `start` in `body`, after a secret's name (at `column`) and separator: where it
    lies and what replaces it when it is withheld, and the carry when it goes on over the next lines.

    A quoted value runs to its closing quote; a triple-quoted one, or one that does not close, goes on
    below. A list or an object has its scalars withheld, to its closing bracket or over the lines below.
    Any other value runs to the end of the line or a comment after a space, so no tail of it is sent. A YAML
    key that ends its line (`line_key`) with nothing or a block indicator (`|`, `>-`) after it has its value
    on the lines indented deeper. Under a name that only ends in `KEY` (`names_a_key`), a value of words
    alone is the name of a key and is kept. A type before the value (`str = "…"`) is looked past once. Only the first
    VALUE_CHARS from `start` decide; the rest of the line is read only to find the end of a value that is
    withheld, after which the scan goes on past it, so a line costs time in proportion to its length."""
    if start >= len(body):
        return None, (Carry("indent", column) if line_key else None)
    window = body[start:start + VALUE_CHARS]
    first = window[0]
    if first in "&,;)]}":
        return None, None
    if window.startswith(('"""', "'''")):
        closer = body.find(window[:3], start + 3)
        if closer >= 0:
            return (start, closer + 3, WITHHELD), None
        return (start, len(body), WITHHELD), Carry("triple", column, closer=window[:3])
    if first in "\"'`":
        end, closed = quoted_end(window)
        inner = window[1:end - 1] if closed else window[1:]
        if kept_literal(first, inner) or (names_a_key and closed and WORDS_ONLY.fullmatch(inner) is not None):
            return None, None
        if not closed:
            end, closed = quoted_end(body, start)
            end -= start
        if closed:
            return (start, start + end, WITHHELD), None
        return (start, len(body), WITHHELD), Carry("quote", column, closer=first)
    if first in "[{" and not env_style:
        closes, depth = close_of(body, start + 1, 1)
        if closes < 0:
            return (start + 1, len(body), withhold_scalars(body[start + 1:])), Carry(
                "bracket", content_column(body), depth=depth)
        if is_placeholder(body[start:closes]):
            return None, None
        return (start + 1, closes - 1, withhold_scalars(body[start + 1:closes - 1])), None
    comment = COMMENT.search(window)
    value = window[:comment.start() if comment else len(window)].rstrip()
    if not value or value.startswith(("#", "//")) or (line_key and BLOCK_SCALAR.fullmatch(value) is not None):
        return None, (Carry("indent", column) if line_key else None)
    if (is_placeholder(value) or is_placeholder(value.split()[0].rstrip(",;"))
            or (names_a_key and WORDS_ONLY.fullmatch(value.rstrip(",;")) is not None)):
        return None, None
    if value_is_code(name, value, env_style):
        typed = TYPED.match(value) if typed_ok else None
        if typed is None:
            return None, None
        return value_span(body, start + typed.end(), name, env_style, column, False, typed_ok=False,
                          names_a_key=names_a_key)
    if comment is None and start + len(window) < len(body):
        comment = COMMENT.search(body, start + len(window))
        return (start, len(body[:comment.start() if comment else len(body)].rstrip()), WITHHELD), None
    return (start, start + len(value), WITHHELD), None


def withhold_values(body: str, head: re.Pattern[str]) -> Tuple[str, Optional[Carry]]:
    """`body` with the value after every secret's name that `head` finds withheld, and the carry of a value
    that goes on below. A name that is no secret's, or a value that is code, is passed over and the scan
    goes on inside its value. A Markdown label (`*Pass:*`) is a label only for a name that is no secret's, and
    a name a declaration introduces is a type's."""
    out: List[str] = []
    pos = 0
    carry: Optional[Carry] = None
    while True:
        found = head.search(body, pos)
        if found is None:
            break
        start = found.end()
        name = found.group("name")
        before = body[found.start() - 1:found.start()] if found.start() else ""
        label = before == "*" and body[start:start + 1] == "*"
        declared = DECLARED.search(body, max(0, found.start("name") - 32), found.start("name")) is not None
        named = not declared and (secret_name(name) or (weak_pass(name) and not label
                                                        and (name.startswith("-") or before in ("?", "&")
                                                             or body[start:start + 1] in ("\"", "'"))))
        span: Optional[Span] = None
        if named:
            env_style = (re.fullmatch(r"[A-Z][A-Z0-9_]*", name) is not None and found.group("sep") == "="
                         and found.group(0) == name + "=")
            line_key = (found.group("sep") == ":"
                        and LINE_START.fullmatch(body, 0, found.start("name")) is not None)
            names_a_key = STRONG_SECRET_WORDS.search(name) is None and KEY_NAME.search(name) is not None
            span, opened = value_span(body, start, name, env_style, found.start("name"), line_key,
                                      names_a_key=names_a_key)
            carry = opened or carry
        if span is None:
            out.append(body[pos:start])
            pos = start
            continue
        out.append(body[pos:span[0]] + span[2])
        pos = span[1]
    out.append(body[pos:])
    return "".join(out), carry


def withhold_userinfo(found: re.Match[str]) -> str:
    """A URI's userinfo with its password withheld, or all of it when it is a token rather than a user name."""
    scheme, info = found.group(1), found.group(2)
    user, colon, password = info.partition(":")
    if colon:
        return found.group(0) if is_placeholder(password) else scheme + user + ":" + WITHHELD + "@"
    return found.group(0) if PLAIN_USER.fullmatch(info) else scheme + WITHHELD + "@"


def withhold_command_user(found: re.Match[str]) -> str:
    """`-u user:password` with the password withheld; a numeric `uid:gid` and a `user:user` pair are kept."""
    user, password = found.group("user"), found.group("pw")
    if (user.isdigit() and password.isdigit()) or user == password or is_placeholder(password):
        return found.group(0)
    return found.group(0)[:found.start("pw") - found.start()] + WITHHELD


def withhold_bearer(found: re.Match[str]) -> str:
    """A bearer or basic credential withheld when it holds a digit or a symbol, as a credential does and a
    word of prose does not."""
    credential = found.group(3)
    if re.search(r"[0-9._~+/=-]", credential) is None:
        return found.group(0)
    return found.group(1) + found.group(2) + WITHHELD


def withhold_header(found: re.Match[str]) -> str:
    """A credential header's value withheld to the end of the line, unless it is a type or a reference."""
    value = found.group(3)
    if value[0] in "{[":
        return found.group(0)
    if value[0] in "\"'`":
        end, closed = quoted_end(value)
        if kept_literal(value[0], value[1:end - 1] if closed else value[1:]):
            return found.group(0)
    word = re.match(r"[^\s,;)|\]}]*", value).group(0).lower()
    if word in CODE_WORDS or is_placeholder(value) or value.startswith(CODE_PREFIXES) or VARIABLE.match(value):
        return found.group(0)
    return found.group(1) + found.group(2) + WITHHELD


def withhold_named_value(found: re.Match[str]) -> str:
    """The value of an XML element or a key/value attribute pair withheld when its name is a secret's."""
    value = found.group("value")
    if not secret_name(found.group("name")) or is_placeholder(value) or value.startswith(("${", "%env(")):
        return found.group(0)
    start, end = found.start("value") - found.start(), found.end("value") - found.start()
    return found.group(0)[:start] + WITHHELD + found.group(0)[end:]


def scrub_line(line: str) -> Tuple[str, Optional[Carry]]:
    """One line with its secret-looking values withheld, and the carry of a value that goes on below; every
    pattern is bounded or scans forward only, so a long line costs time in proportion to its length."""
    body = line.rstrip("\r\n")
    end = line[len(body):]
    body = URI_USERINFO.sub(withhold_userinfo, body)
    body = COMMAND_USER.sub(withhold_command_user, body)
    body = MYSQL_PASSWORD.sub(lambda m: m.group(0)[:m.start("pw") - m.start()] + WITHHELD, body)
    body = TOKEN_SHAPES.sub(WITHHELD, body)
    body = BEARER.sub(withhold_bearer, body)
    body = SECRET_HEADER.sub(withhold_header, body)
    body = XML_ELEMENT.sub(withhold_named_value, body)
    body = KEY_VALUE_ATTRIBUTES.sub(withhold_named_value, body)
    body, set_carry = withhold_values(body, SETTER_HEAD)
    body, carry = withhold_values(body, ASSIGNMENT_HEAD)
    return body + end, carry or set_carry


def weight(text: str) -> int:
    """An estimate of the tokens `text` costs, generous for text that is not ASCII."""
    other = sum(1 for c in text if ord(c) > 127)
    return (len(text) - other) // 3 + other * 2 + 1


def pieces(text: str, cap: int, header: str = "") -> List[str]:
    """`text` cut at line ends (a line longer than LINE_CHARS is cut too) into parts of at most `cap`
    estimated tokens, each after `header`."""
    lines: List[str] = []
    for line in text.splitlines(keepends=True):
        lines += [line[i:i + LINE_CHARS] for i in range(0, len(line), LINE_CHARS)]
    out: List[str] = []
    part, used, base = header, weight(header), weight(header)
    for line in lines:
        cost = weight(line)
        if used + cost > cap and part != header:
            out.append(part)
            part, used = header, base
        part += line
        used += cost
    if part != header:
        out.append(part)
    return out


def unquote_path(raw: str) -> str:
    """A path as a diff header names it: without a trailing tab and its date, C-quoting undone."""
    raw = raw.split("\t", 1)[0].rstrip("\r\n")
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        try:
            raw = raw[1:-1].encode("latin-1", "backslashreplace").decode("unicode_escape").encode("latin-1").decode("utf-8")
        except (UnicodeError, ValueError):
            raw = raw[1:-1]
    return raw


def section_paths(text: str) -> List[str]:
    """Every path a file section's header names, with and without git's a/ and b/ prefixes."""
    head = text.split("\n@@", 1)[0]
    found: List[str] = []
    for line in head.splitlines():
        for marker in ("--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to "):
            if line.startswith(marker):
                found.append(unquote_path(line[len(marker):]))
        if line.startswith("diff --git "):
            found += [unquote_path(p) for p in re.findall(r'"(?:[^"\\]|\\.)*"|\S+', line[len("diff --git "):])]
    paths: List[str] = []
    for path in found:
        if path and path != "/dev/null":
            paths.append(path)
            if path[:2] in ("a/", "b/"):
                paths.append(path[2:])
    return paths


def diff_sections(diff: str) -> List[Tuple[List[str], str]]:
    """(paths, text) per file of a diff, split at `diff --git` or, without those, at `--- ` headers."""
    starts = [m.start() for m in re.finditer(r"^diff --git ", diff, flags=re.M)]
    if not starts:
        starts = [m.start() for m in re.finditer(r"^--- .*\n\+\+\+ ", diff, flags=re.M)]
    if not starts:
        return [([], diff)] if diff.strip() else []
    if starts[0] > 0:
        starts.insert(0, 0)
    return [(section_paths(diff[b:e]), diff[b:e]) for b, e in zip(starts, starts[1:] + [len(diff)])]


def credential_reason(paths: Sequence[str], text: str) -> Optional[str]:
    if any(CREDENTIAL_PATH.search(p) for p in paths):
        return "its name looks like a credential or a database dump"
    if KEY_BLOCK_BEGIN.search(text):
        return "it holds a private key"
    if any(p.lower().endswith(".sql") for p in paths) and (
            re.search(r"^\+?\s*COPY\s.*\sFROM\s+stdin", text, flags=re.M | re.I)
            or len(re.findall(r"^\+?\s*INSERT\s+INTO\b", text, flags=re.M | re.I)) >= 5):
        return "it looks like a database dump"
    if re.search(r"^Binary files .* differ$", text, flags=re.M):
        return "it is binary"
    return None


def states(sections: Sequence[str], cap: int) -> List[str]:
    """Whole sections packed into states of at most `cap` estimated tokens; a larger section is cut
    after its header."""
    out: List[str] = []
    current, used = "", 0
    for text in sections:
        cost = weight(text)
        if cost > cap:
            if current:
                out.append(current)
                current, used = "", 0
            hunk = text.find("\n@@")
            header = text[:hunk + 1] if 0 <= hunk and weight(text[:hunk + 1]) < cap // 4 else ""
            out += pieces(text[len(header):], cap, header)
            continue
        if current and used + cost > cap:
            out.append(current)
            current, used = "", 0
        current += text
        used += cost
    if current:
        out.append(current)
    return out


def batches(state: str, questions: Dict[str, dict]) -> List[Dict[str, dict]]:
    """The questions split into requests of at most MAX_QUESTIONS that keep the body under BODY_BYTES."""
    room = BODY_BYTES - len(json.dumps(state).encode("utf-8")) - 1000
    out: List[Dict[str, dict]] = []
    current: Dict[str, dict] = {}
    load = 0
    for qid, question in questions.items():
        size_of = len(json.dumps({qid: question}).encode("utf-8"))
        if current and (len(current) >= MAX_QUESTIONS or load + size_of > room):
            out.append(current)
            current, load = {}, 0
        current[qid] = question
        load += size_of
    if current:
        out.append(current)
    return out


@dataclass
class Asked:
    """What a run got back: per part, the answers by question id and the ids its answered requests asked;
    the summed usage; the model; and what the whole run would have sent."""
    answers: List[Dict[str, object]]
    asked: List[Set[str]]
    usage: Dict[str, int]
    model: str
    planned_requests: int
    planned_bytes: int

    def over(self, qid: str, among: Sequence[int]) -> List[Dict[str, object]]:
        """The answers of the parts in `among` whose request asking `qid` was answered."""
        return [self.answers[i] for i in among if qid in self.asked[i]]


def ask_parts(ep: Endpoint, meter: Meter, parts: Sequence[str], questions_of: Sequence[Dict[str, dict]]) -> Asked:
    """Each part asked its own questions, batch by batch over every part — the first batch of every part
    before the second of any — until the run is done or `meter` stops it."""
    rounds = [batches(state, questions) if questions else [] for state, questions in zip(parts, questions_of)]
    plan: List[Tuple[int, Dict[str, dict], bytes]] = []
    for r in range(max((len(b) for b in rounds), default=0)):
        plan += [(i, b[r], request_body(ep, parts[i], b[r])) for i, b in enumerate(rounds) if r < len(b)]
    answers: List[Dict[str, object]] = [{} for _ in parts]
    asked: List[Set[str]] = [set() for _ in parts]
    usage: Dict[str, int] = {}
    model = ep.model
    for i, batch, body in plan:
        wait = meter.allow(len(body))
        if wait is None:
            break
        try:
            got, used, model = ask(ep, body, wait)
        except TimedOut:
            meter.timed_out(wait)
            break
        answers[i].update((qid, got[qid]) for qid in batch if qid in got)
        asked[i].update(batch)
        add_usage(usage, used)
    return Asked(answers, asked, usage, model, len(plan), sum(len(body) for _, _, body in plan))


def sending(meter: Meter, asked: Asked) -> Dict[str, object]:
    """What a run sent, what it would have sent whole, the bound that stopped it, and its limits."""
    return {"requests": meter.requests, "bytes": meter.bytes,
            "planned": {"requests": asked.planned_requests, "bytes": asked.planned_bytes},
            "stopped": meter.stopped, "limits": meter.limits.as_json()}


def outcome_of(seen: Sequence[Dict[str, object]], of: int, qid: str, against: str, behind: str) -> Tuple[str, Optional[float], Optional[float]]:
    """The verdict on `qid` from the answers of the `seen` parts out of the `of` it is asked over: `against`
    when a part finds it, uncertain when a part cannot tell, not_asked when a part was left unasked, then
    `behind` or not_shown; with the highest probabilities of `against` and of `behind`."""
    worst, doubt = worst_and_doubt(seen, qid, against)
    best, _ = worst_and_doubt(seen, qid, behind)
    unsure = doubt or worst is None or worst > NO
    if worst is not None and worst >= YES:
        return against, worst, best
    if seen and unsure:
        return "uncertain", worst, best
    if len(seen) < of:
        return "not_asked", worst, best
    if unsure:
        return "uncertain", worst, best
    if best is not None and best >= YES:
        return behind, worst, best
    return "not_shown", worst, best


def worst_and_doubt(per_part: Sequence[Dict[str, object]], qid: str, option: str) -> Tuple[Optional[float], bool]:
    """The highest probability of `option` across the parts, and whether any part gave no readable one."""
    seen = [choice(answers.get(qid), option) for answers in per_part]
    known = [p for p in seen if p is not None]
    return (max(known) if known else None), len(known) < len(seen)


# -- size ---------------------------------------------------------------------------------------------

def size(ep: Endpoint, meter: Meter, state: str) -> dict:
    state, withheld = withhold(state)
    if weight(state) > STATE_TOKENS:
        raise Unusable("the state is too long: keep it to a summary of the request and the facts about the change")
    questions = {qid: {"type": "noul", "instructions": text} for qid, _, text in SIZE_QUESTIONS}
    asked = ask_parts(ep, meter, [state], [questions])
    result: Dict[str, dict] = {}
    for qid, raises_to, _ in SIZE_QUESTIONS:
        p = noul(asked.answers[0].get(qid))
        answer = verdict(p) if qid in asked.asked[0] else "not_asked"
        result[qid] = {"p": p, "answer": answer, "raises_to": raises_to}
    rank = LEVELS.index
    level = max((a["raises_to"] for a in result.values() if a["answer"] == "yes"), key=rank, default="S")
    uncertain = [qid for qid, a in result.items() if a["answer"] == "uncertain"]
    not_asked = [qid for qid, a in result.items() if a["answer"] == "not_asked"]
    highest = max((result[qid]["raises_to"] for qid in uncertain + not_asked), key=rank, default=level)
    return {"kind": "size", "model": asked.model, "level": level,
            "could_be": highest if rank(highest) > rank(level) else None,
            "uncertain": uncertain, "not_asked": not_asked, "answers": result, "withheld": withheld,
            "yes_at": YES, "no_at": NO, "usage": asked.usage, **sending(meter, asked)}


def size_questions() -> dict:
    return {"kind": "size", "yes_at": YES, "no_at": NO, "rule": SIZE_RULE,
            "questions": [{"id": qid, "raises_to": level, "question": text} for qid, level, text in SIZE_QUESTIONS]}


# -- rules --------------------------------------------------------------------------------------------

def include_refusal(folder: Path, name: str) -> Optional[str]:
    """Why the file an `@name` line names may not be included, or None when it may: only a Markdown file
    that lies in the review file's own directory — reached through no path and no link that leaves it —
    under a name that does not look like a credential."""
    if "/" in name or "\\" in name or name in (".", ".."):
        return "an include names a file beside the review file, never a path"
    try:
        target = (folder / name).resolve(strict=True)
    except (OSError, RuntimeError):
        return "it cannot be read"
    if target.parent != folder.resolve():
        return "it leads outside the review file's directory"
    for candidate in (name, target.name):
        if not candidate.lower().endswith(".md"):
            return "only a Markdown file (.md) is included"
        if CREDENTIAL_PATH.search(candidate):
            return "its name looks like a credential"
    if not target.is_file():
        return "it is not a regular file"
    return None


def spliced(path: Path) -> Tuple[List[str], List[Dict[str, str]], int]:
    """The file's lines with each `@name` line outside a code fence replaced by the lines of the file of
    that name beside it, one level deep, its secret values withheld; the includes refused, each named with
    the reason; and the number of included lines withheld. A line naming nothing that exists stays as it
    is; a refused include is left out."""
    lines: List[str] = []
    refused: List[Dict[str, str]] = []
    withheld = 0
    fenced = False
    for line in read_text(str(path)).splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
        include = None if fenced else re.fullmatch(r"@(\S+)", line.strip())
        if include is None or not os.path.lexists(str(path.parent / include.group(1))):
            lines.append(line)
            continue
        name = include.group(1)
        reason = include_refusal(path.parent, name)
        text = ""
        if reason is None:
            try:
                text = read_text(str(path.parent / name))
            except Unusable:
                reason = "it cannot be read"
        reason = reason or credential_reason([name], text)
        if reason:
            refused.append({"path": name, "in": str(path), "why": reason})
            continue
        text, count = withhold(text)
        withheld += count
        lines += text.splitlines()
    return lines, refused, withheld


def review_items(paths: Sequence[str]) -> Tuple[List[Tuple[str, str, str]], List[Dict[str, str]], int]:
    """(id, title, text) of every numbered item under an "Always check" heading, the includes refused, and
    the number of included lines withheld. Ids are unique: a number met again, in another section or file,
    gets a suffix."""
    items: List[Tuple[str, str, str]] = []
    refused: List[Dict[str, str]] = []
    withheld = 0
    taken: Dict[str, int] = {}
    for path in paths:
        checking = False
        fenced = False
        current: Optional[List[str]] = None
        number = ""

        def keep() -> None:
            if current is None:
                return
            text = "\n".join(part.rstrip() for part in current).strip()
            title = re.match(r"\*\*(.+?)\*\*", text)
            qid = "item-" + number
            taken[qid] = taken.get(qid, 0) + 1
            if taken[qid] > 1:
                qid += "-%d" % taken[qid]
            items.append((qid, title.group(1) if title else text[:80], text))

        lines, refused_here, withheld_here = spliced(Path(path))
        refused += refused_here
        withheld += withheld_here
        for line in lines:
            if line.lstrip().startswith("```"):
                fenced = not fenced
            elif not fenced and line.startswith("#"):
                keep()
                current = None
                checking = re.match(r"#+\s*Always check\b", line) is not None
                continue
            if not checking:
                continue
            numbered = None if fenced else re.match(r"(\d+)\.\s+(.*)", line)
            if numbered:
                keep()
                number, current = numbered.group(1), [numbered.group(2)]
            elif current is not None:
                current.append(line)
        keep()
    return items, refused, withheld


def rules(ep: Endpoint, meter: Meter, diff: str, review_files: Sequence[str]) -> dict:
    items, refused, withheld = review_items(review_files)
    if not items:
        raise Unusable("the review files hold no numbered item under an \"Always check\" heading")
    kept: List[str] = []
    dropped = []
    for paths, text in diff_sections(diff):
        reason = credential_reason(paths, text)
        named = next((p for p in paths if p[:2] not in ("a/", "b/")), paths[0] if paths else "")
        if reason:
            dropped.append({"path": named, "why": reason})
            continue
        text, count = withhold(text)
        withheld += count
        kept.append(text)
    parts = states(kept, STATE_TOKENS)
    if not parts:
        raise Unusable("nothing of the diff is left to send")
    questions = {}
    for qid, _, text in items:
        questions[qid] = {"type": "choice", "criteria": RULE_CRITERIA,
                          "instructions": "Judge only what this diff shows. Does it break this project review rule?\n\n" + text}
    asked = ask_parts(ep, meter, parts, [questions] * len(parts))
    every = range(len(parts))
    found = []
    for qid, title, _ in items:
        seen = asked.over(qid, every)
        outcome, worst, _ = outcome_of(seen, len(parts), qid, "violates", "complies")
        found.append({"id": qid, "title": title, "verdict": outcome, "p_violates": worst, "parts_asked": len(seen)})
    order = {"violates": 0, "uncertain": 1, "not_asked": 2, "complies": 3, "not_shown": 4}
    found.sort(key=lambda i: (order[i["verdict"]], -(i["p_violates"] or 0.0)))
    return {"kind": "rules", "model": asked.model, "parts": len(parts), **sending(meter, asked), "dropped": dropped,
            "refused": refused, "withheld": withheld, "items": found, "yes_at": YES, "no_at": NO,
            "usage": asked.usage}


# -- done ---------------------------------------------------------------------------------------------

Claim = Tuple[str, Optional[List[str]]]


def read_claims(path: str) -> Dict[str, Claim]:
    """id -> (claim text, its own evidence files or None for all of them). The file holds a list of claim
    texts, or an object of id to a claim text or to {"claim": text, "evidence": [paths]}."""
    try:
        data = json.loads(read_text(path))
    except ValueError:
        raise Unusable("%s is not JSON: give an object of id to claim, or a list of claims" % path)
    if isinstance(data, list):
        data = {"claim-%d" % (n + 1): text for n, text in enumerate(data)}
    claims: Dict[str, Claim] = {}
    for qid, value in (data.items() if isinstance(data, dict) else ()):
        if isinstance(value, dict):
            text, files = value.get("claim"), value.get("evidence")
        else:
            text, files = value, None
        if files is not None and not (isinstance(files, list) and files and all(isinstance(f, str) for f in files)):
            raise Unusable("the evidence of claim %s must be a list of file paths" % qid)
        if not isinstance(text, str) or not text.strip():
            raise Unusable("%s must give every claim a text" % path)
        claims[str(qid)] = (text, files)
    if not claims:
        raise Unusable("%s holds no claim" % path)
    bad = [qid for qid in claims if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", qid)]
    if bad:
        raise Unusable("claim ids are letters, digits, dot, dash or underscore, at most 64: %s" % ", ".join(bad))
    return claims


def done(ep: Endpoint, meter: Meter, claims: Dict[str, Claim], evidence_files: Sequence[str]) -> dict:
    """Each claim asked over its own evidence files (all of them when it names none)."""
    files = list(dict.fromkeys(list(evidence_files) + [f for _, own in claims.values() for f in (own or [])]))
    parts: List[str] = []
    part_file: List[str] = []
    withheld = 0
    for path in files:
        text, count = withhold(read_text(path))
        withheld += count
        cut = pieces(text, STATE_TOKENS, "=== %s ===\n" % path)
        parts += cut
        part_file += [path] * len(cut)
    if not parts:
        raise Unusable("the evidence files are empty")
    questions: Dict[str, dict] = {}
    for qid, (text, _) in claims.items():
        text, count = withhold(text)
        withheld += count
        questions[qid] = {"type": "choice", "criteria": CLAIM_CRITERIA,
                          "instructions": "Does this evidence support the claim from a report of finished work?\n\nClaim: " + text}
    questions_of = [{qid: q for qid, q in questions.items() if path in (claims[qid][1] or evidence_files)}
                    for path in part_file]
    asked = ask_parts(ep, meter, parts, questions_of)
    out = []
    for qid, (text, own) in claims.items():
        mine = [i for i, path in enumerate(part_file) if path in (own or evidence_files)]
        seen = asked.over(qid, mine)
        outcome, against, support = outcome_of(seen, len(mine), qid, "contradicted", "supported")
        out.append({"id": qid, "claim": text, "verdict": outcome, "p_supported": support, "p_contradicted": against,
                    "parts_asked": len(seen)})
    return {"kind": "done", "model": asked.model, "parts": len(parts), **sending(meter, asked), "withheld": withheld,
            "claims": out, "yes_at": YES, "no_at": NO, "usage": asked.usage}


# -- the command --------------------------------------------------------------------------------------

def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog="pipeline-decide", description="Ask a decision model about a change.")
    sub = top.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="whether the decision model is on, where, for which kinds, and the key")
    listed = sub.add_parser("questions", help="the questions a kind asks, without asking them")
    listed.add_argument("kind", choices=("size",))
    sized = sub.add_parser("size", help="S, M or L for the change the state file describes")
    sized.add_argument("--state", required=True)
    checked = sub.add_parser("rules", help="the review files' Always-check items over a diff")
    checked.add_argument("--diff", required=True)
    checked.add_argument("--rules", required=True, action="append")
    claimed = sub.add_parser("done", help="a report's claims over the evidence")
    claimed.add_argument("--claims", required=True)
    claimed.add_argument("--evidence", required=True, action="append")
    return top


def run(argv: Sequence[str], env: Dict[str, str]) -> Tuple[int, dict]:
    args = parser().parse_args(argv)
    if args.command == "questions":
        return 0, size_questions()
    kind = args.command if args.command in KINDS else None
    ep = endpoint(kind, env)
    if args.command == "status":
        return 0, {"on": True, "endpoint": ep.url, "model": ep.model, "kinds": list(ep.kinds),
                   "key": ep.key_note, "key_file": str(ep.key_file), "limits": ep.limits.as_json()}
    meter = Meter(ep.limits)
    if args.command == "size":
        return 0, size(ep, meter, read_text(args.state))
    if args.command == "rules":
        return 0, rules(ep, meter, read_text(args.diff), args.rules)
    return 0, done(ep, meter, read_claims(args.claims), args.evidence)


def main(argv: Sequence[str]) -> int:
    try:
        status, result = run(argv, dict(os.environ))
    except Off as off:
        status, result = 3, {"on": False, "why": str(off)}
    except Unusable as error:
        print("pipeline-decide: %s" % error, file=sys.stderr)
        return 2
    except Failed as error:
        print("pipeline-decide: %s" % error, file=sys.stderr)
        return 4
    print(json.dumps(result, indent=2, ensure_ascii=False))
    stopped = result.get("stopped")
    if isinstance(stopped, dict):
        print("pipeline-decide: stopped sending: %s (%s); what it did not ask is not_asked"
              % (stopped["why"], stopped["setting"]), file=sys.stderr)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
