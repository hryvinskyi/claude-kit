#!/usr/bin/env python3
"""session_capture.py — what a Claude Code session leaves for its project's vault when it ends. Global.

Usage:
    vault-capture              # the SessionEnd hook: reads its JSON, hands off, returns
    vault-capture --worker F   # the detached half, run on the payload saved in F
    vault-capture --update     # the SessionStart fetch and fast-forward, and why it did not happen
    vault-capture --brief      # the inbox, conflict and backup lines for the SessionStart brief

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
   its own.** A project's repository is never committed, whoever owns it. The commit comes first and
   the rebase onto the remote after it, never a stash. A push the remote refuses is retried after a
   fresh fetch and rebase, a few times, with jittered waits. Notes that do not rebase are pushed to a
   `conflict/<handle>/<UTC time>` branch, and the clone steps back to the remote only when nothing in
   it is uncommitted. A clone in the middle of a merge, rebase, cherry-pick or revert, with unmerged
   paths, or not on a branch is neither committed nor pushed: a person finishes what git started.
   How it ended is left in the state directory for the next brief.
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
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vaultlib  # noqa: E402

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
# after; it never stashes, so a stash that would not re-apply can never leave conflict markers for
# the next commit to publish.

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


# What git leaves in the repository directory while an operation waits for a person, and how to
# step out of it.
UNFINISHED = (("rebase-merge", "a rebase", "rebase --abort"), ("rebase-apply", "a rebase", "rebase --abort"),
              ("MERGE_HEAD", "a merge", "merge --abort"), ("CHERRY_PICK_HEAD", "a cherry-pick", "cherry-pick --abort"),
              ("REVERT_HEAD", "a revert", "revert --abort"))


def unfinished(vault: vaultlib.Vault) -> Optional[str]:
    """Why the vault's clone must not be committed or pushed now, as the brief says it; None when it may."""
    for name, what, abort in UNFINISHED:
        code, out = vaultlib.git_out(vault.path, "rev-parse", "--git-path", name, timeout=20)
        if code != 0 or not out.strip():
            return "git cannot read the vault's repository"
        if (vault.path / out.strip()).exists():
            return f"the vault is in the middle of {what} — finish it or git -C \"{vault.rel}\" {abort}"
    code, out = vaultlib.git_out(vault.path, "ls-files", "--unmerged", timeout=20)
    if code != 0 or out.strip():
        return "the vault has unmerged files — resolve them and commit"
    if current_branch(vault) is None:
        return f"the vault is not on a branch — git -C \"{vault.rel}\" switch <branch>"
    return None


def hold_off(vault: vaultlib.Vault, why: str) -> str:
    """Leave a clone git is not done with as it is, and say so on the next brief."""
    return settle(vault, "unfinished", f"[VAULT] not committed or pushed: {why}; the next session end does it")


def commit_vault(vault: vaultlib.Vault, session_id: str, wait: float = 0.0, sleep=time.sleep) -> bool:
    """Commit what changed in a vault that is its own repository; never anything else."""
    if vault.mode != "own-repo":
        return False
    with vaultlib.holding(lock_path(vault), wait, sleep=sleep) as held:
        if held is None:
            return False
        code, status = vaultlib.git_out(vault.path, "status", "--porcelain")
        if code != 0 or not status.strip():
            return False
        why = unfinished(vault)
        if why is not None:
            hold_off(vault, why)
            return False
        vaultlib.git_out(vault.path, "add", "-A")
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        code, out = git(vault, "commit", "-q", "-m", f"session {stamp} ({session_id[:8]})")
        if code != 0:
            vaultlib.log(vault, "session-capture.log", f"vault commit failed: {out.strip()[:300]}")
            return False
        return True


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


def changes(vault: vaultlib.Vault, untracked: bool = True) -> bool:
    """Whether the work tree holds anything uncommitted (an unreadable status counts as changes)."""
    args = ["status", "--porcelain"] + ([] if untracked else ["--untracked-files=no"])
    code, out = vaultlib.git_out(vault.path, *args)
    return code != 0 or bool(out.strip())


def git_dir(vault: vaultlib.Vault) -> Optional[Path]:
    code, out = vaultlib.git_out(vault.path, "rev-parse", "--absolute-git-dir")
    return Path(out.strip()) if code == 0 and out.strip() else None


def rebasing(vault: vaultlib.Vault) -> bool:
    found = git_dir(vault)
    return found is not None and ((found / "rebase-merge").exists() or (found / "rebase-apply").exists())


def read_state(vault: vaultlib.Vault) -> dict:
    """What the last integration left for the brief: conflict branches still to merge, and one notice."""
    try:
        state = json.loads((vault.state / SYNC_STATE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"conflicts": [], "notice": None}
    conflicts = state.get("conflicts") if isinstance(state, dict) else None
    notice = state.get("notice") if isinstance(state, dict) else None
    return {"conflicts": [c for c in conflicts or [] if isinstance(c, dict) and isinstance(c.get("branch"), str)],
            "notice": notice if isinstance(notice, str) else None}


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
    if changes(vault):
        return settle(vault, "conflict-dirty", None, entry)
    vaultlib.git_out(vault.path, "reset", "--hard", "--quiet", f"refs/remotes/origin/{branch}")
    entry["reset"] = True
    return settle(vault, "conflict", None, entry)


def integrate_vault(vault: vaultlib.Vault, wait: float = 0.0, sleep=time.sleep,
                    jitter=random.uniform, now=utc_now) -> str:
    """Bring this clone's vault commits onto the remote: fetch, rebase, push, a few times if refused."""
    if vault.mode != "own-repo" or not vault_remote(vault):
        return "no-remote"
    with vaultlib.holding(lock_path(vault), wait, sleep=sleep) as held:
        if held is None:
            vaultlib.log(vault, "session-capture.log", "vault not integrated: another process held the lock")
            return "busy"
        why = unfinished(vault)
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
                if changes(vault, untracked=False):
                    return settle(vault, "deferred", f"[VAULT] the remote had new vault commits at {when} while "
                                                     "this clone had uncommitted edits — not rebased; the next "
                                                     "session end integrates them")
                code, out = git(vault, "rebase", "--no-autostash", "--quiet", upstream, timeout=180)
                if code != 0:
                    if rebasing(vault):
                        return park_conflict(vault, branch, now)
                    vaultlib.log(vault, "session-capture.log", f"vault rebase failed: {out.strip()[:300]}")
                    return settle(vault, "unrebased", f"[VAULT] the vault could not be rebased onto its remote "
                                                      f"at {when} — {vault.shown(vault.state)}/session-capture.log "
                                                      "says why")
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
        why = unfinished(vault)
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
        if changes(vault):
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


def sync_lines(vault: vaultlib.Vault) -> list[str]:
    """What the last integration left behind: conflict branches to merge and the notice of a failed one."""
    state = read_state(vault)
    lines = []
    for conflict in state["conflicts"]:
        line = f"[VAULT CONFLICT] your notes from {conflict.get('time')} are on branch {conflict['branch']} — merge them"
        if not conflict.get("reset"):
            line += (f" · this clone's {conflict.get('onto')} still holds them too: the vault had unsaved edits, "
                     f"so it was not reset to the remote")
        lines.append(line)
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
    lines: list[str] = []
    days = own_days(inbox_text, reader, unattributed)
    if days:
        count = len(days)
        mine = f" — yours are the entries by {reader}" if reader else ""
        lines.append(f"[INBOX] {count} session{'s' if count != 1 else ''} committed work with no journal "
                     f"entry (oldest {min(days)}) — /vault:journal it, then delete the entry · "
                     f"{vault.shown(vault.machine_file('Inbox.md'))}{mine}")
    backup = backup_line(vault, has_remote, ahead, uncommitted)
    if backup:
        lines.append(backup)
    return lines


def brief(vault: vaultlib.Vault) -> None:
    inbox = vault.machine_file("Inbox.md")
    text = inbox.read_text(encoding="utf-8") if inbox.is_file() else ""
    has_remote = vault.mode == "own-repo" and vault_remote(vault)
    ahead = unpushed(vault) if has_remote else None
    uncommitted = 0
    if vault.mode == "tracked":
        _, status = vaultlib.git_out(vault.root, "status", "--porcelain", "--", vault.rel)
        uncommitted = len([line for line in status.splitlines() if line.strip()])
    reader: Optional[str] = None
    unattributed: Callable[[], Optional[set[str]]] = lambda: None
    if vault.mode == "own-repo":
        # A vault of its own is shared through its remote, so its inbox holds every member's sessions.
        reader = vaultlib.handle(vault.path)
        email = vaultlib.git_out(vault.path, "config", "user.email", timeout=10)[1].strip()
        unattributed = functools.partial(blamed_sessions, vault.path, "Inbox.md", email)
    for line in sync_lines(vault) + merge_lines(vault):
        print(line)
    for line in brief_lines(vault, text, has_remote, ahead, uncommitted, reader, unattributed):
        print(line)


def main(argv: list[str]) -> int:
    if "--update" in argv:
        vault = None if vaultlib.disabled() else vaultlib.locate()
        if vault:
            for line in update_vault(vault):
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
