"""The `stamps` driver: the vault check's review stamps merged entry by entry.

A stamps file maps each note to the files it cites, and each of those to its stamp. Every
(note, file) entry is merged on its own: equal on both sides it is kept; changed (or added, or
deleted) on one side only, that side wins; deleted on one side and changed on the other, the changed
one is kept; changed on both sides differently, or added on both with different stamps, the entry is
dropped rather than either stamp kept, since neither side reviewed the combination the merge
produces. The vault check's next run stamps a missing entry afresh, as it does for a newly cited file.

The result is written by the vault check's own writer, so the file's layout never drifts.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

import vault_check
from vault_merge.driver import Driver, MergeInput, Outcome, trivial

Stamps = Dict[str, Dict[str, Any]]


def read_stamps(data: bytes) -> Stamps:
    """The notes of a stamps file; an empty file holds none. Raises ValueError on any other shape."""
    if not data.strip():
        return {}
    parsed = json.loads(data.decode("utf-8"))
    notes = parsed.get("notes", {}) if isinstance(parsed, dict) else None
    if not isinstance(notes, dict) or not all(isinstance(entries, dict) for entries in notes.values()):
        raise ValueError("not a stamps file: expected {\"notes\": {note: {path: stamp}}}")
    return notes


def merged_entry(base: Optional[Any], current: Optional[Any], incoming: Optional[Any]) -> Optional[Any]:
    """One entry three-way; None is an absent entry, and the result None drops it."""
    if current == incoming:
        return current
    if current == base:
        return incoming
    if incoming == base:
        return current
    if current is None:
        return incoming
    if incoming is None:
        return current
    return None


class StampsDriver(Driver):
    """Merges review stamps by note and cited file."""

    def merge(self, given: MergeInput) -> Outcome:
        quick = trivial(given)
        if quick is not None:
            return quick
        base, current, incoming = (read_stamps(data) for data in (given.base, given.current, given.incoming))
        notes: Stamps = {}
        dropped = 0
        for note in sorted(set(base) | set(current) | set(incoming)):
            sides = [version.get(note, {}) for version in (base, current, incoming)]
            entries: Dict[str, Any] = {}
            for path in sorted(set().union(*sides)):
                values = [side.get(path) for side in sides]
                kept = merged_entry(*values)
                if kept is not None:
                    entries[path] = kept
                elif values[1] is not None and values[2] is not None:
                    dropped += 1
            if entries:
                notes[note] = entries
        report = []
        if dropped:
            report.append("%s: %d review %s changed on both sides and dropped" % (
                given.path or "the stamps file", dropped, "stamp" if dropped == 1 else "stamps"))
        return Outcome(vault_check.render_stamps(notes).encode("utf-8"), True, report)
