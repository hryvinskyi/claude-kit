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
of `docker exec` and `kubectl exec`; the commands of `find -exec`, `-execdir`,
`-ok` and `-okdir`; and the script a program reads from its stdin --
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
  board-queue
         a pass of the board queue started from a session: `board-queue tick`
         by name, by any path, as "$BOARD_QUEUE_CLI" or through a variable
         assigned on the line, its entry point run by node/tsx/bun/bunx/deno/
         npx or a shell, `npm|pnpm|yarn exec|dlx [-p board-queue] board-queue
         … tick`, `npx -c`/`npm exec -c|--call` lines, the package's `cli`
         script run by npm/pnpm/yarn (`yarn workspace <name> run cli tick`),
         `tick` handed to it by xargs (also as `{}`), the
         launcher its schedule runs (board-queue-tick.sh, or an install's
         own board-queue-tick.<12 hex digits>.sh), and `tick` handed to
         a program named by a substitution or a variable it cannot read --
         whatever variables are set or exported first, BOARD_QUEUE_SCHEDULED
         included. A syntax check (`bash -n`, `node --check`) passes. The
         schedule runs the passes; a session reads the status and waits

  writes  a file written through the shell gets the same two checks the
         Edit/Write hooks apply (bypass mode writes through Bash, and a rule that
         only watches Edit/Write is no rule). A write is
           - a `>`/`>>` redirect target, `tee` (-a appends);
           - `sed -i`/`-I` (also in a group: `-Ei`, `-ri`, `-ni.bak`, with
             BSD's suffix word; a word after a bare -i that is no script is
             read both as the suffix and as the script) and `perl -i`; an
             in-place edit with no file operand edits what xargs hands it;
           - the destination of cp/mv/install/rsync/`git mv` -- the file, or
             each source's name inside a destination directory (-t, a trailing
             `/`, an existing directory, several sources), every file of a
             copied tree; a temporary or unread source brings content that
             cannot be read;
           - each file a patch changes (`git apply`, `patch`), read from the
             patch file, a `<` file, a here-document or a piped `cat`, each
             hunk by the counts of its `@@` line;
           - `dd of=`, curl -o/--output (and -O by the URL's name), wget -O
             where it is named (or the URL's name, under -P);
           - `git checkout`/`git restore` of a baseline, or of `.`, a
             directory or a glob covering one, with content that cannot be
             read (`git restore --staged` alone writes only the index).
         A writer that cannot read its own command line counts as a write of
         a file it does not spell out, with content it cannot read.
         A target the command does not spell out -- `{}` of find -exec or
         xargs, a variable that cannot be read (`while read f`, a loop over a
         substitution, `$1`), a patch that cannot be read -- stands for every
         file the guards care about that the command involves: the files and
         globs it names and the files under the directories it names (under
         its directory when it names only a basename glob such as `*.php`).
         Loop variables over literal words or globs, variables assigned
         literal values, `${NAME:-default}` and brace groups are read; a glob
         is read under the entry budget of a directory search, each directory
         listed once, and is unread past it; a `$(mktemp)` names a temporary
         file; a target under /dev/, a process substitution, one whose literal
         directory lies in no project or holds no own source, or whose literal
         tail ends in an extension neither guard looks at or passes through an
         output directory, is no such write. Where a command puts its output
         (a redirect, tee, a copy's or download's destination), an unread
         target writes no source unless the word says it may (a source
         extension, a literal directory holding own source). An in-place edit
         of unnamed files, or such an output target, that involves no file at
         all and names no directory searched to its end, stands for the source
         it may be where the command runs (PHP in a PHP project, JavaScript in
         a JavaScript one); a patch that cannot be read is refused.
         The checks:
           - plan_skill_gate.py: PHP source needs the clean-architecture-php
             rubric, JS/TS source the clean-architecture-js rubric, and a plan
             file the rubric of each language it orders — with the references
             the target needs and the skills of the stacks registered for the
             session — loaded first;
           - debt_guard.py: the written text (here-document body or
             here-string, echo/printf arguments, a sed `s///` replacement, the
             lines a patch adds, the content a copy or move brings into a
             project unless its source is source of the same repository, the
             blob `git show <rev>:<path>` prints) may not carry a deferral
             marker or a static-analysis suppression into a source file of a
             project tree (a scratch directory outside every project holds
             none) beyond those the file it replaces holds (a sed command that only deletes lines inserts none); and an
             existing static-analysis baseline (or eslint-suppressions.json) may
             only shrink: an append, a replacement that ignores more or cannot be
             read in its format, raised ESLint counts, a patch whose
             result (applied in memory) ignores more or that does not
             apply, and any write whose result cannot be read
             (a download, an unreadable copy, any in-place sed -- deleting one
             line of an entry widens it -- a restore from git) are refused; a
             baseline HEAD tracks may not be deleted, moved or emptied (rm,
             git rm, mv, git mv, truncate, an empty write), and one written
             where it is gone is measured against HEAD's version; and new content that cannot be read (a missing
             source, a file an earlier command of the line writes, a copied
             tree past 64 files) is refused onto the project's own source (not
             tests, dependencies, build output or served copies) and any other
             file either guard covers.
         Scripted writes (python/php/node one-liners) are not seen; the rule
         in the engineering standards still binds them.

Each command name maps to its rule in SEGMENT_RULES; a new rule is one entry.

An internal error while reading a command asks the person to confirm it (permissionDecision
"ask") rather than letting an unchecked command through; malformed hook input passes, since it
carries no command.
"""
import fnmatch
import functools
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
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
    "issue create": "`gh api --method POST repos/OWNER/REPO/issues -f title=... -F body=@file`",
    "issue view": "`gh api repos/OWNER/REPO/issues/N`",
    "issue comment": "the board queue (`board_enqueue`, kind `issue.comment`) where one runs, "
                     "else `gh api --method POST repos/OWNER/REPO/issues/N/comments -F body=@file`",
    "issue close": "the board queue (`board_enqueue`, kind `issue.close`, the evidence as its comment) where one runs, "
                   "else `gh api --method PATCH repos/OWNER/REPO/issues/N -f state=closed`",
    "issue list": "`gh api 'repos/OWNER/REPO/issues?state=open&per_page=100'`",
    "pr create": "`gh api --method POST repos/OWNER/REPO/pulls -f title=... -f head=... -f base=main -F body=@file`",
    "pr view": "`gh api repos/OWNER/REPO/pulls/N`",
    "pr list": "`gh api 'repos/OWNER/REPO/pulls?state=open'`",
    "repo view": "`gh api repos/OWNER/REPO`",
    "release list": "`gh api repos/OWNER/REPO/releases`",
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
if rubric is not None:  # one command can write many files, each judged against one transcript: read it once
    rubric.loaded_in = functools.lru_cache(maxsize=8)(rubric.loaded_in)
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
    redirections write, each as (target, operator); `read` the files a `<` feeds to its stdin;
    `stdin` the here-document bodies and here-strings fed to it; `nested` the command lines its
    substitutions run.
    """

    def __init__(self):
        self.argv, self.written, self.read, self.stdin, self.nested = [], [], [], [], []

    def empty(self):
        """Report whether the segment holds nothing at all."""
        return not (self.argv or self.written or self.read or self.stdin or self.nested)


def parse(cmd):
    """Read a command line into lines, each a list of pipelines, each a list of Segments.

    A redirection never reaches argv: its operator, the fd number glued to it (`2>`, `{fd}>`)
    and its target are taken out. The targets it writes (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, and
    `>&` to a name that is not an fd) go to `written` with their operator; the file a `<` reads
    goes to `read`; a here-document body and a here-string go to `stdin`.
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
            elif tok == "<":
                segment.read.append(target)
            elif tok in REDIRECT_OUT or (tok == ">&" and not re.match(r"^(?:\d+|-)$", target)):
                segment.written.append((target, str(tok)))
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


# Where a `cd` whose target cannot be read leaves the commands after it. It is no directory on disk:
# a file they write by a relative path lands somewhere unknown, so a source file, a plan or a
# baseline written there is refused (write_danger), never judged as a file of another directory
UNREAD_DIRECTORY = os.path.join(os.sep, "dev", "null", "unread-cd-target")
CD_SUBSTITUTION = re.compile(r"\$\(([^()]*)\)|`([^`]*)`")
ROOT_QUERY = re.compile(r"\s*git\s+rev-parse\s+--show-toplevel\s*")
DIRNAME_QUERY = re.compile(r"\s*dirname\s+(\S+)\s*")
PWD_REFERENCE = re.compile(r"\$(?:\{PWD\}|PWD(?!\w))")
# Variables Claude Code sets for its hooks and not for the shell the Bash tool runs: in a cd target the
# hook would read a directory the shell never moves to
HOOK_ONLY_VARIABLE = re.compile(r"\$\{?CLAUDE_\w*")
# Where `cd "$(mktemp -d)"` leads: a fresh directory under the temporary directory, in no project
SCRATCH_DIRECTORY = os.path.join(os.path.realpath(tempfile.gettempdir()), "mktemp-directory")


class Unread(Exception):
    """A part of a word the guard cannot read."""


def work_tree_root(cwd):
    """The top of the git work tree `cwd` lies in; None when it lies in none or git cannot tell."""
    try:
        res = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, timeout=3, stdin=subprocess.DEVNULL)
    except Exception:
        return None
    return res.stdout.strip() or None if res.returncode == 0 else None


def cd_word(word, cwd, ctx):
    """A `cd` target with the parts the guard can tell filled in: `$PWD`, `$(git rev-parse
    --show-toplevel)` (the work tree of `cwd`), `$(dirname <readable path>)` and `$(mktemp …)` (a
    directory in no project); the variables are read later by the line's ShellWrites (its own
    assignments, then the environment). None when another substitution is in it, or a variable only
    the hook's environment holds (HOOK_ONLY_VARIABLE)."""
    text = PWD_REFERENCE.sub(lambda _: cwd, str(word))
    if HOOK_ONLY_VARIABLE.search(text):
        return None

    def substitute(match):
        inner = match.group(1) if match.group(1) is not None else match.group(2)
        if MKTEMP.match(inner):
            found = SCRATCH_DIRECTORY
        elif ROOT_QUERY.fullmatch(inner):
            found = work_tree_root(cwd)
        else:
            dirname = DIRNAME_QUERY.fullmatch(inner)
            values = ctx.expand(PWD_REFERENCE.sub(lambda _: cwd, dirname.group(1).strip("\"'"))) if dirname else None
            found = os.path.dirname(resolve(cwd, values[0])) if isinstance(values, list) and len(values) == 1 else None
        if found is None:
            raise Unread(inner)
        return found

    try:
        text = CD_SUBSTITUTION.sub(substitute, text)
    except Unread:
        return None
    return Token(text, quoted=getattr(word, "quoted", False))


def cd_target(argv, cwd, ctx=None, previous=None):
    """The directory a `cd`/`pushd` segment moves to from `cwd`; None when the segment is no such move.

    @param ctx      the ShellWrites of the line, whose variables the target is read with; a target
                    that cannot be read, or that names more than one directory, moves to UNREAD_DIRECTORY
    @param previous the directory the line was in before its last move, for `cd -`
    """
    if not argv or os.path.basename(argv[0]) not in ("cd", "pushd"):
        return None
    operands = [a for a in argv[1:] if a == "-" or not a.startswith("-")]
    if not operands:
        return HOME
    if ctx is None:
        return resolve(cwd, operands[0])
    if operands[0] == "-":
        return previous or UNREAD_DIRECTORY
    word = cd_word(operands[0], cwd, ctx)
    if word is not None and ctx.expand(str(word)) is TEMPORARY:
        return SCRATCH_DIRECTORY
    paths = ctx.paths(word, cwd) if word is not None else None
    return paths[0] if paths is not None and len(paths) == 1 else UNREAD_DIRECTORY


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
        return f"Use {form}."
    rows = "; ".join(f"`gh {k}` -> {v}" for k, v in GH_REST_FORMS.items())
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


def find_lines(argv, stdin):
    """The commands `find` runs for what it matches: each -exec/-execdir/-ok/-okdir up to its `;` or `+`."""
    lines, j = [], 1
    while j < len(argv):
        if argv[j] in ("-exec", "-execdir", "-ok", "-okdir"):
            end = next((k for k in range(j + 1, len(argv)) if argv[k] in (";", "+")), len(argv))
            lines.extend(command_from_words(argv[j + 1:end], (), False))
            j = end
        j += 1
    return lines


def call_lines(argv, stdin):
    """The command line `npx -c '<line>'` or `npm|pnpm|yarn exec -c|--call '<line>'` runs in a shell."""
    if os.path.basename(argv[0]) not in ("npx", "pnpx", "bunx") and not any(a in ("exec", "x", "dlx") for a in argv[1:]):
        return []
    for j, a in enumerate(argv[1:], start=1):
        option, eq, value = a.partition("=")
        if option in ("-c", "--call"):
            return [(value if eq else (argv[j + 1] if j + 1 < len(argv) else ""), stdin)]
    return []


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
    "find": find_lines,
    **{runner: call_lines for runner in ("npx", "pnpx", "bunx", "npm", "pnpm", "yarn")},
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
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return (f"{tool} uploads data to a URL whose host cannot be read ({url!r}). "
                "If this is intended, the user runs it.")
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


# ------------------------------------------------------------ board queue

# The names the board queue's command line goes by: its wrapper and its entry point
BOARD_QUEUE_PROGRAMS = {"board-queue", "board-queue.ts", "board-queue.js", "board-queue.mjs"}
# The launcher the queue's schedule runs: one pass, with the variable that marks it as scheduled.
# An install at the default places names it board-queue-tick.sh; any other install adds its own
# twelve hex digits (board-queue-tick.0123456789ab.sh)
BOARD_QUEUE_LAUNCHER = re.compile(r"^board-queue-tick(\.[0-9a-f]{12})?\.sh$")
# The variable a script calls the command line by
BOARD_QUEUE_CLI_WORDS = {"$BOARD_QUEUE_CLI", "${BOARD_QUEUE_CLI}"}
# Programs that run a script named among their arguments
SCRIPT_RUNNERS = {"node", "nodejs", "tsx", "ts-node", "bun", "bunx", "deno", "npx", "pnpx", *SHELLS}
# Package-manager options that take the next word as their value
PACKAGE_VALUE_OPTIONS = {"--prefix", "-C", "--dir", "--cwd", "-w", "--workspace", "--filter", "-F", "-p",
                         "--package"}
# Package managers that run the package's `cli` script
PACKAGE_RUNNERS = {"npm", "pnpm", "yarn"}
BOARD_QUEUE_PASS = ("a pass of the board queue (`board-queue tick`) is run by its schedule, never by a session: "
                    "the per-pass cap spreads the board writes over five-minute windows only while nobody runs "
                    "passes by hand, and BOARD_QUEUE_SCHEDULED marks the schedule's own passes, whoever sets "
                    "it. Read where the queue stands with `board_status` (or `board-queue status`) and wait "
                    "for the next scheduled pass.")


def names_launcher(names):
    """Whether one of the program names is the launcher a board queue schedule runs."""
    return any(BOARD_QUEUE_LAUNCHER.fullmatch(name) for name in names)


def board_queue_programs(word, ctx):
    """The names a word calls a program by: its basename, the basename of each value of a variable
    assigned on the line, `board-queue` for `$BOARD_QUEUE_CLI`.

    @return a set of names; None when the word is a substitution or a variable that cannot be read
    """
    text = str(word)
    if text in BOARD_QUEUE_CLI_WORDS:
        return {"board-queue"}
    if getattr(word, "subs", None) or "$(" in text or "`" in text:
        return None
    values = ctx.expand(text) if ctx is not None else [text]
    if values is None:
        return None
    if values is TEMPORARY:
        return set()
    return {os.path.basename(os.path.expandvars(os.path.expanduser(v))) for v in values}


def program_operand(argv, ctx):
    """The board queue's arguments when one of `argv`'s words names its command line or its launcher, else None.

    Option words, and the value of a package-manager option that takes one, name no program.
    """
    j = 0
    while j < len(argv):
        word = argv[j]
        j += 1
        if str(word).startswith("-"):
            j += 1 if word in PACKAGE_VALUE_OPTIONS else 0
            continue
        names = board_queue_programs(word, ctx) or set()
        if names_launcher(names):
            return ["tick"]
        if names & BOARD_QUEUE_PROGRAMS:
            return list(argv[j:])
    return None


def shell_script_operand(argv):
    """The words from the script a shell runs onwards; None when it runs `-c` text, only checks syntax
    (`-n`, `-o noexec`), or names no script."""
    j = 1
    while j < len(argv):
        a = argv[j]
        if a in SHELL_OPTIONS_WITH_VALUE:
            if argv[j + 1:j + 2] == ["noexec"]:
                return None
            j += 2
        elif len(a) > 1 and a[0] in "-+":
            if a[0] == "-" and not a.startswith("--") and ("c" in a[1:] or "n" in a[1:]):
                return None
            j += 1
        else:
            return list(argv[j:])
    return None


def board_queue_arguments(argv, cwd, ctx=None):
    """The arguments a command hands the board queue's command line, else None.

    The command line is reached by its name, any path to it or a variable holding either; by a
    script runner (node, tsx, bun, deno, npx, a shell) given its entry point; by a package
    manager's exec (`npm exec board-queue -- tick`) or, from inside the package, its `cli`
    script. The schedule's launcher stands for `tick`. A syntax check (`bash -n`, `node --check`)
    runs nothing.
    """
    names = board_queue_programs(argv[0], ctx) or set()
    if names_launcher(names):
        return ["tick"]
    if names & BOARD_QUEUE_PROGRAMS:
        return list(argv[1:])
    if names & set(SHELLS):
        script = shell_script_operand(argv) or [""]
        named = board_queue_programs(script[0], ctx) or set()
        if names_launcher(named):
            return ["tick"]
        return list(script[1:]) if named & BOARD_QUEUE_PROGRAMS else None
    in_package = "board-queue" in cwd or any("board-queue" in a for a in argv)
    if names & SCRIPT_RUNNERS:
        if names & {"node", "nodejs"}:
            if any(a in ("-c", "--check") for a in argv[1:]):
                return None
            for j, a in enumerate(argv[1:], start=1):
                option, eq, value = a.partition("=")
                if option == "--run":
                    script = value if eq else (argv[j + 1] if j + 1 < len(argv) else "")
                    return list(argv[j + (1 if eq else 2):]) if in_package and script == "cli" else None
        return program_operand(argv[1:], ctx)
    if names & PACKAGE_RUNNERS:
        runs = next((j for j, a in enumerate(argv) if a in ("exec", "x", "dlx")), None)
        found = program_operand(argv[runs + 1:], ctx) if runs is not None else (
            program_operand(argv[1:2], ctx) if names & {"yarn"} else None)
        if found is not None:
            return found
        script, rest = package_script(argv[1:])
        return rest if in_package and script == "cli" else None
    return None


def package_script(words):
    """The script a package manager runs (`npm run [options] <script>`, `pnpm <script>`,
    `yarn workspace <name> run <script>`) and the words after it; (None, []) when it runs none.
    Option words, the values of the options that take one, and a workspace's name are passed over."""
    positional, j = [], 0
    while j < len(words) and len(positional) < 2:
        a = words[j]
        j += 1
        if a.startswith("-"):
            j += 1 if a in PACKAGE_VALUE_OPTIONS else 0
            continue
        if a == "workspace":
            j += 1
            continue
        positional.append((a, j))
        if a not in ("run", "run-script", "run-s"):
            break
    if not positional:
        return None, []
    name, end = positional[-1]
    if name in ("run", "run-script", "run-s"):
        return None, []
    return name, list(words[end:])


def possibly_tick(word, ctx):
    """Report whether a word the board queue is handed as its command may be `tick`: it is, a
    variable holding it, `{}` that xargs or find fills in, or a word the guard cannot read."""
    text = str(word)
    if text == "tick" or "{}" in text or getattr(word, "subs", None) or "$(" in text or "`" in text:
        return True
    values = ctx.expand(text) if ctx is not None else [text]
    return values is None or (values is not TEMPORARY and "tick" in values)


def board_queue_danger(argv, cwd, stdin, ctx=None):
    """Refuse a pass of the board queue started from a session, in any form: whatever variables are
    set before it, when xargs hands it `tick` from its stdin, when its command is a word that may
    be `tick` (possibly_tick), and when a program the guard cannot name (a substitution, a
    variable it cannot read) is handed `tick`."""
    if board_queue_programs(argv[0], ctx) is None and argv[1:2] == ["tick"]:
        return ("the program this command runs is named by a substitution or a variable the guard cannot "
                "read, and it is handed `tick`. " + BOARD_QUEUE_PASS)
    arguments = board_queue_arguments(argv, cwd, ctx)
    if arguments is None:
        return None
    words, j = [], 0
    while j < len(arguments):
        word = arguments[j]
        j += 1
        if str(word).startswith("-"):
            j += 1 if word in PACKAGE_VALUE_OPTIONS else 0
            continue
        words.append(word)
    if (possibly_tick(words[0], ctx) if words else "tick" in stdin):
        return BOARD_QUEUE_PASS
    return None


# ------------------------------------------------------------ shell writes

class ShellWrite(NamedTuple):
    """A file a command writes, as far as the command shows it.

    `path` is None when the command does not spell out the file (a loop variable it cannot read,
    xargs, find -exec, a patch it cannot read). `text` is the text that lands in the file when
    visible. `mode` says how it lands: "replace" (the file becomes `text`), "append" (`text` is
    added at its end), "edit" (an in-place editor inserts `text`), "patch" (`text` is what a patch adds and `removed` how many lines
    it takes out) or "tree" (`path` is a directory a copied tree lands in). `unreadable` marks
    content new to the file that the guard cannot read: a source missing or written earlier on
    the same line, a sed script it cannot read, a copied tree past what it reads.
    """

    path: object
    text: object
    cwd: str
    mode: str = "replace"
    removed: int = 0
    unreadable: bool = False
    hunks: object = None  # a patch's hunks for this file (patch_hunks), to apply it in memory


# The value of a variable that names a fresh temporary file (`tmp=$(mktemp)`)
TEMPORARY = object()
# A shell variable reference: `${name}`, `${name<operator>…}`, `$name`, or a special parameter
VARIABLE_REFERENCE = re.compile(r"\$(?:\{([A-Za-z_]\w*)([^}]*)\}|([A-Za-z_]\w*)|([0-9@*#?$!-]))")
GLOB_CHARS = re.compile(r"[*?[]")
# A brace group the shell expands into words: `{a,b}`, not `${…}` and not find's `{}`
BRACE_GROUP = re.compile(r"(?<!\$)\{([^{}]*,[^{}]*)\}")
MKTEMP = re.compile(r"^\s*(?:\S*/)?g?mktemp\b")
# How many paths one word, one glob or one directory walk may stand for
EXPANSION_LIMIT = 256
# How many directory entries the search for the files of an unnamed target reads, all walks together
WALK_ENTRY_LIMIT = 20000
# How many files an unnamed target stands for once it is searched for
CANDIDATE_LIMIT = 64
# The bytes read of a patch a command applies
CONTENT_LIMIT = 2_000_000
# The bytes read of one file a command copies, and of all the files of one copied tree together
COPY_FILE_LIMIT = 262_144
COPY_CONTENT_LIMIT = 2_000_000
# The name a write of a file the command does not spell out is judged under, with a source extension
UNNAMED_FILE = "unnamed-shell-target"
# Directories a search for source files never enters: dependencies, build output, caches, VCS data
WALK_SKIPPED_DIRS = {".git", ".hg", ".svn", "node_modules", "vendor", "var", ".venv", "__pycache__", ".cache",
                     ".idea"}
# Directories a command writes output into, which hold no source
OUTPUT_DIRS = {"var", "cache", "node_modules", "vendor", "tmp", "log", "logs"}
# Markers of the tree a file belongs to, for telling a rename inside it from content brought in
TREE_MARKERS = ("composer.json", "package.json", "tsconfig.json", ".git")
VARIABLE_BUILTINS = {"export", "declare", "local", "readonly", "typeset"}
READ_VALUE_OPTIONS = frozenset({"-a", "-d", "-i", "-n", "-N", "-p", "-t", "-u"})
SED_VALUE_LETTERS = set("efl")
PERL_VALUE_LETTERS = set("IMm")
COPY_VALUE_OPTIONS = {
    "cp": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "mv": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "install": frozenset({"-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "--owner",
                          "-g", "--group"}),
    "rsync": frozenset({"-e", "--rsh", "--rsync-path", "-f", "--filter", "--exclude", "--include",
                        "--exclude-from", "--include-from", "--files-from", "-T", "--temp-dir", "--partial-dir",
                        "--compare-dest", "--copy-dest", "--link-dest", "--backup-dir", "--suffix", "--chmod",
                        "--chown", "--usermap", "--groupmap", "--log-file", "--log-file-format", "--out-format",
                        "--password-file", "-B", "--block-size", "--bwlimit", "--timeout", "--contimeout",
                        "--port", "-M", "--remote-option", "--max-size", "--min-size", "--max-delete",
                        "--modify-window", "--info", "--debug", "--iconv", "--sockopts", "--address",
                        "--stop-after", "--stop-at", "--write-batch", "--only-write-batch", "--read-batch"}),
    "git mv": frozenset(),
}
PATCH_VALUE_LETTERS = set("pidoFrBVzDYg")
# The line counts a unified diff's hunk header gives: `@@ -a[,b] +c[,d] @@`
HUNK_HEADER = re.compile(r"@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@", re.ASCII)
GIT_APPLY_REPORTS = {"--check", "--stat", "--numstat", "--summary"}
# The names a static-analysis baseline goes by, as basename globs
BASELINE_GLOBS = ("*baseline*.neon", "*baseline*.xml", "*baseline*.json", "eslint-suppressions.json")
GIT_RESTORE_VALUE_OPTIONS = {"-s", "--source", "-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"}
WGET_VALUE_LETTERS = set("oaiBetTwQUlARDXIPO")
# A word that reads as a sed script on its own: an address, an `s`/`y` command with its delimiter,
# a block or comment, a command letter on its own or before its argument
SED_SCRIPT = re.compile(r"^\s*(?:[\d$/\\{}!=#:]|[sy]\W|[aic]\\|[aicdDgGhHlnNpPqQxzFe](?:\s|;|$)|[btTrRwWv](?:\s|$))")


class ShellWrites(list):
    """The ShellWrites of a command line, and what names the files it does not spell out.

    `words` holds every word of every command the line runs, each with the directory that
    command runs in; `variables` what each variable assigned on the line holds: a list of
    words, TEMPORARY for a fresh temporary file, or None when the value cannot be read;
    `changed` the files an earlier command of the line writes, whose content on disk is not
    what a later command of the line reads.
    """

    def __init__(self):
        super().__init__()
        self.words, self.variables, self.changed = [], {}, set()
        self.links = False  # the line makes a symbolic link: a path outside every project may lead into one

    def extend(self, writes):
        """Add writes, and remember the files they change for the commands after them."""
        writes = list(writes)
        self.changed.update(os.path.realpath(w.path) for w in writes if w.path is not None)
        super().extend(writes)

    def read(self, path, limit=CONTENT_LIMIT):
        """The text a command of the line reads from `path` (/dev/null is empty); None when it cannot
        be read, or an earlier command of the line writes it."""
        if path == os.devnull:
            return ""
        if os.path.realpath(path) in self.changed:
            return None
        return read_text(path, limit)

    def record(self, segment, cwd):
        """Keep the words of a simple command and the variables it assigns."""
        self.words.extend((word, cwd) for word in segment.argv)
        for name in segment.read:
            self.words.append((name, cwd))
            listed = read_text(resolve(cwd, name), 65536)
            self.words.extend((line.strip(), cwd) for line in (listed or "").splitlines()[:EXPANSION_LIMIT])
        argv = segment.argv
        i = 0
        while i < len(argv) and not argv[i].quoted and argv[i] in RESERVED_PREFIXES:
            i += 1
        if i < len(argv) and not argv[i].quoted and argv[i] in ("for", "select"):
            if i + 1 < len(argv):
                listed = argv[i + 3:] if argv[i + 2:i + 3] == ["in"] else None
                self.variables[str(argv[i + 1])] = None if listed is None else self.loop_values(listed, cwd)
            return
        words = command_words(argv)
        if words and makes_link(words):
            self.links = True
        if not words:
            for word in argv[i:]:
                self.assign(word)
        elif os.path.basename(words[0]) in VARIABLE_BUILTINS:
            for word in words[1:]:
                self.assign(word)
        elif os.path.basename(words[0]) in ("read", "mapfile", "readarray"):
            j = 1 + after_options(words[1:], READ_VALUE_OPTIONS)
            for name in words[j:]:
                self.variables[str(name)] = None

    def assign(self, word):
        """Record a `NAME=value` word: the words its value stands for."""
        name, eq, value = str(word).partition("=")
        if not eq or not re.match(r"^[A-Za-z_]\w*$", name):
            return
        if word.subs or "`" in value or "$(" in value:
            self.variables[name] = TEMPORARY if word.subs and all(MKTEMP.match(s) for s in word.subs) else None
            return
        self.variables[name] = self.expand(value)

    def loop_values(self, words, cwd):
        """The words a `for`/`select` loop variable takes in turn; None when one cannot be read."""
        out = []
        for word in words:
            if word.subs:
                return None
            values = []
            for variant in (brace_expand(str(word)) if not word.quoted else [str(word)]):
                expanded = self.expand(variant)
                if expanded is None or expanded is TEMPORARY:
                    return None
                values += expanded
            for value in values:
                matches = glob_paths(value, cwd) if not word.quoted and GLOB_CHARS.search(value) else []
                if matches is None:
                    return None
                out.extend(matches or [value])
        return out[:EXPANSION_LIMIT]

    def expand(self, text):
        """The texts `text` stands for once the variables in it are read.

        A `${name:-word}` or `${name-word}` stands for its default word when the name is neither
        assigned on the line nor set in the environment.

        @return a list of texts; TEMPORARY when a variable in it names a temporary file; None
                when one cannot be read (a special parameter, another operator, a value not known)
        """
        texts = [text]
        for reference in dict.fromkeys(m.group(0) for m in VARIABLE_REFERENCE.finditer(text)):
            m = VARIABLE_REFERENCE.match(reference)
            name, operator = m.group(1) or m.group(3), m.group(2)
            default = re.fullmatch(r":?-(.*)", operator, re.S) if operator else None
            if m.group(4) or (operator and default is None):
                return None
            if name in self.variables:
                value = self.variables[name]
                if value is None or value is TEMPORARY:
                    return value
            elif name in os.environ:
                value = [os.environ[name]]
            elif default is not None:
                value = self.expand(default.group(1))
                if value is None or value is TEMPORARY:
                    return value
            else:
                return None
            texts = [t.replace(reference, v) for t in texts for v in value][:EXPANSION_LIMIT]
        return texts

    def paths(self, word, cwd):
        """The files a target word names, from `cwd`.

        @return absolute paths; [] when it names a temporary file, or a file it does not spell out
                that cannot be one the guards care about (rules_out_source); None when it names a
                file the command does not spell out (`{}`, a substitution, a variable that cannot
                be read)
        """
        text = str(word)
        subs = getattr(word, "subs", [])
        if text.startswith(("<(", ">(")):
            return []  # a process substitution is a pipe; the command it runs is judged on its own
        unread = [] if rules_out_source(text, cwd) else None
        if "{}" in text:
            return unread
        if subs or "`" in text or "$(" in text:
            return [] if subs and all(MKTEMP.match(s) for s in subs) else unread
        values = []
        for variant in (brace_expand(text) if not getattr(word, "quoted", False) else [text]):
            expanded = self.expand(variant)
            if expanded is TEMPORARY:
                return []
            if expanded is None:
                return unread
            values += expanded
        out = []
        for value in values:
            if not getattr(word, "quoted", False) and GLOB_CHARS.search(value):
                matches = glob_paths(value, cwd)
                if matches is None:
                    return unread
                out.extend(matches)
            else:
                out.append(resolve(cwd, value))
        return out


def brace_expand(text):
    """The words an unquoted word's brace groups (`src/A.{php,txt}`) stand for, at most EXPANSION_LIMIT;
    a group the limit leaves unexpanded stays as written."""
    pending, done = [text], []
    while pending and len(done) + len(pending) < EXPANSION_LIMIT:
        word = pending.pop()
        group = BRACE_GROUP.search(word)
        if group is None:
            done.append(word)
            continue
        pending += [word[:group.start()] + part + word[group.end():] for part in group.group(1).split(",")]
    return done + pending


class BudgetSpent(Exception):
    """A search read as many directory entries as it may."""


def glob_paths(pattern, cwd, budget=None):
    """The existing paths a glob matches from `cwd`, at most EXPANSION_LIMIT of them.

    It is read as the shell reads it: `*`, `?` and `[…]` within one component, never matching a
    leading dot unless the component starts with one, and `**` any number of directories (not
    entering WALK_SKIPPED_DIRS).

    @param budget a one-item list holding how many directory entries may still be read
                  (WALK_ENTRY_LIMIT when not given)
    @return the paths, or None when the budget runs out before the glob is read whole
    """
    budget = [WALK_ENTRY_LIMIT] if budget is None else budget
    pattern = os.path.expanduser(pattern)
    parts = os.path.normpath(pattern if os.path.isabs(pattern) else os.path.join(cwd, pattern)).split("/")
    first = next((i for i, part in enumerate(parts) if GLOB_CHARS.search(part)), None)
    if first is None:
        path = "/".join(parts) or "/"
        return [os.path.realpath(path)] if os.path.lexists(path) else []
    found = {}
    try:
        for path in glob_walk("/".join(parts[:first]) or "/", parts[first:], budget):
            found[os.path.realpath(path)] = None
            if len(found) >= EXPANSION_LIMIT:
                break
    except BudgetSpent:
        return None
    return list(found)


def glob_entries(directory, budget):
    """The entries of one directory, counted against the budget; none when it cannot be listed."""
    if budget[0] <= 0:
        raise BudgetSpent()
    try:
        with os.scandir(directory) as listing:
            entries = list(listing)
    except OSError:
        return []
    budget[0] -= len(entries)
    return entries


def glob_walk(directory, parts, budget, entries=None):
    """Yield the paths under `directory` that the glob components `parts` match.

    @param entries the directory's entries when they are already listed, so that `**` lists each
                   directory once
    """
    part, rest = parts[0], parts[1:]
    if part == "**":
        entries = glob_entries(directory, budget) if entries is None else entries
        if rest:
            yield from glob_walk(directory, rest, budget, entries)
        for entry in entries:
            if entry.name.startswith(".") or entry.name in WALK_SKIPPED_DIRS:
                continue
            if not rest:
                yield entry.path
            if entry.is_dir(follow_symlinks=False):
                yield from glob_walk(entry.path, parts, budget)
        return
    if not GLOB_CHARS.search(part):
        path = os.path.join(directory, part)
        if rest:
            if os.path.isdir(path):
                yield from glob_walk(path, rest, budget)
        elif os.path.lexists(path):
            yield path
        return
    for entry in glob_entries(directory, budget) if entries is None else entries:
        if entry.name.startswith(".") and not part.startswith("."):
            continue
        if not fnmatch.fnmatchcase(entry.name, part):
            continue
        if not rest:
            yield entry.path
        elif entry.is_dir():
            yield from glob_walk(entry.path, rest, budget)


def unread_part_end(text):
    """Where the last part of a word the guard cannot read ends: a variable, a substitution or `{}`."""
    ends = [m.end() for m in VARIABLE_REFERENCE.finditer(text)]
    ends += [i + 1 for i, c in enumerate(text) if c in ")}`"]
    return max(ends, default=0)


def unread_part_start(text):
    """Where the first part of a word the guard cannot read starts: a variable, a substitution or `{}`."""
    starts = [m.start() for m in VARIABLE_REFERENCE.finditer(text)]
    starts += [i for i, c in enumerate(text) if c in "`{" or (c == "(" and text[i - 1:i] in ("$", "<", ">"))]
    return min((i - 1 if text[i:i + 1] == "(" else i for i in starts), default=len(text))


def source_directory(directory, cwd):
    """Report whether a file written into `directory` can be the project's own source (own_source)."""
    return any(own_source(os.path.join(directory, "x" + extension), cwd) for extension in (".php", ".js"))


def rules_out_source(text, cwd):
    """Report whether a target the guard cannot read in full still cannot be a file the guards care about.

    It cannot when it lies under /dev/; when the literal directory before its first unread part
    lies in no project (`/tmp/review.$$`) or where no own source lives (the project's var/);
    when the literal text after its last unread part ends in an extension guarded() rejects
    (`$OUT/hits.txt`, `$DIR/$(basename $f).log`); or, with no extension, passes through an
    output directory (`$(git rev-parse --show-toplevel)/var/log/x`).
    """
    if text.startswith("/dev/"):
        return True
    prefix = text[:unread_part_start(text)]
    if "/" in prefix:
        directory = resolve(cwd, prefix[:prefix.rfind("/") + 1])
        if tree_of(os.path.join(directory, "x")) is None or not source_directory(directory, cwd):
            return True
    tail = text[unread_part_end(text):]
    extension = os.path.splitext("x" + tail)[1]
    if extension and "/" not in extension:
        return not guarded("x" + tail)
    return any(part in OUTPUT_DIRS for part in tail.split("/")[:-1])


def may_be_source(text, cwd):
    """Report whether an output target the guard cannot read says it may be source: the literal
    text after its last unread part ends in a guarded extension (`"$X/Gen.php"`), or the literal
    directory before its first unread part holds own source (`src/A.$(echo php)`)."""
    tail = text[unread_part_end(text):]
    extension = os.path.splitext("x" + tail)[1]
    if extension and "/" not in extension and guarded("x" + tail):
        return True
    prefix = text[:unread_part_start(text)]
    directory = resolve(cwd, prefix[:prefix.rfind("/") + 1]) if "/" in prefix else cwd
    return ("/" in prefix or bool(prefix)) and source_directory(directory, cwd)


def read_text(path, limit=CONTENT_LIMIT):
    """The text of a regular file, at most `limit` bytes of it; None when it cannot be read."""
    try:
        if not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except OSError:
        return None


def tree_of(path):
    """The nearest directory above `path` holding a project or repository marker, else None."""
    directory = os.path.dirname(path)
    for _ in range(40):
        if any(os.path.exists(os.path.join(directory, marker)) for marker in TREE_MARKERS):
            return directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent
    return None


def repository_of(path):
    """The nearest directory above `path` holding `.git`: the repository it belongs to, else None."""
    directory = os.path.dirname(path)
    for _ in range(40):
        if os.path.exists(os.path.join(directory, ".git")):
            return directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent
    return None


def new_content(source, target, moved, cwd):
    """Report whether copying or moving `source` onto `target` brings in content the debt guard reads.

    It brings none when the target lies in no project tree (a backup, a scratch copy), and none
    when the source is the own source of a project (own_source: not vendor/, var/, tests or
    build output) and already lies in the target's repository, or is moved inside the target's
    tree. Any other source (a note, a vendored or scratch file, a file from elsewhere) brings new
    content. A baseline's new content is always read.
    """
    if debt is not None and debt.BASELINE.search(os.path.basename(target)):
        return True  # whether a baseline shrinks depends on what lands in it
    tree = tree_of(target)
    if tree is None:
        return False
    if not own_source(source, cwd):
        return True
    repository = repository_of(target)
    if repository is not None and (source + os.sep).startswith(repository + os.sep):
        return False
    return not (moved and (source + os.sep).startswith(tree + os.sep))


def guarded(path):
    """Report whether a write of `path` is one of the two guards' business: source, a plan, or a baseline."""
    extension = os.path.splitext(path)[1].lower()
    known = set(debt.SOURCE_EXTENSIONS) if debt else set()
    if rubric is not None:
        known |= rubric.JS_EXTENSIONS | {".php"}
        if rubric.is_plan_file(path):
            return True
    return extension in known or bool(debt and debt.BASELINE.search(os.path.basename(path)))


def walk_files(directory, budget, filters=(), distinct=True, limit=CANDIDATE_LIMIT, skip=True):
    """The files under `directory` a guard cares about.

    @param budget   a one-item list holding how many directory entries may still be read; the
                    walk stops when it runs out
    @param filters  basename globs a file must match one of, when there are any
    @param distinct True to keep one file per directory and extension, which is all the rubric
                    gate tells apart
    @param limit    how many files to return at most
    @param skip     False to enter WALK_SKIPPED_DIRS as well
    """
    seen, out = set(), []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not skip or d not in WALK_SKIPPED_DIRS]
        budget[0] -= len(dirs) + len(files)
        for name in files:
            path = os.path.join(root, name)
            key = (root, os.path.splitext(name)[1].lower()) if distinct else path
            if key in seen or not guarded(path):
                continue
            if filters and not any(fnmatch.fnmatch(name, f) for f in filters):
                continue
            seen.add(key)
            out.append(path)
        if budget[0] <= 0 or len(out) >= limit:
            break
    return out[:limit]


def unnamed_targets(words):
    """The files a write whose target the command does not spell out is taken to write.

    They are the files the command names, the matches of the globs it names, and the files
    under the directories it names (or, when it names a basename glob and no directory, under
    the directory it runs in) that match those basename globs -- every file a guard cares about
    that the command involves.

    @return (the files, whether a directory was searched to its end): a search that ran to its
            end and found none says the write lands in no such file
    """
    filters, named, directories = set(), [], []
    filter_cwds, excluding, budget = [], False, [WALK_ENTRY_LIMIT]
    for word, cwd in words:
        text = str(word)
        if excluding:
            excluding = False
            continue
        if text.startswith("-") or ("=" in text and not text.startswith(("/", "."))):
            option, eq, text = text.partition("=")
            narrows = "exclude" in option or "ignore" in option
            excluding = narrows and not eq
            if not eq or narrows:
                continue
        if not text or "://" in text or "$" in text or "`" in text or "{}" in text:
            continue
        if GLOB_CHARS.search(text):
            base = os.path.basename(text.rstrip("/"))
            if GLOB_CHARS.search(base):
                filters.add(base)
                filter_cwds.append(cwd)
            if "/" in text:
                named.extend(glob_paths(text, cwd, budget) or [])
            continue
        path = resolve(cwd, text)
        if os.path.isdir(path):
            if not is_root_like(path):
                directories.append(path)
        elif os.path.isfile(path) or os.path.splitext(path)[1]:
            named.append(path)
    if filters and not directories:
        directories = [c for c in dict.fromkeys(filter_cwds) if not is_root_like(c)]
    out = [p for p in dict.fromkeys(named) if guarded(p)]
    for directory in dict.fromkeys(directories):
        if budget[0] <= 0 or len(out) >= CANDIDATE_LIMIT:
            break
        out.extend(p for p in walk_files(directory, budget, tuple(filters)) if p not in out)
    return out[:CANDIDATE_LIMIT], bool(directories) and budget[0] > 0


# One sed address: a line number or `first~step`, `$`, `/regex/` or `\cregexc` with its flags
SED_ADDRESS = re.compile(r"\s*(?:\d+(?:~\d+)?|\$|/(?:\\.|[^/\\])*/[IM]*|\\(\S)(?:\\.|(?!\1)[^\\])*\1[IM]*)")
# A sed command that deletes lines or ends the script, and puts no text into the file
SED_NO_TEXT = re.compile(r"[dDnNlz=]\s*|[qQ]\s*\d*\s*")
# The sed commands that copy lines of the file elsewhere in it (hold and get, exchange; print when sed
# also prints every line): what they write is text the guard cannot read, a suppression on a copied
# line included
SED_HOLD_COMMANDS = set("hHgGx")
SED_STEP = re.compile(r"\s*,\s*(?:[+~]\d+)?")


def sed_command(part):
    """A sed command with its addresses taken off (`/re/d` → `d`, `3,$!p` → `p`); the part as it
    is when its addresses cannot be read."""
    at = 0
    for _ in range(2):
        m = SED_ADDRESS.match(part, at)
        if not m:
            break
        at = m.end()
        step = re.compile(r"\s*,\s*(?:[+~]\d+)?").match(part, at)
        if not step or step.end() == at:
            break
        at = step.end()
    command = part[at:].lstrip()
    return command[1:].lstrip() if command.startswith("!") else command


def sed_letters(script):
    """The command letters of a sed script, read command by command: addresses taken off, and the
    bodies of `s` and `y`, labels, file names and the text of `a`/`i`/`c` skipped. An `s` command's
    `e` flag counts as the `e` command and its `w` flag as the `w` command, which do the same."""
    out, i, n = [], 0, len(script)
    while i < n:
        if script[i] in " \t\n;{}!":
            i += 1
            continue
        address = SED_ADDRESS.match(script, i)
        if address and address.end() > i and not script[i].isalpha():
            i = address.end()
            step = SED_STEP.match(script, i)
            if step and step.end() > i:
                i = step.end()
                second = SED_ADDRESS.match(script, i)
                i = second.end() if second else i
            continue
        letter = script[i]
        out.append(letter)
        i += 1
        if letter in "sy" and i < n:
            delimiter = script[i]
            i += 1
            for _ in range(2):
                while i < n and script[i] != delimiter:
                    i += 2 if script[i] == "\\" else 1
                i += 1
            flags = i
            while i < n and script[i] not in ";\n}":
                i += 1
            if letter == "s":
                head, written, _ = script[flags:i].partition("w")
                out += ["e"] * ("e" in head) + ["w"] * bool(written)
        elif letter in "aic":
            while i < n and script[i] != "\n":
                i += 2 if script[i] == "\\" else 1
        elif letter in "btT:rRwWe":
            while i < n and script[i] not in ";\n":
                i += 1
    return out


def sed_copies(expressions, quiet=False):
    """Report whether a sed script copies lines of the file: a hold-space command, or `p` when sed
    also prints every line (no -n)."""
    letters = {letter for expr in expressions for letter in sed_letters(expr)}
    return bool(letters & SED_HOLD_COMMANDS) or ("p" in letters and not quiet)


# The sed commands whose output is the input's lines and the script's own text: substitute,
# transliterate, delete, print
SED_PLAIN_COMMANDS = set("sydp")


def sed_output(argv, cwd, writes, ctx):
    """The writes of what a sed command prints, with the text that lands.

    When every input is a file of the written file's repository that is its own source
    (new_content), and the script only substitutes, transliterates, deletes and prints
    (SED_PLAIN_COMMANDS, no line copied: sed_copies), what lands is those lines plus the script's
    replacement text. Any other sed -- stdin, a file from elsewhere, a script file that cannot be
    read, a command that runs, reads or writes files -- prints what cannot be read.
    """
    in_place, exprs, scripts, files, ambiguous = sed_reading(argv)
    script_texts = [ctx.read(resolve(cwd, f)) for f in scripts]
    exprs = exprs + [t for t in script_texts if t is not None]
    sources = [resolve(cwd, f) for f in files]
    plain = (not in_place and ambiguous is None and files and "-" not in files and exprs
             and None not in script_texts
             and all(ctx.read(source) is not None for source in sources)
             and {letter for expr in exprs for letter in sed_letters(expr)} <= SED_PLAIN_COMMANDS
             and not sed_copies(exprs, sed_quiet(argv)))
    out = []
    for write in writes:
        if not guarded_content(write):
            out.append(write)
        elif plain and not any(new_content(source, write.path, False, write.cwd) for source in sources):
            out.append(write._replace(text="\n".join(sed_replacements(exprs)) or None, mode="edit"))
        else:
            out.append(write._replace(text=None, unreadable=True))
    return out


def sed_quiet(argv):
    """Report whether a sed command line prints only what its script prints (-n, --quiet, --silent)."""
    for word in argv[1:]:
        if word in ("--quiet", "--silent") or (word.startswith("-") and not word.startswith("--")
                                                and "n" in word[1:].split("i")[0]):
            return True
    return False


def sed_replacements(expressions):
    """The text a sed script inserts: the replacement of every `s` command, nothing for a command
    that only deletes or prints lines (`/re/d`), else the whole expression."""
    out = []
    for expr in expressions:
        for part in re.split(r";(?=\s*[a-z])|\n", expr):
            part = part.strip()
            command = sed_command(part)
            if SED_NO_TEXT.fullmatch(command):
                continue
            m = re.match(r"^s(.)", command)
            if not m:
                out.append(part)
                continue
            d = re.escape(m.group(1))
            m2 = re.match(rf"^s{d}((?:\\.|[^{d}])*){d}((?:\\.|[^{d}])*){d}", command)
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


def targets(ctx, word, cwd, text, mode="replace", removed=0, output=False):
    """The ShellWrites of one target word: one per file it names, or one with no path when it names none.

    @param output True for where a command puts its output (a redirect, tee, a copy's or a
                  download's destination): a word it cannot read is a write of no file the
                  guards care about unless the word says it may be source (may_be_source)
    """
    paths = ctx.paths(word, cwd)
    if paths is None:
        if output and not may_be_source(str(word), cwd):
            return []
        return [ShellWrite(None, text, cwd, mode, removed)]
    return [ShellWrite(path, text, cwd, mode, removed) for path in paths]


def redirect_writes(target, operator, cwd, text, ctx):
    """The files a `>`/`>>` redirection writes; an appending one adds its text, the others replace the file."""
    return targets(ctx, target, cwd, text, "append" if operator in (">>", "&>>") else "replace", output=True)


def tee_writes(argv, cwd, text, ctx, segment, before):
    """The files `tee` writes: every operand, appended to with -a/--append."""
    append, ended, out = False, False, []
    operands = []
    for a in argv[1:]:
        if not ended and a == "--":
            ended = True
        elif not ended and a.startswith("--"):
            append = append or a == "--append"
        elif not ended and a.startswith("-") and len(a) > 1:
            append = append or "a" in a[1:]
        else:
            operands.append(a)
    for a in operands:
        out.extend(targets(ctx, a, cwd, text, "append" if append else "replace", output=True))
    return out


def sed_writes(argv, cwd, text, ctx, segment, before):
    """The files `sed -i`/`-I` edits in place, the in-place flag alone or in a group (`-Ei`, `-ri`, `-ni.bak`).

    GNU sed takes a backup suffix glued to the flag; BSD sed also takes it as the next word,
    which is then empty or starts with `.` or `~`. The script is the first operand unless -e,
    -f or their long forms gave one; the text it inserts is the replacement of its `s` commands.
    An in-place edit with no file operand edits what xargs hands it: a file not spelled out.
    When the word after a bare -i is no sed script and more words follow (`sed -i bak 's/…/' f`),
    it is read both ways -- BSD's suffix and GNU's script -- and the writes of both are kept.
    """
    first = sed_reading(argv)
    readings = [first] if first[4] is None else [first, sed_reading(argv, first[4])]
    out = []
    for in_place, exprs, scripts, files, _ in readings:
        if in_place:
            out += sed_reading_writes(exprs, scripts, files, cwd, ctx, fed_by_xargs(segment), sed_quiet(argv))
    return out


def fed_by_xargs(segment):
    """Report whether a command runs under xargs, which hands it file operands of its own."""
    return segment is not None and any(os.path.basename(str(word)) == "xargs" for word in segment.argv)


def sed_reading(argv, suffix_at=None):
    """Read a sed command line: (in place, expressions, script files, files, the index of a word
    after a bare -i that may be BSD's suffix or GNU's script, else None).

    @param suffix_at the index of a word to read as BSD's backup suffix
    """
    in_place, exprs, scripts, files, j, ended, ambiguous = False, [], [], [], 1, False, None
    while j < len(argv):
        a, nxt = argv[j], (argv[j + 1] if j + 1 < len(argv) else None)
        j += 1
        if ended or not a.startswith("-") or a == "-":
            if a == "" and in_place:
                continue  # BSD sed's empty backup suffix
            (files if exprs or scripts else exprs).append(a)
        elif a == "--":
            ended = True
        elif a.startswith("--"):
            option, eq, value = a.partition("=")
            if option.startswith("--in-place"):
                in_place = True
            elif option in ("--expression", "--file", "--line-length"):
                if not eq and nxt is not None:
                    value, j = nxt, j + 1
                (exprs if option == "--expression" else scripts if option == "--file" else []).append(value)
        else:
            for k, letter in enumerate(a[1:], start=1):
                rest = a[k + 1:]
                if letter in "iI":
                    in_place = True
                    if rest or nxt is None or nxt.startswith("-"):
                        break
                    if j == suffix_at or nxt == "" or re.match(r"^[.~][\w.~-]*$", nxt):
                        j += 1
                    elif not SED_SCRIPT.match(nxt) and any(not w.startswith("-") for w in argv[j + 1:]):
                        ambiguous = j
                    break
                if letter in SED_VALUE_LETTERS:
                    value = rest
                    if not rest and nxt is not None:
                        value, j = nxt, j + 1
                    (exprs if letter == "e" else scripts if letter == "f" else []).append(value)
                    break
    return in_place, exprs, scripts, files, ambiguous


def sed_reading_writes(exprs, scripts, files, cwd, ctx, fed, quiet=False):
    """The writes of one reading of an in-place sed: each file, edited with the text its script
    inserts, and the files xargs hands it when it runs under xargs; a reading with neither writes
    nothing (sed refuses to run without a file)."""
    script_texts = [ctx.read(resolve(cwd, f)) for f in scripts]
    unreadable = any(t is None for t in script_texts)
    exprs = exprs + [t for t in script_texts if t is not None]
    unreadable = unreadable or sed_copies(exprs, quiet)
    sed_text = None if unreadable else ("\n".join(sed_replacements(exprs)) or None)
    out = [ShellWrite(None, sed_text, cwd, "edit", unreadable=unreadable)] if fed else []
    return out + [w._replace(unreadable=unreadable) for f in files for w in targets(ctx, f, cwd, sed_text, "edit")]


def perl_writes(argv, cwd, text, ctx, segment, before):
    """The files `perl -i` edits in place (`-pi`, `-i.bak`, `-0777 -pi -e …`), xargs's files when it names none."""
    in_place, code, files, j = False, [], [], 1
    while j < len(argv):
        a, nxt = argv[j], (argv[j + 1] if j + 1 < len(argv) else None)
        j += 1
        if a.startswith("-") and not a.startswith("--") and len(a) > 1:
            for k, letter in enumerate(a[1:], start=1):
                rest = a[k + 1:]
                if letter == "i":
                    in_place = True
                    break
                if letter in "eE" or letter in PERL_VALUE_LETTERS:
                    value = rest
                    if not rest and nxt is not None:
                        value, j = nxt, j + 1
                    if letter in "eE":
                        code.append(value)
                    break
        elif not a.startswith("-"):
            (files if code else code).append(a)
    if not in_place:
        return []
    perl_text = "\n".join(sed_replacements(code)) or None
    out = [ShellWrite(None, perl_text, cwd, "edit")] if fed_by_xargs(segment) else []
    return out + [w for f in files for w in targets(ctx, f, cwd, perl_text, "edit")]


def copy_options(argv, value_options):
    """Read a cp/mv/install/rsync command line: (operands, target directory or None, -T given, -d given)."""
    operands, target_dir, no_target_dir, directories, j, ended = [], None, False, False, 1, False
    while j < len(argv):
        a, nxt = argv[j], (argv[j + 1] if j + 1 < len(argv) else None)
        j += 1
        if ended or not a.startswith("-") or a == "-":
            operands.append(a)
        elif a == "--":
            ended = True
        elif a.startswith("--"):
            option, eq, value = a.partition("=")
            if option in value_options and not eq:
                value, j = (nxt or ""), j + 1
            if option == "--target-directory":
                target_dir = value
            no_target_dir = no_target_dir or option == "--no-target-directory"
            directories = directories or option == "--directory"
        else:
            for k, letter in enumerate(a[1:], start=1):
                if "-" + letter in value_options:
                    value = a[k + 1:]
                    if not value:
                        value, j = (nxt or ""), j + 1
                    if letter == "t":
                        target_dir = value
                    break
                no_target_dir = no_target_dir or letter == "T"
                directories = directories or letter == "d"
    return operands, target_dir, no_target_dir, directories


def copied(source, dest, into, contents, rename, cwd, ctx):
    """The ShellWrites of one source copied or moved to `dest`.

    A directory source writes each file under it the guards care about, in every directory
    (into `dest/<its name>`, or into `dest` itself for an rsync source ending in `/` or a copy to
    a new directory). The text is the source's content when it is new to the destination
    (new_content), read up to COPY_FILE_LIMIT a file and COPY_CONTENT_LIMIT a tree; new content
    that cannot be read -- a missing source, one written earlier on the line, a tree past
    CANDIDATE_LIMIT files or the entry budget -- is marked unreadable.
    """
    if os.path.isdir(source):
        base = dest if contents or not into else os.path.join(dest, os.path.basename(source.rstrip("/")))
        walk_budget = [WALK_ENTRY_LIMIT]
        files = walk_files(source, walk_budget, distinct=False, limit=CANDIDATE_LIMIT + 1, skip=False)
        out, budget, brings = [], COPY_CONTENT_LIMIT, False
        for f in files[:CANDIDATE_LIMIT]:
            target = os.path.join(base, os.path.relpath(f, source))
            if not new_content(f, target, rename, cwd):
                out.append(ShellWrite(target, None, cwd))
                continue
            brings = True
            text = ctx.read(f, min(budget, COPY_FILE_LIMIT)) if budget > 0 else None
            budget -= len(text or "")
            out.append(ShellWrite(target, text, cwd, unreadable=text is None))
        past_cap = len(files) > CANDIDATE_LIMIT or walk_budget[0] <= 0
        if past_cap and brings and source_directory(base, cwd):
            out.append(ShellWrite(base, None, cwd, "tree", unreadable=True))
        return out
    target = os.path.join(dest, os.path.basename(source)) if into else dest
    if not new_content(source, target, rename, cwd):
        return [ShellWrite(target, None, cwd)]
    text = ctx.read(source, COPY_FILE_LIMIT)
    return [ShellWrite(target, text, cwd, unreadable=text is None)]


def copy_writes(argv, cwd, text, ctx, segment, before, tool=None):
    """The files cp, mv, install, rsync or `git mv` writes: the destination, or each source's name inside it.

    The destination is a directory when -t/--target-directory names it, when it ends in `/` or
    exists as one (unless -T), or when there are several sources. A remote rsync operand
    (`host:path`) writes nothing here; `install -d` only makes directories.
    """
    tool = tool or os.path.basename(argv[0])
    operands, target_dir, no_target_dir, directories = copy_options(argv, COPY_VALUE_OPTIONS[tool])
    if tool == "install" and directories:
        return []
    if tool == "rsync":
        operands = [o for o in operands if not re.match(r"^(?:[\w.@-]+:|rsync://)", o)]
    if target_dir is not None:
        sources, dest = operands, target_dir
    elif len(operands) >= 2:
        sources, dest = operands[:-1], operands[-1]
    else:
        return []
    dest_paths = ctx.paths(dest, cwd)
    if dest_paths is None:
        return [ShellWrite(None, None, cwd)] if may_be_source(str(dest), cwd) else []
    out = []
    for d in dest_paths:
        into = target_dir is not None or (not no_target_dir and (os.path.isdir(d) or str(dest).endswith("/")
                                                                  or len(sources) > 1))
        for source in sources:
            source_paths = ctx.paths(source, cwd)
            if not source_paths:
                # a temporary file, or a source not spelled out: its content is not read here
                if not (into and tree_of(os.path.join(d, "x")) is None):
                    out.append(ShellWrite(None if into else d, None, cwd, unreadable=True))
                continue
            contents = tool == "rsync" and str(source).endswith("/")
            for path in source_paths:
                out.extend(copied(path, d, into, contents, tool in ("mv", "git mv"), cwd, ctx))
    return out


def dd_writes(argv, cwd, text, ctx, segment, before):
    """The file `dd of=<file>` writes, with the content of its `if=` file when that can be read."""
    operands = dict(a.split("=", 1) for a in argv[1:] if "=" in a)
    if "of" not in operands:
        return []
    source = resolve(cwd, operands["if"]) if "if" in operands else None
    out = targets(ctx, Token(operands["of"]), cwd, None, output=True)
    return [w._replace(text=ctx.read(source, COPY_FILE_LIMIT))
            if source and w.path and new_content(source, w.path, False, cwd) else w for w in out]


def url_name(url, directory):
    """The file a download named after its URL lands in: the last segment of the URL's path, in `directory`."""
    try:
        name = os.path.basename(urlparse(url if "://" in url else "http://" + url).path)
    except ValueError:
        return None
    return os.path.join(directory, name) if name else None


def curl_writes(argv, cwd, text, ctx, segment, before):
    """The files curl writes: each -o/--output (spaced, `=`-joined or ending a group: `-so f`), and
    with -O/--remote-name the last segment of each URL, in --output-dir when given."""
    outputs, urls, remote, out_dir, j = [], [], False, None, 1
    while j < len(argv):
        a, nxt = argv[j], (argv[j + 1] if j + 1 < len(argv) else None)
        j += 1
        if a.startswith("--"):
            option, eq, value = a.partition("=")
            if option in ("--output", "--output-dir"):
                if not eq:
                    value, j = (nxt or ""), j + 1
                if option == "--output":
                    outputs.append(value)
                else:
                    out_dir = value
            elif option in ("--remote-name", "--remote-name-all"):
                remote = True
            elif option == "--url" and nxt is not None:
                urls.append(nxt)
                j += 1
        elif a.startswith("-") and len(a) > 1:
            for k, letter in enumerate(a[1:], start=1):
                if letter == "O":
                    remote = True
                    continue
                if letter == "o" or letter in CURL_SHORT_WITH_VALUE:
                    value = a[k + 1:]
                    if not value:
                        value, j = (nxt or ""), j + 1
                    if letter == "o":
                        outputs.append(value)
                    break
        elif re.match(r"^[a-z][a-z0-9+.-]*://", a, re.I) or re.match(r"^[\w.-]+\.[a-z]{2,}(?::\d+)?/", a, re.I):
            urls.append(a)
    base = resolve(cwd, out_dir) if out_dir else cwd
    names = [o for o in outputs if o not in ("-", "/dev/null")]
    if remote:
        names += [n for n in (url_name(u, base) for u in urls) if n]
    return [w for n in names for w in targets(ctx, Token(n), base, None, output=True)]


def wget_writes(argv, cwd, text, ctx, segment, before):
    """The files wget writes: -O/--output-document where it is named, else the last segment of each
    URL, in -P/--directory-prefix."""
    document, prefix, urls, j = None, None, [], 1
    while j < len(argv):
        a, nxt = argv[j], (argv[j + 1] if j + 1 < len(argv) else None)
        j += 1
        if a.startswith("--"):
            option, eq, value = a.partition("=")
            if option in ("--output-document", "--directory-prefix"):
                if not eq:
                    value, j = (nxt or ""), j + 1
                if option == "--output-document":
                    document = value
                else:
                    prefix = value
        elif a.startswith("-") and len(a) > 1:
            for k, letter in enumerate(a[1:], start=1):
                if letter in WGET_VALUE_LETTERS:
                    value = a[k + 1:]
                    if not value:
                        value, j = (nxt or ""), j + 1
                    if letter == "O":
                        document = value
                    elif letter == "P":
                        prefix = value
                    break
        elif re.match(r"^[a-z][a-z0-9+.-]*://", a, re.I) or re.match(r"^[\w.-]+\.[a-z]{2,}(?::\d+)?/", a, re.I):
            urls.append(a)
    if document is not None:
        return [] if document in ("-", "/dev/null") else targets(ctx, Token(document), cwd, None, output=True)
    base = resolve(cwd, prefix) if prefix else cwd
    names = [n for n in (url_name(u, base) for u in urls) if n]
    return [w for n in names for w in targets(ctx, Token(n), base, None, output=True)]


def header_path(raw, strip):
    """The file a `---`/`+++` header of a unified diff names, with `strip` leading components taken off.

    Without a -p level, a path in a/ or b/ loses that one component, as git writes them.
    """
    path = raw.split("\t")[0].strip().strip('"')
    if path == "/dev/null" or not path:
        return None
    parts = path.split("/")
    if strip is None:
        strip = 1 if parts[0] in ("a", "b") and len(parts) > 1 else 0
    return "/".join(parts[strip:]) or None


def patch_files(text, strip, reverse):
    """The files a unified diff changes: {path: (the lines it adds, how many it removes)}; None when it is no diff.

    A hunk is read by the counts of its `@@ -a,b +c,d @@` line, so inside it a removed line that
    starts `-- ` or an added one that starts `++ ` is a line, never a file header; `---`/`+++`
    name files only between hunks. Applied in reverse, the lines it removes are the ones that land.
    """
    files, current, old, old_left, new_left = {}, None, None, 0, 0
    for line in text.splitlines():
        if old_left > 0 or new_left > 0:
            if line.startswith("\\"):
                continue  # "\ No newline at end of file"
            added, removed = files[current]
            if line.startswith("+"):
                new_left -= 1
            elif line.startswith("-"):
                old_left -= 1
            else:
                old_left, new_left = old_left - 1, new_left - 1
                continue
            if (line[0] == "+") != reverse:
                added.append(line[1:])
            else:
                removed[0] += 1
        elif line.startswith("--- "):
            old = header_path(line[4:], strip)
            current = None
        elif line.startswith("+++ "):
            current = header_path(line[4:], strip) or old
            if current is not None:
                files.setdefault(current, ([], [0]))
        elif current is not None and line.startswith("@@"):
            counts = HUNK_HEADER.match(line)
            if counts:
                old_left = int(counts.group(1)) if counts.group(1) is not None else 1
                new_left = int(counts.group(2)) if counts.group(2) is not None else 1
    return {p: (a, r[0]) for p, (a, r) in files.items()} or None


HUNK_STARTS = re.compile(r"@@ -(\d+)(?:,\d+)? \+(\d+)", re.ASCII)


def patch_hunks(text, strip, reverse):
    """The hunks a unified diff applies to each file: {path: [(first old line, [(kind, line)])]}.

    `kind` is " " for context, "-" for a line taken out and "+" for a line put in; applied in
    reverse, the two swap and the first line is the new side's. Hunks are read by their counts,
    as patch_files reads them.
    """
    files, current, old, body, old_left, new_left = {}, None, None, None, 0, 0
    for line in text.splitlines():
        if old_left > 0 or new_left > 0:
            if line.startswith("\\"):
                continue  # "\ No newline at end of file"
            kind = line[:1] if line[:1] in ("+", "-") else " "
            if kind == "+":
                new_left -= 1
            elif kind == "-":
                old_left -= 1
            else:
                old_left, new_left = old_left - 1, new_left - 1
            if reverse and kind != " ":
                kind = "-" if kind == "+" else "+"
            body.append((kind, line[1:]))
        elif line.startswith("--- "):
            old = header_path(line[4:], strip)
            current = None
        elif line.startswith("+++ "):
            current = header_path(line[4:], strip) or old
            if current is not None:
                files.setdefault(current, [])
        elif current is not None and line.startswith("@@"):
            counts, starts = HUNK_HEADER.match(line), HUNK_STARTS.match(line)
            if counts and starts:
                old_left = int(counts.group(1)) if counts.group(1) is not None else 1
                new_left = int(counts.group(2)) if counts.group(2) is not None else 1
                body = []
                files[current].append((int(starts.group(2 if reverse else 1)), body))
    return files


def nearest_fit(lines, old, at, want):
    """The place at or after `at` nearest to `want` where `lines` hold `old` in a row, else None.

    The stated place is tried first and the search moves outward from it, so a patch whose hunks
    land where they say costs one comparison each.
    """
    last = len(lines) - len(old)
    want = min(max(want, at), last) if last >= at else at
    for distance in range(0, max(want - at, last - want) + 1):
        for place in (want - distance, want + distance) if distance else (want,):
            if at <= place <= last and lines[place:place + len(old)] == old:
                return place
    return None


def apply_hunks(current, hunks):
    """The text a file holds once hunks are applied to it, else None when one does not apply.

    A hunk lands at its line when its old lines are there, else at the nearest place after the
    previous hunk that holds them; a hunk whose first line is None (an apply_patch chunk) at the
    first such place.
    """
    lines = current.splitlines()
    out, at = [], 0
    for start, body in hunks:
        old = [text for kind, text in body if kind != "+"]
        new = [text for kind, text in body if kind != "-"]
        if not old:
            place = at if start is None else max(start, at)
            if place > len(lines):
                return None
        else:
            place = nearest_fit(lines, old, at, at if start is None else max(start - 1, 0))
            if place is None:
                return None
        out += lines[at:place] + new
        at = place + len(old)
    out += lines[at:]
    return "\n".join(out) + ("\n" if out and current.endswith("\n") else "")


def patch_input(files, cwd, segment, before, ctx):
    """The text of the patches a command applies: the files it names, else what reaches its stdin.

    Its stdin is a here-document or here-string, a file fed with `<`, or the files of a `cat`
    piped into it; a file an earlier command of the line writes cannot be read.
    @return the texts, or None when what it applies cannot be read
    """
    if files:
        texts = [ctx.read(resolve(cwd, f)) for f in files]
        return None if any(t is None for t in texts) else texts
    texts = list(segment.stdin)
    for name in segment.read:
        content = ctx.read(resolve(cwd, name))
        if content is None:
            return None
        texts.append(content)
    if not texts and before and before[-1] and os.path.basename(before[-1][0]) in ("cat", "zcat"):
        piped = [a for a in before[-1][1:] if not a.startswith("-")]
        texts = [ctx.read(resolve(cwd, f)) for f in piped]
        if not piped or any(t is None for t in texts):
            return None
    return texts or None


def patched(texts, base, strip, reverse, cwd, only=None):
    """The ShellWrites of applying patches from `base`; one with no path when they cannot be read.

    @param only the one file every hunk lands in (patch's file operand or -o), when given
    """
    if texts is None:
        return [ShellWrite(None, None, cwd, "patch")]
    files = patch_files("\n".join(texts), strip, reverse)
    if files is None:
        return []  # what it reads holds no diff: it changes nothing
    hunks = patch_hunks("\n".join(texts), strip, reverse)
    if only is not None:
        added = [line for lines, _ in files.values() for line in lines]
        files = {only: (added, sum(r for _, r in files.values()))}
        hunks = {only: [hunk for each in hunks.values() for hunk in each]}
    return [ShellWrite(resolve(base, path), "\n".join(added) or None, cwd, "patch", removed, hunks=hunks.get(path))
            for path, (added, removed) in files.items()]


def patch_writes(argv, cwd, text, ctx, segment, before):
    """The files `patch` writes, read from the patch it applies (-i, its second operand, or stdin).

    Its first operand, or -o, is the one file every hunk lands in; -d is where paths start;
    --dry-run and BSD's -C/--check write nothing.
    """
    strip, reverse, inputs, directory, output, operands, j = None, False, [], None, None, [], 1
    while j < len(argv):
        a, nxt = argv[j], (argv[j + 1] if j + 1 < len(argv) else None)
        j += 1
        if a.startswith("--"):
            option, eq, value = a.partition("=")
            if option in ("--dry-run", "--check"):
                return []
            reverse = reverse or option == "--reverse"
            if option in ("--strip", "--input", "--directory", "--output"):
                if not eq:
                    value, j = (nxt or ""), j + 1
                if option == "--strip":
                    strip = int(value) if re.fullmatch(r"\d+", value, re.ASCII) else None
                elif option == "--input":
                    inputs.append(value)
                elif option == "--directory":
                    directory = value
                else:
                    output = value
        elif a.startswith("-") and len(a) > 1:
            for k, letter in enumerate(a[1:], start=1):
                if letter == "C":
                    return []
                reverse = reverse or letter == "R"
                if letter in PATCH_VALUE_LETTERS:
                    value = a[k + 1:]
                    if not value:
                        value, j = (nxt or ""), j + 1
                    if letter == "p":
                        strip = int(value) if re.fullmatch(r"\d+", value, re.ASCII) else None
                    elif letter == "i":
                        inputs.append(value)
                    elif letter == "d":
                        directory = value
                    elif letter == "o":
                        output = value
                    break
        else:
            operands.append(a)
    inputs += operands[1:2]
    base = resolve(cwd, directory) if directory else cwd
    only = output if output not in (None, "-") else (operands[0] if operands else None)
    return patched(patch_input(inputs, cwd, segment, before, ctx), base, strip, reverse, cwd,
                   resolve(base, only) if only else None)


def repository_root(cwd):
    """The top of the git work tree `cwd` lies in, else `cwd`."""
    try:
        res = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=3)
    except Exception:
        return cwd
    return res.stdout.strip() or cwd if res.returncode == 0 else cwd


def restored_pathspecs(sub, args, cwd):
    """The pathspecs `git checkout` or `git restore` writes into the work tree.

    They follow `--`; without it, every operand of `git restore`, and the operands after the
    first (the commit) of `git checkout` -- or its one operand when that is an existing path.
    `git restore --staged`/`-S` without `--worktree`/`-W` writes only the index.
    """
    flags = "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))
    staged = "--staged" in args or "S" in flags
    if sub == "restore" and staged and not ("--worktree" in args or "W" in flags):
        return []
    if "--" in args:
        return args[args.index("--") + 1:]
    operands, j = [], 0
    while j < len(args):
        a = args[j]
        j += 1
        if a in GIT_RESTORE_VALUE_OPTIONS:
            j += 1
        elif not a.startswith("-"):
            operands.append(a)
    if sub == "restore":
        return operands
    if len(operands) == 1 and os.path.exists(resolve(cwd, operands[0])):
        return operands
    return operands[1:]


def restored_baselines(sub, args, cwd):
    """The static-analysis baselines `git checkout`/`git restore` writes: a pathspec naming one, or
    `.`, a directory or a glob that covers one."""
    found = []
    for spec in restored_pathspecs(sub, args, cwd):
        path = resolve(cwd, spec)
        if GLOB_CHARS.search(spec):
            directory, pattern = resolve(cwd, os.path.dirname(spec) or "."), (os.path.basename(spec),)
        elif os.path.isdir(path):
            directory, pattern = path, BASELINE_GLOBS
        else:
            found.append(path)
            continue
        found += walk_files(directory, [WALK_ENTRY_LIMIT], pattern, distinct=False, limit=EXPANSION_LIMIT)
    return [p for p in found if debt is not None and debt.BASELINE.search(os.path.basename(p))]


def git_writes(argv, cwd, text, ctx, segment, before):
    """The files `git mv`, `git apply`, `git checkout` and `git restore` write.

    `git apply` reads its patches from its operands or stdin, takes paths from the top of the
    work tree (or --directory) with one component stripped unless -p says otherwise, and writes
    nothing when it only reports (--check, --stat, --numstat, --summary without --apply).
    `git checkout`/`git restore` of a static-analysis baseline writes it with content the guard
    cannot read.
    """
    sub, args, git_cwd = git_parts(argv, cwd)
    if sub in ("checkout", "restore"):
        return [ShellWrite(path, None, git_cwd) for path in restored_baselines(sub, args, git_cwd)]
    if sub == "mv":
        if any(a in ("-n", "--dry-run") for a in args):
            return []
        return copy_writes(["git mv", *args], git_cwd, text, ctx, segment, before, "git mv")
    if sub != "apply":
        return []
    if GIT_APPLY_REPORTS & set(args) and "--apply" not in args:
        return []
    strip, reverse, directory, files, j = 1, False, None, [], 0
    while j < len(args):
        a, nxt = args[j], (args[j + 1] if j + 1 < len(args) else None)
        j += 1
        option, eq, value = a.partition("=")
        if a in ("-R", "--reverse"):
            reverse = True
        elif re.fullmatch(r"-p\d+", a, re.ASCII):
            strip = int(a[2:])
        elif option == "--directory":
            directory = value if eq else (nxt or "")
            j += 0 if eq else 1
        elif option in ("--exclude", "--include") and not eq:
            j += 1
        elif not a.startswith("-") or a == "-":
            files.append(a)
    root = repository_root(git_cwd)
    base = os.path.join(root, directory) if directory else root
    return patched(patch_input([f for f in files if f != "-"], git_cwd, segment, before, ctx), base, strip, reverse, git_cwd)


# The files a program writes by its arguments, by program name:
# (argv, cwd, the line's text, ShellWrites, its Segment, the argvs before it in its pipeline) -> [ShellWrite]
WRITERS = {
    "tee": tee_writes,
    "sed": sed_writes,
    "gsed": sed_writes,
    "perl": perl_writes,
    "cp": copy_writes,
    "mv": copy_writes,
    "install": copy_writes,
    "rsync": copy_writes,
    "dd": dd_writes,
    "curl": curl_writes,
    "wget": wget_writes,
    "patch": patch_writes,
    "gpatch": patch_writes,
    "git": git_writes,
}


def command_writes(argv, cwd, text, ctx, segment, before):
    """The ShellWrites a command makes by its arguments (WRITERS), its wrappers already taken off.

    A writer that cannot read its command line makes one write of a file it does not spell out,
    with content it cannot read.
    """
    writer = WRITERS.get(os.path.basename(argv[0]))
    if writer is None:
        return []
    try:
        return writer(argv, cwd, text, ctx, segment, before)
    except Exception:
        return [ShellWrite(None, None, cwd, "edit", unreadable=True)]


def stand_ins(cwd):
    """The source a write of an unnamed file may be, where the command runs: a PHP file in a PHP
    project (composer.json above it), a JavaScript file in a JavaScript project (package.json or
    tsconfig.json above it), nothing elsewhere."""
    if cwd == UNREAD_DIRECTORY:
        return [os.path.join(cwd, UNNAMED_FILE + ".php")]  # a directory nobody can tell: refused as such
    out = []
    if rubric is not None and rubric.nearest_root(cwd, os.path.join(cwd, "x"), ("composer.json",)):
        out.append(os.path.join(cwd, UNNAMED_FILE + ".php"))
    if rubric is not None and rubric.nearest_root(cwd, os.path.join(cwd, "x"), ("package.json", "tsconfig.json")):
        out.append(os.path.join(cwd, UNNAMED_FILE + ".js"))
    return out


def named_writes(writes):
    """Every write with its file named: a write the command does not spell out stands for each file
    the command involves (unnamed_targets); when it involves none and names no directory the
    search ran through, for the source it may be where it runs (stand_ins)."""
    named = [w for w in writes if w.path is not None]
    unnamed = [w for w in writes if w.path is None]
    if unnamed:
        candidates, searched = unnamed_targets(writes.words)
        for w in unnamed:
            paths = candidates or ([] if searched else stand_ins(w.cwd))
            named += [w._replace(path=path) for path in paths]
    return named


def replaced_text(write):
    """The text a write's markers and suppressions are counted against: the file it replaces, else
    nothing (an append, an in-place edit and a patch add their text to what stays)."""
    if write.mode == "replace":
        return debt.existing_text(write.path) or ""
    return ""


def baseline_grows(write):
    """Report whether a shell write leaves an existing static-analysis baseline bigger than it was.

    A patch is applied to the file in memory and the result judged by what it ignores
    (debt_guard's baseline verdict); a patch that does not apply counts as growth. Any other write
    whose result cannot be read counts as growth, an in-place edit included: deleting one line of
    an entry (its path, its count, an ESLint file key) widens what it ignores, and which lines a
    sed deletes is not known here. Creating the first baseline is allowed.
    """
    current = debt.existing_text(write.path)
    name = os.path.basename(write.path)
    if current is None:
        # a file that is not there: measured against what HEAD holds there, or beside a tracked one
        # of its kind (debt_guard's baseline verdict, given the path); else the first baseline
        if write.mode == "patch":
            after = apply_hunks("", write.hunks) if write.hunks is not None else None
        else:
            after = None if write.mode == "edit" else write.text
        if after is None:
            return tracked_baseline(write.path)
        return debt.baseline_verdict("Write", {"content": after}, None, name, write.path) is not None
    if write.mode == "patch":
        after = apply_hunks(current, write.hunks) if write.hunks is not None else None
        return after is None or debt.baseline_verdict("Write", {"content": after}, current, name, write.path) is not None
    if write.mode == "append":
        return write.text is None or bool(write.text.strip())
    if write.text is None or write.mode == "edit":
        return True
    return debt.baseline_verdict("Write", {"content": write.text}, current, name, write.path) is not None


BASELINE_REMOVAL = ("{what} the static-analysis baseline {path}, which the repository tracks: once it is gone, "
                    "it can be written back ignoring more than it does. " + STANDARDS + " §PHP static analysis, "
                    "§JavaScript and TypeScript static analysis): the baseline only shrinks -- shrink it by removing "
                    "the entries that are fixed (the Edit tool), never by deleting, moving or emptying the file.")


def unplaced_guarded(relative):
    """Report whether a file written by a relative path from an unknown directory may be one the
    guards hold: a plan, a baseline, or PHP or JS/TS source as its own path reads (not under a test,
    dependency, cache or build directory)."""
    if rubric is None or debt is None:
        return False
    parts = relative.split("/")
    if rubric.is_plan_file(relative) or debt.BASELINE.search(parts[-1]):
        return True
    extension = os.path.splitext(parts[-1])[1].lower()
    if extension == ".php":
        return not (rubric.PHP_SKIPPED_DIRS & set(parts[:-1]))
    if extension in rubric.JS_EXTENSIONS:
        return not (rubric.JS_SKIPPED_DIRS & set(parts[:-1]) or rubric.JS_NON_SOURCE.search(parts[-1]))
    return False


def tracked_baseline(path):
    """Report whether `path` is a baseline HEAD tracks (debt_guard.baseline_tracked); a git that cannot
    be asked counts as tracked, so a removal nobody could check is refused."""
    if debt is None or not debt.BASELINE.search(os.path.basename(path)):
        return False
    try:
        return debt.baseline_tracked(path)
    except Exception:
        return True


def ignores_nothing(path):
    """Report whether the baseline at `path` reads, in its format, as ignoring nothing: a paid-off
    baseline, which may go (debt_guard.baseline_ignores_nothing; anything it cannot read does not)."""
    try:
        return debt is not None and debt.baseline_ignores_nothing(path)
    except Exception:
        return False


def protected_baseline(path):
    """Report whether removing `path` is refused: a baseline HEAD tracks that still ignores something."""
    return tracked_baseline(path) and not ignores_nothing(path)


GIT_LIST_TIMEOUT = 5  # seconds `git ls-files` may take to list what a directory holds
DIRECTORY_OPERAND_LIMIT = 16  # directory operands of one command listed for tracked baselines


def tracked_files(directory):
    """The files the git index holds at or below `directory`; [] outside a repository.

    @throws Unread when git cannot be asked in time
    """
    try:
        res = subprocess.run(["git", "-C", directory, "ls-files", "-z", "--", "."], capture_output=True,
                             timeout=GIT_LIST_TIMEOUT, stdin=subprocess.DEVNULL)
    except Exception as error:
        raise Unread(str(error))
    if res.returncode != 0:
        return []
    return [os.path.join(directory, name) for name in res.stdout.decode("utf-8", "replace").split("\0") if name]


def protected_under(directory):
    """The first baseline below `directory` whose removal is refused (protected_baseline), else None."""
    for path in tracked_files(directory):
        if debt.BASELINE.search(os.path.basename(path)) and protected_baseline(path):
            return path
    return None


REMOVAL_WORDS = {"rm": "deletes", "unlink": "deletes", "mv": "moves", "rsync": "moves", "truncate": "truncates"}
MV_VALUE_OPTIONS = {"-t", "--target-directory", "-S", "--suffix"}
TRUNCATE_VALUE_OPTIONS = {"-s", "--size", "-r", "--reference"}
DRY_RUN_OPTIONS = {"-n", "--dry-run"}


def removal_operands(name, args):
    """What a deleting or moving command takes away: (the operands it removes, it recurses into
    directories, the operand it moves them to or None), or None when it removes nothing (a dry run,
    an rsync that keeps its sources)."""
    words, target, recursive, j = [], None, False, 0
    values = MV_VALUE_OPTIONS if name == "mv" else TRUNCATE_VALUE_OPTIONS if name == "truncate" else set()
    ended = False
    while j < len(args):
        a = str(args[j])
        j += 1
        if ended or a == "-" or not a.startswith("-"):
            words.append(args[j - 1])
            continue
        if a == "--":
            ended = True
            continue
        option, eq, value = a.partition("=")
        if option in values and not eq and option.startswith("--"):
            value, j = (str(args[j]) if j < len(args) else ""), j + 1
        elif not option.startswith("--") and len(a) > 2 and a[:2] in values:
            option, value = a[:2], a[2:]
        elif a in values:
            value, j = (str(args[j]) if j < len(args) else ""), j + 1
        if option in ("-t", "--target-directory"):
            target = value
        if name in ("rm", "rsync", "git rm") and (option in ("--recursive", "--archive") or (
                not option.startswith("--") and set(option[1:]) & set("rRa"))):
            recursive = True
        if name in ("rsync", "git rm") and (option in DRY_RUN_OPTIONS or (
                not option.startswith("--") and "n" in option[1:] and name == "git rm")):
            return None
    if name == "rsync":
        if "--remove-source-files" not in {str(a) for a in args}:
            return None
        return words[:-1], recursive, None
    if name == "mv":
        return (words, False, target) if target is not None else (words[:-1], False, words[-1] if words else None)
    return words, recursive, None


def baseline_removal_danger(argv, cwd, ctx=None):
    """Refuse deleting, moving or truncating a baseline the repository tracks while it still ignores
    something: `rm`/`unlink`/`git rm` of it or of a directory holding it (recursively), `mv`/`git mv`
    of it to another path (`-t` and `--target-directory` read), `rsync --remove-source-files` of it,
    `truncate` of it. An operand that cannot be read is refused where the repository tracks such a
    baseline, since it may be one.

    @param ctx the ShellWrites of the line, whose variables and globs the operands are read with
    """
    if debt is None or not argv:
        return None
    name, args, run_cwd = os.path.basename(argv[0]), argv[1:], cwd
    if name == "git":
        sub, args, run_cwd = git_parts(argv, cwd)
        name = {"rm": "git rm", "mv": "mv"}.get(sub or "")
    if name not in REMOVAL_WORDS and name != "git rm":
        return None
    found = removal_operands(name, args)
    if not found:
        return None
    removed, recursive, moved_to = found
    what = "this command " + REMOVAL_WORDS.get(name, "deletes")
    destination = resolve(run_cwd, str(moved_to)) if moved_to is not None else None
    directories = 0
    try:
        for word in removed:
            paths = ctx.paths(word, run_cwd) if ctx is not None else [resolve(run_cwd, str(word))]
            if paths is None:
                held = protected_under(run_cwd if os.path.isdir(run_cwd) else cwd)
                if held is not None:
                    return (f"{what} files it does not spell out ({word}), and the repository tracks the "
                            f"static-analysis baseline {held}, which may be among them. Name the files.")
                continue
            for path in paths:
                if path == destination:
                    continue
                if recursive and os.path.isdir(path) and directories < DIRECTORY_OPERAND_LIMIT:
                    directories += 1
                    held = protected_under(path)
                    if held is not None:
                        return BASELINE_REMOVAL.format(what=what, path=held)
                elif protected_baseline(path):
                    return BASELINE_REMOVAL.format(what=what, path=path)
    except Unread:
        return f"{what} files, and git could not be asked in time whether a tracked static-analysis baseline is among them."
    return None


GIT_SHOW_TIMEOUT = 5  # seconds a `git show` of a blob may take to be read


def project_file(path):
    """Report whether the debt guard reads what lands in `path`: a static-analysis baseline wherever
    it is, a source file inside a project tree. A scratch directory outside every project holds no
    source of a project, so text copied there carries no debt rule."""
    name = os.path.basename(path)
    if debt.BASELINE.search(name):
        return True
    return os.path.splitext(name)[1].lower() in debt.SOURCE_EXTENSIONS and tree_of(path) is not None


# Commands whose output the guard knows without reading anything: nothing, or the text of echo/printf
SILENT_PRODUCERS = {":", "true", "false"}
TEXT_PRODUCERS = {"echo", "printf"}
# Commands that pass on what reaches their stdin, or the files they name
FILE_PRODUCERS = {"cat", "tee"}
LINKERS = {"ln", "gln", "link"}  # every link they make leads where its target is
COPY_LINK_LETTERS = set("sl")
COPY_LINK_OPTIONS = {"--symbolic-link", "--link"}


def makes_link(words):
    """Report whether a command makes a link, symbolic or hard (`ln`, `ln -s`, `link`, `cp -s`,
    `cp -l`, `cp -al`)."""
    name = os.path.basename(words[0])
    if name in LINKERS:
        return True
    if name not in ("cp", "gcp"):
        return False
    return any(w in COPY_LINK_OPTIONS or (w.startswith("-") and not w.startswith("--") and COPY_LINK_LETTERS & set(w[1:]))
               for w in words[1:])


def hard_linked(path):
    """Report whether an existing file has another name (a hard link), which may lie in a project."""
    try:
        return os.stat(path).st_nlink > 1 and os.path.isfile(path)
    except OSError:
        return False


def guarded_content(write):
    """Report whether output the guard cannot read is refused in a write's file: a baseline anywhere,
    a project's own PHP or JS/TS source (code_source). A dump, a report, a config, a log or a fixture
    is none of them."""
    if write.path is None or debt is None:
        return False
    return bool(debt.BASELINE.search(os.path.basename(write.path))) or code_source(write.path, write.cwd)


def code_source(path, cwd):
    """Report whether `path` is a project's own PHP or JS/TS source, as the rubric gate tells it."""
    if rubric is None:
        return False
    extension = os.path.splitext(path)[1].lower()
    if extension == ".php":
        root = rubric.project_root(cwd, path)
        return root is not None and rubric.is_php_source(root, cwd, path)
    if extension in rubric.JS_EXTENSIONS:
        root = rubric.nearest_root(cwd, path, ("package.json", "tsconfig.json", "composer.json"))
        return root is not None and rubric.is_js_source(root, cwd, path)
    return False


def produced(producer, cwd, writes, ctx, before):
    """The writes of a command's output (a redirect, or a tee it feeds), with the text that lands.

    echo/printf, here-documents and here-strings give the line's text (as written already); `cat`
    gives the files it names, or what reaches its stdin; `git show`/`git cat-file -p` of a blob
    gives the blob; sed gives its input's lines and its script's text (sed_output). A copy of a repository's own source into that repository brings nothing new
    (new_content), as `cp` does. Any other command's output is content the guard cannot read, and
    is marked so where the debt guard reads it (guarded_content); elsewhere (scratch, var/, a log)
    it passes as it was.

    @param producer the program words of the command whose output is written
    @param before   the (Segment, program words) of the commands before it in its pipeline
    """
    if not writes or not producer:
        return writes
    name = os.path.basename(producer[0])
    if name in SILENT_PRODUCERS:
        return [write._replace(text="") for write in writes]
    if name in TEXT_PRODUCERS:
        return writes
    if name in FILE_PRODUCERS:
        files = [a for a in producer[1:] if a == "-" or not a.startswith("-")] if name == "cat" else []
        if not files or files == ["-"]:
            if before:
                segment, argv = before[-1]
                return writes if segment.stdin else produced(argv, cwd, writes, ctx, before[:-1])
            return writes
        return [copied_text(write, [resolve(cwd, f) for f in files], ctx) if guarded_content(write) else write
                for write in writes]
    if name in ("sed", "gsed"):
        return sed_output(producer, cwd, writes, ctx)
    if name == "git":
        source = blob_source(producer, cwd)
        if source is not None:
            spec, git_cwd, origin = source
            out, blob = [], False
            for write in writes:
                if not guarded_content(write):
                    out.append(write)
                elif origin is not None and not new_content(origin, write.path, False, write.cwd):
                    out.append(write._replace(text=None))
                else:
                    if blob is False:
                        blob = git_blob(git_cwd, spec)
                    out.append(write._replace(text=blob, unreadable=blob is None))
            return out
    return [write._replace(text=None, unreadable=True) if guarded_content(write) else write for write in writes]


def copied_text(write, sources, ctx):
    """A write of what `cat` prints of `sources`: their text where it is new to the file, none when
    every one is a repository's own source already in the file's repository."""
    if not any(new_content(source, write.path, False, write.cwd) for source in sources):
        return write._replace(text=None)
    texts = [ctx.read(source, COPY_FILE_LIMIT) for source in sources]
    if any(text is None for text in texts):
        return write._replace(text=None, unreadable=True)
    return write._replace(text="\n".join(texts))


def blob_source(argv, cwd):
    """What a `git show <rev>:<path>` or `git cat-file -p <rev>:<path>` prints: (the spec, the
    directory git runs in, the blob's file in the work tree or None); None for any other git command."""
    sub, args, git_cwd = git_parts(argv, cwd)
    specs = [a for a in args if not a.startswith("-")]
    if sub == "cat-file" and "-p" in args:
        pass
    elif sub != "show":
        return None
    if len(specs) != 1 or ":" not in specs[0]:
        return None
    path = specs[0].split(":", 1)[1]
    if path.startswith(("./", "../")):
        origin = resolve(git_cwd, path)
    else:
        root = work_tree_root(git_cwd)
        origin = resolve(root, path) if root and path else None
    return specs[0], git_cwd, origin


def git_blob(cwd, spec):
    """The text `git show <spec>` prints from `cwd`, at most CONTENT_LIMIT of it; None when it fails."""
    try:
        res = subprocess.run(["git", "-C", cwd, "--no-pager", "show", spec], capture_output=True,
                             timeout=GIT_SHOW_TIMEOUT, stdin=subprocess.DEVNULL)
    except Exception:
        return None
    if res.returncode != 0:
        return None
    return res.stdout[:CONTENT_LIMIT].decode("utf-8", errors="replace")


def own_source(path, cwd):
    """Report whether `path` is a file whose content the guards hold to their rules as the project's own:
    PHP or JS/TS source as the rubric gate tells it (not tests, dependencies, build output or served
    copies), or any other file the guards care about."""
    extension = os.path.splitext(path)[1].lower()
    if extension == ".php":
        root = rubric.project_root(cwd, path)
        return root is not None and rubric.is_php_source(root, cwd, path)
    if extension in rubric.JS_EXTENSIONS:
        root = rubric.nearest_root(cwd, path, ("package.json", "tsconfig.json", "composer.json"))
        return root is not None and rubric.is_js_source(root, cwd, path)
    return guarded(path)


def unnamed_danger(writes):
    """The debt guard's reason to refuse a write the command does not spell out, else None.

    A patch the guard cannot read is refused. Its text is judged where the write resolves to
    source (named_writes), and nowhere else.
    """
    if os.environ.get("CLAUDE_NO_DEBT_GUARD"):
        return None
    for write in writes:
        if write.path is not None or debt.exempt(write.cwd):
            continue
        if write.mode == "patch" and write.text is None:
            return ("this command applies a patch that cannot be read here (piped from another command, or "
                    "written earlier on the same line), so the files it changes and the lines it adds cannot "
                    f"be checked. {STANDARDS} §Architecture and tech debt). Write the patch to a file in a "
                    "command of its own, then apply that file.")
    return None


def write_danger(writes, transcript_path):
    """Apply the rubric gate and the debt guard to files written through the shell.

    @param writes the ShellWrites of the command (a ShellWrites, whose unnamed writes are named here)
    """
    if rubric is None or debt is None:
        return None
    why = unnamed_danger(writes)
    if why:
        return why
    for write in named_writes(writes):
        path, text = write.path, write.text
        if path.startswith(UNREAD_DIRECTORY + os.sep):
            relative = path[len(UNREAD_DIRECTORY) + 1:]
            if unplaced_guarded(relative):
                return (f"this command writes {relative} after a `cd` whose target cannot be read here, so "
                        "which project the file lands in -- and whether the rubric and the debt rules apply "
                        f"to it -- cannot be checked. {STANDARDS} §Architecture and tech debt). Write the "
                        "file by its absolute path, or give the cd a literal one.")
            continue
        if not os.environ.get("CLAUDE_NO_PLAN_SKILL_GATE"):
            verdict = rubric.missing_for(write.cwd, path, transcript_path, text)
            if verdict is not None:
                text_ = rubric.denial(*verdict).rstrip()
                return "a shell write of " + text_[len("Blocked: "):] if text_.startswith("Blocked: ") else text_
        if os.environ.get("CLAUDE_NO_DEBT_GUARD") or debt.exempt(path):
            continue
        if debt.BASELINE.search(os.path.basename(path)):
            if write.mode == "replace" and write.text is not None and not write.text.strip() and protected_baseline(path):
                return BASELINE_REMOVAL.format(what="this command empties", path=path)
            if baseline_grows(write):
                return (f"this command grows the static-analysis baseline {path}, or writes it with content "
                        f"that cannot be read. {STANDARDS} §PHP static analysis, §JavaScript and TypeScript "
                        "static analysis): the baseline only shrinks -- fix the reported errors, or report them "
                        "as unfixable. Remove a fixed entry whole with the Edit tool, whose result can be read.")
            continue
        if write.unreadable and (write.mode == "tree" or own_source(path, write.cwd)):
            return (f"this command writes {path} with content new to it that cannot be read here: a file "
                    "that is missing or that an earlier command of the same line writes, a sed script "
                    f"of that kind, or a copied tree of more than {CANDIDATE_LIMIT} source files. {STANDARDS} "
                    "§Architecture and tech debt): what lands in source is checked for deferral markers and "
                    "suppressions. Make the content first in a command of its own, or copy fewer files at a time.")
        # a scratch directory outside every project holds no source, unless the line links it into one
        linked = os.path.splitext(path)[1].lower() in debt.SOURCE_EXTENSIONS and (
            getattr(writes, "links", False) or hard_linked(path))
        if text and (project_file(path) or linked):
            hit = debt.debt_added(replaced_text(write), text, path, fragment=write.mode != "replace")
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


def command_danger(argv, cwd, cmd, stdin, ctx=None):
    """The reason one command is refused by its own rule, the baseline, SQL or board-queue rule, else None.

    @param ctx the ShellWrites of the command line, whose variables name a program held in one
    """
    rule = SEGMENT_RULES.get(os.path.basename(argv[0]))
    return ((rule(argv, cwd, cmd) if rule else None) or baseline_danger(argv, cwd) or sql_danger(argv, stdin)
            or baseline_removal_danger(argv, cwd, ctx) or board_queue_danger(argv, cwd, stdin, ctx))


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
    collected in `writes`, to be judged once every command has passed, with every word and
    variable assignment that can name a file it does not spell out.

    @param text   the command line
    @param cwd    the directory it starts in
    @param cmd    the whole command the hook was given
    @param writes the ShellWrites collecting each file written
    @param depth  how many command lines enclose this one
    @param fed    what an enclosing pipeline feeds to this line's stdin
    """
    deeper = depth < SHELL_NESTING_LIMIT
    previous = None
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
                for target, operator in segment.written:
                    found = redirect_writes(target, operator, cwd, written, writes)
                    writes.extend(produced(argv, cwd, found, writes, list(zip(pipeline[:k], argvs[:k]))))
                writes.record(segment, cwd)
                if not argv:
                    continue
                moved = cd_target(argv, cwd, writes, previous)
                if moved is not None:
                    previous, cwd = cwd, moved
                    continue
                stdin = [*fed, *(word for prev, prev_argv in zip(pipeline[:k], argvs[:k])
                                 for word in [*piped_words(prev_argv), *prev.stdin]), *segment.stdin]
                found = command_writes(argv, cwd, written, writes, segment, argvs[:k])
                if argv and os.path.basename(argv[0]) == "tee" and k > 0 and not segment.stdin:
                    found = produced(argvs[k - 1], cwd, found, writes, list(zip(pipeline[:k - 1], argvs[:k - 1])))
                writes.extend(found)
                why = command_danger(argv, cwd, cmd, stdin, writes)
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
    writes = ShellWrites()
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
        why = check(cmd, cwd, rubric.evidence_transcript(data) if rubric is not None else "")
    except Exception:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": ("bash_guard.py (guards plugin) failed while reading this command, so "
                                         "its rules were not applied; confirm it yourself."),
        }}))
        return 0
    if why:
        print(f"BLOCKED by bash_guard.py (guards plugin): {why}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
