"""The `generated` driver: notes that hold a region a tool writes, merged by git's text merge.

A region opens at a line matching the regular expression in the clone's `vault-merge.generatedBegin`
and closes at the next line matching `vault-merge.generatedEnd` (Python regular expressions,
searched within the line). When every conflict of `git merge-file` lies inside such a region — after
an opening line, before its closing line, and holding neither — each is resolved with the incoming
side's lines, the note's path is appended to `<git dir>/vault-regenerate` for the tool that writes
the region to rewrite, and the merge is resolved. Any other conflict is left in place, with git's
markers, for a person.
"""
from __future__ import annotations

import re
from typing import List, Pattern, Sequence, Tuple

from vault_merge.driver import Driver, MergeInput, Outcome, trivial
from vault_merge.gitmerge import PARSE_MARKER_SIZE, Git, Hunk, Segment, split_conflicts

BEGIN_KEY = "vault-merge.generatedBegin"
END_KEY = "vault-merge.generatedEnd"
REGENERATE = "vault-regenerate"


class MarkersMissing(RuntimeError):
    """The clone does not say how its generated regions are delimited."""


class GeneratedDriver(Driver):
    """Resolves conflicts inside generated regions; leaves every other conflict to a person."""

    def __init__(self, git: Git) -> None:
        self.git = git

    def merge(self, given: MergeInput) -> Outcome:
        quick = trivial(given)
        if quick is not None:
            return quick
        begin, end = self.markers()
        merged, conflicts = self.git.merge_file(given.current, given.base, given.incoming,
                                                marker_size=PARSE_MARKER_SIZE)
        if conflicts == 0:
            return Outcome(merged, True)
        segments = split_conflicts(merged.decode("utf-8"))
        if not all_generated(segments, begin, end):
            shown, _ = self.git.merge_file(given.current, given.base, given.incoming)
            return Outcome(shown, False)
        resolved: List[str] = []
        for segment in segments:
            if isinstance(segment, Hunk):
                resolved.extend(segment.incoming)
            else:
                resolved.append(segment)
        self.mark_for_regeneration(given.path)
        return Outcome("".join(resolved).encode("utf-8"), True, [
            "%s: a generated region changed on both sides; the incoming version was kept and the note "
            "is listed in %s for regeneration" % (given.path or "the note", REGENERATE)])

    def markers(self) -> Tuple[Pattern[str], Pattern[str]]:
        begin, end = self.git.config(BEGIN_KEY), self.git.config(END_KEY)
        if not begin or not end:
            raise MarkersMissing("set %s and %s in this clone's git config" % (BEGIN_KEY, END_KEY))
        return re.compile(begin), re.compile(end)

    def mark_for_regeneration(self, path: str) -> None:
        listing = self.git.git_dir() / REGENERATE
        listed = listing.read_text(encoding="utf-8").splitlines() if listing.exists() else []
        if path and path not in listed:
            with listing.open("a", encoding="utf-8") as handle:
                handle.write(path + "\n")


def all_generated(segments: Sequence[Segment], begin: Pattern[str], end: Pattern[str]) -> bool:
    """Whether every conflict lies inside a region: opened before it, closed after it, and no
    region marker among its own lines."""
    inside = False
    awaiting_close = False
    for segment in segments:
        if isinstance(segment, Hunk):
            own = segment.current + segment.base + segment.incoming
            if not inside or any(begin.search(line) or end.search(line) for line in own):
                return False
            awaiting_close = True
            continue
        if end.search(segment):
            inside = False
            awaiting_close = False
        elif begin.search(segment):
            if awaiting_close:
                return False
            inside = True
    return not awaiting_close

