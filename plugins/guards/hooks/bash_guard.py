#!/usr/bin/env python3
"""PreToolUse guard (Bash): block a short list of catastrophic commands.

Deliberately narrow: a tripwire for irreversible damage, not a policy engine.
Project-specific rules (test-suite discipline, container prefixes) belong in
each project's own .claude/settings.json hook.

The command is parsed, not pattern-matched. One scanner reads it as the shell
does: quotes, backslash escapes, a backslash-newline continuation (joined),
`#` comments (only where a word starts), `${…}`, `$((…))`, and the bodies of
here-documents, which are taken out of the command text before anything else
is read, so a body is never mistaken for commands. It is split into pipelines
on `;`, `&&`, `||`, `&`, parentheses and newlines (a newline after `|`, `&&`
or `||` continues the pipeline), and each pipeline into simple commands on
`|`. Redirections are taken out of argv -- the operator, an fd number glued
to it and its target -- so `2>&1` or `> log` is never read as an argument; a
here-document body and a `<<<` here-string are kept as the command's stdin.
Reserved words and grouping in front (`if`, `then`, `do`, `while`, `!`, `{`,
…; a `for`/`select`/`case` header is no command), leading VAR=val
assignments and wrappers (sudo, doas, env, nohup, time, nice, command, exec,
timeout, xargs, stdbuf, caffeinate, noglob, …, and flock <options>
<lockfile>, whose `-c '<line>'` is read as `sh -c`) are taken off before a
rule sees the program.

Every command line a command runs is judged by every rule, down to four
lines deep: a `$(…)`, backtick or `<(…)` substitution (unquoted, inside
double quotes, inside `${…}`, `$((…))` or `$[…]`, in an assignment, or in an
unquoted here-document); the text of `sh|bash|zsh|dash [options] -c
'<line>'`; the words of `eval`; the words of `ddev exec [-s|-d <value>] ...`
and the remote command of `ssh [options] <host> [options] ...` (joined, as
each joins them for the shell at the other end, and as given); the command
of `docker exec` and `kubectl exec`; and the script a program reads from its
stdin --
a shell with no script operand, `-`, `-s` or /dev/stdin (/dev/fd/0),
`source`/`.` of /dev/stdin, `ssh <host>` with no command, and `ddev ssh`.
What reaches a stdin is a here-document, a here-string, or the words of the
earlier segments of the pipeline and of every enclosing one (echo/printf
words also with their escapes decoded); a script read from stdin is not
also the stdin of the commands in it. A here-document is judged only as
what it is fed to: SQL to a database client, commands to one of those
readers, written text to a file (see `writes`); to anything else it is text.
A command that nests a command line more than four deep is refused, and so
is one nesting substitutions deeper than the scanner reads. A `$((` is
arithmetic only when the parenthesis closing its inner group is followed at
once by another; otherwise it is a substitution running a subshell.

Rules look at argv[0] and its arguments, so a commit message or an `echo`
that merely mentions a dangerous command passes. `cd` segments are tracked so
relative targets and bare pushes are judged from the directory the command
will actually run in; a nested command line starts from the directory its
command runs in, and its `cd` stays inside it.

Rules (each has cases in tests.sh):
  rm     recursive + force whose target resolves to /, $HOME, a /Volumes
         mount root, or a glob naming every entry of one of them ("<dir>/*",
         "<dir>/*/", "<dir>/.*", `**`, `{*,.*}`; `*`, `*/`, `.` while cwd is one)
  find   -delete, or -exec/-execdir/-ok running rm
  git    push with --force/-f (not --force-with-lease / --force-if-includes),
         a "+branch" refspec, --delete, or a ":branch" refspec aimed at main/
         master/develop/production, including a bare force-push while the
         checked-out branch is protected (or cannot be resolved), forced --all,
         a forced glob refspec whose destination can match one of them,
         --prune with --all, such a glob, or no refspec given, and --mirror
         (which force-updates and prunes every remote ref);
         branch -D / update-ref -d on main/master;
         commit whose message carries a Co-Authored-By: or Claude-Session:
         trailer (in -m, in a -F/--file message file, in a --trailer, or in a
         heredoc), only while the `forbid_assistant_commit_trailers` policy is
         on (policies.py; off by default)
  gh     only while the `github_rest_only` policy is on (policies.py; off by
         default, switched on per project with CLAUDE_KIT_GITHUB_REST_ONLY=1):
         `gh issue|pr|project|search ...`, `gh repo view`, `gh release list`
         and `gh api graphql`, which bill the GraphQL allowance the whole
         account shares; the refusal names the REST form
  sql    mysql, mariadb, mysqlsh, psql or `ddev mysql|mariadb|psql` executing
         (via -e / -c / --command, also inside a short-option group such as
         `-Ne`, or its stdin: a here-document, a here-string, or what an
         earlier segment of the pipeline -- or of an enclosing one -- feeds it)
         a statement that is DROP DATABASE/SCHEMA/TABLE, TRUNCATE, or DELETE
         FROM without WHERE. A DROP DATABASE of a name ending in _test or
         _test<digits> is a rebuildable scratch database and is let through
  ddev   `ddev delete` with --omit-snapshot / -O (drops the DB, no snapshot)
  curl   curl/wget sending a request body or upload (-d/--data*/--json/-F/-T/
         --upload-file, spaced, `=`-joined or attached as in `-d@f`/`-sd@f`;
         wget --post-*/--body-*) to a host that is not local
         (localhost, 127.0.0.1, ::1, *.ddev.site, *.test, *.local,
         *.localhost, or a bare hostname without a dot)
  phpstan/psalm/eslint
         --generate-baseline / -b (phpstan), --set-baseline / --update-baseline
         (psalm), or --suppress-all / --suppress-rule (eslint, into
         eslint-suppressions.json or --suppressions-location) while the
         baseline they would write already exists: the baseline only shrinks
         (the engineering standards, §PHP static analysis and §JavaScript and
         TypeScript static analysis); creating the first one is allowed, and
         eslint --prune-suppressions (which only removes) always is

  writes  a file written through the shell -- a `>`/`>>` redirect target, `tee`,
         `sed -i` / `perl -i`, or the destination of cp/mv/install -- gets the
         same two checks the Edit/Write hooks apply (bypass mode writes through
         Bash, and a rule that only watches Edit/Write is no rule):
           - plan_skill_gate.py: PHP source needs the clean-architecture-php
             rubric, JS/TS source the clean-architecture-js rubric, and a plan
             file the rubric of each language it orders — with the references
             the target needs and the skills of the stacks registered for the
             session — loaded first;
           - debt_guard.py: the written text (here-document body or
             here-string, echo/printf arguments, a sed `s///` replacement)
             may not carry a deferral marker or a static-analysis suppression
             into a source file.
         Scripted writes (python/php/node one-liners) are not seen; the rule
         in the engineering standards still binds them.

Each command name maps to its rule in SEGMENT_RULES; a new rule is one entry.

Fails open: any internal error exits 0. A hook must never wedge a session.
"""
import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
from typing import NamedTuple
from urllib.parse import urlparse


class Wrapper(NamedTuple):
    """How a command that runs another program reaches it."""

    value_options: frozenset  # its options that take the next word as their value
    operands: int = 0  # the words it reads after its options and before the program
    shell_options: frozenset = frozenset()  # an option here, after the operands, runs the rest with `sh -c`


PROTECTED = {"main", "master", "develop", "production"}
LOCAL_BRANCH_PROTECTED = {"main", "master"}
WRAPPERS = {
    # sudo's -h takes only an attached host (`-hhost`); alone it is --help
    "sudo": Wrapper(frozenset({
        "-a", "--auth-type", "-C", "--close-from", "-c", "--login-class", "-D", "--chdir",
        "-g", "--group", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-T",
        "--command-timeout", "-t", "--type", "-U", "--other-user", "-u", "--user",
    })),
    "doas": Wrapper(frozenset({"-a", "-C", "-u"})),
    "command": Wrapper(frozenset()),
    "exec": Wrapper(frozenset({"-a"})),
    "nohup": Wrapper(frozenset()),
    "time": Wrapper(frozenset({"-f", "--format", "-o", "--output"})),
    "nice": Wrapper(frozenset({"-n", "--adjustment"})),
    "env": Wrapper(frozenset({
        "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0", "-P",
    })),
    "flock": Wrapper(frozenset({"-w", "--timeout", "--wait", "-E", "--conflict-exit-code"}), 1,
                     frozenset({"-c", "--command"})),
    "timeout": Wrapper(frozenset({"-s", "--signal", "-k", "--kill-after"}), 1),
    "gtimeout": Wrapper(frozenset({"-s", "--signal", "-k", "--kill-after"}), 1),
    # GNU's -i/-e/-l take only an attached value; BSD's -J/-R/-S take the next word
    "xargs": Wrapper(frozenset({
        "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "-E", "-d", "-a", "--arg-file",
        "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--eof",
        "--process-slot-var",
    })),
    "stdbuf": Wrapper(frozenset({"-i", "--input", "-o", "--output", "-e", "--error"})),
    "gstdbuf": Wrapper(frozenset({"-i", "--input", "-o", "--output", "-e", "--error"})),
    "caffeinate": Wrapper(frozenset({"-t", "-w"})),
    "noglob": Wrapper(frozenset()),
    "nocorrect": Wrapper(frozenset()),
    "builtin": Wrapper(frozenset()),
}
# Reserved words that may stand in front of a simple command and run it
RESERVED_PREFIXES = {"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"}
# Reserved words that open a header which is not a command: `for x in …`, `select x in …`, `case w in`
RESERVED_HEADERS = {"for", "select", "case"}
PIPELINE_SEPARATORS = {";", "&&", "||", "&", "(", ")", ";;", ";&", ";;&", "\n"}
SEGMENT_SEPARATORS = {"|", "|&"}
# Operators after which a newline does not end the command line
CONTINUING = {"|", "|&", "&&", "||"}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
LOCAL_HOST_SUFFIXES = (".ddev.site", ".test", ".local", ".localhost")
CURL_BODY_FLAGS = {
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "--data-ascii", "--json", "-F", "--form", "--form-string", "-T",
    "--upload-file",
}
CURL_SHORT_BODY = set("dFT")
# curl's other short options that take a value (attached, the value is the rest of the group)
CURL_SHORT_WITH_VALUE = set("AbcCDeEhHKmoPQrtuUwxXyYz")
WGET_BODY_FLAGS = {"--post-data", "--post-file", "--body-data", "--body-file"}
GH_FLAGS_WITH_VALUE = {"-R", "--repo", "--hostname"}
GH_API_FLAGS_WITH_VALUE = GH_FLAGS_WITH_VALUE | {
    "-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header",
    "-q", "--jq", "-t", "--template", "--input", "--cache", "-p", "--preview",
}
# gh subcommands whose every action is billed to GraphQL
GH_GRAPHQL_COMMANDS = {"issue", "pr", "project", "search"}
# gh subcommands where only the named action is billed to GraphQL
GH_GRAPHQL_ACTIONS = {"repo": "view", "release": "list"}
# The REST (or board-queue) form of the commonly used refused commands, by "<subcommand> <action>"
GH_REST_FORMS = {
    "issue create": "gh api --method POST repos/OWNER/REPO/issues -f title=... -F body=@file",
    "issue view": "gh api repos/OWNER/REPO/issues/N",
    "issue comment": "gh api --method POST repos/OWNER/REPO/issues/N/comments -F body=@file",
    "issue close": "gh api --method PATCH repos/OWNER/REPO/issues/N -f state=closed",
    "issue list": "gh api 'repos/OWNER/REPO/issues?state=open&per_page=100'",
    "pr create": "gh api --method POST repos/OWNER/REPO/pulls -f title=... -f head=... -f base=main -F body=@file",
    "pr view": "gh api repos/OWNER/REPO/pulls/N",
    "pr list": "gh api 'repos/OWNER/REPO/pulls?state=open'",
    "repo view": "gh api repos/OWNER/REPO",
    "release list": "gh api repos/OWNER/REPO/releases",
}
GH_PROJECT_FORM = "the board queue (`board_enqueue`): the board is written only by its worker"
ATTRIBUTION_TRAILER = re.compile(r"(?i)\bco-authored-by\s*[:=]|\bclaude-session\s*:")
DANGEROUS_SQL = re.compile(r"\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\b", re.I)
SQL_DELETE = re.compile(r"\bDELETE\s+FROM\b", re.I)
SQL_WHERE = re.compile(r"\bWHERE\b", re.I)
SQL_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
HOME = os.path.realpath(os.path.expanduser("~"))
# Every shell operator a run of operator characters can hold, longest first
OPERATORS = ("&>>", "<<<", "<<-", ";;&", ";;", ";&", "&&", "||", "|&", "&>", ">>", ">&", "<&", ">|",
             "<>", "<<", ";", "&", "|", "(", ")", "<", ">")
OPERATOR_CHARS = set(";&|()<>")
HEREDOC_OPERATORS = {"<<", "<<-"}
REDIRECTS = {">", ">>", ">|", "&>", "&>>", ">&", "<", "<<", "<<-", "<<<", "<>", "<&"}
FD_WORD = re.compile(r"^(?:\d+|\{\w+\})$")
# What a backslash escape in $'…' stands for; any other escaped character stands for itself
ANSI_C_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "e": "\x1b", "f": "\f", "v": "\v"}
REDIRECT_OUT = {">", ">>", "&>", "&>>", ">|", "<>"}


class Expansion(NamedTuple):
    """A `$` construct read as one piece up to its balanced closing character."""

    opening: str  # the text that opens it, ending in its `opener`
    opener: str
    closer: str


# `$((` is not among them: it is arithmetic only when its inner group closes with `))` (Scanner.arithmetic)
EXPANSIONS = (Expansion("${", "{", "}"), Expansion("$[", "[", "]"))
# How deep substitutions and expansions may nest inside one another before a line is refused unread
SUBSTITUTION_LIMIT = 64
COPY_TOOLS = {"cp", "mv", "install"}

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:  # the sibling hooks own the two rules; without them this guard only does its own list
    import plan_skill_gate as rubric
    import debt_guard as debt
except Exception:  # pragma: no cover - a broken sibling must not wedge the shell
    rubric = debt = None
try:
    import policies
except Exception:  # pragma: no cover - without the policy reader every policy stays off
    policies = None

TRAILER_POLICY = "forbid_assistant_commit_trailers"
REST_POLICY = "github_rest_only"
STANDARDS = "the engineering standards (CLAUDE.standards.md"


# ---------------------------------------------------------------- parsing

class NestingTooDeep(Exception):
    """A command line nests substitutions or expansions deeper than SUBSTITUTION_LIMIT."""


class Token(str):
    """A shell word or operator, as the shell reads it.

    `op` marks an unquoted operator and `spaced` blank space before it; `quoted` marks a word
    with a quoted or escaped part, which is never a reserved word or an fd number; `subs` holds
    the command lines its command substitutions run. On a here-document operator, `body` is
    the text it feeds to the command and `subs` the substitutions an unquoted body runs.
    """

    def __new__(cls, text, op=False, spaced=True, quoted=False, subs=()):
        token = super().__new__(cls, text)
        token.op, token.spaced, token.quoted, token.subs = op, spaced, quoted, list(subs)
        token.body = None
        return token


class WordBuilder:
    """The parts of the word a scan is reading, and the substitutions inside it."""

    def __init__(self):
        self.parts, self.subs, self.quoted, self.started = [], [], False, False

    def add(self, text, quoted=False):
        """Append text to the word; an empty quoted part (`''`) still makes a word."""
        self.parts.append(text)
        self.started = True
        self.quoted = self.quoted or quoted

    def token(self):
        """The finished word as a Token."""
        return Token("".join(self.parts), False, True, self.quoted, self.subs)


class Scanner:
    """Read a command line into Tokens, one pass, the way the shell reads it.

    Single and double quotes, backslash escapes and a backslash-newline continuation (which
    joins the lines) are resolved; `#` starts a comment only where a word starts. `$(…)`,
    backticks and `<(…)`/`>(…)` stay in their word as written and their text is recorded on it;
    `${…}`, `$((…))`, `$[…]`, a `(( … ))` arithmetic command and `$'…'` are read as one piece,
    so a `<<` inside one is no operator, and the substitutions inside them are recorded on the
    word. At each newline that ends a command line, the bodies of the here-documents opened on
    it are taken out of the text and set on their operators, so no body is ever read as
    commands. Nesting deeper than SUBSTITUTION_LIMIT raises NestingTooDeep.
    """

    def __init__(self, text, depth=0):
        self.text, self.pos, self.pending, self.closed, self.depth = text, 0, [], False, depth
        self.not_arithmetic = set()  # positions of `((` and `$((` that open no arithmetic

    def enter(self):
        """Go one substitution or expansion deeper; past SUBSTITUTION_LIMIT the line is not read."""
        self.depth += 1
        if self.depth > SUBSTITUTION_LIMIT:
            raise NestingTooDeep()

    def scan(self, closing=False):
        """Read Tokens to the end of the text or, with `closing`, to the `)` that closes a substitution."""
        text, out = self.text, []
        word, delimiter_of, depth, blank = WordBuilder(), None, 0, True

        def finish():
            nonlocal word, delimiter_of
            if word.started:
                token = word.token()
                if delimiter_of is not None:
                    self.pending.append((delimiter_of, token))
                    delimiter_of = None
                out.append(token)
            word = WordBuilder()

        while self.pos < len(text):
            c = text[self.pos]
            if c == "\\":
                if not text.startswith("\n", self.pos + 1):
                    word.add(text[self.pos + 1:self.pos + 2], True)
                self.pos += 2
            elif c == "'":
                end = text.find("'", self.pos + 1)
                end = len(text) if end < 0 else end
                word.add(text[self.pos + 1:end], True)
                self.pos = end + 1
            elif c == '"':
                self.pos += 1
                word.add(self.double_quoted(word, '"'), True)
            elif c == "$" and self.dollar(word, False):
                pass
            elif c == "`":
                self.backtick(word)
            elif c == "#" and not word.started:
                end = text.find("\n", self.pos)
                self.pos = len(text) if end < 0 else end
                continue
            elif c in " \t":
                finish()
                self.pos += 1
                blank = True
                continue
            elif c == "\n":
                finish()
                if not (out and out[-1].op and out[-1] in CONTINUING):
                    out.append(Token("\n", True))
                self.pos += 1
                self.read_heredocs()
                blank = True
                continue
            elif c == "(" and not word.started and text.startswith("((", self.pos) and self.arithmetic(word, "((", True):
                pass
            elif c in "<>" and text.startswith("(", self.pos + 1):
                self.pos += 2
                word.add(c + "(" + self.substitution(word) + ")")
            elif c in OPERATOR_CHARS:
                if c == ")" and closing and depth == 0:
                    finish()
                    self.pos += 1
                    self.closed = True
                    return out
                finish()
                op = next(o for o in OPERATORS if text.startswith(o, self.pos))
                depth += (op == "(") - (op == ")")
                token = Token(op, True, blank)
                out.append(token)
                self.pos += len(op)
                if op in HEREDOC_OPERATORS:
                    delimiter_of = token
            else:
                word.add(c)
                self.pos += 1
            blank = False
        finish()
        return out

    def substitution(self, word):
        """Read a `$(…)` body up to its closing parenthesis, record its text on the word and return it."""
        start = self.pos
        self.enter()
        self.closed = False
        self.scan(closing=True)
        inner = self.text[start:self.pos - 1 if self.closed else self.pos]
        self.closed = False
        self.depth -= 1
        word.subs.append(inner)
        return inner

    def balanced(self, sink, depth, opener, closer):
        """Read from the cursor to the `closer` that brings `depth` to zero, and return the text read.

        Quotes and escapes are skipped as units; a `$` construct and a backtick substitution are
        read whole, so the command lines they run are recorded on `sink` and their parentheses
        and braces are not counted.
        """
        text, start = self.text, self.pos
        self.enter()
        while self.pos < len(text) and depth:
            c = text[self.pos]
            if c == "\\":
                self.pos = min(self.pos + 2, len(text))
            elif c == "'":
                close = text.find("'", self.pos + 1)
                self.pos = len(text) if close < 0 else close + 1
            elif c == '"':
                self.pos += 1
                self.double_quoted(sink, '"')
            elif c == "`":
                self.backtick(sink)
            elif c == "$" and self.dollar(sink, False):
                pass
            else:
                depth += (c == opener) - (c == closer)
                self.pos += 1
        self.depth -= 1
        return text[start:self.pos]

    def arithmetic(self, word, opening, quoted):
        """Read a `(( … ))` arithmetic command or a `$(( … ))` expansion at the cursor into the word as one piece.

        It is one only when the parenthesis that closes the inner `(` is followed at once by
        another; otherwise (`((cd x; ls) )`, `$((cd x; ls) )`) it is a subshell inside a subshell
        or a substitution, the cursor is left where it was and False is returned. A position
        found not to open one is remembered, so text nesting many of them is read once.

        @param opening `((` or `$((`, the text at the cursor
        @param quoted  whether the piece is added to the word as quoted text
        """
        start, pending = self.pos, list(self.pending)
        if start in self.not_arithmetic:
            return False
        self.pos += len(opening)
        sink = WordBuilder()
        self.balanced(sink, 1, "(", ")")
        if not self.text.startswith(")", self.pos):
            self.pos, self.pending = start, pending
            self.not_arithmetic.add(start)
            return False
        self.pos += 1
        word.add(self.text[start:self.pos], quoted)
        word.subs.extend(sink.subs)
        return True

    def dollar(self, word, in_quotes):
        """Read the `$` construct at the cursor into the word; False when it is a plain `$`."""
        text, start = self.text, self.pos
        nxt = text[start + 1:start + 2]
        enclosed = next((e for e in EXPANSIONS if text.startswith(e.opening, start)), None)
        if text.startswith("$((", start) and self.arithmetic(word, "$((", False):
            pass
        elif enclosed is not None:
            self.pos += len(enclosed.opening)
            sink = WordBuilder()
            word.add(text[start:self.pos] + self.balanced(sink, 1, enclosed.opener, enclosed.closer))
            word.subs.extend(sink.subs)
        elif nxt == "(":
            self.pos += 2
            word.add("$(" + self.substitution(word) + ")")
        elif nxt == "'" and not in_quotes:
            end, parts = start + 2, []
            while end < len(text) and text[end] != "'":
                if text[end] == "\\" and end + 1 < len(text):
                    parts.append(ANSI_C_ESCAPES.get(text[end + 1], text[end + 1]))
                    end += 2
                else:
                    parts.append(text[end])
                    end += 1
            word.add("".join(parts), True)
            self.pos = end + 1
        elif nxt == '"' and not in_quotes:
            self.pos += 2
            word.add(self.double_quoted(word, '"'), True)
        else:
            return False
        return True

    def backtick(self, word):
        """Read a backtick substitution into the word and record the command line it runs."""
        text, end, parts = self.text, self.pos + 1, []
        while end < len(text) and text[end] != "`":
            if text[end] == "\\" and text[end + 1:end + 2] in ("`", "$", "\\"):
                parts.append(text[end + 1])
                end += 2
            else:
                parts.append(text[end])
                end += 1
        word.subs.append("".join(parts))
        word.add(text[self.pos:end + 1])
        self.pos = end + 1

    def double_quoted(self, word, terminator):
        """Read double-quoted text up to `terminator` (None: to the end), recording its substitutions on the word."""
        text, parts = self.text, []
        while self.pos < len(text):
            c = text[self.pos]
            if c == terminator:
                self.pos += 1
                break
            if c == "\\" and self.pos + 1 < len(text):
                nxt = text[self.pos + 1]
                if nxt != "\n":
                    parts.append(nxt if nxt in '$`"\\' else "\\" + nxt)
                self.pos += 2
                continue
            if c == "$" or c == "`":
                inner = WordBuilder()
                if c == "`":
                    self.backtick(inner)
                elif not self.dollar(inner, True):
                    inner.add(c)
                    self.pos += 1
                parts.extend(inner.parts)
                word.subs.extend(inner.subs)
                continue
            parts.append(c)
            self.pos += 1
        return "".join(parts)

    def read_heredocs(self):
        """Take the bodies of the pending here-documents out of the text, from the cursor on.

        A body ends at a line that is exactly its delimiter -- for `<<-`, after its leading tabs
        are stripped -- or at the end of the text. An unquoted delimiter leaves the body open to
        expansion, so its substitutions are recorded on the operator.
        """
        text, pending, self.pending = self.text, self.pending, []
        for operator, delimiter in pending:
            lines, strip_tabs = [], operator == "<<-"
            while self.pos < len(text):
                end = text.find("\n", self.pos)
                end = len(text) if end < 0 else end
                line = text[self.pos:end]
                self.pos = min(end + 1, len(text))
                if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                    break
                lines.append(line)
            operator.body = "\n".join(lines)
            if not delimiter.quoted:
                reader, sink = Scanner(operator.body, self.depth), WordBuilder()
                reader.double_quoted(sink, None)
                operator.subs = sink.subs


class Segment:
    """One simple command of a pipeline.

    `argv` holds its words with every redirection taken out; `written` the files its
    redirections write; `stdin` the here-document bodies and here-strings fed to it; `nested`
    the command lines its substitutions run.
    """

    def __init__(self):
        self.argv, self.written, self.stdin, self.nested = [], [], [], []

    def empty(self):
        """Report whether the segment holds nothing at all."""
        return not (self.argv or self.written or self.stdin or self.nested)


def parse(cmd):
    """Read a command line into lines, each a list of pipelines, each a list of Segments.

    A redirection never reaches argv: its operator, the fd number glued to it (`2>`, `{fd}>`)
    and its target are taken out. The targets it writes (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, and
    `>&` to a name that is not an fd) go to `written`; a here-document body and a here-string
    go to `stdin`.
    """
    tokens = Scanner(cmd).scan() + [Token("\n", True)]
    lines, line, pipeline, segment = [], [], [], Segment()
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if tok.op and (tok in PIPELINE_SEPARATORS or tok in SEGMENT_SEPARATORS):
            if not segment.empty():
                pipeline.append(segment)
            segment = Segment()
            if tok in PIPELINE_SEPARATORS:
                if pipeline:
                    line.append(pipeline)
                pipeline = []
            if tok == "\n" and line:
                lines.append(line)
                line = []
        elif tok.op and tok in REDIRECTS:
            prev = tokens[i - 2] if i >= 2 else None
            if (not tok.spaced and segment.argv and segment.argv[-1] is prev
                    and not prev.quoted and FD_WORD.match(prev)):
                segment.argv.pop()  # the fd number of `2>`
            segment.nested.extend(tok.subs)
            if tok.body is not None:
                segment.stdin.append(tok.body)
            target = tokens[i] if i < len(tokens) and not tokens[i].op else None
            if target is None:
                continue
            i += 1
            if tok in HEREDOC_OPERATORS:
                continue  # the target is the delimiter
            segment.nested.extend(target.subs)
            if tok == "<<<":
                segment.stdin.append(target)
            elif tok in REDIRECT_OUT or (tok == ">&" and not re.match(r"^(?:\d+|-)$", target)):
                segment.written.append(target)
        else:
            segment.argv.append(tok)
            segment.nested.extend(tok.subs)
    return lines


def option_words(word, value_options):
    """How many words an option takes, its value included, read as getopt reads it.

    A long option takes the next word when it is a value option written without `=`. In a
    short group (`-Eu`, `-nw`) the first letter that takes a value takes the rest of the
    group (`-upostgres`), or the next word when it ends the group.
    """
    if word.startswith("--"):
        return 2 if word in value_options else 1
    for k, letter in enumerate(word[1:], start=1):
        if "-" + letter in value_options:
            return 1 if word[k + 1:] else 2
    return 1


def strip_wrappers(argv):
    """Drop leading VAR=val assignments and wrappers (sudo, env, nohup, flock <options> <lockfile>, ...).

    A wrapper's own options are skipped, each value option with its value, then its operands.
    When one of its shell options follows (`flock <lockfile> -c '<line>'`), the program that
    runs is a shell reading that line, and `sh -c '<line>'` is returned.
    """
    i = 0
    while i < len(argv):
        tok = argv[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            i += 1
            continue
        wrapper = WRAPPERS.get(os.path.basename(tok))
        if wrapper is None:
            break
        i += 1
        while i < len(argv) and argv[i].startswith("-"):
            i += option_words(argv[i], wrapper.value_options)
        i += wrapper.operands
        if i < len(argv) and argv[i] in wrapper.shell_options:
            return ["sh", "-c", *argv[i + 1:]]
    return argv[i:]


def command_words(argv):
    """The program a simple command runs and its arguments.

    Unquoted reserved words in front (`if`, `then`, `do`, `while`, `!`, `{`, `}`, …) are taken
    off; a `for`, `select` or `case` header names no program and gives an empty list; then the
    assignments and wrappers go (strip_wrappers).
    """
    i = 0
    while i < len(argv) and not getattr(argv[i], "quoted", False):
        if argv[i] in RESERVED_HEADERS:
            return []
        if argv[i] == "function":
            i += 1 if argv[i + 1:i + 2] == ["{"] else 2  # `function name`, or zsh's anonymous `function {`
            continue
        if argv[i] not in RESERVED_PREFIXES:
            break
        i += 1
    return strip_wrappers(argv[i:])


def cd_target(argv, cwd):
    """The directory a `cd`/`pushd` segment moves to from `cwd`; None when the segment is no such move."""
    if not argv or os.path.basename(argv[0]) not in ("cd", "pushd"):
        return None
    return resolve(cwd, argv[1]) if len(argv) > 1 else HOME


def resolve(cwd, path):
    path = os.path.expandvars(os.path.expanduser(path))
    if not os.path.isabs(path):
        path = os.path.join(cwd, path)
    return os.path.realpath(path)


# ------------------------------------------------------------------ rules

def is_root_like(path):
    if path in ("/", HOME, "/Volumes"):
        return True
    return path.startswith("/Volumes/") and path.count("/") == 2


def every_entry(component):
    """Report whether a glob path component names every entry, or every entry of a kind, of its directory.

    `*`, `**`, `?*`, `.*`, `.[!.]*`, `..?*`, and a brace group of such (`{*,.*}`); a literal
    character other than a leading dot (`*.log`) narrows the glob and it no longer counts.
    """
    if component.startswith("{") and component.endswith("}") and "," in component:
        return all(every_entry(part) for part in component[1:-1].split(","))
    rest = re.sub(r"\[[^]]*\]", "", component.lstrip("."))
    return "*" in rest and set(rest) <= {"*", "?"}


def rm_danger(argv, cwd):
    flags, targets, opts_done = [], [], False
    for a in argv[1:]:
        if not opts_done and a == "--":
            opts_done = True
        elif not opts_done and a.startswith("-") and len(a) > 1:
            flags.append(a)
        else:
            targets.append(a)
    short = [f for f in flags if not f.startswith("--")]
    recursive = "--recursive" in flags or any("r" in f or "R" in f for f in short)
    force = "--force" in flags or any("f" in f for f in short)
    if not (recursive and force):
        return None
    for t in targets:
        p = os.path.expandvars(os.path.expanduser(t))
        parts = [c for c in p.split("/") if c not in ("", ".")]
        while parts and every_entry(parts[-1]):
            parts.pop()  # `dir/*`, `dir/*/`, `dir/.*` delete what `dir` holds
        base = resolve(cwd, ("/" if p.startswith("/") else "") + "/".join(parts) or ".")
        if is_root_like(base):
            return (
                f"recursive force-delete of {t!r} resolves to {base} "
                f"(/, the home directory, or a mount root)."
            )
    return None


def find_danger(argv):
    if "-delete" in argv:
        return "find -delete removes everything it matches; run it without -delete first and ask the user."
    for i, a in enumerate(argv):
        if a in ("-exec", "-execdir", "-ok", "-okdir") and i + 1 < len(argv):
            if os.path.basename(argv[i + 1]) == "rm":
                return "find -exec rm removes everything it matches; list the matches first and ask the user."
    return None


def current_branch(cwd):
    try:
        res = subprocess.run(
            ["git", "-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
            capture_output=True, text=True, timeout=3,
        )
    except Exception:
        return None
    return res.stdout.strip() or None if res.returncode == 0 else None


def branch_of(refspec):
    ref = refspec.lstrip("+")
    dst = ref.split(":", 1)[1] if ":" in ref else ref
    return dst.rsplit("/", 1)[-1]


def destination(refspec):
    """The remote ref a push refspec writes, qualified as git does an unqualified one (`x` -> `refs/heads/x`)."""
    ref = refspec.lstrip("+")
    dst = ref.split(":", 1)[1] if ":" in ref else ref
    if dst.startswith("refs/"):
        return dst
    return "refs/" + dst if dst.startswith("heads/") else "refs/heads/" + dst


def glob_reaches_protected(refspec):
    """Report whether a pattern refspec's destination can match a protected branch (`*` spans `/`)."""
    dst = destination(refspec)
    return "*" in dst and any(fnmatch.fnmatchcase(f"refs/heads/{b}", dst) for b in PROTECTED)


def push_danger(args, cwd):
    force = delete = everything = mirror = prune = False
    positional, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in ("--force-with-lease", "--force-if-includes") or a.startswith("--force-with-lease="):
            pass
        elif a in ("--force", "-f"):
            force = True
        elif a in ("--delete", "-d"):
            delete = True
        elif a == "--mirror":
            mirror = everything = True
        elif a in ("--all", "--branches"):
            everything = True
        elif a == "--prune":
            prune = True
        elif a in ("--repo", "--receive-pack", "--exec", "-o", "--push-option"):
            skip = True
        elif a.startswith("--"):
            pass
        elif a.startswith("-") and len(a) > 1:
            force = force or "f" in a[1:]
            delete = delete or "d" in a[1:]
        else:
            positional.append(a)
    refspecs = positional[1:]
    for r in refspecs:
        if r.lstrip("+").startswith(":") and branch_of(r) in PROTECTED:
            return f"deleting protected remote branch {branch_of(r)} via ':branch' refspec."
    targets, forced = set(), set()  # a "+" refspec forces its own ref without --force
    for r in refspecs:
        b = branch_of(r)
        target = (current_branch(cwd) or "HEAD") if b == "HEAD" else b
        targets.add(target)
        if r.startswith("+"):
            forced.add(target)
    if delete and targets & PROTECTED:
        return "deleting a protected remote branch (main/master/develop/production)."
    if mirror:
        return ("push --mirror force-updates and prunes every remote ref, protected branches included. "
                "Push the branches you mean by name, or ask the user.")
    globbed = [r for r in refspecs if glob_reaches_protected(r)]
    if prune and (everything or globbed or not refspecs):
        # without a refspec on the command line the pushed namespaces come from config this guard does not read
        return ("push --prune deletes every remote branch without a local counterpart, and this push can "
                "reach a protected branch (--all, a glob over the branches, or the configured refspecs). "
                "Delete the branches you mean by name, or ask the user.")
    if globbed and (force or any(r.startswith("+") for r in globbed)):
        return ("forced glob refspec whose destination matches a protected branch (main/master/develop/"
                "production). Push the branches you mean by name, or ask the user.")
    if forced & PROTECTED:
        return ("force-push ('+' refspec) to a protected branch (main/master/develop/production). "
                "Use --force-with-lease on a feature branch, or ask the user.")
    if "HEAD" in forced:
        return ("forced '+HEAD' refspec and the checked-out branch cannot be resolved; "
                "name the branch explicitly (and prefer --force-with-lease).")
    if not force:
        return None
    if everything:
        return "force-push of all branches."
    if targets:
        if targets & PROTECTED:
            return ("force-push to a protected branch (main/master/develop/production). "
                    "Use --force-with-lease on a feature branch, or ask the user.")
        return None
    cur = current_branch(cwd)
    if cur is None:
        return ("bare force-push and the checked-out branch cannot be resolved; "
                "name the branch explicitly (and prefer --force-with-lease).")
    if cur in PROTECTED:
        return f"force-push while the checked-out branch is {cur}. Use --force-with-lease on a feature branch, or ask the user."
    return None


def git_parts(argv, cwd):
    """Split `git [-C dir] [-c k=v] <sub> <args>`; return (sub, args, cwd)."""
    i, git_cwd = 1, cwd
    while i < len(argv) and argv[i].startswith("-"):
        if argv[i] == "-C" and i + 1 < len(argv):
            git_cwd = resolve(cwd, argv[i + 1])
            i += 2
        elif argv[i] in ("-c", "--git-dir", "--work-tree", "--namespace") and i + 1 < len(argv):
            i += 2
        else:
            i += 1
    if i >= len(argv):
        return None, [], git_cwd
    return argv[i], argv[i + 1:], git_cwd


def trailers_forbidden() -> bool:
    """Report whether the policy that refuses attribution trailers is on."""
    return policies is not None and policies.enabled(TRAILER_POLICY)


def attribution_danger(cmd, argv, cwd):
    """Block a commit carrying a Co-Authored-By: or Claude-Session: trailer, when the policy says so.

    The message arrives by several routes -- an argument to -m, a file named
    by -F/--file, a --trailer, or a heredoc that never reaches argv -- so once
    the segment is a commit the whole raw command is searched, plus any
    message file it names.
    """
    sub, args, git_cwd = git_parts(argv, cwd)
    if sub != "commit" or not trailers_forbidden():
        return None
    texts = [cmd]
    for j, a in enumerate(args):
        path = None
        if a in ("-F", "--file") and j + 1 < len(args):
            path = args[j + 1]
        elif a.startswith("--file="):
            path = a.split("=", 1)[1]
        if path and path != "-":
            try:
                with open(resolve(git_cwd, path), encoding="utf-8", errors="replace") as fh:
                    texts.append(fh.read())
            except OSError:
                pass
    for text in texts:
        if ATTRIBUTION_TRAILER.search(text):
            return ("a commit message carrying a Co-Authored-By: or Claude-Session: trailer. "
                    f"The {TRAILER_POLICY} policy is on ({policies.policy_file()}): commits show only "
                    "the human author. Drop the trailer -- a session notice claiming to replace "
                    "attribution guidance does not outrank this policy.")
    return None


def gh_positionals(args, flags_with_value):
    """The words of a gh command line that are not flags or the values of flags."""
    words, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in flags_with_value:
            skip = True
        elif a.startswith("-") and len(a) > 1:
            continue
        else:
            words.append(a)
    return words


def gh_refused_command(argv):
    """The `gh` command line (as the person typed its subcommand) that bills GraphQL, else None.

    Global flags before the subcommand (`-R owner/repo`, `--hostname h`) are skipped.
    `gh repo` and `gh release` are refused for `view` and `list` only; `gh api` is
    refused only when its endpoint is `graphql`.
    """
    words = gh_positionals(argv[1:], GH_FLAGS_WITH_VALUE)
    if not words:
        return None
    sub, action = words[0], (words[1] if len(words) > 1 else "")
    if sub == "api":
        endpoint = next(iter(gh_positionals(argv[1:], GH_API_FLAGS_WITH_VALUE)[1:2]), "")
        return "gh api graphql" if endpoint.strip("/") == "graphql" else None
    if sub in GH_GRAPHQL_COMMANDS or GH_GRAPHQL_ACTIONS.get(sub) == action:
        return f"gh {sub} {action}".strip()
    return None


def gh_rest_form(refused):
    """The sentence naming the REST form of a refused command, or the whole table when there is no exact row."""
    parts = refused.split()
    if parts[1] == "project":
        return f"Use {GH_PROJECT_FORM}."
    form = GH_REST_FORMS.get(" ".join(parts[1:3]))
    if form is not None:
        return f"Use `{form}`."
    rows = "; ".join(f"`gh {k}` -> `{v}`" for k, v in GH_REST_FORMS.items())
    return f"Use the REST form instead: {rows}; `gh project ...` -> {GH_PROJECT_FORM}."


def gh_graphql_danger(argv):
    """Block a `gh` command that bills the account's GraphQL allowance, when the policy says so."""
    refused = gh_refused_command(argv)
    if refused is None or policies is None:
        return None
    on, source = policies.resolve(REST_POLICY)
    if not on:
        return None
    switched = (f"the {policies.env_name(REST_POLICY)} environment variable" if source == "environment"
                else f"{policies.policy_file()}")
    return (f"`{refused}` runs on GitHub's GraphQL API, whose rate-limit allowance is shared by the whole "
            f"account. The {REST_POLICY} policy is on (set by {switched}); REST calls are billed to a "
            f"separate allowance. {gh_rest_form(refused)}")


def git_danger(argv, cwd):
    sub, args, git_cwd = git_parts(argv, cwd)
    if sub is None:
        return None
    if sub == "push":
        return push_danger(args, git_cwd)
    if sub == "branch" and ("-D" in args or ("--delete" in args and "--force" in args)):
        if LOCAL_BRANCH_PROTECTED & set(args):
            return "deleting the main/master branch ref."
    if sub == "update-ref" and "-d" in args:
        if any(a.startswith("refs/heads/") and branch_of(a) in LOCAL_BRANCH_PROTECTED for a in args):
            return "deleting the main/master branch ref."
    return None


DDEV_EXEC_VALUE_OPTIONS = ("-s", "--service", "-d", "--dir")
DDEV_SQL_CLIENTS = ("mysql", "mariadb", "psql")
PSQL_VALUE_OPTIONS = "dhUpfFoPRTvL"
# mysql's short options whose value is the rest of the group or the next word (-e is read on its own)
MYSQL_VALUE_OPTIONS = "DhPSu"
SHELLS = ("sh", "bash", "zsh", "dash")
# The names a shell, `source` or `.` can be given for the file it reads, that are its stdin
STDIN_FILES = {"/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"}
# ssh's options that take the next word (or the rest of their group) as their value
SSH_VALUE_OPTIONS = frozenset(f"-{c}" for c in "BbcDEeFIiJLlmOoPpQRSWw")
DOCKER_VALUE_OPTIONS = frozenset({"-H", "--host", "-c", "--context", "--config", "-l", "--log-level",
                                  "--tlscacert", "--tlscert", "--tlskey"})
DOCKER_EXEC_VALUE_OPTIONS = frozenset({"-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir",
                                       "--detach-keys"})
KUBECTL_VALUE_OPTIONS = frozenset({"-n", "--namespace", "-c", "--container", "-f", "--filename", "--context",
                                   "--kubeconfig", "--cluster", "--user", "-s", "--server",
                                   "--pod-running-timeout"})
# Shell options whose value is the next word: `-o pipefail`, `+O extglob`, `--rcfile <file>`
SHELL_OPTIONS_WITH_VALUE = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
# How deep the rules read command lines nested inside command lines; a command nesting one deeper is refused
SHELL_NESTING_LIMIT = 4
NESTED_TOO_DEEP = (f"the command nests command lines more than {SHELL_NESTING_LIMIT} deep (substitutions, "
                   "`bash -c`, `eval`, `ssh` and the like inside one another), so the innermost cannot be "
                   "checked. Split it into steps: run the inner command on its own.")
# A scratch database named *_test or *_test<digits> is rebuilt from migrations on every stack.
TEST_DATABASE_DROP = re.compile(
    r"DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?[\"`]?\w*_test\d*[\"`]?(?:\s+(?:WITH\s*)?\(\s*FORCE\s*\))?",
    re.I,
)


def sql_client(argv):
    """Return (client, its argv) when the segment runs a SQL client, else None.

    The client is one of mysql, mariadb, mysqlsh, psql, called directly or through
    `ddev mysql|mariadb|psql`.
    """
    name = os.path.basename(argv[0])
    if name in SQL_STATEMENTS:
        return name, argv
    if name == "ddev" and len(argv) > 1 and argv[1] in DDEV_SQL_CLIENTS:
        return argv[1], argv[1:]
    return None


def script_from_stdin(stdin):
    """The command lines of a program that reads its script from stdin: each text fed to it, with nothing fed on."""
    return [(text, ()) for text in stdin]


def command_from_words(words, stdin, joined):
    """The command lines of a program that runs `words` as a command, its stdin passed on to it.

    @param joined True when the words reach a shell joined with spaces (ssh, ddev exec), so the
                  joined text is read as a command line; the words are also read as one command
                  with their quoting intact, the form the person meant
    """
    if not words:
        return []
    quoted = " ".join(shlex.quote(w) for w in words)
    if not joined:
        return [(quoted, stdin)]
    plain = " ".join(words)
    return [(plain, stdin), (quoted, stdin)] if len(words) > 1 else [(plain, stdin)]


def read_options(words, value_options):
    """Where the options at the start of `words` end: (the index after them, whether a `--` ended them)."""
    j = 0
    while j < len(words) and words[j].startswith("-") and len(words[j]) > 1:
        if words[j] == "--":
            return j + 1, True
        j += option_words(words[j], value_options)
    return j, False


def after_options(words, value_options):
    """The index of the first word of `words` that is not an option or the value of one; `--` ends the options."""
    return read_options(words, value_options)[0]


def subcommand_words(argv, subcommand, value_options):
    """The words after `<program> [global options] <subcommand>`, or None when its subcommand is another."""
    j = 1 + after_options(argv[1:], value_options)
    return argv[j + 1:] if argv[j:j + 1] == [subcommand] else None


def shell_lines(argv, stdin):
    """The command lines `sh|bash|zsh|dash [options]` runs: the text of `-c`, or what it reads from stdin.

    `-c` may sit in a group of short options (`-lc`, `-ec`); the text is the first word after
    the options, and the shell's stdin is passed on to it. Without `-c` the shell runs a script
    named by its first operand, unless there is none, it is `-` or a name of stdin
    (STDIN_FILES), or `-s` was given: then it reads its commands from stdin, and what is fed to
    it is its script rather than the stdin of the commands in it.
    """
    command = from_stdin = False
    j = 1
    while j < len(argv):
        a = argv[j]
        if a in SHELL_OPTIONS_WITH_VALUE:
            j += 2
        elif len(a) > 1 and a[0] in "-+":
            if a[0] == "-" and not a.startswith("--"):
                command = command or "c" in a[1:]
                from_stdin = from_stdin or "s" in a[1:]
            j += 1
        elif command:
            return [(a, stdin)]
        else:
            return script_from_stdin(stdin) if from_stdin or a == "-" or a in STDIN_FILES else []
    return [] if command else script_from_stdin(stdin)


def source_lines(argv, stdin):
    """The command lines `source`/`.` runs from stdin, when the file it reads is a name of stdin."""
    return script_from_stdin(stdin) if argv[1:2] and argv[1] in STDIN_FILES else []


def eval_lines(argv, stdin):
    """The command line `eval` runs: its words joined with spaces, its stdin passed on to it."""
    return [(" ".join(argv[1:]), stdin)] if len(argv) > 1 else []


def ddev_lines(argv, stdin):
    """The command lines `ddev exec [its options] <words>` and `ddev ssh` run in the container.

    ddev joins the words of `exec` with spaces and hands them to the container's shell, so the
    joined text is read as a command line: a quoted `ddev exec "cd x && psql ..."` is the
    pipelines it holds. `ddev ssh` opens the container's shell, which reads its commands from
    stdin.
    """
    if argv[1:2] == ["ssh"]:
        return script_from_stdin(stdin)
    if argv[1:2] != ["exec"]:
        return []
    words = argv[2:]
    return command_from_words(words[after_options(words, DDEV_EXEC_VALUE_OPTIONS):], stdin, True)


def ssh_lines(argv, stdin):
    """The command lines `ssh [options] <host> [options] [command]` runs on the host.

    ssh reads options after the host as well as before it, up to a `--`; a `--` before the
    host ends them for good. It joins the command's words with spaces for the remote shell;
    without a command the remote shell reads its commands from stdin.
    """
    words = argv[1:]
    j, ended = read_options(words, SSH_VALUE_OPTIONS)
    if j >= len(words):
        return []
    command = words[j + 1:]
    if not ended:
        command = command[after_options(command, SSH_VALUE_OPTIONS):]
    return command_from_words(command, stdin, True) if command else script_from_stdin(stdin)


def docker_lines(argv, stdin):
    """The command `docker [options] exec [its options] <container> <command>` runs, its stdin passed on."""
    words = subcommand_words(argv, "exec", DOCKER_VALUE_OPTIONS)
    if words is None:
        return []
    j = after_options(words, DOCKER_EXEC_VALUE_OPTIONS)
    return command_from_words(words[j + 1:], stdin, False)


def kubectl_lines(argv, stdin):
    """The command `kubectl [options] exec [its options] <pod> [--] <command>` runs, its stdin passed on."""
    words = subcommand_words(argv, "exec", KUBECTL_VALUE_OPTIONS)
    if words is None:
        return []
    if "--" in words:
        return command_from_words(words[words.index("--") + 1:], stdin, False)
    j = after_options(words, KUBECTL_VALUE_OPTIONS)
    return command_from_words(words[j + 1:], stdin, False)


# The command lines a program runs as shell input, by program name:
# (argv, stdin texts) -> [(command line, what is fed to its stdin)]
NESTED_LINES = {
    **{shell: shell_lines for shell in SHELLS},
    "source": source_lines,
    ".": source_lines,
    "eval": eval_lines,
    "ddev": ddev_lines,
    "ssh": ssh_lines,
    "docker": docker_lines,
    "kubectl": kubectl_lines,
}


def mysql_statements(argv):
    """Collect the text of every -e / --execute, including `-Ne SQL` and `-eSQL`.

    A short group is read left to right as getopt does: `e` takes the rest of the group (or
    the next word) as its value, `p` takes only the rest of the group, and another
    value-taking option swallows the rest of the group or the next word.
    """
    sql, j = [], 1
    while j < len(argv):
        a = argv[j]
        if a == "--execute" and j + 1 < len(argv):
            sql.append(argv[j + 1])
            j += 1
        elif a.startswith("--execute="):
            sql.append(a.split("=", 1)[1])
        elif a.startswith("-") and not a.startswith("--") and len(a) > 1:
            for i, ch in enumerate(a[1:], start=1):
                rest = a[i + 1:]
                if ch == "e":
                    if rest:
                        sql.append(rest)
                    elif j + 1 < len(argv):
                        sql.append(argv[j + 1])
                        j += 1
                    break
                if ch == "p":
                    break
                if ch in MYSQL_VALUE_OPTIONS:
                    if not rest:
                        j += 1
                    break
        j += 1
    return sql


def psql_statements(argv):
    """Collect the text of every -c / --command, including `-Atc SQL` and `-cSQL`.

    A short group is read left to right as getopt does: `c` takes the rest of the group
    (or the next word) as its value, and a value-taking option swallows the rest.
    """
    sql = []
    j = 1
    while j < len(argv):
        a = argv[j]
        if a == "--command" and j + 1 < len(argv):
            sql.append(argv[j + 1])
            j += 1
        elif a.startswith("--command="):
            sql.append(a.split("=", 1)[1])
        elif a.startswith("-") and not a.startswith("--") and len(a) > 1:
            for i, ch in enumerate(a[1:], start=1):
                if ch == "c":
                    if a[i + 1:]:
                        sql.append(a[i + 1:])
                    elif j + 1 < len(argv):
                        sql.append(argv[j + 1])
                        j += 1
                    break
                if ch in PSQL_VALUE_OPTIONS:
                    if not a[i + 1:]:
                        j += 1
                    break
        j += 1
    return sql


# Each SQL client and the reader of the statements its arguments execute
SQL_STATEMENTS = {
    "mysql": mysql_statements,
    "mariadb": mysql_statements,
    "mysqlsh": mysql_statements,
    "psql": psql_statements,
}


def destructive_sql(text):
    """Report whether a statement of the SQL text drops a database, schema or table, truncates, or deletes every row.

    The text is split into statements on `;`. A DELETE FROM is destructive when its statement
    has no WHERE outside a comment; a statement that, without its comments, only drops a
    scratch `*_test` database is not. The other words are searched for in the whole statement,
    comments included, so a `--` inside a string literal hides nothing.
    """
    for statement in text.split(";"):
        code = SQL_COMMENT.sub(" ", statement).strip()
        if TEST_DATABASE_DROP.fullmatch(code):
            continue
        if DANGEROUS_SQL.search(statement) or (SQL_DELETE.search(statement) and not SQL_WHERE.search(code)):
            return True
    return False


def sql_danger(argv, stdin):
    """Block destructive SQL sent to a database client, in its arguments or on its stdin.

    @param argv  the client's command, wrappers already taken off
    @param stdin what reaches its stdin: here-documents, here-strings and the words of the
                 earlier segments of its pipeline and of every enclosing one
    """
    found = sql_client(argv)
    if found is None:
        return None
    client, client_argv = found
    if any(destructive_sql(s) for s in [*SQL_STATEMENTS[client](client_argv), *stdin]):
        return ("destructive SQL (DROP DATABASE/TABLE, TRUNCATE, or DELETE without WHERE) sent to a "
                "database. Take a snapshot/backup and ask the user.")
    return None


def ddev_danger(argv):
    if len(argv) >= 2 and argv[1] == "delete":
        for a in argv[2:]:
            if a == "--omit-snapshot" or (a.startswith("-") and not a.startswith("--") and "O" in a):
                return "ddev delete without a snapshot destroys the project database. Drop --omit-snapshot or ask the user."
    return None


def curl_short_body(group):
    """Report whether a curl short-option group sends a body: `-d`, `-sd@x`, `-Fa=@x`, `-T./f`.

    Options are read left to right; the first one that takes a value takes the rest of
    the group as that value, so `-odata.json` writes a file and sends nothing.
    """
    for c in group[1:]:
        if c in CURL_SHORT_BODY:
            return True
        if c in CURL_SHORT_WITH_VALUE:
            return False
    return False


def curl_danger(argv):
    tool = os.path.basename(argv[0])
    body, url = False, None
    for j, a in enumerate(argv[1:], 1):
        if tool == "curl":
            if a in CURL_BODY_FLAGS or any(a.startswith(f + "=") for f in CURL_BODY_FLAGS if f.startswith("--")):
                body = True
            elif a.startswith("-") and not a.startswith("--") and curl_short_body(a):
                body = True
        elif a in WGET_BODY_FLAGS or any(a.startswith(f + "=") for f in WGET_BODY_FLAGS):
            body = True
        if a == "--url" and j + 1 < len(argv):
            url = argv[j + 1]
        elif re.match(r"^[a-z][a-z0-9+.-]*://", a, re.I):
            url = a
        elif url is None and not a.startswith("-") and re.match(r"^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:/|$)", a, re.I):
            url = "http://" + a
    if not (body and url):
        return None
    host = (urlparse(url).hostname or "").lower()
    if not host or host in LOCAL_HOSTS or host.endswith(LOCAL_HOST_SUFFIXES) or "." not in host:
        return None
    return f"{tool} uploads data to the external host {host}. If this is intended, the user runs it."


def baseline_danger(argv, cwd):
    """Block regenerating a static-analysis baseline that already exists.

    Wrappers (`ddev exec`, `composer exec`, `vendor/bin/…`, `npx`, `pnpm exec`)
    are skipped by looking at every token, not only argv[0]. The target is the
    path given to the flag, else the tool's default file in cwd; if that file is
    absent this is the first baseline, which the rule allows.
    """
    if any(os.path.basename(a) == "eslint" for a in argv):
        return eslint_suppressions_danger(argv, cwd)
    tools = {"phpstan": "phpstan-baseline.neon", "psalm": "psalm-baseline.xml"}
    tool = next((t for a in argv for t in tools if os.path.basename(a) == t), None)
    if tool is None:
        return None
    flags = {"--generate-baseline", "-b"} if tool == "phpstan" else {"--set-baseline", "--update-baseline"}
    target = None
    for j, a in enumerate(argv):
        name, _, value = a.partition("=")
        if name in flags:
            nxt = argv[j + 1] if j + 1 < len(argv) else ""
            target = value or (nxt if nxt and not nxt.startswith("-") else "") or tools[tool]
            break
    if target is None:
        return None
    if not os.path.isfile(resolve(cwd, target)):
        return None
    return (f"regenerating the existing {tool} baseline {target!r}. {STANDARDS} §PHP static analysis): "
            "the baseline never grows -- fix the errors at the project's level, or report them as "
            "unfixable. Deleting entries is done by editing the file, not by regenerating it.")


def eslint_suppressions_danger(argv, cwd):
    """Block `eslint --suppress-all` / `--suppress-rule` over an existing bulk-suppressions file.

    Both flags add every current violation to the file; `--prune-suppressions` only
    removes entries and is left alone.
    """
    if not any(a == "--suppress-all" or a.partition("=")[0] == "--suppress-rule" for a in argv):
        return None
    target = "eslint-suppressions.json"
    for j, a in enumerate(argv):
        name, _, value = a.partition("=")
        if name == "--suppressions-location":
            nxt = argv[j + 1] if j + 1 < len(argv) else ""
            target = value or nxt or target
            break
    if not os.path.isfile(resolve(cwd, target)):
        return None
    return (f"adding violations to the existing ESLint suppressions file {target!r}. {STANDARDS} "
            "§JavaScript and TypeScript static analysis): a suppressions file is a baseline and never "
            "grows -- fix the lint errors, or report them as unfixable. `eslint --prune-suppressions` "
            "removes fixed entries.")


# ------------------------------------------------------------ shell writes

def sed_replacements(expressions):
    """The text a sed script inserts: the replacement of every `s` command, else the whole expression."""
    out = []
    for expr in expressions:
        for part in re.split(r";(?=\s*[a-z])", expr):
            part = part.strip()
            m = re.match(r"^\d*,?\d*\s*s(.)", part)
            if not m:
                out.append(part)
                continue
            d = re.escape(m.group(1))
            m2 = re.match(rf"^\d*,?\d*\s*s{d}((?:\\.|[^{d}])*){d}((?:\\.|[^{d}])*){d}", part)
            out.append(m2.group(2).replace("\\/", "/") if m2 else part)
    return out


def line_text(line, commands):
    """The text a command line can write: its here-documents and here-strings, and what echo/printf print.

    @param line     the line's pipelines of Segments
    @param commands the program words of each of those Segments, in the same shape
    @return the text, or None when the line shows none
    """
    produced = [text for pipeline in line for segment in pipeline for text in segment.stdin]
    for argvs in commands:
        for argv in argvs:
            if argv and os.path.basename(argv[0]) in ("echo", "printf"):
                produced.append(" ".join(a for a in argv[1:] if not a.startswith("-")))
    return "\n".join(produced) or None


def decode_escapes(text):
    """The text with the backslash escapes echo -e and printf print decoded (`\\n`, `\\t`, `\\\\`, …)."""
    def decoded(match):
        letter = match.group(1)
        return ANSI_C_ESCAPES.get(letter, letter if letter == "\\" else match.group(0))

    return re.sub(r"\\(.)", decoded, text, flags=re.S)


def piped_words(argv):
    """What a command is read as writing down its pipe: its arguments, and those of echo/printf decoded as well."""
    words = list(argv[1:])
    if argv and os.path.basename(argv[0]) in ("echo", "printf"):
        words += [decoded for decoded in map(decode_escapes, argv[1:]) if decoded not in words]
    return words


def command_writes(argv, cwd, text):
    """The files a command writes by its arguments: tee, sed -i, perl -i, and the destination of cp/mv/install.

    @param argv the program words, wrappers taken off
    @param cwd  the directory the command runs in
    @param text the text its line writes (line_text)
    @return List of (absolute path, text or None, cwd) -- the text is None when the content is
            not visible in the command (cp/mv/install, sed without an `s` command).
    """
    found = []
    name = os.path.basename(argv[0])
    if name == "tee":
        for t in (a for a in argv[1:] if not a.startswith("-")):
            found.append((resolve(cwd, t), text, cwd))
    elif name == "sed" and any(a == "-i" or a.startswith("-i") or a.startswith("--in-place") for a in argv[1:]):
        exprs, files, take_expr = [], [], False
        for a in argv[1:]:
            if take_expr:
                exprs.append(a)
                take_expr = False
            elif a in ("-e", "--expression"):
                take_expr = True
            elif a.startswith("--expression="):
                exprs.append(a.split("=", 1)[1])
            elif a.startswith("-") or a == "":
                continue  # a flag, or BSD sed's empty backup suffix after -i
            elif not exprs:
                exprs.append(a)
            else:
                files.append(a)
        sed_text = "\n".join(sed_replacements(exprs)) or None
        for f in files:
            found.append((resolve(cwd, f), sed_text, cwd))
    elif name == "perl" and any(a.startswith("-") and "i" in a[1:] and not a.startswith("--") for a in argv[1:]):
        code, files, take = [], [], False
        for a in argv[1:]:
            if take:
                code.append(a)
                take = False
            elif a == "-e":
                take = True
            elif a.startswith("-"):
                continue
            else:
                files.append(a)
        perl_text = "\n".join(sed_replacements(code)) or None
        for f in files:
            found.append((resolve(cwd, f), perl_text, cwd))
    elif name in COPY_TOOLS:
        positional = [a for a in argv[1:] if not a.startswith("-")]
        if len(positional) >= 2:
            found.append((resolve(cwd, positional[-1]), None, cwd))
    return found


def write_danger(writes, transcript_path):
    """Apply the rubric gate and the debt guard to files written through the shell.

    @param writes (absolute path, text or None, the cwd of the writing command) for each write
    """
    if rubric is None or debt is None:
        return None
    for path, text, segment_cwd in writes:
        if not os.environ.get("CLAUDE_NO_PLAN_SKILL_GATE"):
            verdict = rubric.missing_for(segment_cwd, path, transcript_path, text)
            if verdict is not None:
                text_ = rubric.denial(*verdict).rstrip()
                return "a shell write of " + text_[len("Blocked: "):] if text_.startswith("Blocked: ") else text_
        if text and not os.environ.get("CLAUDE_NO_DEBT_GUARD") and not debt.exempt(path):
            if os.path.splitext(path)[1].lower() in debt.SOURCE_EXTENSIONS:
                hit = debt.debt_in(text.splitlines(), path)
                if hit:
                    kind, line = hit
                    return (f"this command writes a {kind} into the source file {path}:\n    {line}\n"
                            f"{STANDARDS} §Architecture and tech debt): debt inside the change is fixed "
                            "in the change, never marked for later and never silenced.")
    return None


# ------------------------------------------------------------------- main

# The rule each command name answers to: (argv, cwd, raw command) -> reason or None
SEGMENT_RULES = {
    "rm": lambda argv, cwd, cmd: rm_danger(argv, cwd),
    "find": lambda argv, cwd, cmd: find_danger(argv),
    "git": lambda argv, cwd, cmd: git_danger(argv, cwd) or attribution_danger(cmd, argv, cwd),
    "ddev": lambda argv, cwd, cmd: ddev_danger(argv),
    "gh": lambda argv, cwd, cmd: gh_graphql_danger(argv),
    "curl": lambda argv, cwd, cmd: curl_danger(argv),
    "wget": lambda argv, cwd, cmd: curl_danger(argv),
}


def command_danger(argv, cwd, cmd, stdin):
    """The reason one command is refused by its own rule, the baseline rule or the SQL rule, else None."""
    rule = SEGMENT_RULES.get(os.path.basename(argv[0]))
    return (rule(argv, cwd, cmd) if rule else None) or baseline_danger(argv, cwd) or sql_danger(argv, stdin)


def judge(text, cwd, cmd, writes, depth=0, fed=()):
    """Return why the first refused command of a command line is refused, else None.

    Each simple command is judged with its reserved words, assignments and wrappers taken off;
    a `cd` moves `cwd` for the commands after it. Every command line a command runs -- its
    substitutions, and what it hands to a shell (NESTED_LINES) -- is judged the same way from
    the directory the command runs in, while `depth` is under the nesting limit; a command with
    a line still to read at the limit is refused, since that line cannot be judged. A command's
    stdin is what `fed` holds, what the earlier segments of its pipeline write, and its own
    here-documents and here-strings; a reader passes it on to the line it runs, or, when it
    read its script from that stdin, feeds that line nothing. The files a command writes are
    collected in `writes`, to be judged once every command has passed.

    @param text   the command line
    @param cwd    the directory it starts in
    @param cmd    the whole command the hook was given
    @param writes collects (absolute path, text or None, cwd) for each file written
    @param depth  how many command lines enclose this one
    @param fed    what an enclosing pipeline feeds to this line's stdin
    """
    deeper = depth < SHELL_NESTING_LIMIT
    for line in parse(text):
        commands = [[command_words(segment.argv) for segment in pipeline] for pipeline in line]
        written = line_text(line, commands)
        for pipeline, argvs in zip(line, commands):
            for k, (segment, argv) in enumerate(zip(pipeline, argvs)):
                if not deeper and any(inner.strip() for inner in segment.nested):
                    return NESTED_TOO_DEEP
                for inner in segment.nested:
                    why = judge(inner, cwd, cmd, writes, depth + 1)
                    if why:
                        return why
                writes.extend((resolve(cwd, t), written, cwd) for t in segment.written)
                if not argv:
                    continue
                moved = cd_target(argv, cwd)
                if moved is not None:
                    cwd = moved
                    continue
                writes.extend(command_writes(argv, cwd, written))
                stdin = [*fed, *(word for prev, prev_argv in zip(pipeline[:k], argvs[:k])
                                 for word in [*piped_words(prev_argv), *prev.stdin]), *segment.stdin]
                why = command_danger(argv, cwd, cmd, stdin)
                if why:
                    return why
                reader = NESTED_LINES.get(os.path.basename(argv[0]))
                nested = reader(argv, stdin) if reader else []
                if not deeper and any(inner.strip() for inner, _ in nested):
                    return NESTED_TOO_DEEP
                for inner, inner_fed in nested:
                    why = judge(inner, cwd, cmd, writes, depth + 1, inner_fed)
                    if why:
                        return why
    return None


def check(cmd, cwd, transcript_path=""):
    """Return why the command is refused, else None: its commands first, then the files it writes.

    A command that nests substitutions past SUBSTITUTION_LIMIT is refused, since what it runs
    cannot be read.
    """
    writes = []
    try:
        return judge(cmd, cwd, cmd, writes) or write_danger(writes, transcript_path)
    except NestingTooDeep:
        return (f"the command nests substitutions or expansions more than {SUBSTITUTION_LIMIT} deep, "
                "so what it runs cannot be read. Split it into steps.")


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    cmd = (data.get("tool_input") or {}).get("command", "")
    if not cmd:
        return 0
    cwd = data.get("cwd") or os.getcwd()
    try:
        why = check(cmd, cwd, data.get("transcript_path") or "")
    except Exception:
        return 0  # fail open: a broken guard must not wedge the session
    if why:
        print(f"BLOCKED by bash_guard.py (guards plugin): {why}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
