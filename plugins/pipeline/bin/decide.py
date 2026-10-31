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
key block), and every text sent but the review files' own items has the values of secret-looking lines withheld (a password or token
assignment, an Authorization or Cookie header, a password inside a URI, a known token shape). The
answer counts what was dropped and withheld. The filter is a net, not a guarantee: what is not meant
to leave the machine does not go into a state, claims or evidence file.

Answers print as JSON on standard output. A probability of YES or more counts as yes, NO or less as no,
anything between — or no readable answer — as uncertain: the session settles an uncertain answer by
reading the code.

Exit status: 0 answered; 3 off (no endpoint, or the kind is left out), nothing sent; 4 the endpoint
failed or answered something unreadable; 2 the input or the configuration is unusable.
"""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

YES = 0.85
NO = 0.15
DEFAULT_MODEL = "jev-latest"
TIMEOUT = 60
# The API takes a body of 256000 bytes, and a state with its longest question must fit the model's
# context of 32k tokens; a state is held to an estimate of 20000 tokens, counted generously for text
# that is not ASCII.
STATE_TOKENS = 20_000
LINE_CHARS = 4_000
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
    r"(?<![A-Za-z0-9_-])(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}"
    r"|xox[abposr]-[A-Za-z0-9-]{10,}|sk_(live|test)_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{20,}|sk_[a-z0-9-]+_[A-Za-z0-9]{16,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})")
# A name holding a secret word, then one `=`, `:`, `:=` or `=>` (never `==`, `::` or `->`), then its value: a
# quoted string, or everything up to a separator (`&`, `,`, `;`, `)`), a comment after a space, or the end of
# the line. `value_is_code` leaves a value that is a type, a literal or a reference to other code.
SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?P<head>(?<![\w.-])(?P<name>[\w.-]{0,64}"
    r"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|credentials?)"
    r"[\w.-]{0,64})[\"']?[ \t]{0,8}(?<![=:!<>])(?::=|=>|=|:)(?![=:>])[ \t]{0,8})"
    r"(?P<value>\"[^\"\n]{0,512}\"|'[^'\n]{0,512}'|[^\s\"'&,;)][^\n&,;)]{0,511}?)"
    r"(?=[ \t]+(?:#|//)|[ \t]{0,64}(?:[&,;)]|$))")
CODE_WORDS = frozenset(("string", "str", "int", "integer", "bool", "boolean", "number", "float", "double", "bytes",
                        "none", "null", "nil", "true", "false", "undefined", "any", "void", "object", "array",
                        "mixed", "unknown", "never"))
CODE_PREFIXES = ("$", "@", "%env(", "${", "process.env", "os.environ", "getenv(", "env(", "this.", "self.", "this->")
SECRET_HEADER = re.compile(r"(?i)\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*:\s*)(\S.*)$")
URI_PASSWORD = re.compile(r"((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}://[^/\s:@]{1,256}:)([^@\s/]{1,256})(@)", re.I)
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


@dataclass(frozen=True)
class Endpoint:
    url: str
    model: str
    key: Optional[str]
    key_file: Path
    key_note: str
    local: bool
    kinds: Tuple[str, ...]


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
    return Endpoint(base.rstrip("/") + "/v1/systemone", model, key, key_file, note, local, kinds)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the request to wherever it points; it is refused as an error instead."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


def scrub(text: str, key: Optional[str]) -> str:
    return text.replace(key, "***") if key else text


def ask(ep: Endpoint, state: str, questions: Dict[str, dict]) -> Tuple[Dict[str, object], Dict[str, int], str]:
    """One systemone request: the answers by question id, the usage, and the model that answered."""
    body = json.dumps({"state": state, "model": ep.model, "questions": questions}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if ep.key:
        headers["Authorization"] = "Bearer " + ep.key
    request = urllib.request.Request(ep.url, data=body, headers=headers, method="POST")
    handlers: List[urllib.request.BaseHandler] = [_NoRedirect()]
    if ep.local:
        handlers.append(urllib.request.ProxyHandler({}))
    try:
        with urllib.request.build_opener(*handlers).open(request, timeout=TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        hint = HTTP_HINTS.get(error.code) or ("it redirected, and a redirect is never followed: check the base URL"
                                              if 300 <= error.code < 400 else "an error")
        if error.code == 401:
            hint += " (the key is %s; DECISION_MODEL_API_KEY in %s)" % (ep.key_note, ep.key_file)
        raise Failed("the endpoint answered %d: %s" % (error.code, hint))
    except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
        reason = getattr(error, "reason", error)
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

def withhold(text: str) -> Tuple[str, int]:
    """The text with the values of secret-looking lines replaced, and how many lines were touched."""
    out: List[str] = []
    count = 0
    in_block = False
    for line in text.splitlines(keepends=True):
        if in_block or KEY_BLOCK_BEGIN.search(line):
            in_block = not KEY_BLOCK_END.search(line)
            out.append(WITHHELD + "\n")
            count += 1
            continue
        changed = scrub_line(line)
        if changed != line:
            count += 1
            if line.endswith("\n") and not changed.endswith("\n"):
                changed += "\n"
        out.append(changed)
    return "".join(out), count


def value_is_code(name: str, value: str) -> bool:
    """A value that is a type, a literal, the name again, or a reference to other code — not a secret."""
    if value[:1] in "\"'":
        return False
    word = re.split(r"[\s|]", value.strip(), maxsplit=1)[0].strip("?[]").lower()
    last = re.split(r"[.-]", name)[-1].lower()
    a_file = re.search(r"\.(php|py|js|mjs|ts|tsx|jsx|rb|go|rs|java|kt|cs|twig|html|css|ya?ml|json|xml|md|txt|log|sh)$",
                       name, re.I) is not None
    return (word in CODE_WORDS or word == last or word == name.lower() or "(" in value or a_file
            or value.startswith(CODE_PREFIXES))


def scrub_line(line: str) -> str:
    """One line with its secret-looking values withheld; every pattern is bounded, so a long line costs
    time in proportion to its length."""
    body = line.rstrip("\r\n")
    end = line[len(body):]
    body = URI_PASSWORD.sub(lambda m: m.group(1) + WITHHELD + m.group(3), body)
    body = TOKEN_SHAPES.sub(WITHHELD, body)
    body = SECRET_HEADER.sub(lambda m: m.group(1) + m.group(2) + WITHHELD, body)
    body = SECRET_ASSIGNMENT.sub(
        lambda m: m.group(0) if value_is_code(m.group("name"), m.group("value")) else m.group("head") + WITHHELD, body)
    return body + end


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


def ask_over(ep: Endpoint, parts: Sequence[str], questions: Dict[str, dict]) -> Tuple[List[Dict[str, object]], Dict[str, int], str, int]:
    """Every question over every part: one answers map per part, the summed usage, the model, the requests."""
    per_part: List[Dict[str, object]] = []
    usage: Dict[str, int] = {}
    model = ep.model
    requests = 0
    for state in parts:
        answers: Dict[str, object] = {}
        for batch in batches(state, questions):
            got, used, model = ask(ep, state, batch)
            answers.update(got)
            add_usage(usage, used)
            requests += 1
        per_part.append(answers)
    return per_part, usage, model, requests


def worst_and_doubt(per_part: Sequence[Dict[str, object]], qid: str, option: str) -> Tuple[Optional[float], bool]:
    """The highest probability of `option` across the parts, and whether any part gave no readable one."""
    seen = [choice(answers.get(qid), option) for answers in per_part]
    known = [p for p in seen if p is not None]
    return (max(known) if known else None), len(known) < len(seen)


# -- size ---------------------------------------------------------------------------------------------

def size(ep: Endpoint, state: str) -> dict:
    state, withheld = withhold(state)
    if weight(state) > STATE_TOKENS:
        raise Unusable("the state is too long: keep it to a summary of the request and the facts about the change")
    questions = {qid: {"type": "noul", "instructions": text} for qid, _, text in SIZE_QUESTIONS}
    answers, usage, model = ask(ep, state, questions)
    result: Dict[str, dict] = {}
    for qid, raises_to, _ in SIZE_QUESTIONS:
        p = noul(answers.get(qid))
        result[qid] = {"p": p, "answer": verdict(p), "raises_to": raises_to}
    rank = LEVELS.index
    level = max((a["raises_to"] for a in result.values() if a["answer"] == "yes"), key=rank, default="S")
    uncertain = [qid for qid, a in result.items() if a["answer"] == "uncertain"]
    highest = max((result[qid]["raises_to"] for qid in uncertain), key=rank, default=level)
    return {"kind": "size", "model": model, "level": level,
            "could_be": highest if rank(highest) > rank(level) else None,
            "uncertain": uncertain, "answers": result, "withheld": withheld,
            "yes_at": YES, "no_at": NO, "usage": usage}


def size_questions() -> dict:
    return {"kind": "size", "yes_at": YES, "no_at": NO, "rule": SIZE_RULE,
            "questions": [{"id": qid, "raises_to": level, "question": text} for qid, level, text in SIZE_QUESTIONS]}


# -- rules --------------------------------------------------------------------------------------------

def spliced(path: Path) -> List[str]:
    """The file's lines with each `@name` line outside a code fence replaced by the lines of the file of
    that name beside it, one level deep; a line naming no such file stays as it is."""
    lines: List[str] = []
    fenced = False
    for line in read_text(str(path)).splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
        include = None if fenced else re.fullmatch(r"@(\S+)", line.strip())
        beside = (path.parent / include.group(1)).resolve() if include else None
        if beside is not None and beside.parent == path.parent.resolve() and beside.is_file():
            lines += read_text(str(beside)).splitlines()
        else:
            lines.append(line)
    return lines


def review_items(paths: Sequence[str]) -> List[Tuple[str, str, str]]:
    """(id, title, text) of every numbered item under an "Always check" heading. Ids are unique: a number
    met again, in another section or file, gets a suffix."""
    items: List[Tuple[str, str, str]] = []
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

        for line in spliced(Path(path)):
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
    return items


def rules(ep: Endpoint, diff: str, review_files: Sequence[str]) -> dict:
    items = review_items(review_files)
    if not items:
        raise Unusable("the review files hold no numbered item under an \"Always check\" heading")
    kept: List[str] = []
    dropped = []
    withheld = 0
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
    per_part, usage, model, requests = ask_over(ep, parts, questions)
    found = []
    for qid, title, _ in items:
        worst, doubt = worst_and_doubt(per_part, qid, "violates")
        complies, _ = worst_and_doubt(per_part, qid, "complies")
        if worst is not None and worst >= YES:
            outcome = "violates"
        elif doubt or worst is None or worst > NO:
            outcome = "uncertain"
        elif complies is not None and complies >= YES:
            outcome = "complies"
        else:
            outcome = "not_shown"
        found.append({"id": qid, "title": title, "verdict": outcome, "p_violates": worst})
    order = {"violates": 0, "uncertain": 1, "complies": 2, "not_shown": 3}
    found.sort(key=lambda i: (order[i["verdict"]], -(i["p_violates"] or 0.0)))
    return {"kind": "rules", "model": model, "parts": len(parts), "requests": requests, "dropped": dropped,
            "withheld": withheld, "items": found, "yes_at": YES, "no_at": NO, "usage": usage}


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


def done(ep: Endpoint, claims: Dict[str, Claim], evidence_files: Sequence[str]) -> dict:
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
    usage: Dict[str, int] = {}
    model = ep.model
    requests = 0
    per_part: List[Dict[str, object]] = []
    for state, path in zip(parts, part_file):
        asked = {qid: q for qid, q in questions.items() if path in (claims[qid][1] or evidence_files)}
        answers: Dict[str, object] = {}
        for batch in batches(state, asked) if asked else []:
            got, used, model = ask(ep, state, batch)
            answers.update(got)
            add_usage(usage, used)
            requests += 1
        per_part.append(answers)
    out = []
    for qid, (text, own) in claims.items():
        mine = [a for a, path in zip(per_part, part_file) if path in (own or evidence_files)]
        against, doubt = worst_and_doubt(mine, qid, "contradicted")
        support, _ = worst_and_doubt(mine, qid, "supported")
        if against is not None and against >= YES:
            outcome = "contradicted"
        elif doubt or against is None or against > NO:
            outcome = "uncertain"
        elif support is not None and support >= YES:
            outcome = "supported"
        else:
            outcome = "not_shown"
        out.append({"id": qid, "claim": text, "verdict": outcome, "p_supported": support, "p_contradicted": against})
    return {"kind": "done", "model": model, "parts": len(parts), "requests": requests, "withheld": withheld,
            "claims": out, "yes_at": YES, "no_at": NO, "usage": usage}


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
                   "key": ep.key_note, "key_file": str(ep.key_file)}
    if args.command == "size":
        return 0, size(ep, read_text(args.state))
    if args.command == "rules":
        return 0, rules(ep, read_text(args.diff), args.rules)
    return 0, done(ep, read_claims(args.claims), args.evidence)


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
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
