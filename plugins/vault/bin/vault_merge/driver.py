"""The contract every merge driver keeps, in git's terms.

Git hands a driver three versions of one file: the common ancestor (`%O`, the *base*), the version
in the work tree being merged into (`%A`, *current*) and the version being merged in (`%B`,
*incoming*). Under `git merge`, current is the local branch; under `git pull --rebase` it is the
upstream commit the local one is being replayed onto, and incoming is the local commit. The drivers
are written in these terms only, never in "mine" and "theirs".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass(frozen=True)
class MergeInput:
    """Three versions of the file at `path` (its path in the repository, for messages)."""

    base: bytes
    current: bytes
    incoming: bytes
    path: str = ""


@dataclass
class Outcome:
    """What a driver produced: the merged bytes, whether git may take them as resolved, and lines
    for the person running the merge."""

    merged: bytes
    resolved: bool
    notes: List[str] = field(default_factory=list)


class Driver:
    """Merges three versions of a file. Raising means the driver could not: git's own text merge
    is used instead."""

    def merge(self, given: MergeInput) -> Outcome:
        raise NotImplementedError


def trivial(given: MergeInput) -> Optional[Outcome]:
    """The result when at most one side changed the file, which needs no driver."""
    if given.current == given.incoming or given.incoming == given.base:
        return Outcome(given.current, True)
    if given.current == given.base:
        return Outcome(given.incoming, True)
    return None
