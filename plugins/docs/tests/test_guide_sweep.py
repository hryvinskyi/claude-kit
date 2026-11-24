"""Runs the user guide's sweep over small guides and checks what it lists."""
import pathlib
import subprocess
import sys
import tempfile
import unittest

SWEEP = pathlib.Path(__file__).resolve().parents[1] / "skills/user-guide/scripts/guide_sweep.py"


def run(text: str, *arguments: str) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as directory:
        guide = pathlib.Path(directory) / "guide.md"
        guide.write_text(text, encoding="utf-8")
        return subprocess.run([sys.executable, str(SWEEP), str(guide), *arguments], capture_output=True, text=True)


class GuideSweepTest(unittest.TestCase):
    def test_a_guide_from_the_readers_side_has_nothing_to_read(self) -> None:
        result = run("# Guide\n\n## Invite a colleague\n\n1. Choose **Team** > **Members**.\n2. Click **Send invitation**.\n")
        self.assertEqual(0, result.returncode)
        self.assertIn("0 place(s) to read", result.stdout)

    def test_each_class_is_listed_with_its_line(self) -> None:
        result = run(
            "# Guide\n\n"
            "Ask whoever runs the installation.\n\n"                      # 3 another reader
            "A member with no token does not see the form.\n\n"           # 5 what other people see
            "The menu used to say Saved replies.\n\n"                     # 7 history
            "The list now has two groups.\n\n"                            # 9 a clock
            "The setting is not enforced by anything.\n\n"                # 11 not available (and the inside view)
            "This is deliberate.\n\n"                                     # 13 a design defended
            "The export runs as a background job.\n\n"                    # 15 the inside view
            "You need `team.members.invite`.\n\n"                         # 17 an identifier
            "![The screen. It shows the previous layout.](a.png)\n"       # 19 a distrusted picture
        )
        for name, line in (("another reader", 3), ("what other people see", 5), ("history", 7), ("a word with a clock", 9),
                           ("not available", 11), ("a design defended", 13), ("the inside view", 15), ("an identifier", 17),
                           ("a picture the page distrusts", 19)):
            section = result.stdout.split("\n" + name + " (", 1)
            self.assertEqual(2, len(section), "the class %r is not listed:\n%s" % (name, result.stdout))
            self.assertIn("  %d: " % line, section[1].split("\n\n", 1)[0])

    def test_the_document_history_and_fenced_code_are_left_out(self) -> None:
        result = run(
            "# Guide\n\n```\nthe queue used to be refused now\n```\n\n"
            "## Document history\n\n| 1.4 | Saved replies were renamed and are no longer shown. |\n"
        )
        self.assertIn("0 place(s) to read", result.stdout)

    def test_a_role_named_as_out_of_reach_is_listed_wherever_it_stands(self) -> None:
        result = run("# Guide\n\nThe steps are for Acme staff.\n\nAsk the Acme Staff.\n", "--other-reader", "Acme staff")
        self.assertIn("a reader named as out of reach (2)", result.stdout)

    def test_a_unit_that_holds_too_much_is_listed(self) -> None:
        result = run("# Guide\n\n" + " ".join(["word"] * 120) + ".\n\n- " + " ".join(["item"] * 70) + "\n\n| A | " + " ".join(["cell"] * 50) + " |\n")
        self.assertIn("a paragraph of 120 words", result.stdout)
        self.assertIn("a list item of 70 words", result.stdout)
        self.assertIn("a table cell of 50 words", result.stdout)

    def test_a_missing_file_is_an_error(self) -> None:
        result = subprocess.run([sys.executable, str(SWEEP), "/nonexistent/guide.md"], capture_output=True, text=True)
        self.assertEqual(2, result.returncode)
        self.assertIn("no such file", result.stderr)


if __name__ == "__main__":
    unittest.main()
