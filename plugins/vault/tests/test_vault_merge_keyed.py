#!/usr/bin/env python3
"""Tests for the keyed merge driver and the block reader beneath it (bin/vault_merge/).

Pinned: how a document is cut into blocks and keyed (an issue reference with its repository, a bold
span, leading text, an inbox entry's session, a level-three block, repeated keys numbered); that
writing a document back gives its bytes (CRLF, no final newline, trailing spaces); and every three-way
case of the merge, in base/current/incoming terms: one side, both sides alike or differently,
deletions against edits, additions on both sides, section moves, retitled rows without a ticket,
repeated keys, inbox entries, free text, line endings — and that swapping the sides keeps the same
rows. Fixtures are synthetic.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import unittest
from collections import Counter
from typing import List, Tuple

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
