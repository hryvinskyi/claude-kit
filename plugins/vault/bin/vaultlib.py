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

A vault is a directory strictly inside its project: `locate` refuses the project root itself and
anything a path or a symbolic link leads to outside it, whatever the resolver printed. A vault is
`own-repo` only when it is the top of a work tree whose repository is not the project's — a clone,
a submodule, or a linked work tree of a vault repository; a linked work tree of the project's own
repository is not.

Locks are `flock(2)` locks on a file in the state directory, so a lock whose holder exited — however
it exited — is free, and no process ever takes over a lock another one still holds.
"""
from __future__ import annotations

import hashlib
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

try:
    import fcntl
except ImportError:  # not a POSIX system: no lock is ever held, so nothing that needs one runs
    fcntl = None

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


# The variables that point git at a repository other than the one `git -C <dir>` names. A tool run
# from inside a git hook inherits the hook's; left in place, a commit "in the vault" would land in the
# repository that ran the hook.
REPOSITORY_VARIABLES = ("GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                        "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
                        "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_NAMESPACE")


def git_env(extra: Optional[dict] = None) -> dict:
    """The environment for a git command that must act on the directory it is given and no other."""
    env = {key: value for key, value in os.environ.items() if key not in REPOSITORY_VARIABLES}
    env.update(extra or {})
    return env


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
                              timeout=timeout, stdin=subprocess.DEVNULL, env=git_env())
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
        """The name of the project's state directory: readable, and told apart by its full path's hash."""
        real = os.path.realpath(str(self.root))
        readable = re.sub(r"[^A-Za-z0-9]+", "-", real).strip("-")[-80:].strip("-") or "root"
        return f"{readable}-{hashlib.sha256(real.encode('utf-8')).hexdigest()[:12]}"

    @property
    def legacy_slug(self) -> str:
        """The name state directories had before it carried a hash; two projects could share one."""
        return re.sub(r"[^A-Za-z0-9]+", "-", str(self.root)).strip("-") or "root"

    @property
    def state(self) -> Path:
        return state_dir(self)

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


# The file in a state directory that names the project it belongs to, by its full resolved path.
OWNER_FILE = "project"


def state_dir(vault: Vault) -> Path:
    """The project's state directory, adopting the one an older version named by the readable slug.

    A legacy directory is adopted when no project claims it yet, or this one does; one that names
    another project in its owner file is left to that project. The owner file is written either way.
    """
    target = state_root() / vault.slug
    owner = os.path.realpath(str(vault.root))
    if not target.is_dir():
        legacy = state_root() / vault.legacy_slug
        if legacy.is_dir() and legacy != target and _claimed_by(legacy) in (None, owner):
            try:
                os.rename(str(legacy), str(target))
            except OSError:
                pass  # another process adopted it first, or it went away
    if target.is_dir() and _claimed_by(target) != owner:
        try:
            (target / OWNER_FILE).write_text(owner + "\n", encoding="utf-8")
        except OSError:
            pass
    return target


def _claimed_by(directory: Path) -> Optional[str]:
    try:
        return (directory / OWNER_FILE).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def project_root(cwd: Path) -> Path:
    """The git work tree containing a directory, or the directory itself outside any."""
    code, out = git_out(cwd, "rev-parse", "--show-toplevel")
    return Path(out.strip()) if code == 0 and out.strip() else cwd


def strictly_inside(root: Path, path: Path) -> bool:
    """Whether `path`, every symbolic link followed, lies below `root` and is not `root` itself."""
    real_root, real = Path(os.path.realpath(str(root))), Path(os.path.realpath(str(path)))
    return real != real_root and real_root in real.parents


def own_repository(root: Path, path: Path) -> bool:
    """Whether a vault is the top of a work tree of a repository that is not the project's."""
    if not (path / ".git").exists():
        return False
    code, top = git_out(path, "rev-parse", "--show-toplevel", timeout=20)
    if code != 0 or os.path.realpath(top.strip()) != os.path.realpath(str(path)):
        return False
    mine = common_dir(path)
    return mine is not None and common_dir(root) != mine


def common_dir(directory: Path) -> Optional[str]:
    """The resolved repository directory shared by every work tree of the repository `directory` is in."""
    code, out = git_out(directory, "rev-parse", "--git-common-dir", timeout=20)
    if code != 0 or not out.strip():
        return None
    return os.path.realpath(os.path.join(str(directory), out.strip()))


def vault_mode(root: Path, path: Path) -> str:
    """Which of the five modes a vault is in (see the module docstring)."""
    if own_repository(root, path):
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
    declared = lines[0].strip()
    if not declared or os.path.isabs(declared) or ".." in Path(declared).parts:
        return None
    path = root / declared
    if not path.is_dir() or not strictly_inside(root, path):
        return None
    return Vault(root=root, path=path, mode=vault_mode(root, path))


# What git leaves in the repository directory while an operation waits for a person, and how to
# step out of it.
UNFINISHED = (("rebase-merge", "a rebase", "rebase --abort"), ("rebase-apply", "a rebase", "rebase --abort"),
              ("MERGE_HEAD", "a merge", "merge --abort"), ("CHERRY_PICK_HEAD", "a cherry-pick", "cherry-pick --abort"),
              ("REVERT_HEAD", "a revert", "revert --abort"))


def unfinished(clone: Path, shown: str) -> Optional[str]:
    """Why a vault's clone must not be committed or rewired now, said with the way out; None when it may.

    A merge, rebase, cherry-pick or revert waiting for a person, unmerged files, or a head on no
    branch. `shown` is how the clone is named in the command the reason suggests.
    """
    for name, what, abort in UNFINISHED:
        code, out = git_out(clone, "rev-parse", "--git-path", name, timeout=20)
        if code != 0 or not out.strip():
            return "git cannot read the vault's repository"
        if (clone / out.strip()).exists():
            return f"the vault is in the middle of {what} — finish it or git -C \"{shown}\" {abort}"
    code, out = git_out(clone, "ls-files", "--unmerged", timeout=20)
    if code != 0 or out.strip():
        return "the vault has unmerged files — resolve them and commit"
    code, out = git_out(clone, "symbolic-ref", "--quiet", "--short", "HEAD", timeout=20)
    if code != 0 or not out.strip():
        return f"the vault is not on a branch — git -C \"{shown}\" switch <branch>"
    return None


def project_owns(root: Path, event: str) -> bool:
    """Whether the project ships its own hook for an event, which the global tools then leave to it."""
    try:
        text = (root / ".claude" / "settings.json").read_text(encoding="utf-8")
    except OSError:
        return False
    return f'"{event}"' in text


class HeldLock:
    """A lock this process holds: an open descriptor carrying an exclusive `flock` on the lock file."""

    def __init__(self, path: Path, fd: int) -> None:
        self.path = path
        self.fd = fd

    def release(self) -> None:
        """Remove the lock file while it is still this holder's, then let the lock go."""
        try:
            mine, there = os.fstat(self.fd), os.stat(str(self.path))
            if (mine.st_dev, mine.st_ino) == (there.st_dev, there.st_ino):
                os.unlink(str(self.path))
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def claim(lock: Path) -> Optional[HeldLock]:
    """Take a lock without waiting; None while another process holds it.

    The lock file is removed when it is released, so a waiter that locked a file just unlinked
    checks that the path still names the file it locked, and tries again when it does not.
    """
    if fcntl is None:
        return None
    for _ in range(20):
        try:
            lock.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(lock), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            return None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
        try:
            mine, there = os.fstat(fd), os.stat(str(lock))
        except OSError:
            os.close(fd)
            continue
        if (mine.st_dev, mine.st_ino) != (there.st_dev, there.st_ino):
            os.close(fd)
            continue
        try:
            os.ftruncate(fd, 0)
            os.write(fd, f"{os.getpid()} {uuid.uuid4().hex}\n".encode())
        except OSError:
            pass
        return HeldLock(lock, fd)
    return None


@contextmanager
def holding(lock: Path, wait: float = 0.0, poll: float = 0.25,
            sleep: Callable[[float], None] = time.sleep,
            clock: Callable[[], float] = time.monotonic) -> Iterator[Optional[HeldLock]]:
    """Hold a lock for the block, waiting up to `wait` seconds for it; yields None when it stayed taken."""
    deadline = clock() + wait
    held = claim(lock)
    while held is None and clock() < deadline:
        sleep(poll)
        held = claim(lock)
    if held is None:
        yield None
        return
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
