"""What the drivers ask of git: a line-wise three-way merge, the clone's configuration, its git dir."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple, Union

# Long enough that no line of a note is mistaken for a conflict marker when the driver reads the
# result back; a result left for a person is made again with git's usual markers.
PARSE_MARKER_SIZE = 41
LABELS = ("current", "base", "incoming")
LINE = re.compile(r"[^\n]*\n|[^\n]+\Z")


class GitError(RuntimeError):
    """git could not be run, or failed in a way that is not a merge conflict."""


@dataclass
class Hunk:
    """One conflict: the current side's lines, the base's (when the conflict style shows them) and
    the incoming side's."""

    current: List[str] = field(default_factory=list)
    base: List[str] = field(default_factory=list)
    incoming: List[str] = field(default_factory=list)


Segment = Union[str, Hunk]


class Git:
    """The git command, run in one directory (a merge driver runs at the top of the work tree)."""

    def __init__(self, cwd: Optional[Path] = None, timeout: float = 60.0) -> None:
        self.cwd = cwd
        self.timeout = timeout

    def run(self, *args: str, input_bytes: Optional[bytes] = None) -> Tuple[int, bytes, bytes]:
        try:
            done = subprocess.run(["git", *args], cwd=str(self.cwd) if self.cwd else None,
                                  input=input_bytes, capture_output=True, timeout=self.timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            raise GitError("git %s could not run: %s" % (args[0], exc)) from exc
        return done.returncode, done.stdout, done.stderr

    def merge_file(self, current: bytes, base: bytes, incoming: bytes,
                   marker_size: Optional[int] = None) -> Tuple[bytes, int]:
        """`git merge-file -p` over three texts: the merged bytes and the number of conflicts."""
        with tempfile.TemporaryDirectory(prefix="vault-merge-") as tmp:
            paths = []
            for name, data in (("current", current), ("base", base), ("incoming", incoming)):
                path = os.path.join(tmp, name)
                with open(path, "wb") as handle:
                    handle.write(data)
                paths.append(path)
            args = ["merge-file", "-p"]
            if marker_size:
                args.append("--marker-size=%d" % marker_size)
            for label in LABELS:
                args += ["-L", label]
            code, out, err = self.run(*args, *paths)
        if code < 0 or code > 127:
            raise GitError("git merge-file failed: %s" % err.decode("utf-8", "replace").strip())
        return out, code

    def config(self, name: str) -> Optional[str]:
        """One value of the clone's configuration, or None when it is not set."""
        code, out, _ = self.run("config", "--get", name)
        if code != 0:
            return None
        return out.decode("utf-8").rstrip("\n")

    def git_dir(self) -> Path:
        code, out, err = self.run("rev-parse", "--absolute-git-dir")
        if code != 0:
            raise GitError("not inside a git repository: %s" % err.decode("utf-8", "replace").strip())
        return Path(out.decode("utf-8").rstrip("\n"))


def split_conflicts(text: str, marker_size: int = PARSE_MARKER_SIZE) -> List[Segment]:
    """The lines of a `git merge-file` result, every conflict gathered into one Hunk."""
    opening, original = "<" * marker_size, "|" * marker_size
    middle, closing = "=" * marker_size, ">" * marker_size
    segments: List[Segment] = []
    hunk: Optional[Hunk] = None
    target: List[str] = []
    for line in LINE.findall(text):
        bare = line.rstrip("\r\n")
        if hunk is None:
            if bare == opening or bare.startswith(opening + " "):
                hunk = Hunk()
                target = hunk.current
            else:
                segments.append(line)
        elif bare == original or bare.startswith(original + " "):
            target = hunk.base
        elif bare == middle:
            target = hunk.incoming
        elif bare == closing or bare.startswith(closing + " "):
            segments.append(hunk)
            hunk = None
        else:
            target.append(line)
    if hunk is not None:
        raise GitError("a conflict in git's result never closes")
    return segments
