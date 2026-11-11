#!/usr/bin/env python3
"""Tests for the keyed merge driver and the block reader beneath it (bin/vault_merge/).

Pinned: how a document is cut into blocks and keyed (an issue reference with its repository, a bold
span, leading text, an inbox entry's session, a level-three block, repeated keys numbered); that
writing a document back gives its bytes (CRLF, no final newline, trailing spaces); and every three-way
case of the merge, in base/current/incoming terms: one side, both sides alike or differently,
deletions against edits, additions on both sides, section moves, retitled rows without a ticket,
a row replaced by another (never read as a retitle when both name a ticket or a session and not the
same one), a row or an action rewritten in place to gain its ticket or drop it,
repeated keys, inbox entries, free text, line endings — and that swapping the sides keeps the same
rows; seeded random edits of a ticket board lose no ticket. Fixtures are synthetic.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import random
import re
import subprocess
import unittest
from collections import Counter
from typing import Dict, List, Set, Tuple

import merge_support  # puts the plugin's bin/ on the import path
from vault_merge import blocks as md
from vault_merge.driver import MergeInput, Outcome
from vault_merge.gitmerge import Git
from vault_merge.keyed import ANNOTATION, KeyedDriver

BOARD = """# Board

> Rows read `- [ ] **#N — title** — context`.

## Now

- [ ] **#41 — Fix the invoice rounding** — billing, added 2026-01-02
- [ ] **example-org/example-repo#42 — Widget shows stale totals** — the widget's twin row
- [ ] **#42 — Totals are cached too long** — billing
- [ ] **Rename the export job** — no ticket yet
- [ ] a plain row with no bold span at all

## Next

- [ ] **#50 — Archive old invoices**
  - first point
  - second point
  - third point

## Done

- [x] **#30 — Retire the old importer**
"""

INBOX = """---
type: inbox
---

# Inbox

Sessions that committed work without a journal entry.

<!-- session:aaaa-1111 -->
## 2026-01-05 · 1 commit

- `abc1234` fix(billing): round once
<!-- /session -->

<!-- session:bbbb-2222 -->
## 2026-01-06 · 2 commits

- `def5678` feat(export): stream rows
<!-- /session -->
"""

ACTIONS = """# Deferred actions

Outward work the queue cannot do.

## Open

### #41: check the rounding on the stand

Run the invoice report.

Compare the totals with the ledger.

### #42: purge the test workspace

Remove it by its id.
"""


def merge(base: str, current: str, incoming: str) -> Tuple[str, Outcome]:
    outcome = KeyedDriver(Git()).merge(MergeInput(base.encode(), current.encode(), incoming.encode(), "To DO.md"))
    return outcome.merged.decode(), outcome


def edit(text: str, old: str, new: str) -> str:
    assert old in text, old
    return text.replace(old, new, 1)


def rows(text: str) -> List[str]:
    return [line for line in text.splitlines() if line.startswith("- ")]


def section_of(text: str, needle: str) -> str:
    heading = ""
    for line in text.splitlines():
        if line.startswith("## "):
            heading = line[3:]
        if needle in line:
            return heading
    raise AssertionError(needle)


class ReadingTests(unittest.TestCase):
    def test_blocks_and_their_keys(self) -> None:
        document = md.parse(BOARD)
        items = [block for block in document.blocks if block.kind == md.ITEM_KIND]

        self.assertEqual([block.key for block in items], [
            "ref:#41", "ref:example-org/example-repo#42", "ref:#42", "bold:rename the export job",
            "text:a plain row with no bold span at all", "ref:#50", "ref:#30"])
        self.assertEqual(len(items[5].lines), 4, "an item takes its indented lines")
        self.assertEqual(items[0].section, "h2:now")
        self.assertEqual(items[-1].section, "h2:done")
        self.assertTrue(merge_support.COMMAND.is_file())

    def test_a_reference_keeps_its_repository_lower_cased(self) -> None:
        document = md.parse("- [ ] **Example-Org/Example-Repo#7 — x**\n")
        self.assertEqual(document.blocks[0].key, "ref:example-org/example-repo#7")

    def test_the_first_reference_in_the_bold_span_is_the_key(self) -> None:
        document = md.parse("- [ ] **Follow-up of #12, see #13** — and #99 later\n- **no ref** #5\n")
        self.assertEqual([block.key for block in document.blocks], ["ref:#12", "bold:no ref"])

    def test_leading_text_keys_on_its_first_characters_normalised(self) -> None:
        long = "Word " * 40
        document = md.parse("- [x]   %s\n" % long)
        self.assertEqual(document.blocks[0].key, "text:" + md.normalise(long)[:120])

    def test_repeated_keys_are_numbered(self) -> None:
        document = md.parse("- [ ] **#7 — a**\n- [ ] **#7 — b**\n- [x] **#7 — c**\n")
        self.assertEqual([block.key for block in document.blocks], ["ref:#7", "ref:#7#2", "ref:#7#3"])

    def test_an_inbox_entry_is_one_block_keyed_by_its_session(self) -> None:
        entries = [block for block in md.parse(INBOX).blocks if block.kind == md.ENTRY]
        self.assertEqual([block.key for block in entries], ["session:aaaa-1111", "session:bbbb-2222"])
        self.assertTrue(entries[0].lines[-1].startswith("<!-- /session -->"))

    def test_an_entry_marker_may_carry_more_than_the_session(self) -> None:
        document = md.parse("<!-- session:cccc-3333 by:someone -->\n## 2026-01-07\n<!-- /session -->\n")
        self.assertEqual(document.blocks[0].key, "session:cccc-3333")

    def test_a_level_three_heading_takes_its_body(self) -> None:
        sections = [block for block in md.parse(ACTIONS).blocks if block.kind == md.SECTION]
        self.assertEqual([block.key for block in sections],
                         ["h3:#41: check the rounding on the stand", "h3:#42: purge the test workspace"])
        self.assertEqual(sections[0].section, "h2:open")
        self.assertIn("Compare the totals with the ledger.\n", sections[0].lines)

    def test_a_fence_is_text_even_when_it_holds_rows_or_headings(self) -> None:
        text = "## Notes\n\n```\n- [ ] not a row\n### not a heading\n```\n- [ ] a row\n"
        kinds = [(block.kind, len(block.lines)) for block in md.parse(text).blocks]
        self.assertEqual(kinds, [(md.HEADING_LINE, 1), (md.TEXT, 5), (md.ITEM_KIND, 1)])

    def test_a_blank_line_followed_by_an_indented_one_stays_in_the_item(self) -> None:
        document = md.parse("- [ ] a row\n\n  more of it\n\n- [ ] next\n")
        self.assertEqual([len(block.lines) for block in document.blocks], [3, 1, 1])


class WritingBackTests(unittest.TestCase):
    def assertSameBytes(self, text: str) -> None:
        self.assertEqual(md.parse(text).text(), text)

    def test_every_fixture_comes_back_byte_for_byte(self) -> None:
        for text in (BOARD, INBOX, ACTIONS, ""):
            self.assertSameBytes(text)

    def test_crlf_line_endings_come_back(self) -> None:
        self.assertSameBytes(BOARD.replace("\n", "\r\n"))
        self.assertSameBytes("## Now\r\n- [ ] one\n- [ ] two\r\n")

    def test_a_missing_final_newline_stays_missing(self) -> None:
        self.assertSameBytes(BOARD.rstrip("\n"))
        self.assertSameBytes("- [ ] only row")

    def test_trailing_spaces_and_odd_lines_come_back(self) -> None:
        self.assertSameBytes("# T  \n\n- [ ] row   \n  \t\n   \n- \n-\n#nohash\n")

    def test_front_matter_that_never_closes_is_text(self) -> None:
        self.assertSameBytes("---\ntitle: x\n- [ ] row\n")


class KeyedMergeTests(merge_support.IsolatedGitTestCase):
    def test_a_file_changed_on_one_side_only_is_that_side(self) -> None:
        changed = edit(BOARD, "rounding**", "rounding again**")
        self.assertEqual(merge(BOARD, BOARD, changed)[0], changed)
        self.assertEqual(merge(BOARD, changed, BOARD)[0], changed)

    def test_edits_to_adjacent_rows_on_each_side_both_land(self) -> None:
        current = edit(BOARD, "billing, added", "billing and tax, added")
        incoming = edit(BOARD, "the widget's twin row", "the widget's twin row, reopened")
        _, conflicts = Git().merge_file(current.encode(), BOARD.encode(), incoming.encode())
        self.assertGreater(conflicts, 0, "git's text merge conflicts on these two edits")

        merged, outcome = merge(BOARD, current, incoming)

        self.assertEqual(merged, edit(current, "the widget's twin row", "the widget's twin row, reopened"))
        self.assertTrue(outcome.resolved)
        self.assertEqual(outcome.notes, [])

    def test_a_row_deleted_on_one_side_and_unchanged_on_the_other_is_deleted(self) -> None:
        current = edit(BOARD, "- [ ] **#42 — Totals are cached too long** — billing\n", "")
        incoming = edit(BOARD, "Archive old invoices", "Archive invoices older than a year")
        merged, _ = merge(BOARD, current, incoming)
        self.assertNotIn("Totals are cached", merged)
        self.assertIn("older than a year", merged)

    def test_a_row_deleted_on_one_side_and_changed_on_the_other_is_kept_changed(self) -> None:
        deleted = edit(BOARD, "- [ ] **#42 — Totals are cached too long** — billing\n", "")
        changed = edit(BOARD, "cached too long** — billing", "cached too long** — billing, owner found")
        for current, incoming in ((deleted, changed), (changed, deleted)):
            merged, _ = merge(BOARD, current, incoming)
            self.assertEqual(merged, changed)

    def test_the_same_change_on_both_sides_is_kept_once(self) -> None:
        changed = edit(BOARD, "- [ ] **#41", "- [x] **#41")
        other = edit(changed, "no ticket yet", "ticket soon")
        merged, outcome = merge(BOARD, changed, other)
        self.assertEqual(merged, other)
        self.assertEqual(outcome.notes, [])

    def test_different_changes_to_one_row_keep_both_annotated(self) -> None:
        current = edit(BOARD, "billing, added", "billing (current), added")
        incoming = edit(BOARD, "billing, added", "billing (incoming), added")

        merged, outcome = merge(BOARD, current, incoming)

        now = rows(merged)
        self.assertEqual(now[0], rows(current)[0])
        self.assertEqual(now[1], rows(incoming)[0])
        lines = merged.splitlines()
        self.assertEqual(lines[lines.index(now[0]) + 1], ANNOTATION)
        self.assertTrue(outcome.resolved, "the annotation reports the conflict; nothing blocks")
        self.assertEqual(len(outcome.notes), 1)
        self.assertIn("1 row has two versions", outcome.notes[0])

    def test_edits_to_different_lines_of_one_row_merge_line_wise(self) -> None:
        current = edit(BOARD, "  - first point", "  - first point, done")
        incoming = edit(BOARD, "  - third point", "  - third point, moved")
        merged, outcome = merge(BOARD, current, incoming)
        self.assertIn("first point, done", merged)
        self.assertIn("third point, moved", merged)
        self.assertNotIn(ANNOTATION, merged)
        self.assertEqual(outcome.notes, [])

    def test_a_row_added_on_both_sides_with_the_same_text_is_kept_once(self) -> None:
        row = "- [ ] **#60 — Export the ledger** — billing\n"
        added = edit(BOARD, "- [ ] a plain row", row + "- [ ] a plain row")
        merged, outcome = merge(BOARD, added, edit(added, "no ticket yet", "ticket soon"))
        self.assertEqual(merged.count("#60"), 1)
        self.assertEqual(outcome.notes, [])

    def test_a_row_added_on_both_sides_with_different_text_is_kept_twice_annotated(self) -> None:
        current = edit(BOARD, "## Next\n\n", "## Next\n\n- [ ] **#60 — Export the ledger** — first opener\n")
        incoming = edit(BOARD, "## Next\n\n", "## Next\n\n- [ ] **#60 — Export the ledger** — second opener\n")
        merged, outcome = merge(BOARD, current, incoming)
        lines = merged.splitlines()
        first = lines.index("- [ ] **#60 — Export the ledger** — first opener")
        self.assertEqual(lines[first + 1:first + 3],
                         [ANNOTATION, "- [ ] **#60 — Export the ledger** — second opener"])
        self.assertEqual(len(outcome.notes), 1)

    def test_new_rows_go_after_their_predecessor_in_that_sides_order(self) -> None:
        current = edit(BOARD, "the widget's twin row\n", "the widget's twin row\n- [ ] **#61 — from current**\n")
        incoming = edit(BOARD, "cached too long** — billing\n",
                        "cached too long** — billing\n- [ ] **#62 — from incoming**\n")
        merged, _ = merge(BOARD, current, incoming)
        order = [row.split("**")[1].split(" —")[0] for row in rows(merged) if "**" in row]
        self.assertEqual(order[:6], ["#41", "example-org/example-repo#42", "#61", "#42", "#62",
                                     "Rename the export job"])

    def test_a_new_row_at_the_start_of_a_section_stays_there(self) -> None:
        incoming = edit(BOARD, "## Done\n\n", "## Done\n\n- [x] **#63 — shipped first**\n")
        current = edit(BOARD, "Retire the old importer", "Retire the importer")
        merged, _ = merge(BOARD, current, incoming)
        self.assertEqual(merged.splitlines()[-3:], ["", "- [x] **#63 — shipped first**",
                                                    "- [x] **#30 — Retire the importer**"])

    def test_a_move_between_sections_on_one_side_lands_beside_an_edit_on_the_other(self) -> None:
        row = "- [ ] **#41 — Fix the invoice rounding** — billing, added 2026-01-02\n"
        moved = edit(edit(BOARD, row, ""), "## Done\n\n", "## Done\n\n" + row.replace("[ ]", "[x]"))
        changed = edit(BOARD, "no ticket yet", "ticket soon")
        for current, incoming in ((moved, changed), (changed, moved)):
            merged, outcome = merge(BOARD, current, incoming)
            self.assertEqual(section_of(merged, "#41 —"), "Done")
            self.assertIn("ticket soon", merged)
            self.assertEqual(merged.count("#41 —"), 1)
            self.assertEqual(outcome.notes, [])

    def test_a_move_on_one_side_and_a_text_edit_on_the_other_combine(self) -> None:
        row = "- [ ] **#41 — Fix the invoice rounding** — billing, added 2026-01-02\n"
        moved = edit(edit(BOARD, row, ""), "## Next\n\n", "## Next\n\n" + row)
        changed = edit(BOARD, "billing, added", "billing and tax, added")
        for current, incoming in ((moved, changed), (changed, moved)):
            merged, outcome = merge(BOARD, current, incoming)
            self.assertEqual(section_of(merged, "#41 —"), "Next")
            self.assertIn("billing and tax", merged)
            self.assertEqual(merged.count("#41 —"), 1)
            self.assertEqual(outcome.notes, [])

    def test_a_row_moved_to_different_sections_on_each_side_keeps_both_annotated(self) -> None:
        row = "- [ ] **#41 — Fix the invoice rounding** — billing, added 2026-01-02\n"
        to_next = edit(edit(BOARD, row, ""), "## Next\n\n", "## Next\n\n" + row)
        to_done = edit(edit(BOARD, row, ""), "## Done\n\n", "## Done\n\n" + row)
        merged, outcome = merge(BOARD, to_next, to_done)
        self.assertEqual(merged.count("#41 —"), 2)
        self.assertIn(ANNOTATION, merged)
        self.assertEqual(len(outcome.notes), 1)


class RetitledRowTests(merge_support.IsolatedGitTestCase):
    RETITLED = edit(BOARD, "**Rename the export job**", "**Rename the nightly export job**")

    def test_a_retitle_and_an_edit_of_the_same_row_are_flagged_not_silently_duplicated(self) -> None:
        incoming = edit(BOARD, "no ticket yet", "waiting on billing")
        for current, other in ((self.RETITLED, incoming), (incoming, self.RETITLED)):
            merged, outcome = merge(BOARD, current, other)
            self.assertEqual(sum("export job" in row for row in rows(merged)), 2)
            self.assertIn(ANNOTATION, merged)
            self.assertEqual(len(outcome.notes), 1)

    def test_a_retitle_alone_replaces_the_row(self) -> None:
        incoming = edit(BOARD, "Archive old invoices", "Archive invoices")
        merged, _ = merge(BOARD, self.RETITLED, incoming)
        self.assertEqual([row for row in rows(merged) if "export job" in row],
                         ["- [ ] **Rename the nightly export job** — no ticket yet"])

    def test_a_retitled_row_deleted_on_the_other_side_keeps_the_retitled_one(self) -> None:
        deleted = edit(BOARD, "- [ ] **Rename the export job** — no ticket yet\n", "")
        merged, _ = merge(BOARD, deleted, self.RETITLED)
        self.assertIn("Rename the nightly export job", merged)
        self.assertNotIn(ANNOTATION, merged)

    def test_a_retitled_heading_keeps_its_rows_where_they_are(self) -> None:
        current = edit(BOARD, "## Next", "## Next quarter")
        incoming = edit(BOARD, "  - second point", "  - second point, agreed")
        merged, outcome = merge(BOARD, current, incoming)
        self.assertEqual(section_of(merged, "#50 —"), "Next quarter")
        self.assertIn("second point, agreed", merged)
        self.assertEqual(merged.count("## Next"), 1)
        self.assertEqual(outcome.notes, [])


class ReplacedRowTests(merge_support.IsolatedGitTestCase):
    """A side that deleted one row and put another in its place deleted a row and added one; the
    other side's move or edit of the deleted row stays with that row."""

    ROW_41 = "- [ ] **#41 — Fix the invoice rounding** — billing, added 2026-01-02\n"
    ROW_42 = "- [ ] **#42 — Totals are cached too long** — billing\n"
    NEW_12 = "- [ ] **#12 — Export to CSV** — reporting\n"
    NEW_13 = "- [ ] **#13 — Export to PDF** — reporting\n"

    def assertBothRows(self, merged: str, outcome: Outcome, old: str, old_section: str,
                       new: str, new_section: str) -> None:
        self.assertEqual(merged.count(old), 1, merged)
        self.assertEqual(section_of(merged, old.rstrip("\n")), old_section, merged)
        self.assertEqual(merged.count(new), 1, merged)
        self.assertEqual(section_of(merged, new.rstrip("\n")), new_section, merged)
        self.assertNotIn(ANNOTATION, merged)
        self.assertEqual(outcome.notes, [])

    def both_orientations(self, one: str, other: str) -> List[Tuple[str, Outcome]]:
        return [merge(BOARD, one, other), merge(BOARD, other, one)]

    def test_a_ticket_replaced_on_one_side_and_moved_on_the_other_keeps_both_tickets(self) -> None:
        replaced = edit(BOARD, self.ROW_41, self.NEW_12)
        moved = edit(edit(BOARD, self.ROW_41, ""), "## Next\n\n", "## Next\n\n" + self.ROW_41)
        for merged, outcome in self.both_orientations(replaced, moved):
            self.assertBothRows(merged, outcome, self.ROW_41, "Next", self.NEW_12, "Now")

    def test_a_ticket_replaced_in_the_middle_of_a_section_and_moved_on_the_other_side(self) -> None:
        replaced = edit(BOARD, self.ROW_42, self.NEW_12)
        moved = edit(edit(BOARD, self.ROW_42, ""), "## Done\n\n", "## Done\n\n" + self.ROW_42)
        for merged, outcome in self.both_orientations(replaced, moved):
            self.assertBothRows(merged, outcome, self.ROW_42, "Done", self.NEW_12, "Now")

    def test_a_ticket_replaced_by_two_new_ones_and_moved_on_the_other_side(self) -> None:
        replaced = edit(BOARD, self.ROW_41, self.NEW_12 + self.NEW_13)
        moved = edit(edit(BOARD, self.ROW_41, ""), "## Next\n\n", "## Next\n\n" + self.ROW_41)
        for merged, outcome in self.both_orientations(replaced, moved):
            self.assertBothRows(merged, outcome, self.ROW_41, "Next", self.NEW_12, "Now")
            self.assertEqual(section_of(merged, self.NEW_13.rstrip("\n")), "Now")

    def test_a_ticket_replaced_on_one_side_and_edited_on_the_other_keeps_the_edit(self) -> None:
        replaced = edit(BOARD, self.ROW_41, self.NEW_12)
        edited_row = self.ROW_41.replace("billing,", "billing and tax,")
        edited = edit(BOARD, self.ROW_41, edited_row)
        for merged, outcome in self.both_orientations(replaced, edited):
            self.assertBothRows(merged, outcome, edited_row, "Now", self.NEW_12, "Now")

    def test_a_row_without_a_ticket_replaced_by_a_ticket_keeps_both(self) -> None:
        plain = "- [ ] **Rename the export job** — no ticket yet\n"
        replaced = edit(BOARD, plain, self.NEW_12)
        moved = edit(edit(BOARD, plain, ""), "## Next\n\n", "## Next\n\n" + plain)
        for merged, outcome in self.both_orientations(replaced, moved):
            self.assertBothRows(merged, outcome, plain, "Next", self.NEW_12, "Now")

    def test_a_ticket_replaced_by_a_row_without_one_keeps_both(self) -> None:
        plain = "- [ ] **Write the import guide** — no ticket yet\n"
        replaced = edit(BOARD, self.ROW_42, plain)
        moved = edit(edit(BOARD, self.ROW_42, ""), "## Next\n\n", "## Next\n\n" + self.ROW_42)
        for merged, outcome in self.both_orientations(replaced, moved):
            self.assertBothRows(merged, outcome, self.ROW_42, "Next", plain, "Now")

    def test_a_text_row_replaced_by_an_unrelated_one_keeps_both(self) -> None:
        plain = "- [ ] a plain row with no bold span at all\n"
        other = "- [ ] something entirely different\n"
        replaced = edit(BOARD, plain, other)
        moved = edit(edit(BOARD, plain, ""), "## Next\n\n", "## Next\n\n" + plain)
        for merged, outcome in self.both_orientations(replaced, moved):
            self.assertBothRows(merged, outcome, plain, "Next", other, "Now")

    def test_a_retitle_without_a_ticket_still_follows_a_move_on_the_other_side(self) -> None:
        plain = "- [ ] **Rename the export job** — no ticket yet\n"
        retitled = plain.replace("the export job", "the nightly export job")
        changed = edit(BOARD, plain, retitled)
        moved = edit(edit(BOARD, plain, ""), "## Next\n\n", "## Next\n\n" + plain)
        for merged, outcome in self.both_orientations(changed, moved):
            self.assertEqual(sum("export job" in row for row in rows(merged)), 1, merged)
            self.assertEqual(section_of(merged, "nightly export job"), "Next")
            self.assertEqual(outcome.notes, [])

    def test_an_inbox_entry_replaced_on_one_side_and_edited_on_the_other_keeps_both(self) -> None:
        start, end = INBOX.index("<!-- session:aaaa-1111"), INBOX.index("<!-- session:bbbb")
        new ="<!-- session:cccc-3333 -->\n## 2026-01-07 · 1 commit\n\n- `1111111` one\n<!-- /session -->\n\n"
        replaced = INBOX[:start] + new + INBOX[end:]
        edited = edit(INBOX, "fix(billing): round once", "fix(billing): round once, per line")
        for one, other in ((replaced, edited), (edited, replaced)):
            merged, outcome = merge(INBOX, one, other)
            self.assertIn("round once, per line", merged)
            self.assertIn("session:aaaa-1111", merged)
            self.assertIn("session:cccc-3333", merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])

    def test_an_action_for_one_ticket_replaced_by_another_keeps_the_edited_one(self) -> None:
        start, end = ACTIONS.index("### #41"), ACTIONS.index("### #42")
        new = "### #43: rotate the certificates\n\nRenew them before the end of the month.\n\n"
        replaced = ACTIONS[:start] + new + ACTIONS[end:]
        edited = edit(ACTIONS, "Run the invoice report.", "Run the invoice report for January.")
        for one, other in ((replaced, edited), (edited, replaced)):
            merged, outcome = merge(ACTIONS, one, other)
            self.assertIn("for January", merged)
            self.assertIn("### #41: check the rounding", merged)
            self.assertIn("### #43: rotate the certificates", merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])

    def test_the_command_git_runs_keeps_the_moved_ticket(self) -> None:
        base = "## Now\n- [ ] **#10** ship login\n\n## Next\n- [ ] **#11** rate limits\n- [ ] **#13** audit log\n\n## Done\n"
        alice = edit(base, "- [ ] **#11** rate limits\n", "- [ ] **#12** export to CSV\n")
        bob = edit(edit(base, "- [ ] **#11** rate limits\n", ""), "ship login\n", "ship login\n- [ ] **#11** rate limits\n")
        for current, incoming in ((alice, bob), (bob, alice)):
            paths = [self.home / name for name in ("O", "A", "B")]
            for path, text in zip(paths, (base, current, incoming)):
                path.write_text(text, encoding="utf-8")
            done = subprocess.run([str(merge_support.COMMAND), "keyed", *map(str, paths), "To DO.md"],
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            merged = paths[1].read_text(encoding="utf-8")
            self.assertEqual(section_of(merged, "**#11** rate limits"), "Now", merged)
            self.assertEqual(section_of(merged, "**#12** export to CSV"), "Next", merged)
            self.assertEqual(merged.count("#11"), 1)
            self.assertNotIn(ANNOTATION, merged)


class TicketGainedOrLostTests(merge_support.IsolatedGitTestCase):
    """A row or an action rewritten in place to gain a ticket (or to drop one) is the same row: a
    move or an edit of it on the other side lands on the rewritten one, not beside it."""

    PLAIN = "- [ ] **Rename the export job** — no ticket yet\n"
    GAINED = "- [ ] **#55 — Rename the export job** — no ticket yet\n"
    TICKETED = "- [ ] **#42 — Totals are cached too long** — billing\n"
    LOST = "- [ ] **Totals are cached too long** — billing\n"
    STEPS = "  - draft the new name\n  - tell the team\n"
    PLANNED = edit(edit(BOARD, PLAIN, ""), "## Done\n", "## Later\n\n" + PLAIN + "\n## Done\n")
    ACTIONS_DONE = ACTIONS.replace(
        "## Open\n\n", "## Open\n\n### Rotate the certificates\n\nRenew them before they expire.\n\n", 1
    ) + "\n## Done\n\n### #30: retire the old importer\n\nRemoved.\n"

    def move(self, text: str, row: str, heading: str) -> str:
        return edit(edit(text, row, ""), "## %s\n\n" % heading, "## %s\n\n%s" % (heading, row))

    def assertOneRow(self, merged: str, outcome: Outcome, needle: str, expected: str, section: str) -> None:
        self.assertEqual([row for row in rows(merged) if needle in row], [expected.rstrip("\n")], merged)
        self.assertEqual(section_of(merged, expected.rstrip("\n")), section, merged)
        self.assertNotIn(ANNOTATION, merged)
        self.assertEqual(outcome.notes, [])

    def test_a_row_that_gains_a_ticket_follows_a_move_on_the_other_side(self) -> None:
        gained = edit(self.PLANNED, self.PLAIN, self.GAINED)
        moved = self.move(self.PLANNED, self.PLAIN, "Next")
        for current, incoming in ((gained, moved), (moved, gained)):
            merged, outcome = merge(self.PLANNED, current, incoming)
            self.assertOneRow(merged, outcome, "Rename the export job", self.GAINED, "Next")

    def test_a_row_that_drops_its_ticket_follows_a_move_on_the_other_side(self) -> None:
        lost = edit(BOARD, self.TICKETED, self.LOST)
        moved = self.move(BOARD, self.TICKETED, "Done")
        for current, incoming in ((lost, moved), (moved, lost)):
            merged, outcome = merge(BOARD, current, incoming)
            self.assertOneRow(merged, outcome, "Totals are cached too long", self.LOST, "Done")

    def test_a_row_that_gains_a_ticket_keeps_an_edit_of_its_other_lines(self) -> None:
        base = edit(BOARD, self.PLAIN, self.PLAIN + self.STEPS)
        gained = edit(base, self.PLAIN, self.GAINED)
        edited = edit(base, "  - tell the team\n", "  - tell the team on Monday\n")
        for current, incoming in ((gained, edited), (edited, gained)):
            merged, outcome = merge(base, current, incoming)
            self.assertIn(self.GAINED + "  - draft the new name\n  - tell the team on Monday\n", merged)
            self.assertEqual(merged.count("Rename the export job"), 1, merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])

    def test_a_row_that_gains_a_ticket_and_a_retitle_on_the_other_side_are_flagged(self) -> None:
        gained = edit(BOARD, self.PLAIN, self.GAINED)
        retitled = edit(BOARD, "**Rename the export job**", "**Rename the nightly export job**")
        for current, incoming in ((gained, retitled), (retitled, gained)):
            merged, outcome = merge(BOARD, current, incoming)
            self.assertEqual(sum("export job" in row for row in rows(merged)), 2, merged)
            self.assertEqual(merged.count(ANNOTATION), 1, merged)
            self.assertEqual(len(outcome.notes), 1)

    def test_an_action_that_gains_a_ticket_keeps_an_edit_of_its_body(self) -> None:
        gained = edit(self.ACTIONS_DONE, "### Rotate the certificates", "### #43: rotate the certificates")
        edited = edit(self.ACTIONS_DONE, "Renew them before they expire.", "Renew them a week before they expire.")
        for current, incoming in ((gained, edited), (edited, gained)):
            merged, outcome = merge(self.ACTIONS_DONE, current, incoming)
            self.assertIn("### #43: rotate the certificates\n\nRenew them a week before they expire.\n", merged)
            self.assertEqual(merged.lower().count("rotate the certificates"), 1, merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])

    def test_an_action_that_gains_a_ticket_follows_a_move_on_the_other_side(self) -> None:
        block = "### Rotate the certificates\n\nRenew them before they expire.\n\n"
        gained = edit(self.ACTIONS_DONE, "### Rotate the certificates", "### #43: rotate the certificates")
        moved = edit(edit(self.ACTIONS_DONE, block, ""), "## Done\n\n", "## Done\n\n" + block)
        for current, incoming in ((gained, moved), (moved, gained)):
            merged, outcome = merge(self.ACTIONS_DONE, current, incoming)
            self.assertEqual(merged.lower().count("rotate the certificates"), 1, merged)
            self.assertEqual(section_of(merged, "### #43: rotate the certificates"), "Done", merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])

    def test_an_action_that_drops_its_ticket_keeps_an_edit_of_its_body(self) -> None:
        lost = edit(self.ACTIONS_DONE, "### #41: check the rounding", "### Check the rounding")
        edited = edit(self.ACTIONS_DONE, "Run the invoice report.", "Run the invoice report for January.")
        for current, incoming in ((lost, edited), (edited, lost)):
            merged, outcome = merge(self.ACTIONS_DONE, current, incoming)
            self.assertIn("### Check the rounding on the stand\n\nRun the invoice report for January.\n", merged)
            self.assertEqual(merged.lower().count("check the rounding"), 1, merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])

    def test_a_row_that_gains_a_ticket_after_a_deleted_neighbour_is_not_read_as_the_neighbour(self) -> None:
        pair = "- [ ] **Export the invoices** — no ticket yet\n- [ ] **Export the credit notes** — no ticket yet\n"
        base = edit(BOARD, "## Done\n\n", "## Done\n\n" + pair)
        gained = edit(base, pair, "- [ ] **#57 — Export the credit notes** — no ticket yet\n")
        edited = edit(base, "**Export the invoices** — no ticket yet", "**Export the invoices** — waiting on billing")
        for current, incoming in ((gained, edited), (edited, gained)):
            merged, outcome = merge(base, current, incoming)
            self.assertOneRow(merged, outcome, "Export the invoices",
                              "- [ ] **Export the invoices** — waiting on billing", "Done")
            self.assertOneRow(merged, outcome, "Export the credit notes",
                              "- [ ] **#57 — Export the credit notes** — no ticket yet", "Done")

    def test_a_row_that_gains_a_ticket_below_a_new_row_follows_a_move_on_the_other_side(self) -> None:
        added = "- [ ] **#58 — Import the price lists** — reporting\n"
        gained = edit(self.PLANNED, self.PLAIN, added + self.GAINED)
        moved = self.move(self.PLANNED, self.PLAIN, "Next")
        for current, incoming in ((gained, moved), (moved, gained)):
            merged, outcome = merge(self.PLANNED, current, incoming)
            self.assertOneRow(merged, outcome, "Rename the export job", self.GAINED, "Next")
            self.assertEqual(section_of(merged, "#58 — Import the price lists"), "Later", merged)

    def test_a_row_that_gains_a_ticket_below_a_row_moved_in_follows_a_move_on_the_other_side(self) -> None:
        arrived = "- [ ] **#41 — Fix the invoice rounding** — billing, added 2026-01-02\n"
        gained = edit(edit(self.PLANNED, arrived, ""), self.PLAIN, arrived + self.GAINED)
        moved = self.move(self.PLANNED, self.PLAIN, "Next")
        for current, incoming in ((gained, moved), (moved, gained)):
            merged, outcome = merge(self.PLANNED, current, incoming)
            self.assertOneRow(merged, outcome, "Rename the export job", self.GAINED, "Next")
            self.assertOneRow(merged, outcome, "#41 —", arrived, "Later")

    def test_a_row_that_gains_a_ticket_is_read_as_the_row_it_resembles_most(self) -> None:
        invoices = "- [ ] **Export the invoices** — no ticket yet\n"
        notes = "- [ ] **Export the credit notes** — no ticket yet\n"
        importer = "- [x] **#30 — Retire the old importer**\n"
        base = edit(BOARD, importer, invoices + importer + notes)
        gained = edit(edit(edit(base, invoices, ""), importer, ""), notes,
                      "- [ ] **#57 — Export the credit notes** — no ticket yet\n")
        gained = edit(gained, "## Next\n\n", "## Next\n\n" + importer)
        edited = edit(base, "**Export the invoices** — no ticket yet", "**Export the invoices** — waiting on billing")
        for current, incoming in ((gained, edited), (edited, gained)):
            merged, outcome = merge(base, current, incoming)
            self.assertOneRow(merged, outcome, "Export the invoices",
                              "- [ ] **Export the invoices** — waiting on billing", "Done")
            self.assertOneRow(merged, outcome, "Export the credit notes",
                              "- [ ] **#57 — Export the credit notes** — no ticket yet", "Done")
            self.assertOneRow(merged, outcome, "#30 —", importer, "Next")

    def test_a_closed_ticket_and_a_new_row_elsewhere_in_its_section_stay_two_rows(self) -> None:
        closed = "- [ ] **#44 — Fix the export job** — billing\n"
        opened = "- [ ] **Fix the import job** — no ticket yet\n"
        last = "- [ ] a plain row with no bold span at all\n"
        base = edit(BOARD, "## Now\n\n", "## Now\n\n" + closed)
        ours = edit(edit(base, closed, ""), last, last + opened)
        theirs = edit(edit(base, closed, ""), "## Done\n\n", "## Done\n\n" + closed)
        for current, incoming in ((ours, theirs), (theirs, ours)):
            merged, outcome = merge(base, current, incoming)
            self.assertOneRow(merged, outcome, "Fix the export job", closed, "Done")
            self.assertOneRow(merged, outcome, "Fix the import job", opened, "Now")

    def test_an_action_replaced_by_an_unrelated_ticket_still_keeps_both(self) -> None:
        replaced = edit(self.ACTIONS_DONE, "### Rotate the certificates\n\nRenew them before they expire.\n\n",
                        "### #44: purge the stale exports\n\nDelete the files older than a year.\n\n")
        edited = edit(self.ACTIONS_DONE, "Renew them before they expire.", "Renew them a week before they expire.")
        for current, incoming in ((replaced, edited), (edited, replaced)):
            merged, outcome = merge(self.ACTIONS_DONE, current, incoming)
            self.assertIn("### Rotate the certificates\n\nRenew them a week before they expire.\n", merged)
            self.assertIn("### #44: purge the stale exports", merged)
            self.assertNotIn(ANNOTATION, merged)
            self.assertEqual(outcome.notes, [])


class RepositoryAndRepeatedKeyTests(merge_support.IsolatedGitTestCase):
    TWO_PARTS = edit(BOARD, "## Done\n\n",
                     "## Done\n\n- [x] **#41 — first half shipped**\n- [x] **#41 — second half shipped**\n")

    def test_a_repo_qualified_row_is_not_the_bare_row_of_the_same_number(self) -> None:
        current = edit(BOARD, "the widget's twin row", "the widget's twin row, fixed")
        incoming = edit(BOARD, "cached too long** — billing", "cached too long** — billing, fixed")
        merged, outcome = merge(BOARD, current, incoming)
        self.assertIn("twin row, fixed", merged)
        self.assertIn("billing, fixed", merged)
        self.assertEqual(outcome.notes, [])

    def test_rows_of_two_repositories_added_on_each_side_are_both_kept_plainly(self) -> None:
        current = edit(BOARD, "## Next\n\n", "## Next\n\n- [ ] **example-org/example-repo#77 — widget side**\n")
        incoming = edit(BOARD, "## Next\n\n", "## Next\n\n- [ ] **#77 — platform side**\n")
        merged, outcome = merge(BOARD, current, incoming)
        self.assertIn("widget side", merged)
        self.assertIn("platform side", merged)
        self.assertNotIn(ANNOTATION, merged)
        self.assertEqual(outcome.notes, [])

    def test_a_row_added_among_rows_of_one_ticket_does_not_shift_them(self) -> None:
        current = edit(self.TWO_PARTS, "## Now\n\n", "## Now\n\n- [ ] **#41 — a third part**\n")
        incoming = edit(self.TWO_PARTS, "second half shipped**", "second half shipped** — verified")
        merged, outcome = merge(self.TWO_PARTS, current, incoming)
        self.assertEqual(merged, edit(current, "second half shipped**", "second half shipped** — verified"))
        self.assertEqual(outcome.notes, [])

    def test_a_row_removed_among_rows_of_one_ticket_does_not_shift_them(self) -> None:
        current = edit(self.TWO_PARTS, "- [x] **#41 — first half shipped**\n", "")
        incoming = edit(self.TWO_PARTS, "second half shipped**", "second half shipped** — verified")
        merged, outcome = merge(self.TWO_PARTS, current, incoming)
        self.assertEqual(merged, edit(current, "second half shipped**", "second half shipped** — verified"))
        self.assertEqual(outcome.notes, [])


class InboxTests(merge_support.IsolatedGitTestCase):
    @staticmethod
    def entry(session: str, line: str) -> str:
        return "\n<!-- session:%s -->\n## 2026-01-07 · 1 commit\n\n- %s\n<!-- /session -->\n" % (session, line)

    def test_entries_with_the_same_heading_are_told_apart_by_session(self) -> None:
        current = INBOX + self.entry("cccc-3333", "`1111111` one")
        incoming = INBOX + self.entry("dddd-4444", "`2222222` two")
        merged, outcome = merge(INBOX, current, incoming)
        self.assertIn("session:cccc-3333", merged)
        self.assertIn("session:dddd-4444", merged)
        self.assertEqual(merged.count("## 2026-01-07"), 2)
        self.assertEqual(outcome.notes, [])
        self.assertEqual(md.parse(merged).text(), merged)

    def test_an_entry_cleared_on_one_side_and_another_added_on_the_other(self) -> None:
        start, end = INBOX.index("<!-- session:aaaa-1111"), INBOX.index("<!-- session:bbbb")
        cleared = INBOX[:start] + INBOX[end:]
        added = INBOX + self.entry("cccc-3333", "`1111111` one")
        merged, _ = merge(INBOX, cleared, added)
        self.assertNotIn("aaaa-1111", merged)
        self.assertIn("bbbb-2222", merged)
        self.assertIn("cccc-3333", merged)


class TextAndBlockTests(merge_support.IsolatedGitTestCase):
    def test_edits_to_different_level_three_blocks_both_land(self) -> None:
        current = edit(ACTIONS, "Run the invoice report.", "Run the invoice report for January.")
        incoming = edit(ACTIONS, "Remove it by its id.", "Remove it by its exact id.")
        merged, outcome = merge(ACTIONS, current, incoming)
        self.assertIn("for January", merged)
        self.assertIn("exact id", merged)
        self.assertEqual(outcome.notes, [])

    def test_free_text_merges_line_wise(self) -> None:
        base = "# T\n\nline one\nline two\nline three\nline four\n"
        merged, outcome = merge(base, base.replace("line one", "line 1"), base.replace("line four", "line 4"))
        self.assertEqual(merged, "# T\n\nline 1\nline two\nline three\nline 4\n")
        self.assertEqual(outcome.notes, [])

    def test_a_free_text_conflict_keeps_both_annotated(self) -> None:
        base = "# T\n\nthe same line\n"
        for style in ("merge", "diff3", "zdiff3"):
            self.git_config("[merge]\n\tconflictStyle = %s\n" % style)
            merged, outcome = merge(base, base.replace("same", "current"), base.replace("same", "incoming"))
            self.assertEqual(merged, "# T\n\n%s\nthe current line\nthe incoming line\n" % ANNOTATION, style)
            self.assertEqual(len(outcome.notes), 1)

    def test_the_blank_line_after_a_deleted_row_is_not_doubled(self) -> None:
        current = edit(BOARD, "- [x] **#30 — Retire the old importer**\n", "")
        incoming = edit(BOARD, "no ticket yet", "ticket soon")
        merged, _ = merge(BOARD, current, incoming)
        self.assertEqual(merged, edit(current, "no ticket yet", "ticket soon"))


class LineEndingTests(merge_support.IsolatedGitTestCase):
    def test_a_crlf_board_merges_into_crlf(self) -> None:
        base = BOARD.replace("\n", "\r\n")
        current = edit(base, "billing, added", "billing (current), added")
        incoming = edit(base, "billing, added", "billing (incoming), added")
        merged, _ = merge(base, current, incoming)
        self.assertNotIn("\n", merged.replace("\r\n", ""))
        self.assertIn(ANNOTATION + "\r\n", merged)

    def test_rows_from_a_side_with_other_line_endings_take_the_current_sides(self) -> None:
        base = "## Now\r\n- a\r\n- b\r\n- c\r\n"
        current = base + "- e\r\n"
        incoming = "## Now\n- a\n- b\n- d\n- c\n"
        merged, _ = merge(base, current, incoming)
        self.assertEqual(merged, "## Now\r\n- a\r\n- b\r\n- d\r\n- c\r\n- e\r\n")
        merged, _ = merge(base.replace("\r\n", "\n"), current.replace("\r\n", "\n"), incoming.replace("\n", "\r\n"))
        self.assertEqual(merged, "## Now\n- a\n- b\n- d\n- c\n- e\n")

    def test_a_side_that_only_converted_line_endings_changed_no_row(self) -> None:
        base = BOARD.replace("\n", "\r\n")
        current = edit(base, "billing, added", "billing (current), added")
        incoming = edit(BOARD, "cached too long", "cached far too long")
        merged, outcome = merge(base, current, incoming)
        self.assertEqual(merged, edit(current, "cached too long", "cached far too long"))
        self.assertEqual(outcome.notes, [])
        current = edit(base, "second point", "second point, sharpened")
        merged, outcome = merge(base, current, incoming)
        self.assertEqual(merged, edit(current, "cached too long", "cached far too long"))
        self.assertEqual(outcome.notes, [], "a row whose lines only changed their endings was taken for an edit")

    def test_a_row_appended_to_a_file_without_a_final_newline(self) -> None:
        base = BOARD.rstrip("\n")
        current = edit(base, "rounding**", "rounding again**")
        incoming = base + "\n- [x] **#31 — appended**"
        merged, _ = merge(base, current, incoming)
        self.assertEqual(merged, current + "\n- [x] **#31 — appended**")

    def test_a_final_newline_added_on_one_side_is_kept(self) -> None:
        base = BOARD.rstrip("\n")
        merged, _ = merge(base, edit(base, "rounding**", "rounding again**"), base + "\n")
        self.assertTrue(merged.endswith("importer**\n"))


class RandomBoardTests(merge_support.IsolatedGitTestCase):
    """Seeded random edits on both sides of a board of rows with and without a ticket, a row without
    one sometimes rewritten in place to gain one: no row a side kept and changed is lost, a row only
    one side moved lands where that side put it, every new row is kept, a row shows twice only as
    two versions of itself, and two versions are only ever two versions of one row."""

    SECTIONS = ("Now", "Next", "Later", "Done")
    UNTICKETED = re.compile(r"\*\*(?:#\d+ — )?Base task (\d+)\*\*")
    TICKET = re.compile(r"\*\*#(\d+)\*\*")
    GAINED_FROM = {"A": 300, "B": 400}

    @classmethod
    def render(cls, board: Dict[str, List[str]]) -> str:
        return "".join("## %s\n%s\n" % (name, "".join(row + "\n" for row in board[name])) for name in cls.SECTIONS)

    def side(self, rng: random.Random, base: Dict[str, List[str]], who: str, first_new: int
             ) -> Tuple[Dict[str, List[str]], Dict[str, Set[int]]]:
        board = {name: list(rows) for name, rows in base.items()}
        did: Dict[str, Set[int]] = {"changed": set(), "moved": set(), "deleted": set(), "added": set()}
        touched: Set[int] = set()
        for step in range(rng.randint(1, 4)):
            name = rng.choice(self.SECTIONS)
            here = board[name]
            new = "- [ ] **#%d** new by %s" % (first_new + step, who)
            op = rng.choice(("add", "edit", "delete", "move", "replace", "ticket"))
            if op == "add":
                here.insert(rng.randint(0, len(here)), new)
                did["added"].add(first_new + step)
                continue
            candidates = [at for at, row in enumerate(here) if self.number(row) not in touched
                          and self.number(row) < 100 and (op != "ticket" or "**Base task" in row)]
            if not candidates:
                continue
            at = rng.choice(candidates)
            ticket = self.number(here[at])
            touched.add(ticket)
            if op == "edit":
                here[at] += " (edited by %s)" % who
                did["changed"].add(ticket)
            elif op == "ticket":
                here[at] = here[at].replace("**Base task", "**#%d — Base task" % (self.GAINED_FROM[who] + ticket))
                did["changed"].add(ticket)
            elif op == "delete":
                del here[at]
                did["deleted"].add(ticket)
            elif op == "replace":
                here[at] = new
                did["deleted"].add(ticket)
                did["added"].add(first_new + step)
            else:
                row = here.pop(at)
                target = board[rng.choice([other for other in self.SECTIONS if other != name])]
                target.insert(rng.randint(0, len(target)), row)
                did["changed"].add(ticket)
                did["moved"].add(ticket)
        return board, did

    def number(self, row: str) -> int:
        """The row's identity: the task number of a row that had no ticket at the base (whether or
        not it gained one since), else its ticket."""
        found = self.UNTICKETED.search(row) or self.TICKET.search(row)
        assert found, row
        return int(found.group(1))

    def sections_of(self, text: str) -> Dict[int, List[str]]:
        found: Dict[int, List[str]] = {}
        heading = ""
        for line in text.splitlines():
            if line.startswith("## "):
                heading = line[3:]
            elif line.startswith("- "):
                found.setdefault(self.number(line), []).append(heading)
        return found

    def test_random_edits_on_both_sides_lose_no_ticket(self) -> None:
        for seed in range(600):
            rng = random.Random(seed)
            count = 0
            base: Dict[str, List[str]] = {}
            for name in self.SECTIONS:
                base[name] = []
                for _ in range(rng.randint(1, 3)):
                    count += 1
                    base[name].append("- [ ] **#%d** base task %d" % (count, count) if rng.random() < 0.5
                                      else "- [ ] **Base task %d** — no ticket yet" % count)
            current, mine = self.side(rng, base, "A", 100)
            incoming, theirs = self.side(rng, base, "B", 200)
            merged, _ = merge(self.render(base), self.render(current), self.render(incoming))
            where = self.sections_of(merged)
            context = "seed %d\n%s" % (seed, merged)

            for ticket in set(range(1, count + 1)) - mine["deleted"] - theirs["deleted"]:
                self.assertIn(ticket, where, context)
            for did, other, board in ((mine, theirs, current), (theirs, mine, incoming)):
                for ticket in did["changed"] | did["added"]:
                    self.assertIn(ticket, where, context)
                for ticket in did["moved"] - other["moved"]:
                    self.assertEqual(where[ticket], [self.sections_of(self.render(board))[ticket][0]], context)
            lines = merged.splitlines()
            twins: Counter = Counter()
            for at, line in enumerate(lines):
                if line == ANNOTATION:
                    self.assertEqual(self.number(lines[at - 1]), self.number(lines[at + 1]), context)
                    twins[self.number(lines[at - 1])] += 1
            for ticket, found in where.items():
                self.assertEqual(len(found), 1 + twins[ticket], context)


class OrientationTests(merge_support.IsolatedGitTestCase):
    """Under a rebase the two sides swap; a merge without a conflict gives the same file either way."""

    def test_swapping_the_sides_gives_the_same_file(self) -> None:
        current = edit(edit(BOARD, "billing, added", "billing and tax, added"),
                       "## Next\n\n", "## Next\n\n- [ ] **#64 — from current**\n")
        incoming = edit(edit(BOARD, "- [ ] a plain row with no bold span at all\n", ""),
                        "## Done\n\n", "## Done\n\n- [x] **#65 — from incoming**\n")
        one, _ = merge(BOARD, current, incoming)
        other, _ = merge(BOARD, incoming, current)
        self.assertEqual(Counter(one.splitlines()), Counter(other.splitlines()))
        self.assertEqual(one, other)


if __name__ == "__main__":
    unittest.main()
