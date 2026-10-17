"""The `stamps` driver: the vault check's review stamps merged entry by entry.

A stamps file maps each note to the files it cites, and each of those to its stamp: the commit of
the project at which someone reviewed that note against that file. Every (note, file) entry is
merged on its own, and an entry present on either side is never dropped — the vault check stamps a
missing entry afresh at the project's HEAD, which would record a review nobody made:

- equal on both sides, it is kept; changed, added or deleted on one side only, that side wins;
- deleted on one side and changed on the other, the changed one is kept;
- changed differently on both sides, the base entry is kept: a review that really happened. If the
  file moved on since, the vault check reports the note and someone stamps it deliberately;
- added differently on both sides, the older review is kept — the entry whose commit is an
  ancestor of the other's in the project's history — and the current side's when that cannot be
  told.

The result is written by the vault check's own writer, so the file's layout never drifts.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import vault_check
import vaultlib
from vault_merge.driver import Driver, MergeInput, Outcome, trivial
from vault_merge.gitmerge import Git

Stamps = Dict[str, Dict[str, Any]]


class ReviewHistory:
    """Tells which of two review commits came first in the project's history."""

    def is_ancestor(self, older: str, newer: str) -> bool:
        """Whether `older` is an ancestor of (or the same commit as) `newer`; False when unknown."""
        raise NotImplementedError


class ProjectHistory(ReviewHistory):
    """The history of the project whose vault is the git repository at `vault`, resolved the way
    the vault tools find a project's vault, on first use. A vault no project claims has no history:
    every question about it answers False."""

    def __init__(self, vault: Path) -> None:
        self.vault = vault
        self._git: Optional[Git] = None
        self._resolved = False

    def project(self) -> Optional[Git]:
        if not self._resolved:
            self._resolved = True
            top = self.vault.resolve()
            root = vaultlib.project_root(top.parent)
            found = vaultlib.locate(root)
            if found is not None and found.path.resolve() == top:
                self._git = Git(found.root)
        return self._git

    def is_ancestor(self, older: str, newer: str) -> bool:
        project = self.project()
        if project is None or not older or not newer:
            return False
        code, _, _ = project.run("merge-base", "--is-ancestor", older, newer)
        return code == 0


def read_stamps(data: bytes) -> Stamps:
    """The notes of a stamps file; an empty file holds none. Raises ValueError on any other shape."""
    if not data.strip():
        return {}
    parsed = json.loads(data.decode("utf-8"))
    notes = parsed.get("notes", {}) if isinstance(parsed, dict) else None
    if not isinstance(notes, dict) or not all(isinstance(entries, dict) for entries in notes.values()):
        raise ValueError("not a stamps file: expected {\"notes\": {note: {path: stamp}}}")
    return notes


def commit_of(entry: Any) -> str:
    value = entry.get("commit") if isinstance(entry, dict) else None
    return value if isinstance(value, str) else ""


class StampsDriver(Driver):
    """Merges review stamps by note and cited file."""

    def __init__(self, history: ReviewHistory) -> None:
        self.history = history

    def merge(self, given: MergeInput) -> Outcome:
        quick = trivial(given)
        if quick is not None:
            return quick
        base, current, incoming = (read_stamps(data) for data in (given.base, given.current, given.incoming))
        notes: Stamps = {}
        contested = 0
        for note in sorted(set(base) | set(current) | set(incoming)):
            sides = [version.get(note, {}) for version in (base, current, incoming)]
            entries: Dict[str, Any] = {}
            for path in sorted(set().union(*sides)):
                kept, both = self.entry(*(side.get(path) for side in sides))
                contested += both
                if kept is not None:
                    entries[path] = kept
            if entries:
                notes[note] = entries
        report = []
        if contested:
            report.append("%s: %d review %s changed on both sides; the earlier review was kept" % (
                given.path or "the stamps file", contested, "stamp" if contested == 1 else "stamps"))
        return Outcome(vault_check.render_stamps(notes).encode("utf-8"), True, report)

    def entry(self, base: Optional[Any], current: Optional[Any],
              incoming: Optional[Any]) -> Tuple[Optional[Any], bool]:
        """One entry three-way (None: absent) and whether both sides changed it differently."""
        if current == incoming:
            return current, False
        if current == base:
            return incoming, False
        if incoming == base:
            return current, False
        if current is None:
            return incoming, False
        if incoming is None:
            return current, False
        if base is not None:
            return base, True
        if self.history.is_ancestor(commit_of(incoming), commit_of(current)) \
                and not self.history.is_ancestor(commit_of(current), commit_of(incoming)):
            return incoming, True
        return current, True
