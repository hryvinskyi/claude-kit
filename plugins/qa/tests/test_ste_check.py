#!/usr/bin/env python3
"""Tests for skills/tighten/scripts/ste_check.py, run as the tighten skill runs it: the script as a
subprocess, the text on standard input or in a file.

What is pinned: the 25-word limit of a sentence and the 20-word limit under --procedure; a sentence of
21 to 25 words reported for review only when it sits in a numbered item or starts with a command, in
English and in Ukrainian; the six-sentence limit of a paragraph and of a list item; a semicolon as a
fix in every profile; the word count of a code span, a link, a link address, a quotation, text in
parentheses and a hyphenated word; text in parentheses measured as a sentence of its own; the line
above a vertical list ending its sentence; fenced code, front matter, headings, tables, HTML comments,
link definitions and key-value lines left out; the line number of each finding; abbreviations, version
numbers and file names not ending a sentence; text written without capitals split at its full stops; in
English, contractions as a fix in standard and strict but not in light, verb forms and inflated words
for review, a participle used as an adjective left alone, and the dictionary entries and "-ing" forms
that only strict reports; a text that is not English measured against the limits only; the first and
last lines of the report; the same word total for a code span and a link address in a source and in
its rewrite; exit status 0 for a printed report whatever it holds, 1 for a fix line only under --gate,
and 2 for input that cannot be used.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import List

SCRIPT = Path(__file__).resolve().parent.parent / "skills" / "tighten" / "scripts" / "ste_check.py"


def check(text: str, *options: str) -> "subprocess.CompletedProcess[bytes]":
    return subprocess.run([sys.executable, str(SCRIPT), *options], input=text.encode("utf-8"), capture_output=True)


def report(text: str, *options: str) -> str:
    return check(text, *options).stdout.decode("utf-8")


def findings(text: str, *options: str) -> List[str]:
    """The finding lines of the report: all but its first and its last line."""
    return report(text, *options).splitlines()[1:-1]


def sentence(count: int, first: str = "The", filler: str = "valve") -> str:
    """A sentence of exactly `count` words."""
    return " ".join([first] + [filler] * (count - 1)) + "."


class SentenceLimits(unittest.TestCase):
    def test_a_sentence_of_25_words_passes_and_one_of_26_is_a_fix(self) -> None:
        self.assertEqual(findings(sentence(25)), [])
        lines = findings(sentence(26))
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("fix "), lines[0])
        self.assertIn("long sentence, 26 words (the limit is 25, or 20 for an instruction)", lines[0])

    def test_procedure_sets_the_limit_of_every_sentence_to_20(self) -> None:
        self.assertEqual(findings(sentence(20), "--procedure"), [])
        lines = findings(sentence(21), "--procedure")
        self.assertEqual(len(lines), 1)
        self.assertIn("fix ", lines[0])
        self.assertIn("long sentence, 21 words (the limit is 20)", lines[0])

    def test_a_describing_sentence_between_21_and_25_words_is_not_reported(self) -> None:
        self.assertEqual(findings(sentence(23)), [])

    def test_a_command_between_21_and_25_words_is_for_review(self) -> None:
        lines = findings(sentence(22, first="Open"), "--lang", "en")
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("review"), lines[0])
        self.assertIn("22 words (the limit is 20 if this sentence gives an instruction)", lines[0])
        self.assertEqual(findings(sentence(22, first="Opening"), "--lang", "en"), [])

    def test_a_command_after_a_condition_or_a_sequence_word_is_for_review(self) -> None:
        after_condition = "If the queue is empty, restart " + " ".join(["worker"] * 16) + "."
        self.assertEqual(len(findings(after_condition, "--lang", "en")), 1)
        after_sequence_word = "Then restart " + " ".join(["worker"] * 20) + "."
        self.assertEqual(len(findings(after_sequence_word, "--lang", "en")), 1)
        self.assertEqual(findings("Then the " + " ".join(["worker"] * 20) + ".", "--lang", "en"), [])
        self.assertEqual(findings("If the queue is empty, the " + " ".join(["worker"] * 16) + ".", "--lang", "en"), [])

    def test_a_sentence_in_a_numbered_item_is_an_instruction(self) -> None:
        lines = findings("1. " + sentence(22))
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("review"), lines[0])
        self.assertEqual(findings("- " + sentence(22)), [])

    def test_a_ukrainian_command_between_21_and_25_words_is_for_review(self) -> None:
        command = "Відкрийте " + " ".join(["файл"] * 21) + "."
        lines = findings(command)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("review"), lines[0])
        self.assertEqual(findings("Система " + " ".join(["файл"] * 21) + "."), [])


class ParagraphLimits(unittest.TestCase):
    def test_six_sentences_pass_and_seven_are_a_fix(self) -> None:
        self.assertEqual(findings(" ".join([sentence(4)] * 6)), [])
        lines = findings(" ".join([sentence(4)] * 7))
        self.assertEqual(len(lines), 1)
        self.assertIn("fix ", lines[0])
        self.assertIn("long paragraph, 7 sentences (the limit is 6)", lines[0])

    def test_a_list_item_has_the_same_limit(self) -> None:
        lines = findings("- " + " ".join([sentence(4)] * 7))
        self.assertEqual(len(lines), 1)
        self.assertIn("long list item, 7 sentences", lines[0])

    def test_a_blank_line_starts_a_new_paragraph(self) -> None:
        self.assertEqual(findings(" ".join([sentence(4)] * 4) + "\n\n" + " ".join([sentence(4)] * 4)), [])


class Semicolons(unittest.TestCase):
    def test_a_semicolon_is_a_fix_in_every_profile(self) -> None:
        for profile in ("light", "standard", "strict"):
            lines = findings("The pump stops; the valve closes.", "--profile", profile)
            self.assertEqual(len(lines), 1, profile)
            self.assertIn("fix ", lines[0])
            self.assertIn("semicolon", lines[0])

    def test_a_semicolon_in_code_an_entity_or_a_quotation_is_not_prose(self) -> None:
        self.assertEqual(findings("Run `a; b` now.\n\n```\nx; y;\n```\n\nTom &amp; Jerry agree."), [])
        self.assertEqual(findings('The log says "stopped; restarting" at that time.'), [])


class WordCounts(unittest.TestCase):
    def test_a_code_span_counts_as_one_word(self) -> None:
        self.assertEqual(findings(sentence(24) + " Run `one two three four five six seven eight` now."), [])
        self.assertEqual(findings("The " + "valve " * 23 + "`a b c d e f`."), [])

    def test_a_link_counts_by_its_text_and_an_address_as_one_word(self) -> None:
        linked = "The " + "valve " * 22 + "[release guide](https://example.org/a/very/long/path?with=query)."
        self.assertEqual(findings(linked), [])
        bare = "The " + "valve " * 23 + "https://example.org/a."
        self.assertEqual(findings(bare), [])

    def test_a_quotation_counts_as_one_word(self) -> None:
        self.assertEqual(findings("The " + "valve " * 23 + '"one two three four five".'), [])
        self.assertEqual(findings("Кнопка " + "працює " * 23 + "«Зберегти всі зміни зараз»."), [])

    def test_text_in_parentheses_counts_as_one_word_of_its_sentence(self) -> None:
        self.assertEqual(findings("The " + "valve " * 23 + "(one two three four five six)."), [])

    def test_text_in_parentheses_is_measured_as_a_sentence_of_its_own(self) -> None:
        lines = findings("The valve closes (" + " ".join(["word"] * 26) + ").")
        self.assertEqual(len(lines), 1)
        self.assertIn("long text in parentheses, 26 words", lines[0])

    def test_a_call_written_with_parentheses_is_a_word_not_an_aside(self) -> None:
        self.assertEqual(findings("The " + "valve " * 23 + "close(valve)."), [])
        self.assertEqual(len(findings("The " + "valve " * 23 + "close(valve) again.")), 1)

    def test_a_hyphenated_word_counts_as_one_word(self) -> None:
        self.assertEqual(findings("The " + "valve " * 23 + "end-to-end-check."), [])

    def test_the_line_above_a_vertical_list_ends_its_sentence(self) -> None:
        text = "Do these " + "valve " * 14 + "steps:\n\n" + "\n".join("- " + sentence(8) for _ in range(3))
        self.assertEqual(findings(text), [])
        self.assertIn("4 sentences", report(text).splitlines()[0])


class Markdown(unittest.TestCase):
    def test_what_is_not_prose_is_skipped(self) -> None:
        long_line = " ".join(["word"] * 40) + "; x."
        text = "\n".join((
            "---", "description: " + long_line, "---",
            "# " + long_line,
            "",
            "Title " + long_line,
            "=====",
            "",
            "```sh", long_line, "```",
            "",
            "~~~", long_line, "~~~",
            "",
            "| a | b |", "|---|---|", "| " + long_line + " | c |",
            "",
            "a | b", "---|---", long_line + " | c",
            "",
            "<!-- " + long_line, long_line + " -->",
            "",
            "[guide]: https://example.org/" + "x" * 40 + " \"" + long_line + "\"",
            "",
            "The valve closes.",
        ))
        self.assertEqual(findings(text), [])
        self.assertIn("1 sentence, 1 paragraph, 3 words", report(text).splitlines()[0])

    def test_a_fence_inside_a_longer_fence_does_not_end_it(self) -> None:
        text = "````\n```\n" + " ".join(["word"] * 40) + "\n```\n````\n\nThe valve closes."
        self.assertEqual(findings(text), [])

    def test_key_value_lines_are_not_one_long_sentence(self) -> None:
        text = "\n".join(f"Key{index}: value number {index} of the block" for index in range(8))
        self.assertEqual(findings(text), [])
        self.assertEqual(len(findings(text + "; more")), 1)

    def test_a_quoted_block_is_measured(self) -> None:
        lines = findings("> " + sentence(26))
        self.assertEqual(len(lines), 1)
        self.assertIn("long sentence, 26 words", lines[0])

    def test_emphasis_marks_are_not_words(self) -> None:
        self.assertEqual(findings("The " + "valve " * 23 + "**closes**."), [])
        self.assertEqual(findings("* " + sentence(25)), [])

    def test_a_finding_names_the_line_of_its_sentence(self) -> None:
        text = "The valve opens.\nThe pump\nstarts. " + sentence(26) + "\n\n- one\n- two; three"
        lines = findings(text)
        self.assertEqual(len(lines), 2)
        self.assertIn("line 3: long sentence", lines[0])
        self.assertIn("line 6: semicolon", lines[1])

    def test_a_line_number_counts_the_front_matter(self) -> None:
        lines = findings("---\nname: x\n---\n\n" + sentence(26))
        self.assertIn("line 5:", lines[0])


class Sentences(unittest.TestCase):
    def count(self, text: str) -> int:
        return int(report(text).splitlines()[0].split(", ")[2].split()[0])

    def test_an_abbreviation_does_not_end_a_sentence(self) -> None:
        self.assertEqual(self.count("Use a queue, e.g. Redis, for the jobs. See Fig. 3 and No. 5 at 5 p.m. tomorrow."), 2)
        self.assertEqual(self.count("Додайте поля, напр. Назву, і т. д. Потім збережіть."), 2)

    def test_a_version_a_file_name_and_a_decimal_do_not_end_a_sentence(self) -> None:
        self.assertEqual(self.count("Node.js 22.3 reads config.yaml in v2.9.1 and later. Then it starts."), 2)

    def test_a_file_name_at_the_end_of_a_sentence_ends_it(self) -> None:
        self.assertEqual(self.count("Edit config.yaml. Then restart the worker."), 2)

    def test_a_sentence_can_end_inside_a_closing_mark(self) -> None:
        self.assertEqual(self.count('Click "Save." Then close the page. (This is an aside.) The end!'), 3)

    def test_text_without_capitals_is_split_at_its_full_stops(self) -> None:
        self.assertEqual(self.count("fixed it. pushed to staging. can u check"), 3)

    def test_an_ellipsis_before_a_small_letter_does_not_end_a_sentence(self) -> None:
        self.assertEqual(self.count("The worker waits... and then it stops. Next step."), 2)


class English(unittest.TestCase):
    def test_a_contraction_is_a_fix_in_standard_and_strict(self) -> None:
        for profile in ("standard", "strict"):
            lines = [line for line in findings("It's ready, and we don’t wait.", "--profile", profile) if "contraction" in line]
            self.assertEqual(len(lines), 2, profile)
            self.assertTrue(all(line.startswith("fix ") for line in lines))
            self.assertIn('"It\'s"', lines[0])
            self.assertIn('"don’t"', lines[1])

    def test_a_contraction_stays_in_light(self) -> None:
        self.assertEqual(findings("It's ready, and we don't wait.", "--profile", "light"), [])

    def test_a_possessive_is_not_a_contraction(self) -> None:
        self.assertEqual(findings("The user's file and the team's queue are ready."), [])

    def test_verb_forms_are_for_review(self) -> None:
        cases = {
            "The worker is running now.": 'progressive "is running"',
            "The team has deployed the fix.": 'perfect "has deployed"',
            "The worker must be restarted.": 'passive "must be restarted"',
            "The file was created by the worker.": 'passive "was created by"',
            "Clear the cache after restarting the worker.": '"-ing" form after a preposition "after restarting"',
        }
        for text, expected in cases.items():
            lines = findings(text)
            self.assertEqual(len(lines), 1, text)
            self.assertTrue(lines[0].startswith("review"), lines[0])
            self.assertIn(expected, lines[0])

    def test_one_verb_group_gives_one_line(self) -> None:
        self.assertEqual(len(findings("The worker has been running for a day.")), 1)

    def test_a_participle_as_an_adjective_and_an_ing_noun_are_left_alone(self) -> None:
        self.assertEqual(findings("The valve is closed. Something is missing. Deleting a workspace removes its files."), [])
        self.assertEqual(findings("Two hedges are padding. The usual words are WARNING and CAUTION."), [])

    def test_inflated_words_are_for_review(self) -> None:
        lines = findings("Utilize the tool prior to the test in order to save time.")
        self.assertEqual(len(lines), 3)
        self.assertTrue(all(line.startswith("review") for line in lines))
        self.assertIn('"Utilize": write "use"', lines[0])
        self.assertIn('"prior to": write "before"', lines[1])
        self.assertIn('"in order to": write "to"', lines[2])

    def test_strict_adds_the_dictionary_entries_and_every_ing_form(self) -> None:
        text = "Ensure that the valve is open. Wait about 10 minutes. Follow the safety instructions. Test the circuit. Deleting a file removes it."
        self.assertEqual(findings(text), [])
        lines = findings(text, "--profile", "strict")
        self.assertEqual(len(lines), 5)
        self.assertTrue(all(line.startswith("review") for line in lines))
        self.assertIn('write "make sure"', lines[0])
        self.assertIn('write "approximately"', lines[1])
        self.assertIn('write "obey" or "do"', lines[2])
        self.assertIn('write "do a test"', lines[3])
        self.assertIn('"-ing" form (strict: only in a technical name) "Deleting"', lines[4])

    def test_wording_inside_a_quotation_or_code_is_not_reported(self) -> None:
        self.assertEqual(findings('The page says "It\'s being utilized" and runs `don\'t`.'), [])


class OtherLanguages(unittest.TestCase):
    def test_a_ukrainian_text_is_measured_against_the_limits_only(self) -> None:
        text = "Система " + "працює " * 25 + "добре; it's running."
        lines = findings(text)
        self.assertEqual(len(lines), 2)
        self.assertIn("long sentence, 29 words", lines[0])
        self.assertIn("semicolon", lines[1])
        self.assertIn("not English (the limits only)", report(text).splitlines()[0])

    def test_the_language_can_be_given(self) -> None:
        text = "It's ready."
        self.assertEqual(len(findings(text, "--lang", "en")), 1)
        self.assertEqual(findings(text, "--lang", "other"), [])
        self.assertIn("English", report(text, "--lang", "en").splitlines()[0])


class Report(unittest.TestCase):
    def test_a_text_inside_the_limits(self) -> None:
        result = check("The pump supplies fuel to the engine when the switch is on. Thus the engine starts.")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.decode("utf-8").splitlines(), [
            "ste-check: standard profile, English, 2 sentences, 1 paragraph, 16 words",
            "result: inside the limits",
        ])
        self.assertEqual(result.stderr, b"")

    def test_a_printed_report_exits_0_whatever_it_holds(self) -> None:
        result = check("The worker is running now.")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.decode("utf-8").splitlines()[-1], "result: nothing to fix, 1 to review")
        result = check("The pump stops; the valve closes. The worker is running now.")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.decode("utf-8").splitlines()[-1], "result: 1 to fix, 1 to review")

    def test_gate_exits_1_for_a_fix_line_and_0_for_review_lines(self) -> None:
        self.assertEqual(check("The pump stops; the valve closes.", "--gate").returncode, 1)
        self.assertEqual(check("The worker is running now.", "--gate").returncode, 0)
        self.assertEqual(check("The valve closes.", "--gate").returncode, 0)

    def test_the_word_total_counts_a_code_span_and_an_address_as_one_word(self) -> None:
        text = "Run `bin/console cache:clear --env=prod` and read https://example.org/a/b now."
        self.assertIn("1 sentence, 1 paragraph, 6 words", report(text).splitlines()[0])

    def test_a_text_with_no_prose_is_inside_the_limits(self) -> None:
        result = check("# Only a heading\n\n```\ncode\n```\n")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.decode("utf-8").splitlines(), [
            "ste-check: standard profile, not English (the limits only), 0 sentences, 0 paragraphs, 0 words",
            "result: inside the limits",
        ])

    def test_the_text_can_come_from_a_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "guide.md"
            path.write_text("# Guide\n\n" + sentence(26) + "\n", encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "--profile", "light", str(path)], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("line 3: long sentence, 26 words", result.stdout.decode("utf-8"))

    def test_a_file_that_cannot_be_read_exits_2_and_prints_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(SCRIPT), str(Path(directory) / "absent.md")], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"ste_check.py:", result.stderr)

    def test_input_that_is_not_utf_8_exits_2(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT)], input=b"\xff\xfe\xff", capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")

    def test_an_unknown_profile_exits_2(self) -> None:
        result = check("The valve closes.", "--profile", "loose")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
