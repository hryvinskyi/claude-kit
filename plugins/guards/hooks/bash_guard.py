#!/usr/bin/env python3
"""PreToolUse guard (Bash): block a short list of catastrophic commands.

Deliberately narrow: a tripwire for irreversible damage, not a policy engine.
Project-specific rules (test-suite discipline, container prefixes) belong in
each project's own .claude/settings.json hook.

The command is parsed, not pattern-matched. It is split into pipelines on
`;`, `&&`, `||`, `&` and newlines, each pipeline into segments on `|`, and
each segment into argv with shlex. Rules look at argv[0] and its arguments,
so a commit message or an `echo` that merely mentions a dangerous command
passes. `cd` segments are tracked so relative targets and bare pushes are
judged from the directory the command will actually run in.

Rules (each has cases in tests.sh):
  rm     recursive + force whose target resolves to /, $HOME, a /Volumes
         mount root, "<any of those>/*", or `*` / `.` while cwd is one of them
  find   -delete, or -exec/-execdir/-ok running rm
  git    push with --force/-f (not --force-with-lease / --force-if-includes),
         --delete, or a ":branch" refspec aimed at main/master/develop/
         production, including a bare force-push while the checked-out branch
         is protected (or cannot be resolved), and forced --all/--mirror;
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
  mysql  mysql, mariadb, `ddev mysql`, `ddev exec mysql` executing (via -e or
         an earlier segment of the same pipeline) DROP DATABASE/SCHEMA/TABLE,
         TRUNCATE, or DELETE FROM without WHERE
  ddev   `ddev delete` with --omit-snapshot / -O (drops the DB, no snapshot)
  curl   curl/wget sending a request body or upload (-d/--data*/--json/-F/-T/
         --upload-file; wget --post-*/--body-*) to a host that is not local
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
REDIRECT_OUT = {">", ">>", "&>", "&>>", ">|"}
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


def tokenize(line):
    """Tokenize one logical line; degrade gracefully on unbalanced quotes."""
    try:
        lex = shlex.shlex(line, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        return list(lex)
    except ValueError:
        tokens = []
        for physical in line.split("\n"):
            try:
                lex = shlex.shlex(physical, posix=True, punctuation_chars=True)
                lex.whitespace_split = True
                tokens.extend(list(lex))
            except ValueError:
                tokens.extend(physical.replace("'", " ").replace('"', " ").split())
            tokens.append(";")
        return tokens


def pipelines(cmd):
    """Split a command into pipelines, each a list of argv segments."""
    result = []
    for line in logical_lines(cmd):
        pipeline, argv = [], []
        for tok in tokenize(line) + [";"]:
            if tok in PIPELINE_SEPARATORS:
                if argv:
                    pipeline.append(argv)
                if pipeline:
                    result.append(pipeline)
                pipeline, argv = [], []
            elif tok in SEGMENT_SEPARATORS:
                if argv:
                    pipeline.append(argv)
                argv = []
            elif tok and all(c in "<>&" for c in tok):
                continue  # redirection operator
            else:
                argv.append(tok)
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
        if p in ("*", ".", "./", "./*"):
            base = os.path.realpath(cwd)
        else:
            if p.endswith("/*"):
                p = p[:-2] or "/"
            p = p.rstrip("/") or "/"
            base = resolve(cwd, p)
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


def push_danger(args, cwd):
    force = delete = everything = False
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
        elif a in ("--all", "--mirror", "--branches"):
            everything = True
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
        if r.startswith(":") and branch_of(r) in PROTECTED:
            return f"deleting protected remote branch {branch_of(r)} via ':branch' refspec."
    targets = set()
    for r in refspecs:
        b = branch_of(r)
        targets.add(current_branch(cwd) or "HEAD" if b == "HEAD" else b)
    if delete and targets & PROTECTED:
        return "deleting a protected remote branch (main/master/develop/production)."
    if not force:
        return None
    if everything:
        return "force-push of all branches / mirror."
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


def is_mysql(argv):
    name = os.path.basename(argv[0])
    if name in ("mysql", "mariadb", "mysqlsh"):
        return True
    if name == "ddev" and len(argv) >= 2 and argv[1] == "mysql":
        return True
    if name == "ddev" and len(argv) >= 3 and argv[1] == "exec" and os.path.basename(argv[2]) in ("mysql", "mariadb"):
        return True
    return False


def mysql_danger(pipeline):
    for k, argv in enumerate(pipeline):
        if not is_mysql(argv):
            continue
        sql = []
        for j, a in enumerate(argv):
            if a in ("-e", "--execute") and j + 1 < len(argv):
                sql.append(argv[j + 1])
            elif a.startswith("--execute="):
                sql.append(a.split("=", 1)[1])
            elif a.startswith("-e") and len(a) > 2 and not a.startswith("--"):
                sql.append(a[2:])
        for prev in pipeline[:k]:
            sql.extend(prev[1:])
        for s in sql:
            if DANGEROUS_SQL.search(s):
                return "destructive SQL (DROP DATABASE/TABLE, TRUNCATE, or DELETE without WHERE) sent to MySQL. Take a snapshot/backup and ask the user."
    return None


def ddev_danger(argv):
    if len(argv) >= 2 and argv[1] == "delete":
        for a in argv[2:]:
            if a == "--omit-snapshot" or (a.startswith("-") and not a.startswith("--") and "O" in a):
                return "ddev delete without a snapshot destroys the project database. Drop --omit-snapshot or ask the user."
    return None


def curl_danger(argv):
    tool = os.path.basename(argv[0])
    body, url = False, None
    for j, a in enumerate(argv[1:], 1):
        if tool == "curl":
            if a in CURL_BODY_FLAGS or any(a.startswith(f + "=") for f in CURL_BODY_FLAGS if f.startswith("--")):
                body = True
            elif re.match(r"^-[A-Za-z]+$", a) and any(c in a[1:] for c in "dFT"):
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

    @return List of (absolute path, text or None) -- None when the content is not
            visible in the command (cp/mv/install, sed without an `s` command).
    """
    found = []
    bodies = heredoc_bodies(cmd)
    line_no = 0
    for line in logical_lines(cmd):
        line_text = "\n".join(bodies.get(line_no, []))
        line_no += line.count("\n") + 1
        toks = tokenize(line) + [";"]
        segments, argv, targets, skip = [], [], [], False
        for i, tok in enumerate(toks):
            if skip:
                skip = False
                continue
            if tok in PIPELINE_SEPARATORS or tok in SEGMENT_SEPARATORS:
                if argv or targets:
                    segments.append((argv, targets))
                argv, targets = [], []
            elif tok in REDIRECT_OUT:
                nxt = toks[i + 1] if i + 1 < len(toks) else ""
                if nxt and not all(c in "<>&|;()" for c in nxt):
                    targets.append(nxt)
                    skip = True
            elif tok and all(c in "<>&" for c in tok):
                continue
            else:
                argv.append(tok)
        produced = [line_text] if line_text else []
        for argv, _ in segments:
            argv = strip_wrappers(argv)
            if argv and os.path.basename(argv[0]) in ("echo", "printf"):
                produced.append(" ".join(a for a in argv[1:] if not a.startswith("-")))
        text = "\n".join(produced) or None
        for argv, targets in segments:
            argv = strip_wrappers(argv)
            name = os.path.basename(argv[0]) if argv else ""
            if name in ("cd", "pushd"):
                cwd = resolve(cwd, argv[1]) if len(argv) > 1 else HOME
                continue
            for t in targets:
                found.append((resolve(cwd, t), text))
            if name == "tee":
                for t in (a for a in argv[1:] if not a.startswith("-")):
                    found.append((resolve(cwd, t), text))
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
                    found.append((resolve(cwd, f), sed_text))
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
                    found.append((resolve(cwd, f), perl_text))
            elif name in COPY_TOOLS:
                positional = [a for a in argv[1:] if not a.startswith("-")]
                if len(positional) >= 2:
                    found.append((resolve(cwd, positional[-1]), None))
    return found


def write_danger(cmd, cwd, transcript_path):
    """Apply the rubric gate and the debt guard to files the command writes through the shell."""
    if rubric is None or debt is None:
        return None
    for path, text in written_files(cmd, cwd):
        if not os.environ.get("CLAUDE_NO_PLAN_SKILL_GATE"):
            verdict = rubric.missing_for(cwd, path, transcript_path, text)
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
    for pipeline in pipelines(cmd):
        segments = [s for s in (strip_wrappers(a) for a in pipeline) if s]
        for argv in segments:
            name = os.path.basename(argv[0])
            if name in ("cd", "pushd"):
                cwd = resolve(cwd, argv[1]) if len(argv) > 1 else HOME
                continue
            rule = SEGMENT_RULES.get(name)
            why = rule(argv, cwd, cmd) if rule else None
            if why is None:
                why = baseline_danger(argv, cwd)
            if why:
                return why
        why = mysql_danger(segments)
        if why:
            return why
    return write_danger(cmd, cwd, transcript_path)


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
