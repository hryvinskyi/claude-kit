"""vaultlib — what every global vault tool agrees on: where the project, its vault and its state live.

A project's vault is found by `find-vault.sh`, the one resolver the commands and hooks share. What a
tool may write depends on where the vault lives, and that is the vault's *mode*:

- `own-repo`   the vault is a git repository of its own; its history is the vault's backup.
- `ignored`    the project's repository ignores it, so nothing written there reaches that history.
- `tracked`    the project's repository versions it — a team's or a client's tree.
- `untracked`  it sits inside a project repository, neither versioned nor ignored.
- `no-git`     the project is not a git repository at all.

Machine-written files — the inbox, the review stamps — live beside the notes only in an `own-repo`
or `ignored` vault. Every other vault's go under `~/.claude/state/vaults/<project>/`, so a
project's tracked tree never changes because a tool ran. A project's repository is never committed.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional, Union

HOME_CLAUDE = Path.home() / ".claude"
FIND_VAULT = Path(__file__).resolve().parent / "find-vault.sh"


def state_root() -> Path:
    """Where vaults that must not hold machine files keep theirs (`CLAUDE_VAULT_STATE` overrides)."""
    return Path(os.environ.get("CLAUDE_VAULT_STATE") or HOME_CLAUDE / "state" / "vaults").expanduser()


def disabled() -> bool:
    """The kill switch for every global vault tool."""
    return bool(os.environ.get("CLAUDE_NO_VAULT_TOOLS"))


def spawning_allowed() -> bool:
    """Whether a tool may start a detached process (tests switch it off)."""
    return not os.environ.get("CLAUDE_VAULT_NO_SPAWN")


def run(args: list[str], cwd: Optional[Path] = None, timeout: int = 120,
        env: Optional[dict] = None) -> tuple[int, str]:
    """Run a command; (1, reason) when it cannot run at all. stdout and stderr come back together."""
    try:
        proc = subprocess.run(args, cwd=str(cwd) if cwd else None, capture_output=True, text=True,
                              timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, repr(exc)
    return proc.returncode, proc.stdout + proc.stderr


# The exit code git_out answers when git did not finish in time, as timeout(1) spells it, so a caller that
# reads "no match" from git grep's 1 can tell an unfinished search from an empty one.
TIMED_OUT = 124


def git_out(root: Path, *args: str, timeout: int = 180) -> tuple[int, str]:
    """Run git in a directory and return its exit code and stdout; TIMED_OUT when it did not finish."""
    try:
        proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True,
                              timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return TIMED_OUT, ""
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return proc.returncode, proc.stdout


@dataclass(frozen=True)
class Vault:
    """A project, the vault it keeps, and what may be written where."""

    root: Path
    path: Path
    mode: str

    @property
    def rel(self) -> str:
        return os.path.relpath(self.path, self.root)

    @property
    def slug(self) -> str:
        return re.sub(r"[^A-Za-z0-9]+", "-", str(self.root)).strip("-") or "root"

    @property
    def state(self) -> Path:
        return state_root() / self.slug

    def machine_file(self, name: str) -> Path:
        """Where a machine-written file belongs: beside the notes only when that changes no project history."""
        return self.path / name if self.mode in ("own-repo", "ignored") else self.state / name

    def shown(self, path: Path) -> str:
        """A path as a brief line prints it: relative inside the project, `~`-anchored outside it."""
        try:
            return str(path.relative_to(self.root))
        except ValueError:
            home = str(Path.home())
            text = str(path)
            return "~" + text[len(home):] if text.startswith(home) else text


def project_root(cwd: Path) -> Path:
    """The git work tree containing a directory, or the directory itself outside any."""
    code, out = git_out(cwd, "rev-parse", "--show-toplevel")
    return Path(out.strip()) if code == 0 and out.strip() else cwd


def vault_mode(root: Path, path: Path) -> str:
    """Which of the five modes a vault is in (see the module docstring)."""
    if (path / ".git").exists():
        return "own-repo"
    code, _ = git_out(root, "rev-parse", "--is-inside-work-tree")
    if code != 0:
        return "no-git"
    rel = os.path.relpath(path, root)
    code, _ = git_out(root, "check-ignore", "-q", "--", rel)
    if code == 0:
        return "ignored"
    _, listed = git_out(root, "ls-files", "--", rel)
    return "tracked" if listed.strip() else "untracked"


def locate(cwd: Union[str, Path, None] = None) -> Optional[Vault]:
    """The vault of the project containing `cwd`, or None when it keeps none (or several)."""
    start = Path(cwd or os.getcwd()).absolute()
    if not start.is_dir():
        return None
    root = project_root(start)
    code, out = run([str(FIND_VAULT), str(root)], timeout=10)
    lines = out.strip().splitlines() if code == 0 else []
    if not lines:
        return None
    path = root / lines[0].strip()
    if not path.is_dir():
        return None
    return Vault(root=root, path=path, mode=vault_mode(root, path))


def project_owns(root: Path, event: str) -> bool:
    """Whether the project ships its own hook for an event, which the global tools then leave to it."""
    try:
        text = (root / ".claude" / "settings.json").read_text(encoding="utf-8")
    except OSError:
        return False
    return f'"{event}"' in text


def _claim(lock: Path, stale: int) -> Optional[str]:
    """Create a lock file holding a token of this process; steal one that has gone stale. None when held."""
    token = f"{os.getpid()} {uuid.uuid4().hex}"
    try:
        lock.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, token.encode())
        os.close(fd)
        return token
    except FileExistsError:
        try:
            if time.time() - lock.stat().st_mtime < stale:
                return None
            lock.unlink()
        except OSError:
            return None
        return _claim(lock, stale)
    except OSError:
        return None


def take_lock(lock: Path, stale: int = 600) -> bool:
    """Claim a lock file, stealing one that has gone stale."""
    return _claim(lock, stale) is not None


class HeldLock:
    """A lock file this process holds."""

    def __init__(self, path: Path, token: str) -> None:
        self.path = path
        self.token = token

    def refresh(self) -> None:
        """Mark the lock as alive, so a long run of steps never looks stale to a waiting process."""
        try:
            os.utime(str(self.path), None)
        except OSError:
            pass

    def release(self) -> None:
        """Remove the lock file, but only while it is still this holder's — never one a waiter stole."""
        try:
            if self.path.read_text(encoding="utf-8") == self.token:
                self.path.unlink()
        except OSError:
            pass


@contextmanager
def holding(lock: Path, wait: float = 0.0, stale: int = 600, poll: float = 0.25,
            sleep: Callable[[float], None] = time.sleep,
            clock: Callable[[], float] = time.monotonic) -> Iterator[Optional[HeldLock]]:
    """Hold a lock file for the block, waiting up to `wait` seconds for it; yields None when it stayed taken."""
    deadline = clock() + wait
    token = _claim(lock, stale)
    while token is None and clock() < deadline:
        sleep(poll)
        token = _claim(lock, stale)
    if token is None:
        yield None
        return
    held = HeldLock(lock, token)
    try:
        yield held
    finally:
        held.release()


def handle(repo: Path) -> str:
    """The person this clone acts for, as a short name a git ref can hold.

    `git config vault.handle` when set, else `$VAULT_HANDLE`, else the git user name — each reduced to
    lower-case letters, digits and hyphens.
    """
    code, out = git_out(repo, "config", "vault.handle", timeout=10)
    raw = out.strip() if code == 0 else ""
    raw = raw or os.environ.get("VAULT_HANDLE", "").strip()
    if not raw:
        code, out = git_out(repo, "config", "user.name", timeout=10)
        raw = out.strip() if code == 0 else ""
    raw = raw or os.environ.get("USER", "")
    return re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-") or "someone"


def spawn(args: list[str], cwd: Path) -> None:
    """Start a detached Python process that outlives the caller (never when spawning is switched off)."""
    if not spawning_allowed():
        return
    try:
        subprocess.Popen([sys.executable, *args], cwd=str(cwd), start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def log(vault: Vault, name: str, message: str, keep: int = 200) -> None:
    """Append one line to a log in the vault's state directory, keeping only its tail."""
    path = vault.state / name
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
        lines.append(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}")
        path.write_text("\n".join(lines[-keep:]) + "\n", encoding="utf-8")
    except OSError:
        pass
