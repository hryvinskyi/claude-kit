#!/usr/bin/env python3
"""session_capture.py — what a Claude Code session leaves for its project's vault when it ends. Global.

Usage:
    vault-capture              # the SessionEnd hook: reads its JSON, hands off, returns
    vault-capture --worker F   # the detached half, run on the payload saved in F
    vault-capture --update     # the SessionStart fetch and fast-forward, and why it did not happen
    vault-capture --brief      # the inbox, conflict, commit and backup lines for the SessionStart brief
    vault-capture --outcome    # the fast-forward and what the session end recorded, where no brief is printed

A project that ships its own SessionEnd hook is left to it, and so is a project that keeps no vault.
Otherwise the hook saves its payload in the project's state directory and starts a detached worker —
a SessionEnd hook is given seconds. The worker:

1. **Files the session in the vault's inbox** when it committed work and wrote no journal entry.
   A commit is the session's own when it was made after the session began and a `git commit` call of
   the session printed its hash or carried its subject, so `git commit -q` counts and a parallel
   session's commit does not. A journal entry counts when the session created one, or edited one dated
   within the session; fixing a link in last month's entry is not writing today's. The entry is what
   git says — hash, subject, tickets from `Refs` — and nothing is ever written into `Journal/` or
   `Decisions/`: promoting an entry is a person's call.
2. **Refreshes `vault_check.py`'s stamps and cache.**
3. **Commits the vault, then integrates and pushes it — only when the vault is a git repository of
   its own.** A project's repository is never committed, whoever owns it. A file named like a
   credential, or whose added lines look like one (`credential_filter`), is held back: unstaged, left
   in the work tree, and named with its reason — never its value — on every brief until it is gone or
   committed by hand; the rest is committed without it. The commit comes first and the rebase onto
   the remote after it. Only a held edit of a tracked file is stashed for the rebase, by its exact
   paths, and put back after it; when the remote changed the same lines, deleted the note or renamed
   it, each path goes back to the remote's version (or away, where the remote has none), the edits
   stay in the stash, and the brief names the command that brings them back. A push the remote refuses is retried after a
   fresh fetch and rebase, a few times, with jittered waits. Notes that do not rebase are pushed to a
   `conflict/<handle>/<UTC time>` branch, and the clone steps back to the remote only when nothing in
   it is uncommitted. A clone in the middle of a merge, rebase, cherry-pick or revert, with unmerged
   paths, or not on a branch is neither committed nor pushed: a person finishes what git started.
   A commit git refuses — signing that needs an agent, a hook, no identity — is kept with its reason
   until a commit lands. How it ended is left in the state directory for the next session start,
   which prints it even where the project briefs its own session start or the vault has no board
   (`--outcome`).
4. **Refreshes the project's qmd index** (`vault_search.py refresh`).

Where the inbox lives follows `vaultlib`: beside the notes for a vault that is its own repository or
ignored by the project, otherwise in `~/.claude/state/vaults/<project>/`. The brief names the file.
Every step is best-effort; failures go to `session-capture.log` in the state directory.

The inbox of a vault that is its own repository is shared by everybody who clones it, and each entry
names a `claude --resume` only its author can run, so an entry records its author (`- by: <handle>`)
and the brief counts the reader's own. The session start brings such a vault up to date only by a
fast-forward, and never mid-way: under the same lock as the session end, without uncommitted edits
and without commits of its own.
"""
from __future__ import annotations

import functools
import json
import os
import random
import re
import shlex
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vaultlib  # noqa: E402
import credential_filter

SESSION_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
COMMITTING = re.compile(r"\bgit\b[^|;&\n]*\b(?:commit|cherry-pick|revert|merge)\b")
HASH = re.compile(r"\b[0-9a-f]{7,40}\b")
TIMESTAMP = re.compile(r'"timestamp"\s*:\s*"([^"]+)"')
REFS = re.compile(r"^Refs[: ]\s*(.+)$", re.M)
MESSAGE_FLAG = re.compile(r"""(?:^|\s)(?:-m|--message)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)')""", re.S)
STDIN_FILE = re.compile(r"(?:^|\s)(?:-F|--file)(?:\s+|=)-(?:\s|$)")
HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n(.*?)\n\s*\1\s*(?:\n|$)", re.S)

INBOX_HEAD = """---
type: note
tags: [inbox]
---

# Inbox

Sessions that committed work and wrote no journal entry, recorded by the vault's session capture
(`vault-capture`) as each one ended. An entry is what git says the session did, not a summary of it.
Promote an entry with `/vault:journal` and delete it, or delete it when the work needs no entry of its own.
"""


# --- reading a session --------------------------------------------------------


def transcript_files(transcript: Path, session_id: str) -> list[Path]:
    files = [transcript] if transcript.is_file() else []
    subagents = transcript.parent / session_id / "subagents"
    if subagents.is_dir():
        files += sorted(subagents.glob("*.jsonl"))
    return files


def read_lines(paths: list[Path]) -> list[str]:
    lines: list[str] = []
    for path in paths:
        try:
            lines += path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
    return lines


def moments(lines: list[str]) -> list[float]:
    """Every timestamp the transcripts carry, as epoch seconds."""
    found: list[float] = []
    for line in lines:
        m = TIMESTAMP.search(line)
        if not m:
            continue
        try:
            found.append(datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp())
        except ValueError:
            continue
    return found


def session_days(lines: list[str], today: Optional[date] = None) -> set[str]:
    """The local calendar days the session spans, from its first moment to today."""
    stamps = moments(lines)
    last = today or date.today()
    first = datetime.fromtimestamp(min(stamps)).date() if stamps else last
    days, day = set(), min(first, last)
    while day <= last:
        days.add(day.isoformat())
        day += timedelta(days=1)
    return days


def entries(lines: list[str]):
    """The content items of every parseable transcript line."""
    for line in lines:
        if '"tool_use"' not in line and '"tool_result"' not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        message = record.get("message") if isinstance(record, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    yield item


def result_text(item: dict) -> str:
    content = item.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def subjects_of(command: str) -> set[str]:
    """The subject lines a committing command carries: its first `-m`, or a heredoc fed to `-F -`."""
    subjects: set[str] = set()
    flag = MESSAGE_FLAG.search(command)
    if flag:
        body = flag.group(1) if flag.group(1) is not None else flag.group(2)
        first = next((line.strip() for line in body.replace('\\"', '"').splitlines() if line.strip()), "")
        if first:
            subjects.add(first)
    if STDIN_FILE.search(command):
        for m in HEREDOC.finditer(command):
            first = next((line.strip() for line in m.group(2).splitlines() if line.strip()), "")
            if first:
                subjects.add(first)
    return subjects


def commit_evidence(lines: list[str]) -> tuple[set[str], set[str]]:
    """(hashes printed by, subjects carried in) the session's committing Bash calls."""
    commands: dict[str, str] = {}
    hashes: set[str] = set()
    subjects: set[str] = set()
    for item in entries(lines):
        if item.get("type") == "tool_use" and item.get("name") == "Bash":
            command = str((item.get("input") or {}).get("command", ""))
            if COMMITTING.search(command):
                commands[str(item.get("id"))] = command
                subjects |= subjects_of(command)
        elif item.get("type") == "tool_result" and str(item.get("tool_use_id")) in commands:
            hashes |= set(HASH.findall(result_text(item)))
    return hashes, subjects


def journal_written(lines: list[str], vault: Path, days: set[str]) -> bool:
    """Whether the session created a journal entry, or edited one dated within it."""
    journal = os.path.realpath(vault / "Journal") + os.sep
    for item in entries(lines):
        if item.get("type") != "tool_use" or item.get("name") not in WRITE_TOOLS:
            continue
        tool_input = item.get("input")
        path = tool_input.get("file_path") if isinstance(tool_input, dict) else None
        if not isinstance(path, str) or not os.path.realpath(path).startswith(journal):
            continue
        if item.get("name") == "Write" or Path(path).name[:10] in days:
            return True
    return False


def session_commits(root: Path, started: Optional[float], hashes: set[str], subjects: set[str]) -> list[dict]:
    """The commits made after the session began that its own calls printed or carried, oldest first."""
    if started is None or (not hashes and not subjects):
        return []
    code, out = vaultlib.git_out(root, "log", "--all", f"--since=@{int(started) - 120}",
                                 "--format=%H%x00%ct%x00%s%x00%B%x1e")
    if code != 0:
        return []
    found: dict[str, dict] = {}
    for record in filter(None, (r.strip("\n") for r in out.split("\x1e"))):
        fields = record.split("\x00", 3)
        if len(fields) != 4 or not fields[1].isdigit() or int(fields[1]) < started - 60:
            continue
        full, committed, subject, body = fields
        if not (subject in subjects or any(full.startswith(h) for h in hashes)):
            continue
        tickets = sorted({t for refs in REFS.findall(body) for t in re.findall(r"#(\d+)", refs)}, key=int)
        found[full] = {"sha": full, "subject": subject, "tickets": tickets, "time": int(committed)}
    return sorted(found.values(), key=lambda c: (c["time"], c["sha"]))


# --- the inbox ----------------------------------------------------------------


# An entry opens with its session marker, which may carry its author (`<!-- session:<id> by:<handle> -->`);
# an entry written without one names its author on a `- by: <handle>` line, and one written before
# entries recorded an author has neither.
ENTRY = re.compile(r"<!-- session:(?P<id>[A-Za-z0-9-]+)(?: by:(?P<marker>[a-z0-9-]+))? -->\n"
                   r"(?P<body>.*?)<!-- /session -->", re.S)
BY_LINE = re.compile(r"^- by: (?P<by>[a-z0-9-]+)[ \t]*$", re.M)
DAY = re.compile(r"\A## (\d{4}-\d{2}-\d{2})")
UNCOMMITTED = "0" * 40


def _entry_pattern(session_id: str) -> "re.Pattern[str]":
    return re.compile(r"<!-- session:%s(?: by:[a-z0-9-]+)? -->\n.*?<!-- /session -->\n?" % re.escape(session_id),
                      re.S)


def inbox_entries(text: str) -> list[dict]:
    """Every entry of an inbox: its session, the day its heading names, and its author when it records one."""
    found = []
    for m in ENTRY.finditer(text):
        day = DAY.match(m.group("body"))
        by = BY_LINE.search(m.group("body"))
        found.append({"session": m.group("id"), "day": day.group(1) if day else None,
                      "author": m.group("marker") or (by.group("by") if by else None)})
    return found


def blamed_sessions(repo: Path, rel: str, email: str) -> Optional[set[str]]:
    """The sessions whose inbox marker line this person's commits wrote, or that nobody committed yet.

    None when git cannot tell, as for an inbox it does not track.
    """
    code, out = vaultlib.git_out(repo, "blame", "--line-porcelain", "--", rel, timeout=20)
    if code != 0:
        return None
    mine: set[str] = set()
    sha, mail = "", ""
    for line in out.splitlines():
        if line.startswith("\t"):
            m = re.match(r"\t<!-- session:([A-Za-z0-9-]+)", line)
            if m and (sha == UNCOMMITTED or (email and mail.lower() == f"<{email.lower()}>")):
                mine.add(m.group(1))
        elif re.match(r"[0-9a-f]{40} ", line):
            sha = line[:40]
        elif line.startswith("author-mail "):
            mail = line[len("author-mail "):].strip()
    return mine


def own_days(text: str, reader: Optional[str], unattributed: Callable[[], Optional[set[str]]]) -> list[str]:
    """The days of the reader's entries — every entry when there is no reader to tell them apart.

    An entry without an author is the reader's when `unattributed` names its session, or when it
    cannot say whose it is.
    """
    days: list[str] = []
    legacy: Optional[set[str]] = None
    asked = False
    for entry in inbox_entries(text):
        if not entry["day"]:
            continue
        if reader is not None and entry["author"] is not None and entry["author"] != reader:
            continue
        if reader is not None and entry["author"] is None:
            if not asked:
                legacy, asked = unattributed(), True
            if legacy is not None and entry["session"] not in legacy:
                continue
        days.append(entry["day"])
    return days


def render_entry(session_id: str, day: str, commits: list[dict], author: str = "") -> str:
    tickets = sorted({t for c in commits for t in c["tickets"]}, key=int)
    heading = f"## {day} · {len(commits)} commit{'s' if len(commits) != 1 else ''}"
    if tickets:
        heading += " · " + ", ".join(f"#{t}" for t in tickets)
    lines = [f"<!-- session:{session_id} -->", heading, ""]
    for c in commits:
        refs = f" — Refs {', '.join('#' + t for t in c['tickets'])}" if c["tickets"] else ""
        lines.append(f"- `{c['sha'][:9]}` {c['subject']}{refs}")
    if author:
        lines.append(f"- by: {author}")
    lines += [f"- the conversation: `claude --resume {session_id}`", "<!-- /session -->", ""]
    return "\n".join(lines)


def upsert_entry(text: str, session_id: str, entry: str) -> str:
    if not text.strip():
        text = INBOX_HEAD
    pattern = _entry_pattern(session_id)
    if pattern.search(text):
        return pattern.sub(lambda _m: entry, text, count=1)
    return text.rstrip("\n") + "\n\n" + entry


def remove_entry(text: str, session_id: str) -> str:
    return _entry_pattern(session_id).sub("", text).rstrip("\n") + "\n" if text else text


def capture(vault: vaultlib.Vault, session_id: str, lines: list[str], day: str,
            today: Optional[date] = None) -> bool:
    """File or clear this session's inbox entry; True when the inbox now holds one for it."""
    inbox = vault.machine_file("Inbox.md")
    text = inbox.read_text(encoding="utf-8") if inbox.is_file() else ""
    stamps = moments(lines)
    hashes, subjects = commit_evidence(lines)
    commits = session_commits(vault.root, min(stamps) if stamps else None, hashes, subjects)
    if commits and not journal_written(lines, vault.path, session_days(lines, today)):
        entry = render_entry(session_id, day, commits, vaultlib.handle(vault.path))
        updated, filed = upsert_entry(text, session_id, entry), True
    else:
        updated, filed = remove_entry(text, session_id), False
    if updated != text:
        inbox.parent.mkdir(parents=True, exist_ok=True)
        inbox.write_text(updated, encoding="utf-8")
    return filed


# --- the vault's copy ---------------------------------------------------------
#
# Every git operation on the vault — the commit, the rebase and push that follow it, the session
# start's fetch and fast-forward — runs under one lock file in the state directory, so two sessions
# of one machine never rebase the same clone at once. A session end commits first and integrates
# after. It stashes nothing but the held edits of tracked files, and puts them back only when they
# apply without a conflict, so a stash that would not re-apply never leaves conflict markers for the
# next commit to publish.

CAPTURE_WAIT = 600.0
BRIEF_WAIT = 3.0
PUSH_ATTEMPTS = 3
SYNC_STATE = "vault-sync.json"
REGENERATE = "vault-regenerate"
TWO_VERSIONS = r"^[[:space:]]*<!-- vault-merge: two versions.*-->[[:space:]]*$"


def lock_path(vault: vaultlib.Vault) -> Path:
    return vault.state / "vault-commit.lock"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def shown_time(moment: datetime) -> str:
    return moment.astimezone().strftime("%Y-%m-%d %H:%M")


def git(vault: vaultlib.Vault, *args: str, timeout: int = 120, env: Optional[dict] = None) -> tuple[int, str]:
    """Run git in the vault, and only there; stdout and stderr come back together."""
    return vaultlib.run(["git", "-C", str(vault.path), *args], timeout=timeout, env=vaultlib.git_env(env))


def ssh_command(vault: vaultlib.Vault, connect: int) -> Optional[str]:
    """The ssh command git would run for the vault, made unable to prompt; None to leave git's own.

    The command is the one git picks — `$GIT_SSH_COMMAND`, else `core.sshCommand`, else `$GIT_SSH`,
    else `ssh` — so a key, a config file or a proxy the person set up still applies. Only OpenSSH
    (a program named `ssh`) is given `-o BatchMode=yes -o ConnectTimeout=N`, after the person's own
    options, which ssh lets win; another program is left as it is, bounded by the timeout alone.
    """
    command = os.environ.get("GIT_SSH_COMMAND", "").strip()
    if not command:
        code, out = vaultlib.git_out(vault.path, "config", "--get", "core.sshCommand", timeout=10)
        command = out.strip() if code == 0 else ""
    if not command:
        program = os.environ.get("GIT_SSH", "").strip()
        command = shlex.quote(program) if program else "ssh"
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if not words or os.path.basename(words[0]) != "ssh":
        return None
    return f"{command} -o BatchMode=yes -o ConnectTimeout={connect}"


def net(vault: vaultlib.Vault, *args: str, timeout: int, connect: int = 20) -> tuple[int, str]:
    """Run a git command that talks to the remote, never waiting on a prompt."""
    env = {"GIT_TERMINAL_PROMPT": "0"}
    ssh = ssh_command(vault, connect)
    if ssh is not None:
        env["GIT_SSH_COMMAND"] = ssh
    return git(vault, *args, timeout=timeout, env=env)


def hold_off(vault: vaultlib.Vault, why: str) -> str:
    """Leave a clone git is not done with as it is, and say so on the next brief."""
    return settle(vault, "unfinished", f"[VAULT] not committed or pushed: {why}; the next session end does it")


def git_bytes(vault: vaultlib.Vault, *args: str, timeout: int = 120) -> tuple[int, bytes]:
    """Run git in the vault with every pathspec literal; its stdout undecoded, (1, b"") when it cannot run.

    This is the read for what a file holds or a path is named: a byte that is no UTF-8 must not stop a
    session end, and a note named with a `*` must not reach its neighbours.
    """
    try:
        proc = subprocess.run(["git", "-C", str(vault.path), "--literal-pathspecs", *args], capture_output=True,
                              timeout=timeout, stdin=subprocess.DEVNULL, env=vaultlib.git_env())
    except (OSError, subprocess.SubprocessError):
        return 1, b""
    return proc.returncode, proc.stdout


def readable(path: str) -> str:
    """A path as text any output can carry; a byte of its name that is no UTF-8 shows as `?`."""
    return path.encode("utf-8", "surrogateescape").decode("utf-8", "replace").replace("\ufffd", "?")


def staged_files(vault: vaultlib.Vault) -> Optional[list[list[str]]]:
    """The paths of each file the commit would add or change, a rename's old one first; None when git cannot say."""
    code, listing = git_bytes(vault, "diff", "--cached", "-z", "--name-status", "--find-renames",
                              "--diff-filter=ACMRT")
    if code != 0:
        return None
    fields = [os.fsdecode(field) for field in listing.split(b"\0")]
    files, at = [], 0
    while at + 1 < len(fields):
        width = 2 if fields[at][:1] in ("R", "C") else 1
        files.append(fields[at + 1:at + 1 + width])
        at += 1 + width
    return files


def added_lines(diff: bytes) -> list[str]:
    """What a diff adds: the lines after its first hunk header that start with `+`, less the `+`.

    Every NUL is dropped first: a file saved as UTF-16 spells an ASCII value with NULs between its
    letters, and no value holds one of its own.
    """
    lines = diff.replace(b"\0", b"").decode("utf-8", errors="replace").split("\n")
    first = next((at for at, line in enumerate(lines) if line.startswith("@@")), len(lines))
    return [line[1:] for line in lines[first:] if line.startswith("+")]


def why_held(vault: vaultlib.Vault, paths: list[str]) -> Optional[str]:
    """Why a staged file may not be committed; None when it may.

    Only what the commit adds is read, so a file's old lines never hold a new edit back, and a rename
    passes both its paths: limited to the new one, git would show the whole file as added. A file git
    would call binary is read as text. A diff that cannot be read never counts as clean.
    """
    def added() -> Optional[list[str]]:
        code, diff = git_bytes(vault, "diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--text",
                               "--find-renames", "--", *paths)
        return added_lines(diff) if code == 0 else None
    return credential_filter.why_held(paths[-1], added)


def record_held(vault: vaultlib.Vault, files: list[dict]) -> None:
    """Replace the list of files held back from the vault's commit."""
    state = read_state(vault)
    state["held"] = files
    write_state(vault, state)


def hold_back(vault: vaultlib.Vault) -> bool:
    """Unstage and record every staged file that may not be committed; False when no commit may follow.

    Only a path and a reason are kept or logged, never the value. A rename is unstaged by both its
    paths, or the commit would delete the old file for everyone while the new one stays here. When
    something cannot be listed or unstaged, the whole index is put back, so nothing staged is left
    for a later commit to publish.
    """
    staged = staged_files(vault)
    if staged is None:
        vaultlib.log(vault, "session-capture.log", "vault not committed: git could not list what is staged")
        vaultlib.git_out(vault.path, "reset", "-q")
        return False
    kept: list[dict] = []
    unstaged = True
    for paths in staged:
        reason = why_held(vault, paths)
        if reason is None:
            continue
        shown = readable(paths[-1])
        vaultlib.log(vault, "session-capture.log", f"vault file held back: {shown} ({reason})")
        if git_bytes(vault, "reset", "-q", "--", *paths)[0] != 0:
            vaultlib.log(vault, "session-capture.log", f"vault not committed: {shown} could not be unstaged")
            unstaged = False
        kept.append({"path": paths[-1], "reason": reason})
        kept += [{"path": path, "reason": f"renamed to {shown}"} for path in paths[:-1]]
    record_held(vault, kept)
    if not unstaged:
        vaultlib.git_out(vault.path, "reset", "-q")
    return unstaged


def commit_vault(vault: vaultlib.Vault, session_id: str, wait: float = 0.0, sleep=time.sleep) -> bool:
    """Commit what changed in a vault that is its own repository, less the files held back; never anything else."""
    if vault.mode != "own-repo":
        return False
    with vaultlib.holding(lock_path(vault), wait, sleep=sleep) as held:
        if held is None:
            return False
        code, status = vaultlib.git_out(vault.path, "status", "--porcelain")
        if code != 0:
            return False
        if not status.strip():
            record_held(vault, [])
            record_commit(vault, None)
            return False
        why = vaultlib.unfinished(vault.path, vault.rel)
        if why is not None:
            hold_off(vault, why)
            return False
        vaultlib.git_out(vault.path, "add", "-A")
        if not hold_back(vault):
            return False
        if vaultlib.git_out(vault.path, "diff", "--cached", "--quiet")[0] == 0:
            record_commit(vault, None)
            return False
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        code, out = git(vault, "commit", "-q", "-m", f"session {stamp} ({session_id[:8]})")
        if code != 0:
            vaultlib.log(vault, "session-capture.log", f"vault commit failed: {out.strip()[:300]}")
            record_commit(vault, {"time": stamp, "reason": why_not_committed(out)})
            return False
        record_commit(vault, None)
        return True


SIGNING_FAILED = re.compile(r"failed to sign|signing failed|gpg: signing|error: cannot run gpg|ssh-keygen.*sign", re.I)
NO_IDENTITY = re.compile(r"please tell me who you are|unable to auto-detect email|empty ident name", re.I)


def why_not_committed(out: str) -> str:
    """Why `git commit` refused, in the reader's words, from what it printed (or the error that stopped it).

    git's own words are quoted only from its first line, and never one that looks like a credential:
    a hook that refuses may print what it found.
    """
    if "TimeoutExpired" in out:
        return ("the commit did not finish in time — a signing program waiting for a passphrase, or a hook "
                "that waits for input, does this")
    if SIGNING_FAILED.search(out):
        return "signing the commit failed — start the signing agent or unlock the key"
    if NO_IDENTITY.search(out):
        return "git has no identity in the vault — set user.name and user.email"
    first = next((line.strip() for line in out.splitlines() if line.strip()), "")
    if not first:
        return "git refused the commit without a message, as a pre-commit or commit-msg hook that refuses does"
    if credential_filter.line_reason(first) is not None:
        return "git refused the commit; its message is in session-capture.log"
    return f"git refused the commit: {first[:160]}"


def record_commit(vault: vaultlib.Vault, failure: Optional[dict]) -> None:
    """Keep the last commit failure for the brief, or clear it once a commit lands or nothing is left to commit."""
    state = read_state(vault)
    if state["commit"] != failure:
        state["commit"] = failure
        write_state(vault, state)


def vault_remote(vault: vaultlib.Vault) -> bool:
    return vaultlib.git_out(vault.path, "remote", "get-url", "origin")[0] == 0


def unpushed(vault: vaultlib.Vault) -> Optional[int]:
    code, out = vaultlib.git_out(vault.path, "rev-list", "--count", "@{u}..HEAD")
    return int(out.strip()) if code == 0 and out.strip().isdigit() else None


def current_branch(vault: vaultlib.Vault) -> Optional[str]:
    code, out = vaultlib.git_out(vault.path, "symbolic-ref", "--quiet", "--short", "HEAD")
    return out.strip() if code == 0 and out.strip() else None


def ref_exists(vault: vaultlib.Vault, ref: str) -> bool:
    return vaultlib.git_out(vault.path, "rev-parse", "--verify", "--quiet", ref)[0] == 0


def contains(vault: vaultlib.Vault, ancestor: str, descendant: str = "HEAD") -> bool:
    return vaultlib.git_out(vault.path, "merge-base", "--is-ancestor", ancestor, descendant)[0] == 0


def count(vault: vaultlib.Vault, revisions: str) -> int:
    code, out = vaultlib.git_out(vault.path, "rev-list", "--count", revisions)
    return int(out.strip()) if code == 0 and out.strip().isdigit() else 0


def status_paths(status: bytes) -> list[str]:
    """Every path of a `status --porcelain -z` listing, both of a rename's."""
    fields = status.split(b"\0")
    paths: list[str] = []
    at = 0
    while at < len(fields) and fields[at]:
        width = 2 if set(fields[at][:2]) & set(b"RC") else 1
        paths.append(os.fsdecode(fields[at][3:]))
        paths += [os.fsdecode(field) for field in fields[at + 1:at + width]]
        at += width
    return paths


def changes(vault: vaultlib.Vault, untracked: bool = True, aside: frozenset = frozenset()) -> bool:
    """Whether the work tree holds anything uncommitted beyond the exact paths `aside`.

    An unreadable status counts as changes. Untracked files are listed one by one, so a new file in a
    new directory shows as its own path rather than as the directory.
    """
    code, out = git_bytes(vault, "status", "--porcelain", "-z", f"--untracked-files={'all' if untracked else 'no'}")
    return code != 0 or any(path not in aside for path in status_paths(out))


def tracked(vault: vaultlib.Vault, paths: list[str]) -> list[str]:
    """Those of `paths` git tracks; an edit to one is what a rebase cannot pass."""
    if not paths:
        return []
    code, out = git_bytes(vault, "ls-files", "-z", "--", *paths)
    known = {os.fsdecode(field) for field in out.split(b"\0")} if code == 0 else set()
    return [path for path in paths if path in known]


def git_dir(vault: vaultlib.Vault) -> Optional[Path]:
    code, out = vaultlib.git_out(vault.path, "rev-parse", "--absolute-git-dir")
    return Path(out.strip()) if code == 0 and out.strip() else None


def rebasing(vault: vaultlib.Vault) -> bool:
    found = git_dir(vault)
    return found is not None and ((found / "rebase-merge").exists() or (found / "rebase-apply").exists())


def read_state(vault: vaultlib.Vault) -> dict:
    """What the last runs left for the brief: conflict branches to merge, one notice, the files held back,
    the held edits left in git's stash, and the last commit that failed."""
    try:
        state = json.loads((vault.state / SYNC_STATE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"conflicts": [], "notice": None, "held": [], "aside": [], "commit": None}
    conflicts = state.get("conflicts") if isinstance(state, dict) else None
    notice = state.get("notice") if isinstance(state, dict) else None
    held = state.get("held") if isinstance(state, dict) else None
    aside = state.get("aside") if isinstance(state, dict) else None
    commit = state.get("commit") if isinstance(state, dict) else None
    failed = isinstance(commit, dict) and all(isinstance(commit.get(key), str) for key in ("time", "reason"))
    return {"commit": {"time": commit["time"], "reason": commit["reason"]} if failed else None,
            "conflicts": [c for c in conflicts or [] if isinstance(c, dict) and isinstance(c.get("branch"), str)],
            "notice": notice if isinstance(notice, str) else None,
            "held": [h for h in (held if isinstance(held, list) else [])
                     if isinstance(h, dict) and isinstance(h.get("path"), str) and isinstance(h.get("reason"), str)],
            "aside": [a for a in (aside if isinstance(aside, list) else [])
                      if isinstance(a, dict) and isinstance(a.get("stash"), str) and isinstance(a.get("paths"), list)
                      and all(isinstance(path, str) for path in a["paths"])]}


def write_state(vault: vaultlib.Vault, state: dict) -> None:
    path = vault.state / SYNC_STATE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(state, indent=1), encoding="utf-8")
        os.replace(str(temporary), str(path))
    except OSError:
        pass


def add_notice(vault: vaultlib.Vault, line: str) -> None:
    """Put one more line on the next brief, beside whatever the last integration left there."""
    state = read_state(vault)
    state["notice"] = "\n".join(filter(None, (state["notice"], line)))
    write_state(vault, state)


def settle(vault: vaultlib.Vault, outcome: str, notice: Optional[str], conflict: Optional[dict] = None) -> str:
    """Record how an integration ended for the next brief, and answer its outcome."""
    state = read_state(vault)
    state["notice"] = notice
    if conflict:
        state["conflicts"].append(conflict)
    write_state(vault, state)
    if notice:
        vaultlib.log(vault, "session-capture.log", notice)
    return outcome


def free_branch(vault: vaultlib.Vault, base: str) -> str:
    name, n = base, 1
    while ref_exists(vault, f"refs/heads/{name}") or ref_exists(vault, f"refs/remotes/origin/{name}"):
        n += 1
        name = f"{base}-{n}"
    return name


def park_conflict(vault: vaultlib.Vault, branch: str, now) -> str:
    """Move notes that will not rebase onto a branch of their own on the remote, and step aside."""
    vaultlib.git_out(vault.path, "rebase", "--abort")
    moment = now()
    name = free_branch(vault, f"conflict/{vaultlib.handle(vault.path)}/{moment.strftime('%Y%m%d-%H%M')}")
    vaultlib.git_out(vault.path, "branch", name, "HEAD")
    code, out = net(vault, "push", "--quiet", "origin", f"refs/heads/{name}:refs/heads/{name}", timeout=180)
    when = shown_time(moment)
    if code != 0:
        vaultlib.log(vault, "session-capture.log", f"conflict branch push failed: {out.strip()[:300]}")
        return settle(vault, "conflict-unpushed",
                      f"[VAULT CONFLICT] your notes from {when} do not rebase onto the remote and their branch "
                      f"{name} could not be pushed — they stay on this clone's {branch}")
    entry = {"branch": name, "onto": branch, "time": when, "reset": False}
    # A held new file survives the reset, and a rebase would not have started onto a remote carrying
    # its path; left in the way, it would replay this conflict onto a new branch at every session end.
    paths = [file["path"] for file in read_state(vault)["held"]]
    if changes(vault, aside=frozenset(paths) - frozenset(tracked(vault, paths))):
        return settle(vault, "conflict-dirty", None, entry)
    vaultlib.git_out(vault.path, "reset", "--hard", "--quiet", f"refs/remotes/origin/{branch}")
    entry["reset"] = True
    return settle(vault, "conflict", None, entry)


def deferred_notice(when: str) -> str:
    """Why a rebase did not run: an uncommitted edit that is not held back waits on the next session end."""
    return (f"[VAULT] the remote had new vault commits at {when} while this clone had uncommitted edits — not "
            "rebased; the next session end integrates them")


def dirty_tracked(vault: vaultlib.Vault) -> Optional[list[str]]:
    """Every tracked path with an uncommitted change; None when git cannot say."""
    code, out = git_bytes(vault, "status", "--porcelain", "-z", "--untracked-files=no")
    return status_paths(out) if code == 0 else None


def stash_list(vault: vaultlib.Vault) -> list[str]:
    """The commits of git's stash, newest first, so a position in it is `stash@{n}`."""
    code, out = vaultlib.git_out(vault.path, "stash", "list", "--format=%H")
    return out.split() if code == 0 else []


def set_aside(vault: vaultlib.Vault, paths: list[str]) -> Optional[str]:
    """Stash the edits of exactly `paths`, and nothing else; the stash's commit, or None when none was made."""
    before = stash_list(vault)
    code, _ = git_bytes(vault, "stash", "push", "--quiet", "-m", "vault: edits held back from the commit",
                        "--", *paths)
    after = stash_list(vault)
    if code != 0 or not after or after[:1] == before[:1]:
        return None
    return after[0]


def restore(vault: vaultlib.Vault, path: str) -> None:
    """Return one path, index and work tree, to what HEAD holds; remove it where HEAD holds none."""
    git_bytes(vault, "reset", "-q", "--", path)
    if git_bytes(vault, "cat-file", "-e", f"HEAD:{path}")[0] == 0:
        git_bytes(vault, "checkout", "-q", "HEAD", "--", path)
        return
    target = vault.path / path
    if target.is_file() or target.is_symlink():
        target.unlink()


def put_back(vault: vaultlib.Vault, stash: str, paths: list[str]) -> bool:
    """Re-apply a set-aside stash and drop it; False when it conflicts, and then it stays in the stash.

    A conflicting apply leaves markers in the files, so each path is returned on its own to the
    commit the rebase left: a path that commit holds is checked out from it, and one it deleted or
    renamed away is removed, its edit kept in the stash. No marker, and no copy of a note the remote
    deleted, is left for a later commit to publish. Either way the paths are left unstaged, as a held
    edit stands.
    """
    applied = git_bytes(vault, "stash", "apply", "--quiet", stash)[0] == 0
    if not applied:
        # The rebase left every tracked path clean, so whatever the apply changed — a held path, or
        # the new name of one the remote renamed — goes back.
        for path in dict.fromkeys(paths + (dirty_tracked(vault) or [])):
            restore(vault, path)
        return False
    git_bytes(vault, "reset", "-q", "--", *paths)
    listed = stash_list(vault)
    if stash in listed:
        vaultlib.git_out(vault.path, "stash", "drop", "--quiet", f"stash@{{{listed.index(stash)}}}")
    return True


def keep_aside(vault: vaultlib.Vault, stash: str, paths: list[str], when: str) -> None:
    """Record held edits that stay in the stash; they are no longer in the work tree to be held."""
    state = read_state(vault)
    waiting = set(stash_list(vault))
    state["aside"] = [entry for entry in state["aside"] if entry["stash"] in waiting]
    state["aside"].append({"stash": stash, "paths": paths, "time": when})
    state["held"] = [entry for entry in state["held"] if entry["path"] not in paths]
    write_state(vault, state)
    vaultlib.log(vault, "session-capture.log",
                 f"held edits kept in the stash {stash[:12]}: {', '.join(readable(path) for path in paths)}")


def rebase_onto(vault: vaultlib.Vault, branch: str, upstream: str, when: str, now) -> Optional[str]:
    """Rebase this clone's commits onto the remote; None when the push may follow, else how it ended.

    Held edits of tracked files are the only uncommitted change a rebase is run past: they are set
    aside by their exact paths and put back after it, on whatever commit it left.
    """
    held = set(tracked(vault, [entry["path"] for entry in read_state(vault)["held"]]))
    dirty = dirty_tracked(vault)
    if dirty is None or any(path not in held for path in dirty):
        return settle(vault, "deferred", deferred_notice(when))
    stash = set_aside(vault, dirty) if dirty else None
    if dirty and stash is None:
        return settle(vault, "deferred", f"[VAULT] the remote had new vault commits at {when} — not rebased: "
                                         "the edits held back from the commit could not be set aside; the next "
                                         "session end tries again")
    try:
        code, out = git(vault, "rebase", "--no-autostash", "--quiet", upstream, timeout=180)
        if code == 0:
            return None
        if rebasing(vault):
            return park_conflict(vault, branch, now)
        vaultlib.log(vault, "session-capture.log", f"vault rebase failed: {out.strip()[:300]}")
        return settle(vault, "unrebased", f"[VAULT] the vault could not be rebased onto its remote at {when} — "
                                          f"{vault.shown(vault.state)}/session-capture.log says why")
    finally:
        if stash is not None and not put_back(vault, stash, dirty):
            keep_aside(vault, stash, dirty, when)


def integrate_vault(vault: vaultlib.Vault, wait: float = 0.0, sleep=time.sleep,
                    jitter=random.uniform, now=utc_now) -> str:
    """Bring this clone's vault commits onto the remote: fetch, rebase, push, a few times if refused."""
    if vault.mode != "own-repo" or not vault_remote(vault):
        return "no-remote"
    with vaultlib.holding(lock_path(vault), wait, sleep=sleep) as held:
        if held is None:
            vaultlib.log(vault, "session-capture.log", "vault not integrated: another process held the lock")
            return "busy"
        why = vaultlib.unfinished(vault.path, vault.rel)
        if why is not None:
            return hold_off(vault, why)
        branch = current_branch(vault)
        if branch is None:
            return hold_off(vault, "the vault is not on a branch")
        if unpushed(vault) == 0:
            return settle(vault, "current", None)
        upstream = f"refs/remotes/origin/{branch}"
        for attempt in range(1, PUSH_ATTEMPTS + 1):
            if attempt > 1:
                sleep(jitter(1.0, 4.0))
            code, out = net(vault, "fetch", "--quiet", "--prune", "origin", timeout=60)
            when = shown_time(now())
            if code != 0:
                vaultlib.log(vault, "session-capture.log", f"vault fetch failed: {out.strip()[:300]}")
                return settle(vault, "offline", f"[VAULT] the vault's remote could not be reached at {when} — "
                                                "the notes are committed on this machine; the next session end "
                                                "pushes them")
            if ref_exists(vault, upstream) and not contains(vault, upstream):
                ended = rebase_onto(vault, branch, upstream, when, now)
                if ended is not None:
                    return ended
            code, out = net(vault, "push", "--quiet", "-u", "origin", f"refs/heads/{branch}:refs/heads/{branch}",
                            timeout=180)
            if code == 0:
                return settle(vault, "pushed", None)
            vaultlib.log(vault, "session-capture.log", f"vault push attempt {attempt} failed: {out.strip()[:300]}")
            if "rejected" not in out:
                return settle(vault, "offline", f"[VAULT] the vault's remote could not be reached at {when} — "
                                                "the notes are committed on this machine; the next session end "
                                                "pushes them")
        return settle(vault, "rejected", f"[VAULT] the vault's remote refused {PUSH_ATTEMPTS} pushes at {when} — "
                                         "the notes are committed on this machine; the next session end retries")


def resolved_conflicts(vault: vaultlib.Vault, conflicts: list[dict]) -> list[dict]:
    """The conflict branches still waiting: gone from the remote or merged into their branch, they are done."""
    waiting = []
    for conflict in conflicts:
        remote = f"refs/remotes/origin/{conflict['branch']}"
        onto = f"refs/remotes/origin/{conflict.get('onto') or ''}"
        if not ref_exists(vault, remote):
            continue
        if ref_exists(vault, onto) and contains(vault, remote, onto):
            continue
        waiting.append(conflict)
    return waiting


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'s' if n != 1 else ''}"


def update_vault(vault: vaultlib.Vault, wait: float = BRIEF_WAIT, sleep=time.sleep) -> list[str]:
    """Bring the vault up to date at session start — fetch, then fast-forward or say why not. Never rebases."""
    if vault.mode != "own-repo" or not vault_remote(vault):
        return []
    with vaultlib.holding(lock_path(vault), wait, sleep=sleep) as held:
        if held is None:
            return ["[VAULT] not brought up to date — another session is syncing the vault"]
        why = vaultlib.unfinished(vault.path, vault.rel)
        if why is not None:
            return [f"[VAULT] not brought up to date: {why}"]
        branch = current_branch(vault)
        if branch is None:
            return ["[VAULT] not brought up to date — the vault is not on a branch"]
        code, _ = net(vault, "fetch", "--quiet", "--prune", "origin", timeout=10, connect=5)
        if code != 0:
            return ["[VAULT] the vault's remote could not be reached — this session reads the local copy"]
        state = read_state(vault)
        waiting = resolved_conflicts(vault, state["conflicts"])
        if waiting != state["conflicts"]:
            state["conflicts"] = waiting
            write_state(vault, state)
        upstream = f"refs/remotes/origin/{branch}"
        if not ref_exists(vault, upstream):
            return []
        behind = count(vault, f"HEAD..{upstream}")
        if not behind:
            return []
        news = f"the remote has {plural(behind, 'vault commit')} this clone lacks"
        if changes(vault, aside=frozenset(entry["path"] for entry in state["held"])):
            return [f"[VAULT] {news} — not merged: the vault has uncommitted edits; the next session end "
                    f"integrates them"]
        ahead = count(vault, f"{upstream}..HEAD")
        if ahead:
            return [f"[VAULT] {news} — not merged: this clone has {plural(ahead, 'commit')} of its own; the next "
                    f"session end rebases them"]
        code, _ = vaultlib.git_out(vault.path, "merge", "--ff-only", "--quiet", upstream)
        if code != 0:
            return [f"[VAULT] {news} — the fast-forward failed; the next session end integrates them"]
        return [f"[VAULT] brought up to date — {plural(behind, 'commit')} from the remote"]


def held_lines(held: list[dict]) -> list[str]:
    """One line per file held back from the commit: its path and the reason class, never its value."""
    return [f"[VAULT] not committed: {readable(entry['path'])} ({entry['reason']}) — take the value out, or "
            f"commit it by hand if it is no credential" for entry in held]


def aside_lines(vault: vaultlib.Vault, aside: list[dict]) -> list[str]:
    """One line per set-aside stash still in git's stash: the paths, and the command that brings them back."""
    listed = stash_list(vault) if aside else []
    lines = []
    for entry in aside:
        if entry["stash"] not in listed:
            continue
        names = ", ".join(readable(path) for path in entry["paths"])
        lines.append(f"[VAULT] held edits of {names} did not go back after the rebase at {entry.get('time')} — the "
                     f"remote changed them too; they wait in git's stash: git -C \"{vault.rel}\" stash pop "
                     f"stash@{{{listed.index(entry['stash'])}}}, then take the value out")
    return lines


def commit_line(vault: vaultlib.Vault, failure: Optional[dict], held: list[dict]) -> list[str]:
    """The failed commit, with its reason and the command that finishes it — while something is left to commit."""
    if failure is None or not changes(vault, aside=frozenset(entry["path"] for entry in held)):
        return []
    return [f"[VAULT] the session end of {failure['time']} could not commit the vault: {failure['reason']}; the "
            f"next session end tries again, or commit it by hand: git -C \"{vault.rel}\" commit -m \"vault notes\""]


def sync_lines(vault: vaultlib.Vault) -> list[str]:
    """What the last runs left behind: conflict branches to merge, a commit that failed, files held back,
    held edits left in the stash, a failed integration's notice."""
    state = read_state(vault)
    lines = []
    for conflict in state["conflicts"]:
        line = f"[VAULT CONFLICT] your notes from {conflict.get('time')} are on branch {conflict['branch']} — merge them"
        if not conflict.get("reset"):
            line += (f" · this clone's {conflict.get('onto')} still holds them too: the vault had unsaved edits, "
                     f"so it was not reset to the remote")
        lines.append(line)
    lines += commit_line(vault, state["commit"], state["held"])
    lines += held_lines(state["held"])
    lines += aside_lines(vault, state["aside"])
    if state["notice"]:
        lines.append(state["notice"])
    return lines


def merge_lines(vault: vaultlib.Vault) -> list[str]:
    """What the merge drivers reported: notes whose generated facts need refreshing, rows kept twice."""
    lines = []
    found = git_dir(vault) if vault.mode == "own-repo" else None
    if found is not None:
        try:
            listed = (found / REGENERATE).read_text(encoding="utf-8").splitlines()
        except OSError:
            listed = []
        notes = list(dict.fromkeys(line.strip() for line in listed if line.strip()))
        if notes:
            more = f" (+{len(notes) - 5} more)" if len(notes) > 5 else ""
            lines.append(f"[VAULT] regenerate: {', '.join(notes[:5])}{more} — refresh their generated facts, "
                         f"then delete {vault.shown(found / REGENERATE)}")
        code, out = vaultlib.git_out(vault.path, "grep", "-c", "-I", "-E", TWO_VERSIONS, timeout=20)
        if code == 0:
            counts = [(name, int(n)) for name, _, n in (line.rpartition(":") for line in out.splitlines())
                      if n.isdigit()]
            total = sum(n for _, n in counts)
            if total:
                rows = "1 row has" if total == 1 else f"{total} rows have"
                lines.append(f"[VAULT] {rows} two versions — keep one · "
                             + ", ".join(f"{name} ({n})" for name, n in counts))
    return lines


# --- entry points -------------------------------------------------------------


def worker(payload_path: Path) -> int:
    try:
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    finally:
        payload_path.unlink(missing_ok=True)
    if not isinstance(payload, dict):
        return 0
    session_id = str(payload.get("session_id") or "")
    vault = vaultlib.locate(payload.get("cwd"))
    if not SESSION_ID.fullmatch(session_id) or vault is None:
        return 0
    transcript = Path(str(payload.get("transcript_path") or ""))
    lines = read_lines(transcript_files(transcript, session_id))
    # Under the lock, so a session start's fast-forward cannot land between reading the inbox and
    # writing it back — the write would quietly undo the entries the fast-forward brought. A lock
    # that stays taken means the inbox is not written at all, and the next brief says so.
    filed = True
    with vaultlib.holding(lock_path(vault), CAPTURE_WAIT) as held:
        if held is None:
            filed = False
            vaultlib.log(vault, "session-capture.log",
                         f"inbox not written for {session_id}: another process held the vault's lock")
        else:
            try:
                capture(vault, session_id, lines, datetime.now().strftime("%Y-%m-%d"))
            except Exception as exc:  # a detached worker has no caller; the log is its only reader
                vaultlib.log(vault, "session-capture.log", f"inbox capture failed for {session_id}: {exc!r}")
    here = Path(__file__).resolve().parent
    vaultlib.run([sys.executable, str(here / "vault_check.py"), "--quiet", "--root", str(vault.root)],
                 cwd=vault.root, timeout=900)
    commit_vault(vault, session_id, wait=CAPTURE_WAIT)
    integrate_vault(vault, wait=CAPTURE_WAIT)
    if not filed:
        add_notice(vault, f"[VAULT] session {session_id[:8]} was not checked for the inbox — another process "
                          f"held the vault's lock; {vault.shown(vault.state)}/session-capture.log says when")
    vaultlib.run([sys.executable, str(here / "vault_search.py"), "refresh", "--root", str(vault.root)],
                 cwd=vault.root, timeout=3600)
    return 0


def hook(stdin_text: str, spawn=vaultlib.spawn) -> int:
    """The SessionEnd hook: save the payload and hand it to a detached worker. Never fails."""
    if vaultlib.disabled():
        return 0
    try:
        payload = json.loads(stdin_text or "{}")
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    session_id = str(payload.get("session_id") or "")
    if not SESSION_ID.fullmatch(session_id):
        return 0
    vault = vaultlib.locate(payload.get("cwd"))
    if vault is None or vaultlib.project_owns(vault.root, "SessionEnd"):
        return 0
    try:
        target = vault.state / "payloads" / f"{session_id}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        return 0
    spawn([str(Path(__file__).resolve()), "--worker", str(target)], vault.root)
    return 0


def backup_line(vault: vaultlib.Vault, has_remote: bool, ahead: Optional[int], uncommitted: int) -> Optional[str]:
    """Whether the vault has a copy off this machine, as one line — or None when all is well."""
    if vault.mode == "own-repo":
        if not has_remote:
            return "[VAULT] no copy off this machine — the vault's repository has no remote"
        if ahead:
            return (f"[VAULT] {ahead} vault commit{'s' if ahead != 1 else ''} not pushed — the next "
                    f"session end retries · git -C \"{vault.rel}\" push")
        return None
    if vault.mode == "tracked":
        if uncommitted:
            return (f"[VAULT] {uncommitted} vault change{'s' if uncommitted != 1 else ''} not yet committed "
                    f"with the project")
        return None
    why = {"ignored": "the project ignores the vault and it is no repository of its own",
           "untracked": "the vault is neither versioned by the project nor a repository of its own",
           "no-git": "the project is not a git repository"}[vault.mode]
    return f"[VAULT] no copy off this machine — {why}"


def brief_lines(vault: vaultlib.Vault, inbox_text: str, has_remote: bool, ahead: Optional[int],
                uncommitted: int, reader: Optional[str] = None,
                unattributed: Callable[[], Optional[set[str]]] = lambda: None) -> list[str]:
    """The inbox and the vault's off-machine copy as the brief shows them; the inbox counts the reader's own."""
    lines = inbox_lines(vault, inbox_text, reader, unattributed)
    backup = backup_line(vault, has_remote, ahead, uncommitted)
    if backup:
        lines.append(backup)
    return lines


def inbox_lines(vault: vaultlib.Vault, inbox_text: str, reader: Optional[str] = None,
                unattributed: Callable[[], Optional[set[str]]] = lambda: None) -> list[str]:
    """The inbox as the brief shows it, counting the reader's own entries; nothing when it holds none."""
    days = own_days(inbox_text, reader, unattributed)
    if not days:
        return []
    count = len(days)
    mine = f" — yours are the entries by {reader}" if reader else ""
    return [f"[INBOX] {count} session{'s' if count != 1 else ''} committed work with no journal "
            f"entry (oldest {min(days)}) — /vault:journal it, then delete the entry · "
            f"{vault.shown(vault.machine_file('Inbox.md'))}{mine}"]


def inbox_of(vault: vaultlib.Vault) -> tuple[str, Optional[str], Callable[[], Optional[set[str]]]]:
    """The inbox's text, whose entries the reader owns, and how to tell an entry without an author."""
    inbox = vault.machine_file("Inbox.md")
    text = inbox.read_text(encoding="utf-8") if inbox.is_file() else ""
    if vault.mode != "own-repo":
        return text, None, lambda: None
    # A vault of its own is shared through its remote, so its inbox holds every member's sessions.
    email = vaultlib.git_out(vault.path, "config", "user.email", timeout=10)[1].strip()
    return text, vaultlib.handle(vault.path), functools.partial(blamed_sessions, vault.path, "Inbox.md", email)


def outcome_lines(vault: vaultlib.Vault) -> list[str]:
    """What the session end recorded: conflicts, a failed commit, held files, merge reports, the inbox."""
    text, reader, unattributed = inbox_of(vault)
    return sync_lines(vault) + merge_lines(vault) + inbox_lines(vault, text, reader, unattributed)


def outcome(vault: vaultlib.Vault) -> list[str]:
    """The session start's share of the session end, where the plugin's own brief is not printed.

    A project that briefs its own session start, or a vault without a board, still has its vault
    synced and committed by this plugin's session end unless the project ends sessions itself: so the
    clone is brought up to date and what the session end recorded is printed. Everything else the
    brief says is left to the project. Nothing at all where the session end is the project's.
    """
    if vaultlib.project_owns(vault.root, "SessionEnd"):
        return []
    lines = update_vault(vault) + outcome_lines(vault)
    return [f"=== Knowledge vault ({vault.rel}/): what its session end left ===", *lines] if lines else []


def brief(vault: vaultlib.Vault) -> None:
    has_remote = vault.mode == "own-repo" and vault_remote(vault)
    ahead = unpushed(vault) if has_remote else None
    uncommitted = 0
    if vault.mode == "tracked":
        _, status = vaultlib.git_out(vault.root, "status", "--porcelain", "--", vault.rel)
        uncommitted = len([line for line in status.splitlines() if line.strip()])
    for line in outcome_lines(vault):
        print(line)
    backup = backup_line(vault, has_remote, ahead, uncommitted)
    if backup:
        print(backup)


def main(argv: list[str]) -> int:
    if "--update" in argv:
        vault = None if vaultlib.disabled() else vaultlib.locate()
        if vault:
            for line in update_vault(vault):
                print(line)
        return 0
    if "--outcome" in argv:
        vault = None if vaultlib.disabled() else vaultlib.locate()
        if vault:
            for line in outcome(vault):
                print(line)
        return 0
    if "--brief" in argv:
        vault = None if vaultlib.disabled() else vaultlib.locate()
        if vault:
            brief(vault)
        return 0
    if "--worker" in argv:
        index = argv.index("--worker")
        return worker(Path(argv[index + 1])) if index + 1 < len(argv) else 0
    return hook(sys.stdin.read())


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
