#!/usr/bin/env python3
"""session_capture.py — what a Claude Code session leaves for its project's vault when it ends. Global.

Usage:
    vault-capture              # the SessionEnd hook: reads its JSON, hands off, returns
    vault-capture --worker F   # the detached half, run on the payload saved in F
    vault-capture --brief      # the inbox and backup lines for the SessionStart brief

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
3. **Commits and pushes the vault — only when the vault is a git repository of its own.** A project's
   repository is never committed, whoever owns it.
4. **Refreshes the project's qmd index** (`vault_search.py refresh`).

Where the inbox lives follows `vaultlib`: beside the notes for a vault that is its own repository or
ignored by the project, otherwise in `~/.claude/state/vaults/<project>/`. The brief names the file.
Every step is best-effort; failures go to `session-capture.log` in the state directory.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

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


def _entry_pattern(session_id: str) -> "re.Pattern[str]":
    return re.compile(r"<!-- session:%s -->\n.*?<!-- /session -->\n?" % re.escape(session_id), re.S)


def render_entry(session_id: str, day: str, commits: list[dict]) -> str:
    tickets = sorted({t for c in commits for t in c["tickets"]}, key=int)
    heading = f"## {day} · {len(commits)} commit{'s' if len(commits) != 1 else ''}"
    if tickets:
        heading += " · " + ", ".join(f"#{t}" for t in tickets)
    lines = [f"<!-- session:{session_id} -->", heading, ""]
    for c in commits:
        refs = f" — Refs {', '.join('#' + t for t in c['tickets'])}" if c["tickets"] else ""
        lines.append(f"- `{c['sha'][:9]}` {c['subject']}{refs}")
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
        updated, filed = upsert_entry(text, session_id, render_entry(session_id, day, commits)), True
    else:
        updated, filed = remove_entry(text, session_id), False
    if updated != text:
        inbox.parent.mkdir(parents=True, exist_ok=True)
        inbox.write_text(updated, encoding="utf-8")
    return filed


# --- the vault's copy ---------------------------------------------------------


def commit_vault(vault: vaultlib.Vault, session_id: str) -> bool:
    """Commit what changed in a vault that is its own repository; never anything else."""
    if vault.mode != "own-repo" or not vaultlib.take_lock(vault.state / "vault-commit.lock", 300):
        return False
    try:
        code, status = vaultlib.git_out(vault.path, "status", "--porcelain")
        if code != 0 or not status.strip():
            return False
        vaultlib.git_out(vault.path, "add", "-A")
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        code, out = vaultlib.run(["git", "-C", str(vault.path), "commit", "-q", "-m",
                                  f"session {stamp} ({session_id[:8]})"])
        if code != 0:
            vaultlib.log(vault, "session-capture.log", f"vault commit failed: {out.strip()[:300]}")
            return False
        return True
    finally:
        (vault.state / "vault-commit.lock").unlink(missing_ok=True)


def vault_remote(vault: vaultlib.Vault) -> bool:
    return vaultlib.git_out(vault.path, "remote", "get-url", "origin")[0] == 0


def unpushed(vault: vaultlib.Vault) -> Optional[int]:
    code, out = vaultlib.git_out(vault.path, "rev-list", "--count", "@{u}..HEAD")
    return int(out.strip()) if code == 0 and out.strip().isdigit() else None


def push_vault(vault: vaultlib.Vault) -> None:
    if vault.mode != "own-repo" or not vault_remote(vault) or unpushed(vault) == 0:
        return
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=20")
    code, out = vaultlib.run(["git", "-C", str(vault.path), "push", "--quiet", "origin", "HEAD"], timeout=180, env=env)
    if code != 0:
        vaultlib.log(vault, "session-capture.log", f"vault push failed: {out.strip()[:300]}")


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
    try:
        capture(vault, session_id, read_lines(transcript_files(transcript, session_id)),
                datetime.now().strftime("%Y-%m-%d"))
    except Exception as exc:  # a detached worker has no caller; the log is its only reader
        vaultlib.log(vault, "session-capture.log", f"inbox capture failed for {session_id}: {exc!r}")
    here = Path(__file__).resolve().parent
    vaultlib.run([sys.executable, str(here / "vault_check.py"), "--quiet", "--root", str(vault.root)],
                 cwd=vault.root, timeout=900)
    commit_vault(vault, session_id)
    push_vault(vault)
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
                uncommitted: int) -> list[str]:
    lines: list[str] = []
    days = re.findall(r"<!-- session:[A-Za-z0-9-]+ -->\n## (\d{4}-\d{2}-\d{2})", inbox_text)
    if days:
        count = len(days)
        lines.append(f"[INBOX] {count} session{'s' if count != 1 else ''} committed work with no journal "
                     f"entry (oldest {min(days)}) — /vault:journal it, then delete the entry · "
                     f"{vault.shown(vault.machine_file('Inbox.md'))}")
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
    for line in brief_lines(vault, text, has_remote, ahead, uncommitted):
        print(line)


def main(argv: list[str]) -> int:
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
