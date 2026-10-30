#!/usr/bin/env python3
"""PreToolUse guard (Bash): block a short list of catastrophic commands.

Deliberately narrow: a tripwire for irreversible damage, not a policy engine.
Project-specific rules (test-suite discipline, container prefixes) belong in
each project's own .claude/settings.json hook.

The command is parsed, not pattern-matched. It is split into pipelines on
`;`, `&&`, `||`, `&` and newlines, each pipeline into segments on `|`, and
each segment into argv with shlex. Redirections are taken out of argv --
the operator, an fd number glued to it and its target -- so `2>&1` or
`> log` is never read as an argument. Rules look at argv[0] and its arguments,
so a commit message or an `echo` that merely mentions a dangerous command
passes. `cd` segments are tracked so relative targets and bare pushes are
judged from the directory the command will actually run in.

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
  sql    mysql, mariadb, mysqlsh, psql, `ddev mysql|psql`, `ddev exec <client>`
         (also `ddev exec "<client> ..."`) executing (via -e / -c / --command or
         an earlier segment of the same pipeline) DROP DATABASE/SCHEMA/TABLE,
         TRUNCATE, or DELETE FROM without WHERE; a DROP DATABASE of a name
         ending in _test or _test<digits> is a rebuildable scratch database
         and is let through
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
           - debt_guard.py: the written text (heredoc body, echo/printf
             arguments, a sed `s///` replacement) may not carry a deferral
             marker or a static-analysis suppression into a source file.
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
from urllib.parse import urlparse

PROTECTED = {"main", "master", "develop", "production"}
LOCAL_BRANCH_PROTECTED = {"main", "master"}
WRAPPERS = {"sudo", "doas", "command", "exec", "nohup", "time", "nice", "env"}
WRAPPER_FLAGS_WITH_VALUE = {"-u", "-g", "-n", "-C", "-h", "-p"}
PIPELINE_SEPARATORS = {";", "&&", "||", "&", "(", ")", ";;"}
SEGMENT_SEPARATORS = {"|", "|&"}
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
DANGEROUS_SQL = re.compile(
    r"\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\s+\S+\s*(?:;|$)",
    re.I,
)
HOME = os.path.realpath(os.path.expanduser("~"))
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
# Every shell operator a run of operator characters can hold, longest first
OPERATORS = ("&>>", "<<<", ";;", "&&", "||", "|&", "&>", ">>", ">&", "<&", ">|", "<>", "<<",
             ";", "&", "|", "(", ")", "<", ">")
REDIRECTS = {">", ">>", ">|", "&>", "&>>", ">&", "<", "<<", "<<<", "<>", "<&"}
REDIRECT_OUT = {">", ">>", "&>", "&>>", ">|", "<>"}
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

def logical_lines(cmd):
    """Yield shell lines, joining continuations and multi-line quoted strings."""
    buf = ""
    for line in cmd.split("\n"):
        buf = f"{buf}\n{line}" if buf else line
        if buf.endswith("\\"):
            continue
        try:
            shlex.split(buf)
        except ValueError:
            continue  # unbalanced quote so far: keep accumulating
        yield buf
        buf = ""
    if buf:
        yield buf


class Token(str):
    """A shell word, knowing whether it is an unquoted operator and whether blank space came before it."""

    def __new__(cls, text, op=False, spaced=True):
        token = super().__new__(cls, text)
        token.op, token.spaced = op, spaced
        return token


class Lexer(shlex.shlex):
    """shlex in punctuation mode, returning Tokens.

    An operator token is one whose first character is an unquoted operator
    character, so `">"` stays a word. A word ends either on blank space, which
    shlex consumes, or on an operator character, which it pushes back: that
    pushback tells a glued `2>` from a spaced `2 >`.
    """

    def __init__(self, line):
        super().__init__(line, posix=True, punctuation_chars=True)
        self.whitespace_split = True

    def read_token(self):
        spaced = not self._pushback_chars
        while True:
            c = self._pushback_chars.pop() if self._pushback_chars else self.instream.read(1)
            if not c or c not in self.whitespace:
                break
            spaced = True
        if c:
            self._pushback_chars.append(c)
        raw = super().read_token()
        if raw is None:
            return None
        return Token(raw, bool(c) and c in self.punctuation_chars, spaced)


def split_operators(token):
    """Split a run of operator characters (`;)>`, `2>&1|`'s `>&`) into the operators it is made of."""
    out, i = [], 0
    while i < len(token):
        op = next((o for o in OPERATORS if token.startswith(o, i)), token[i])
        out.append(Token(op, True, token.spaced and i == 0))
        i += len(op)
    return out


def tokenize(line):
    """Tokenize one logical line into Tokens; degrade gracefully on unbalanced quotes."""
    try:
        tokens = list(Lexer(line))
    except ValueError:
        tokens = []
        for physical in line.split("\n"):
            try:
                tokens.extend(list(Lexer(physical)))
            except ValueError:
                words = physical.replace("'", " ").replace('"', " ").split()
                tokens.extend(Token(w, all(c in "();<>|&" for c in w)) for w in words)
            tokens.append(Token(";", True))
    out = []
    for tok in tokens:
        out.extend(split_operators(tok) if tok.op else [tok])
    return out


def line_segments(line):
    """Split one logical line into pipelines of (argv, written files) segments.

    A redirection never reaches argv: its operator, the fd number glued to it
    (`2>`, `{fd}>`) and its target are taken out, and the targets it writes
    (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, and `>&` to a name that is not an fd)
    are returned beside argv.
    """
    result, pipeline, argv, written = [], [], [], []
    toks = tokenize(line) + [Token(";", True)]
    i = 0
    while i < len(toks):
        tok = toks[i]
        i += 1
        if tok in PIPELINE_SEPARATORS or tok in SEGMENT_SEPARATORS:
            if argv or written:
                pipeline.append((argv, written))
            argv, written = [], []
            if tok in PIPELINE_SEPARATORS:
                if pipeline:
                    result.append(pipeline)
                pipeline = []
        elif tok.op and tok in REDIRECTS:
            prev = toks[i - 2] if i >= 2 else None
            if (not tok.spaced and argv and argv[-1] is prev and not prev.op
                    and re.match(r"^(?:\d+|\{\w+\})$", prev)):
                argv.pop()  # the fd number of `2>`
            target = toks[i] if i < len(toks) and not toks[i].op else None
            if target is None:
                continue
            i += 1
            if tok in REDIRECT_OUT or (tok == ">&" and not re.match(r"^(?:\d+|-)$", target)):
                written.append(target)
        else:
            argv.append(tok)
    return result


def pipelines(cmd):
    """Split a command into pipelines, each a list of argv segments, redirections taken out."""
    result = []
    for line in logical_lines(cmd):
        for pipeline in line_segments(line):
            argvs = [argv for argv, _ in pipeline if argv]
            if argvs:
                result.append(argvs)
    return result


def strip_wrappers(argv):
    """Drop leading VAR=val assignments and sudo/env/nohup-style wrappers."""
    i = 0
    while i < len(argv):
        tok = argv[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            i += 1
            continue
        if os.path.basename(tok) in WRAPPERS:
            i += 1
            while i < len(argv) and argv[i].startswith("-"):
                i += 2 if argv[i] in WRAPPER_FLAGS_WITH_VALUE else 1
            continue
        break
    return argv[i:]


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


SQL_CLIENTS = ("mysql", "mariadb", "mysqlsh", "psql")
DDEV_EXEC_VALUE_OPTIONS = ("-s", "--service", "-d", "--dir")
PSQL_VALUE_OPTIONS = "dhUpfFoPRTvL"
# A scratch database named *_test or *_test<digits> is rebuilt from migrations on every stack.
TEST_DATABASE_DROP = re.compile(
    r"\bDROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?[\"`]?\w*_test\d*[\"`]?"
    r"(?:\s+(?:WITH\s*)?\(\s*FORCE\s*\))?\s*(?=;|$)",
    re.I,
)


def sql_client(argv):
    """Return (client, its argv) when the segment runs a SQL client, else None.

    The client is one of mysql, mariadb, mysqlsh, psql, called directly, through
    `ddev <client>`, or through `ddev exec` (program as separate words, or the whole
    program line as one quoted string).
    """
    name = os.path.basename(argv[0])
    if name in SQL_CLIENTS:
        return name, argv
    if name != "ddev" or len(argv) < 2:
        return None
    if argv[1] in ("mysql", "psql"):
        return argv[1], argv[1:]
    if argv[1] != "exec":
        return None
    rest = argv[2:]
    k = 0
    while k < len(rest) and rest[k].startswith("-"):
        k += 2 if rest[k] in DDEV_EXEC_VALUE_OPTIONS else 1
    rest = rest[k:]
    if len(rest) == 1:
        try:
            rest = shlex.split(rest[0])
        except ValueError:
            rest = rest[0].split()
    if rest and os.path.basename(rest[0]) in SQL_CLIENTS:
        return os.path.basename(rest[0]), rest
    return None


def mysql_statements(argv):
    sql = []
    for j, a in enumerate(argv):
        if a in ("-e", "--execute") and j + 1 < len(argv):
            sql.append(argv[j + 1])
        elif a.startswith("--execute="):
            sql.append(a.split("=", 1)[1])
        elif a.startswith("-e") and len(a) > 2 and not a.startswith("--"):
            sql.append(a[2:])
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


def sql_danger(pipeline):
    for k, argv in enumerate(pipeline):
        found = sql_client(argv)
        if found is None:
            continue
        client, client_argv = found
        sql = psql_statements(client_argv) if client == "psql" else mysql_statements(client_argv)
        for prev in pipeline[:k]:
            sql.extend(prev[1:])
        for s in sql:
            if DANGEROUS_SQL.search(TEST_DATABASE_DROP.sub("", s)):
                return "destructive SQL (DROP DATABASE/TABLE, TRUNCATE, or DELETE without WHERE) sent to a database. Take a snapshot/backup and ask the user."
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

def heredoc_bodies(cmd):
    """Map each command line index to the heredoc bodies that line opens."""
    lines = cmd.split("\n")
    bodies, i = {}, 0
    while i < len(lines):
        markers = HEREDOC.findall(lines[i])
        opener = i
        i += 1
        for _quote, word in markers:
            body = []
            while i < len(lines) and lines[i].rstrip("\t").strip("\t") != word and lines[i] != word:
                body.append(lines[i])
                i += 1
            i += 1  # the terminator line
            bodies.setdefault(opener, []).append("\n".join(body))
    return bodies


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


def written_files(cmd, cwd):
    """Files the command writes and the text it writes into them.

    @param cwd The directory the command starts in; each `cd` moves it once, from where it stands.
    @return List of (absolute path, text or None, the cwd of the writing segment) -- the text is
            None when the content is not visible in the command (cp/mv/install, sed without an
            `s` command).
    """
    found = []
    bodies = heredoc_bodies(cmd)
    line_no = 0
    for line in logical_lines(cmd):
        line_text = "\n".join(bodies.get(line_no, []))
        line_no += line.count("\n") + 1
        segments = [segment for pipeline in line_segments(line) for segment in pipeline]
        produced = [line_text] if line_text else []
        for argv, _ in segments:
            argv = strip_wrappers(argv)
            if argv and os.path.basename(argv[0]) in ("echo", "printf"):
                produced.append(" ".join(a for a in argv[1:] if not a.startswith("-")))
        text = "\n".join(produced) or None
        for argv, targets in segments:
            argv = strip_wrappers(argv)
            name = os.path.basename(argv[0]) if argv else ""
            moved = cd_target(argv, cwd)
            if moved is not None:
                cwd = moved
                continue
            for t in targets:
                found.append((resolve(cwd, t), text, cwd))
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


def write_danger(cmd, cwd, transcript_path):
    """Apply the rubric gate and the debt guard to files the command writes through the shell."""
    if rubric is None or debt is None:
        return None
    for path, text, segment_cwd in written_files(cmd, cwd):
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


def check(cmd, cwd, transcript_path=""):
    start = cwd  # the shell-write pass walks the same `cd`s itself
    for pipeline in pipelines(cmd):
        segments = [s for s in (strip_wrappers(a) for a in pipeline) if s]
        for argv in segments:
            name = os.path.basename(argv[0])
            moved = cd_target(argv, cwd)
            if moved is not None:
                cwd = moved
                continue
            rule = SEGMENT_RULES.get(name)
            why = rule(argv, cwd, cmd) if rule else None
            if why is None:
                why = baseline_danger(argv, cwd)
            if why:
                return why
        why = sql_danger(segments)
        if why:
            return why
    return write_danger(cmd, start, transcript_path)


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
