#!/usr/bin/env python3
"""PreToolUse hook (mcp__.*): an MCP tool that writes a file, runs a shell command or runs SQL
meets the guard its built-in counterpart meets.

MCP servers ship tools that do what Edit, Write and Bash do: an IDE server creates files,
applies patches, replaces text, runs its terminal and its database console; a filesystem server
writes, edits and moves files. Each call is classified by the shape of its input, never by the
server's name, so every server is covered:

  shell  a `command` (`cmd`, `shell_command`, `command_line`, `commandLine`), as a string or a
         list of words, with its `args`/`argv`/`arguments` appended when they are words (a shell
         whose arguments are not is asked about; another program is judged alone): the shell guard's judge
         (bash_guard.check), as for a Bash call, with the writes it makes held to the rubric gate
         and the debt guard. What reaches a shell's `stdin`/`input` is judged as a script too, and
         so is the `input` written to a running process (a `pid`, `process_id` or `terminal_id`
         in the input, or a tool named for a process, a terminal or a REPL). A shell-shaped key
         that holds neither text nor a list of words is asked about.
  SQL    `sql`, `sql_query`, `sqlQuery`, `queryText`, `query_text`, `statement`, `statements`;
         `query` when it is a statement (it opens with a SQL verb) and the tool's or its server's
         name speaks of a database (sql, postgres, mysql, sqlite, db …), or when it is a destructive
         statement whole — a search's or a log query's prose is neither: the shell guard's
         SQL rule (bash_guard.destructive_sql — DROP DATABASE/SCHEMA/TABLE, TRUNCATE, DELETE
         without WHERE).
  patch  `patch` or `diff`, or `input` holding one: an apply_patch envelope (its first line
         `*** Begin Patch`) or a unified diff. Every file it adds lines to meets the rubric gate,
         and the debt guard on the lines it adds (debt_guard.debt_added); a baseline is applied
         in memory and judged by what it ignores after (bash_guard.baseline_grows), refused when
         the patch does not apply.
  file   a path (`file_path`, `filePath`, `path`, `pathInProject`, `relative_path`,
         `relativePath`, `file`, `filename`, `target_file`, `targetFile`) with the text it writes
         (`content`, `contents`, `text`, `file_text`, `new_content`, `newContent`, `body`,
         `new_body`, `newBody`, `replacement`), with a replacement (`old_string`/`new_string`,
         `oldText`/`newText`, `old_text`/`new_text`, `old_str`/`new_str`, `oldString`/`newString`),
         or with a list of such `edits`: the rubric gate (plan_skill_gate.missing_for) and the
         debt guard's own checks of a Write or an Edit (debt_guard.write_debt, baseline_verdict,
         config_verdict). A move (`source` with `destination`) is a Write of the source's text to
         the destination, unless the source is a repository's own source moved within it
         (bash_guard.new_content, as for `mv`) or a baseline that ignores nothing; a move of a
         baseline the repository tracks, while it ignores something, away from its place is
         refused, as through the shell.

A preview (`dryRun`/`dry_run` true) writes nothing, and a path of a remote repository (an input
naming an `owner`, `repo`, `repository` or `branch`) is no file on this disk. Relative paths
resolve against the input's `projectPath` (or `project_path`) when it is an absolute directory,
else against the hook's cwd. The rubric evidence is the caller's own transcript
(plan_skill_gate.evidence_transcript), as for every other write.

Read-only tools pass untouched: a tool whose input holds none of the keys above returns before
any sibling is imported, and so does one whose own name starts with a reading verb (read, get,
list, search, find, grep, show, view, describe, inspect, preview, fetch, …), holds no writing
word (write, edit, create, replace, overwrite, apply, patch, move, rename, delete, insert,
update, set, put, save, store, execute, run, …) and whose input holds no key that writes or runs
(a command, SQL, a patch, a replacement, edits, a destination, a stdin) — a search's path and
text do not. An input that carries a key in no shape above (a `path` with nothing to write, an
`input` that is no patch) passes as before.

Denial is exit 2. An input that cannot be parsed, or an error while judging a classified call,
asks the person to confirm the call (permissionDecision "ask") rather than letting an unchecked
write, command or statement through. Kill switches: those of the rules applied
(CLAUDE_NO_PLAN_SKILL_GATE, CLAUDE_NO_DEBT_GUARD).
"""
import json
import os
import re
import shlex
import sys

SHELL_KEYS = ("command", "cmd", "shell_command", "command_line", "commandLine")
ARGS_KEYS = ("args", "argv", "arguments")  # the words a `command` runs with
STDIN_KEYS = ("stdin", "input")  # what reaches a shell's stdin, or a running process's
PROCESS_KEYS = ("pid", "process_id", "processId", "terminal_id", "terminalId")
PROCESS_WORDS = frozenset({"process", "terminal", "interact", "stdin", "repl"})
SQL_KEYS = ("sql", "sql_query", "sqlQuery", "queryText", "query_text", "statement", "statements")
NAMED_SQL_KEYS = ("query",)  # SQL when the tool's name speaks of a database, or the text is a destructive statement
PATCH_KEYS = ("patch", "diff", "input")
PATH_KEYS = ("file_path", "filePath", "path", "pathInProject", "relative_path", "relativePath", "file", "filename",
             "target_file", "targetFile")
CONTENT_KEYS = ("content", "contents", "text", "file_text", "new_content", "newContent", "body", "new_body",
                "newBody", "replacement")
REPLACEMENT_KEYS = (("old_string", "new_string"), ("oldText", "newText"), ("old_text", "new_text"),
                    ("old_str", "new_str"), ("oldString", "newString"))
MOVE_KEYS = ("source", "destination")
PROJECT_KEYS = ("projectPath", "project_path")
REMOTE_KEYS = ("owner", "repo", "repository", "branch")  # a path in a remote repository, not on this disk
DRY_RUN_KEYS = ("dryRun", "dry_run")
# Keys that say the call writes or runs something whatever the tool's name: the name-based skip of a
# reading tool is taken only without them. A bare text (a search's) is not among them.
WRITE_SHAPED = frozenset(SHELL_KEYS + SQL_KEYS + ("patch", "diff", "edits", "destination", "stdin")
                         + tuple(new for _, new in REPLACEMENT_KEYS))
KEYS = frozenset(SHELL_KEYS + STDIN_KEYS + SQL_KEYS + NAMED_SQL_KEYS + PATCH_KEYS + PATH_KEYS + CONTENT_KEYS
                 + MOVE_KEYS + ("edits",) + tuple(new for _, new in REPLACEMENT_KEYS))

SQL_TOOL_NAME = re.compile(r"sql|database|postgres|mysql|maria|sqlite|duckdb|clickhouse|(?:^|_)(?:db|pg)(?:_|$)", re.I)
# A text that is a statement rather than prose: it opens with a SQL verb
SQL_STATEMENT = re.compile(
    r"\s*(?:(?:--[^\n]*|/\*.*?\*/)\s*)*(?:SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|WITH|REPLACE|MERGE|"
    r"GRANT|REVOKE|RENAME|COPY|VACUUM|ANALYZE|EXPLAIN|SET|BEGIN|COMMIT|ROLLBACK|USE|SHOW|PRAGMA|CALL|EXEC|EXECUTE)\b",
    re.I | re.S,
)
# A whole statement that destroys: what a `query` holds when no name says it is SQL
DESTRUCTIVE_STATEMENT = re.compile(
    r"\s*(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)(?:\s+IF\s+EXISTS)?\s+[\w.\"`\[\]]+"
    r"|TRUNCATE(?:\s+TABLE)?\s+[\w.\"`\[\]]+"
    r"|DELETE\s+FROM\s+[\w.\"`\[\]]+(?:\s+(?:AS\s+)?\w+)?)\s*",
    re.I,
)
NAME_WORD = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")
READING_VERBS = frozenset({
    "read", "get", "list", "search", "find", "grep", "glob", "show", "view", "describe", "inspect",
    "preview", "fetch", "lookup", "count", "stat", "browse", "explain", "introspect", "lint", "diagnose",
})
WRITING_WORDS = frozenset({
    "write", "edit", "create", "replace", "apply", "patch", "move", "rename", "delete", "remove", "insert",
    "update", "set", "put", "save", "execute", "run", "exec", "command", "terminal", "shell", "sql", "append",
    "overwrite", "modify", "upsert", "store", "rewrite", "add", "commit", "push", "drop", "truncate",
})
ENVELOPE_START = "*** Begin Patch"
ENVELOPE_FILE = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+?)\s*$")
ENVELOPE_MOVE = re.compile(r"^\*\*\* Move to: (.+?)\s*$")
MOVE_TEXT_LIMIT = 2_000_000  # bytes of a moved file read to judge what it brings
STANDARDS = "the engineering standards (CLAUDE.standards.md"


def tool_words(tool_name: str) -> list:
    """The lower-case words of an MCP tool's own name (the part after its server)."""
    own = tool_name.split("__")[-1]
    return [word.lower() for word in NAME_WORD.findall(own)]


def reads_only(tool_name: str) -> bool:
    """Report whether the tool's name says it only reads: a reading verb first, no writing word."""
    words = tool_words(tool_name)
    return bool(words) and words[0] in READING_VERBS and not WRITING_WORDS.intersection(words)


def text_of(value):
    """A string value as it is, a list of strings joined by lines; None for anything else."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return "\n".join(value)
    return None


def base_of(tool_input: dict, cwd: str) -> str:
    """The directory relative paths resolve against: an absolute project path, else the cwd."""
    for key in PROJECT_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and os.path.isabs(value) and os.path.isdir(value):
            return value
    return cwd


def resolve(base: str, path: str) -> str:
    """An absolute path for `path`, relative ones taken from `base`."""
    return os.path.normpath(os.path.join(base, os.path.expanduser(path)))


class TrackedBaseline(Exception):
    """A move of a static-analysis baseline the repository tracks away from its place."""


class Unreadable(Exception):
    """A shell-shaped input the guard cannot read: the call is asked about, never passed unchecked."""


def words_line(value) -> str:
    """A command given as a string, or as a list of words, as one command line."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(word, str) for word in value):
        return " ".join(shlex.quote(word) for word in value)
    raise Unreadable("a command that is neither text nor a list of words")


def shell_lines(shell, tool_name: str, tool_input: dict) -> list:
    """The command lines the input runs: its command with its arguments; the script that reaches a
    shell's stdin; what a call writes to a running process's input.

    @raise Unreadable when a shell-shaped key holds what cannot be read as a command
    """
    lines = []
    key = next((key for key in SHELL_KEYS if key in tool_input), None)
    stdin = next((tool_input[key] for key in STDIN_KEYS if isinstance(tool_input.get(key), str)), None)
    if key is not None:
        line = words_line(tool_input[key])
        program = os.path.basename(line.split()[0].strip("\"'")) if line.strip() else ""
        args_key = next((key for key in ARGS_KEYS if key in tool_input), None)
        if args_key is not None:
            args = tool_input[args_key]
            if isinstance(args, (str, list)) and (isinstance(args, str) or all(isinstance(a, str) for a in args)):
                line = (line + " " + words_line(args)).strip()
            elif program in shell.SHELLS:
                raise Unreadable("a shell whose arguments are not words")
        if line.strip():
            lines.append(line)
            if stdin is not None and program in shell.SHELLS:
                lines.append(stdin)
    elif stdin is not None and (any(key in tool_input for key in PROCESS_KEYS)
                                or PROCESS_WORDS.intersection(tool_words(tool_name))):
        lines.append(stdin)
    return lines


def sql_texts(tool_name: str, tool_input: dict) -> list:
    """The SQL texts the input runs: its SQL keys; and a `query` that is a statement (it opens with a
    SQL verb) where the tool's or its server's name speaks of a database, or that is a destructive
    statement whole anywhere. A search's or a log query's prose is neither."""
    texts = [text_of(tool_input.get(key)) for key in SQL_KEYS]
    named = SQL_TOOL_NAME.search(tool_name[len("mcp__"):])
    for key in NAMED_SQL_KEYS:
        text = text_of(tool_input.get(key))
        if text and ((named and SQL_STATEMENT.match(text))
                     or any(DESTRUCTIVE_STATEMENT.fullmatch(part) for part in text.split(";"))):
            texts.append(text)
    return [text for text in texts if text]


def envelope_files(text: str):
    """The files an apply_patch envelope changes: {path: (added lines, removed count, hunks)}.

    An added file is one hunk of added lines; each `@@` chunk of an updated file is a hunk with no
    line number, applied where its old lines are (bash_guard.apply_hunks).
    """
    files, current = {}, None
    for line in text.splitlines():
        header = ENVELOPE_FILE.match(line)
        if header:
            current = None if header.group(1) == "Delete" else header.group(2)
            if current is not None:
                files.setdefault(current, ([], [0], [(None, [])]))
            continue
        moved = ENVELOPE_MOVE.match(line)
        if moved and current is not None:
            files[moved.group(1)] = files.pop(current)
            current = moved.group(1)
            continue
        if current is None or line.startswith("***"):
            continue
        added, removed, hunks = files[current]
        if line.startswith("@@"):
            hunks.append((None, []))
            continue
        kind = line[:1] if line[:1] in ("+", "-") else " "
        hunks[-1][1].append((kind, line[1:]))
        if kind == "+":
            added.append(line[1:])
        elif kind == "-":
            removed[0] += 1
    return {path: (added, removed[0], [hunk for hunk in hunks if hunk[1]])
            for path, (added, removed, hunks) in files.items()} or None


def patched_files(shell, tool_input: dict):
    """The files a patch in the input changes, as {path: (added lines, removed count, hunks)}, else None."""
    for key in PATCH_KEYS:
        text = tool_input.get(key)
        if not isinstance(text, str) or not text.strip():
            continue
        files = None
        if text.lstrip().startswith(ENVELOPE_START):
            files = envelope_files(text)
        if not files:
            counted, hunks = shell.patch_files(text, None, False), shell.patch_hunks(text, None, False)
            files = {path: (added, removed, hunks.get(path)) for path, (added, removed) in (counted or {}).items()}
        if files:
            return files
    return None


def remote(tool_input: dict) -> bool:
    """Report whether the input names a remote repository (an owner, a repo, a branch): its paths
    are not files on this disk."""
    return any(isinstance(tool_input.get(key), str) and tool_input[key] for key in REMOTE_KEYS)


def dry_run(tool_input: dict) -> bool:
    """Report whether the call only previews its change (a filesystem server's dryRun)."""
    return any(tool_input.get(key) is True for key in DRY_RUN_KEYS)


def file_writes(shell, tool_input: dict, base: str) -> list:
    """The Write- or Edit-shaped writes the input makes: [(path, "Write" | "Edit", tool input)].

    A move brings the source's text, unless the source is a repository's own source moved within
    it (bash_guard.new_content, as for `mv`). A remote repository's path writes nothing here.
    """
    writes = []
    if remote(tool_input):
        return writes
    path = next((tool_input[key] for key in PATH_KEYS if isinstance(tool_input.get(key), str) and tool_input[key]), None)
    if path is not None:
        target = resolve(base, path)
        content = next((tool_input[key] for key in CONTENT_KEYS if isinstance(tool_input.get(key), str)), None)
        if content is not None:
            writes.append((target, "Write", {"content": content}))
        edits = [tool_input]
        if isinstance(tool_input.get("edits"), list):
            edits += [edit for edit in tool_input["edits"] if isinstance(edit, dict)]
        for edit in edits:
            for old_key, new_key in REPLACEMENT_KEYS:
                new = edit.get(new_key)
                if isinstance(new, str):
                    old = edit.get(old_key)
                    writes.append((target, "Edit", {"old_string": old if isinstance(old, str) else "",
                                                    "new_string": new,
                                                    "replace_all": edit.get("replace_all") is True}))
    source, destination = (tool_input.get(key) for key in MOVE_KEYS)
    if isinstance(source, str) and isinstance(destination, str) and source and destination:
        origin, target = resolve(base, source), resolve(base, destination)
        if origin != target and shell.protected_baseline(origin):
            raise TrackedBaseline(origin)
        if not shell.new_content(origin, target, True, base) or shell.ignores_nothing(origin):
            writes.append((target, "Write", {}))
            return writes
        try:
            with open(origin, encoding="utf-8", errors="ignore") as fh:
                moved = fh.read(MOVE_TEXT_LIMIT)
        except OSError:
            moved = None
        writes.append((target, "Write", {"content": moved} if moved is not None else {}))
    return writes


def rubric_reason(rubric, base: str, path: str, transcript: str, text):
    """The rubric gate's denial for one written file, else None."""
    if os.environ.get("CLAUDE_NO_PLAN_SKILL_GATE"):
        return None
    verdict = rubric.missing_for(base, path, transcript, text)
    return rubric.denial(*verdict).rstrip() if verdict is not None else None


def debt_reason(debt, path: str, tool: str, tool_input: dict):
    """The debt guard's reason to refuse a Write- or Edit-shaped write, else None: the checks its
    own hook runs on an Edit or a Write (debt_guard.main)."""
    if os.environ.get("CLAUDE_NO_DEBT_GUARD") or debt.exempt(path):
        return None
    name = os.path.basename(path)
    current = debt.existing_text(path)
    readable = tool == "Edit" or "content" in tool_input
    if debt.BASELINE.search(name):
        if not readable:
            if current is None and not debt.baseline_tracked(path):
                return None
            return baseline_message(f"this call moves a file that cannot be read over {path}")
        why = debt.baseline_verdict(tool, tool_input, current, name, path)
        return baseline_message(why) if why else None
    if debt.PHPSTAN_CONFIG.search(name) and readable:
        why = debt.config_verdict(tool, tool_input, current, name, path)
        if why:
            return baseline_message(why)
    if os.path.splitext(name)[1].lower() not in debt.SOURCE_EXTENSIONS or not readable:
        return None  # not source, or a move whose source cannot be read: the move itself fails
    return debt_message(debt.write_debt(tool, tool_input, current, path), path)


def baseline_message(why: str) -> str:
    return (f"{why}. {STANDARDS} §PHP static analysis, §JavaScript and TypeScript static analysis): the "
            "baseline only shrinks -- fix the reported errors, or report them as unfixable and explain why.")


def debt_message(hit, path: str):
    if not hit:
        return None
    kind, line = hit
    return (f"this call adds a {kind} to the source file {path}:\n    {line}\n{STANDARDS} §Architecture and "
            "tech debt): debt inside the change is fixed in the change, never marked for later and never "
            "silenced. Fix it now; if it is outside the blast radius, leave the code as it was and name the "
            "debt in your final message and on the vault's TODO board instead.")


def patch_reason(shell, rubric, debt, files: dict, base: str, cwd: str, transcript: str):
    """Why a patch the input applies is refused, else None."""
    for relative, (added, removed, hunks) in files.items():
        path = resolve(base, relative)
        text = "\n".join(added)
        why = rubric_reason(rubric, base, path, transcript, text)
        if why:
            return why
        if os.environ.get("CLAUDE_NO_DEBT_GUARD") or debt.exempt(path):
            continue
        if debt.BASELINE.search(os.path.basename(path)):
            if shell.baseline_grows(shell.ShellWrite(path, text, cwd, "patch", removed, hunks=hunks)):
                return baseline_message(f"this patch grows the static-analysis baseline {path}")
            continue
        if os.path.splitext(path)[1].lower() in debt.SOURCE_EXTENSIONS:
            why = debt_message(debt.debt_added("", text, path), path)
            if why:
                return why
    return None


def judge(tool_name: str, tool_input: dict, cwd: str, transcript: str):
    """Why the MCP call is refused, else None. Raises on an internal error."""
    import bash_guard as shell
    import debt_guard as debt
    import plan_skill_gate as rubric

    base = base_of(tool_input, cwd)
    for line in shell_lines(shell, tool_name, tool_input):
        why = shell.check(line, base, transcript)
        if why:
            return why
    for text in sql_texts(tool_name, tool_input):
        if shell.destructive_sql(text):
            return ("destructive SQL (DROP DATABASE/TABLE, TRUNCATE, or DELETE without WHERE) sent to a "
                    "database. Take a snapshot/backup and ask the user.")
    if dry_run(tool_input) or remote(tool_input):
        return None
    files = patched_files(shell, tool_input)
    if files:
        why = patch_reason(shell, rubric, debt, files, base, cwd, transcript)
        if why:
            return why
    try:
        writes = file_writes(shell, tool_input, base)
    except TrackedBaseline as moved:
        return shell.BASELINE_REMOVAL.format(what="this call moves", path=str(moved))
    for path, tool, shaped in writes:
        why = (rubric_reason(rubric, base, path, transcript, rubric.written_text(shaped))
               or debt_reason(debt, path, tool, shaped))
        if why:
            return why
    return None


def ask(what: str) -> str:
    """The hook output that asks the person to confirm a call the guard could not read."""
    return json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": (f"mcp_guard.py (guards plugin) failed while reading {what}, so its rules "
                                     "were not applied; confirm it yourself."),
    }})


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:  # the hook runs for MCP tools only: an input it cannot read is one nobody checked
        print(ask("this MCP call"))
        return 0
    if not isinstance(data, dict):
        return 0
    tool_name = data.get("tool_name")
    tool_input = data.get("tool_input")
    if not isinstance(tool_name, str) or not tool_name.startswith("mcp__") or not isinstance(tool_input, dict):
        return 0
    if not KEYS.intersection(tool_input) or (reads_only(tool_name) and not WRITE_SHAPED.intersection(tool_input)):
        return 0
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import plan_skill_gate as rubric

        transcript = rubric.evidence_transcript(data)
        why = judge(tool_name, tool_input, data.get("cwd") or os.getcwd(), transcript)
    except Exception:
        print(ask(f"this {tool_name} call"))
        return 0
    if why:
        reason = why[len("Blocked: "):] if why.startswith("Blocked: ") else why
        print(f"BLOCKED by mcp_guard.py (guards plugin) for {tool_name}: {reason}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
