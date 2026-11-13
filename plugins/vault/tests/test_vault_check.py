#!/usr/bin/env python3
"""Tests for bin/vault_check.py.

Pinned: which code spans count as a class or a path, and that a path counts only when it is about the
repository (its first segment exists at the root or in the note's package); which notes are living;
that a vault is held to the dated decision template only when its records keep it, so a numbered-ADR
vault is not flooded with findings; that links resolve as Obsidian resolves them; and, against a real
throwaway project whose vault the project does not version, that a vanished class is hard while a
class that exists as a word in code or under vendor/ is not, that an ignored path is never a finding,
that the stamps live outside the project, and that a changed file flags the note until it is stamped;
that a note-base rule, from the vault's git config or the user's rule file, adds a package layout
while a rule that does not parse is reported and skipped; and that stamps are taken against the
default branch, so a branch without a cited file resets no stamp and is told softly what it removed,
two branches never turn a note soft for each other, a note reviewed on a branch is current once it
merges, a stamp at a commit the clone lacks is still judged by its blob, and only the default branch
moving (as the remote has it) turns a note soft.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"
sys.path.insert(0, str(BIN))
import vault_check as vc  # noqa: E402
import vaultlib  # noqa: E402

# A process that takes a lock, says so, and keeps it until its standard input closes.
HOLDER = """
import sys
sys.path.insert(0, sys.argv[1])
import vaultlib
from pathlib import Path
held = vaultlib.claim(Path(sys.argv[2]))
print("held" if held else "busy", flush=True)
sys.stdin.read()
"""


class SpanTests(unittest.TestCase):
    def test_a_span_names_the_class_it_cites(self) -> None:
        self.assertEqual(vc.span_name("AgentCase::answered()"), "AgentCase")
        self.assertEqual(vc.span_name("LlmTextEmbedder:48"), "LlmTextEmbedder")
        self.assertEqual(vc.span_name("DbalVectorStore.php"), "DbalVectorStore")
        self.assertEqual(vc.span_name("Vendor\\Module\\Model\\ConsentSync"), "ConsentSync")

    def test_a_span_that_is_not_a_class_names_nothing(self) -> None:
        for span in ("\\DateTimeImmutable", "new ContactsList()", "Resolution", "SELECT", "example.view"):
            self.assertIsNone(vc.span_name(span), span)

    def test_path_shaped_spans_are_collected_and_placeholders_are_not(self) -> None:
        self.assertEqual(vc.span_path("packages/crm/src/X.php:48"), "packages/crm/src/X.php")
        self.assertEqual(vc.span_path("etc/settings.ini"), "etc/settings.ini")
        self.assertEqual(vc.span_path("text/plain"), "text/plain")  # shaped like one; the repository decides
        for span in ("packages/{module}/src", "modules/*/Api", "https://example.com/x", "@scope/pkg", "a / b"):
            self.assertIsNone(vc.span_path(span), span)

    def test_a_path_with_a_member_is_read_as_its_path_and_the_member(self) -> None:
        for span, member in (("packages/crm/src/X.php::read", "read"), ("packages/crm/src/X.php::read()", "read"),
                             ("packages/crm/src/X.php::read(int $id)", "read"), ("src/X.php::$items", "items"),
                             ("src/X::LIMIT", "LIMIT")):
            self.assertEqual(vc.span_path(span), span.split("::", 1)[0], span)
            self.assertEqual(vc.span_member(span), member, span)
            self.assertIsNone(vc.span_name(span), span)
        self.assertIsNone(vc.span_member("packages/crm/src/X.php:48"))
        cited = vc.citations("Reads `src/X.php::read()` and `src/X.php`.\n")
        self.assertEqual(sorted(cited.paths), ["src/X.php"])
        self.assertEqual(sorted(cited.members), [("src/X.php", "read")])


class ScopeTests(unittest.TestCase):
    def test_a_path_is_about_the_repository_only_when_its_first_segment_exists(self) -> None:
        entries = {"packages", "scripts", ".claude"}
        exists = {"modules/Acme/Catalog/etc"}.__contains__
        self.assertEqual(vc.homes_of("scripts/x.py", [], entries, exists), [""])
        self.assertEqual(vc.homes_of("Scripts/x.py", [], entries, exists), [""])
        self.assertEqual(vc.homes_of("text/plain", [], entries, exists), [])
        self.assertEqual(vc.homes_of("tools/x.py", [], entries, exists, frozenset({"tools"})), [""])
        self.assertEqual(vc.homes_of("etc/settings.ini", ["modules/Acme/Catalog/"], entries, exists),
                         ["modules/Acme/Catalog/"])

    def test_a_path_inside_the_vault_itself_is_no_claim_about_the_repository(self) -> None:
        entries = {"modules", "plugins", "scripts"}
        in_vault = {"Modules", "Plugins", "Plugins/board-queue.md", "Plugins/assets/map.png",
                    "Plugins/assets/notes.md", "scripts"}.__contains__
        exists = set().__contains__
        self.assertEqual(vc.homes_of("Plugins/board-queue.md", [], entries, exists, in_vault=in_vault), [])
        self.assertEqual(vc.homes_of("Plugins/assets/map.png", [], entries, exists, in_vault=in_vault), [])
        self.assertEqual(vc.homes_of("Modules/not-yet-written.md", [], entries, exists, in_vault=in_vault), [])
        self.assertEqual(vc.homes_of("Plugins/assets/notes.md", [], entries, exists, in_vault=in_vault), [])
        self.assertEqual(vc.homes_of("Plugins/x/src/Y.ts", [], entries, exists, in_vault=in_vault), [""])
        self.assertEqual(vc.homes_of("Plugins/board-queue/README.md", [], entries, exists, in_vault=in_vault), [""])
        self.assertEqual(vc.homes_of("Docs/guide.md", [], entries | {"docs"}, exists, in_vault=in_vault), [""])
        self.assertEqual(vc.homes_of("modules/crm/x.py", [], entries, exists, in_vault=in_vault), [""])
        self.assertEqual(vc.homes_of("scripts/x.py", [], entries, exists, in_vault=in_vault), [""])
        self.assertEqual(vc.homes_of("MODULES/crm/x.py", [], entries, exists, in_vault=in_vault), [""])

    def test_a_package_note_gets_its_packages_as_bases(self) -> None:
        self.assertEqual(vc.package_bases("Modules/crm.md", ["acme"]),
                         ["packages/crm/", "plugins/crm/", "vendor/acme/crm/"])
        self.assertEqual(vc.package_bases("Modules/Acme_Catalog.md", []),
                         ["packages/Acme_Catalog/", "plugins/Acme_Catalog/"])
        self.assertEqual(vc.package_bases("Runbooks/Deploy.md", ["acme"]), [])

    def test_a_rule_adds_the_directory_its_template_derives_from_a_matching_stem(self) -> None:
        rule, why = vc.parse_note_base(RULE)
        self.assertIsNotNone(rule, why)
        self.assertEqual(vc.package_bases("Modules/Acme_Catalog.md", [], [rule]),
                         ["packages/Acme_Catalog/", "plugins/Acme_Catalog/", "modules/Acme/Catalog/"])
        self.assertEqual(vc.package_bases("Modules/crm.md", [], [rule]), ["packages/crm/", "plugins/crm/"])
        self.assertEqual(vc.package_bases("Modules/Acme_Catalog_Extra.md", [], [rule]),
                         ["packages/Acme_Catalog_Extra/", "plugins/Acme_Catalog_Extra/"])  # a full match only


RULE = "([A-Z][A-Za-z0-9]*)_([A-Z][A-Za-z0-9]*) modules/{1}/{2}/"


class RuleParsingTests(unittest.TestCase):
    def test_the_template_is_the_last_field_so_a_regex_may_hold_a_space(self) -> None:
        rule, _ = vc.parse_note_base("(Old|New) Notes  archive/{1}")
        self.assertIsNotNone(rule)
        self.assertEqual(rule.base_for("Old Notes"), "archive/Old/")

    def test_a_rule_that_does_not_parse_says_why(self) -> None:
        cases = {
            "([A-Z]+ modules/{1}/": "does not compile",
            "modules/only/": "expected",
            "([A-Z]+) modules/{1}/{2}/": "names a group the regex does not have",
            "([A-Z]+) /etc/{1}/": "inside the project",
            "([A-Z]+) ../{1}/": "inside the project",
        }
        for line, why in cases.items():
            rule, problem = vc.parse_note_base(line)
            self.assertIsNone(rule, line)
            self.assertIn(why, problem, line)

    def test_living_notes_are_the_code_folders_and_the_overview(self) -> None:
        for rel in ("Modules/crm.md", "Kernel/admin.md", "Bridges/a-b.md", "Runbooks/Deploy.md",
                    "00 Hub — Project Overview.md"):
            self.assertTrue(vc.is_living(Path(rel)), rel)
        for rel in ("Decisions/0001-x.md", "Journal/2026-01-01 x.md", "To DO.md", "Modules/sub/deep.md"):
            self.assertFalse(vc.is_living(Path(rel)), rel)

    def test_any_generated_block_prefix_ends_the_generated_half(self) -> None:
        self.assertEqual(vc.prose_of("facts\n<!-- kb:generated:end -->\nprose"), "\nprose")
        self.assertEqual(vc.prose_of("---\na: b\n---\nbody"), "body")


class DecisionTemplateTests(unittest.TestCase):
    @staticmethod
    def dated(n: int) -> dict[str, str]:
        return {f"2026-01-0{i + 1} record-{i}.md":
                f"---\ntype: decision\nstatus: accepted\narea: x\ndate: 2026-01-0{i + 1}\n---\n" for i in range(n)}

    def test_a_vault_is_held_to_the_dated_template_only_when_its_records_keep_it(self) -> None:
        self.assertTrue(vc.follows_dated_template(self.dated(5)))
        self.assertFalse(vc.follows_dated_template(self.dated(4)))
        numbered = {f"000{i}-consumer-owned-ports.md": "# A\n\n**Status:** accepted\n" for i in range(1, 9)}
        self.assertFalse(vc.follows_dated_template(numbered))
        mixed = {**self.dated(5), **{f"note {i}.md": "# x\n" for i in range(3)}}
        self.assertFalse(vc.follows_dated_template(mixed))

    def test_a_dated_records_malformed_fields_are_named(self) -> None:
        text = "---\ntype: decision\nstatus: superseded by [[2026-01-09 nowhere]]\narea: x\ndate: 2026-01-02\n---\n"
        self.assertEqual(vc.lint_decision("2026-01-01 x.md", text, set()), [
            "`date` is `2026-01-02` but the file name says `2026-01-01`",
            "`status` is superseded by [[2026-01-09 nowhere]], which is not a record",
        ])


class LinkTests(unittest.TestCase):
    def test_resolution_is_by_file_name_without_regard_to_case_and_code_is_skipped(self) -> None:
        stems, files = {"crm", "deploy"}, {"diagram.png"}
        self.assertEqual(vc.wikilink_targets("`[[x]]` [[crm|CRM]] [[#heading]] [[Deploy#Steps]]"), ["crm", "Deploy"])
        self.assertTrue(vc.link_resolves("Deploy", stems, files))
        self.assertTrue(vc.link_resolves("diagram.png", stems, files))
        self.assertFalse(vc.link_resolves("2026-07-07\nwrapped", stems, files))
        self.assertFalse(vc.link_resolves("nowhere", stems, files))


class ReconcileTests(unittest.TestCase):
    def test_code_that_moved_under_unchanged_prose_is_stale_until_restamped(self) -> None:
        stamps = {"Modules/crm.md": {"a.php": {"blob": "b1", "commit": "c1", "context": "ctx"}}}
        carried, stale = vc.reconcile({"Modules/crm.md": {"a.php": "ctx"}}, stamps, {"a.php": "b2"}, "c2", set())
        self.assertEqual((stale, carried), ([("Modules/crm.md", "a.php", "c1")], stamps))
        carried, stale = vc.reconcile({"Modules/crm.md": {"a.php": "ctx"}}, stamps, {"a.php": "b2"}, "c2",
                                      {"Modules/crm.md"})
        self.assertEqual((stale, carried["Modules/crm.md"]["a.php"]["blob"]), ([], "b2"))

    class Unreached(vc.StampHistory):
        """A history whose default branch never held the reviewed blob, knowing only `known`."""

        def __init__(self, known: set) -> None:
            self.commits = known

        def reached(self, path: str, blob: str) -> bool:
            return False

        def known(self, commit: str) -> bool:
            return commit in self.commits

    def test_a_review_of_code_the_default_branch_has_not_reached_waits(self) -> None:
        stamps = {"Modules/crm.md": {"a.php": {"blob": "b3", "commit": "c1", "context": "ctx"}}}
        carried, stale = vc.reconcile({"Modules/crm.md": {"a.php": "ctx"}}, stamps, {"a.php": "b2"}, "c2", set(),
                                      self.Unreached({"c1"}))
        self.assertEqual((stale, carried), ([], stamps))

    def test_a_stamp_at_a_commit_this_clone_lacks_is_judged_by_its_blob(self) -> None:
        stamps = {"Modules/crm.md": {"a.php": {"blob": "b3", "commit": "gone", "context": "ctx"}}}
        carried, stale = vc.reconcile({"Modules/crm.md": {"a.php": "ctx"}}, stamps, {"a.php": "b2"}, "c2", set(),
                                      self.Unreached(set()))
        self.assertEqual((stale, carried), ([("Modules/crm.md", "a.php", "gone")], stamps))

    def test_a_stamp_whose_blob_the_reference_holds_moves_up_to_the_reference(self) -> None:
        stamps = {"Modules/crm.md": {"a.php": {"blob": "b2", "commit": "gone", "context": "ctx"}}}
        carried, stale = vc.reconcile({"Modules/crm.md": {"a.php": "ctx"}}, stamps, {"a.php": "b2"}, "c2", set(),
                                      self.Unreached(set()))
        self.assertEqual((stale, carried["Modules/crm.md"]["a.php"]),
                         ([], {"blob": "b2", "commit": "c2", "context": "ctx"}))

    def test_a_restamp_records_the_blob_the_reviewer_saw(self) -> None:
        class OnABranch(vc.StampHistory):
            def seen(self, path: str, reference_blob: str) -> str:
                return "branch-blob"

        carried, _ = vc.reconcile({"Modules/crm.md": {"a.php": "ctx"}}, {}, {"a.php": "b2"}, "c2", set(), OnABranch())
        self.assertEqual(carried["Modules/crm.md"]["a.php"], {"blob": "branch-blob", "commit": "c2", "context": "ctx"})


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


class MeasureTests(unittest.TestCase):
    """The whole measurement against a throwaway project whose vault the project does not version."""

    NOTE = ("---\ntitle: crm\n---\n<!-- kb:generated:start -->\n# crm\n- `GeneratedOnlyName`\n"
            "<!-- kb:generated:end -->\n\n## Purpose\n\n`ContactReader` reads contacts; `EnumOnlyCase` is a case "
            "of it; `ReportWriter` is a name the scripts write in their own case; "
            "`VendorProvidedThing` comes from a library; `GoneClass` was deleted.\n\n"
            "It replaced ~~`RetiredClass`~~, is configured in `src/Resources/config/assistant.yaml` and "
            "`src/Missing.php`, logs to `var/log/app.log` and answers `text/plain`. See [[crm]] and [[nowhere]].\n")

    def setUp(self) -> None:
        self.env = {k: os.environ.get(k) for k in ("CLAUDE_VAULT_STATE", "CLAUDE_VAULT_NO_SPAWN", "XDG_CONFIG_HOME",
                                                     "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM")}
        self.state = Path(tempfile.mkdtemp()).resolve()
        os.environ["CLAUDE_VAULT_STATE"] = str(self.state)
        os.environ["CLAUDE_VAULT_NO_SPAWN"] = "1"
        # The rules a developer configured for their own vaults must not reach these measurements.
        self.config = Path(tempfile.mkdtemp()).resolve()
        os.environ["XDG_CONFIG_HOME"] = str(self.config)
        os.environ["GIT_CONFIG_GLOBAL"] = str(self.config / "gitconfig")
        os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
        self.root = Path(tempfile.mkdtemp()).resolve()
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.email", "tests@example.com")
        git(self.root, "config", "user.name", "Tests")
        git(self.root, "config", "commit.gpgsign", "false")
        self.write("packages/crm/src/Service/ContactReader.php",
                   "<?php\nfinal class ContactReader { const EnumOnlyCase = 1; }\n")
        self.write("packages/crm/src/Resources/config/assistant.yaml", "assistant: {}\n")
        self.write("packages/crm/assets/report.js", "export const reportWriter = () => null;\n")
        self.write("packages/crm/README.md", "Mentions GoneClass in Markdown only.\n")
        self.write("vendor/acme/lib/src/VendorProvidedThing.php", "<?php\n")
        self.write("var/cache/.keep", "")
        self.write(".gitignore", "/vendor/\n/var/\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "init")
        self.write(".claude/kb/To DO.md", "## Now\n")
        self.write(".claude/kb/Decisions/0001-a-numbered-record.md", "# A record\n\n**Status:** accepted\n")
        self.write(".claude/kb/Modules/crm.md", self.NOTE)
        self.write(".claude/kb/Journal/2026-01-01 history.md", "Cites `GoneClass` as it was. [[0001-a-numbered-record]]\n")
        self.vault = vaultlib.locate(self.root)

    def tearDown(self) -> None:
        for key, value in self.env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def messages(self, report: vc.Report, level: str) -> list[str]:
        return [f"{f.note}: {f.message}" for f in report.findings if f.level == level]

    def test_hard_findings_are_exactly_the_things_that_are_gone(self) -> None:
        self.assertEqual(self.vault.mode, "untracked")
        hard = self.messages(vc.measure(self.vault, write=False), "HARD")
        self.assertEqual(len(hard), 3, hard)
        self.assertTrue(any("`GoneClass` appears nowhere" in m and m.startswith("Modules/crm.md") for m in hard))
        self.assertTrue(any("`src/Missing.php` does not exist" in m for m in hard))
        self.assertTrue(any("[[nowhere]] resolves to no note" in m for m in hard))
        joined = "\n".join(hard)
        for survivor in ("ContactReader", "EnumOnlyCase", "ReportWriter", "VendorProvidedThing", "RetiredClass",
                         "GeneratedOnlyName", "assistant.yaml", "app.log", "text/plain", "0001", "Journal/"):
            self.assertNotIn(survivor, joined)

    def test_an_unfinished_code_search_is_one_finding_and_calls_no_name_gone(self) -> None:
        real = vaultlib.git_out

        def grep_never_finishes(root: Path, *args: str, timeout: int = 180) -> tuple[int, str]:
            return (vaultlib.TIMED_OUT, "") if "grep" in args else real(root, *args, timeout=timeout)

        vaultlib.git_out = grep_never_finishes
        try:
            hard = self.messages(vc.measure(self.vault, write=False), "HARD")
        finally:
            vaultlib.git_out = real
        unfinished = [m for m in hard if "did not finish in time" in m]
        self.assertEqual(len(unfinished), 1, hard)
        self.assertFalse(any("appears nowhere" in m for m in hard), hard)

    def test_a_timed_out_git_answers_its_own_code(self) -> None:
        self.assertNotIn(vaultlib.TIMED_OUT, (0, 1))
        code, out = vaultlib.git_out(self.root, "-c", "core.pager=cat", "log", "-1", timeout=0)
        self.assertEqual((code, out), (vaultlib.TIMED_OUT, ""))

    def test_the_stamps_live_outside_the_project_and_a_changed_file_flags_the_note(self) -> None:
        vc.measure(self.vault, write=True)
        stamps_path = self.state / self.vault.slug / ".anchors.json"
        self.assertTrue(stamps_path.is_file())
        self.assertEqual(git(self.root, "status", "--porcelain", "--", "packages"), "")
        stamped = json.loads(stamps_path.read_text())["notes"]["Modules/crm.md"]
        self.assertEqual(sorted(stamped), ["packages/crm/src/Resources/config/assistant.yaml",
                                           "packages/crm/src/Service/ContactReader.php"])

        self.write("packages/crm/src/Service/ContactReader.php", "<?php\nfinal class ContactReader { const EnumOnlyCase = 2; }\n")
        git(self.root, "commit", "-q", "-am", "the reader changes")
        soft = self.messages(vc.measure(self.vault, write=True), "SOFT")
        self.assertEqual(len(soft), 1)
        self.assertIn("`packages/crm/src/Service/ContactReader.php` (1 commit)", soft[0])

        self.assertEqual(self.messages(vc.measure(self.vault, write=True, restamp={"Modules/crm.md"}), "SOFT"), [])
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

    def stamps_text(self) -> str:
        return (self.state / self.vault.slug / ".anchors.json").read_text(encoding="utf-8")

    def change_the_reader(self, value: int) -> None:
        self.write("packages/crm/src/Service/ContactReader.php",
                   f"<?php\nfinal class ContactReader {{ const EnumOnlyCase = {value}; }}\n")
        git(self.root, "commit", "-q", "-am", f"the reader answers {value}")

    def test_a_branch_without_a_cited_file_tells_its_session_and_resets_no_stamp(self) -> None:
        vc.measure(self.vault, write=True)
        stamped = self.stamps_text()
        git(self.root, "checkout", "-q", "-b", "slim")
        git(self.root, "rm", "-q", "packages/crm/src/Service/ContactReader.php",
            "packages/crm/src/Resources/config/assistant.yaml")
        git(self.root, "commit", "-q", "-m", "a branch without the reader")

        report = vc.measure(self.vault, write=True)

        hard = self.messages(report, "HARD")
        self.assertEqual(len(hard), 3, hard)
        for kept in ("ContactReader", "EnumOnlyCase", "assistant.yaml"):
            self.assertFalse(any(kept in m for m in hard), hard)
        soft = self.messages(report, "SOFT")
        self.assertEqual(len(soft), 3, soft)
        for removed in ("`ContactReader`", "`EnumOnlyCase`", "`src/Resources/config/assistant.yaml`"):
            self.assertTrue(any(removed in m and "gone from this branch" in m for m in soft), soft)
        self.assertEqual(report.stale_notes, [])
        self.assertTrue(any("cite code this branch removed" in line for line in vc.brief_lines(report)))
        self.assertEqual(self.stamps_text(), stamped)
        git(self.root, "checkout", "-q", "main")
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

    def test_stamps_taken_on_two_branches_do_not_turn_the_note_soft_for_each_other(self) -> None:
        vc.measure(self.vault, write=True)
        git(self.root, "checkout", "-q", "-b", "alice")
        self.change_the_reader(2)
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])
        vc.measure(self.vault, write=True, restamp={"Modules/crm.md"})
        git(self.root, "checkout", "-q", "-b", "bob", "main")
        self.change_the_reader(3)
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])
        vc.measure(self.vault, write=True, restamp={"Modules/crm.md"})
        git(self.root, "checkout", "-q", "alice")
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

        git(self.root, "checkout", "-q", "main")
        git(self.root, "merge", "-q", "--ff-only", "bob")
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])
        self.change_the_reader(4)
        soft = self.messages(vc.measure(self.vault, write=True), "SOFT")
        self.assertEqual(len(soft), 1, soft)
        self.assertIn("`packages/crm/src/Service/ContactReader.php` (1 commit)", soft[0])

    def test_a_note_rewritten_on_a_branch_is_current_once_the_branch_merges(self) -> None:
        vc.measure(self.vault, write=True)
        git(self.root, "checkout", "-q", "-b", "feature")
        self.change_the_reader(2)
        self.write(".claude/kb/Modules/crm.md", self.NOTE.replace("reads contacts", "reads contacts by id"))
        vc.measure(self.vault, write=True)
        git(self.root, "checkout", "-q", "main")
        git(self.root, "merge", "-q", "--ff-only", "feature")

        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

    def test_a_note_stamped_on_a_branch_is_current_once_the_branch_merges(self) -> None:
        vc.measure(self.vault, write=True)
        git(self.root, "checkout", "-q", "-b", "feature")
        self.change_the_reader(2)
        vc.measure(self.vault, write=True, restamp={"Modules/crm.md"})
        git(self.root, "checkout", "-q", "main")
        git(self.root, "merge", "-q", "--ff-only", "feature")

        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

    def test_stamps_follow_the_remotes_default_branch_and_not_unpushed_commits(self) -> None:
        remote = Path(tempfile.mkdtemp()).resolve() / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
        git(self.root, "remote", "add", "origin", str(remote))
        git(self.root, "push", "-q", "origin", "main")
        git(self.root, "remote", "set-head", "origin", "main")
        vc.measure(self.vault, write=True)
        self.change_the_reader(2)
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

        git(self.root, "push", "-q", "origin", "main")

        self.assertEqual(len(self.messages(vc.measure(self.vault, write=True), "SOFT")), 1)

    def test_what_the_default_branch_added_after_this_branch_left_is_no_finding(self) -> None:
        git(self.root, "branch", "older")
        self.write("packages/crm/src/Service/NewerThing.php", "<?php\nfinal class NewerThing {}\n")
        self.write("packages/crm/assets/newer.js", "export const newerHelper = () => 'NewerWordOnly';\n")
        git(self.root, "add", "packages")
        git(self.root, "commit", "-q", "-m", "the default branch moves on")
        self.write(".claude/kb/Runbooks/Newer.md", "## Steps\n\n`NewerThing` lives in "
                   "`packages/crm/src/Service/NewerThing.php`; `NewerWordOnly` is in the assets.\n")
        git(self.root, "checkout", "-q", "older")

        report = vc.measure(self.vault, write=False)

        self.assertEqual([f.message for f in report.findings if "Newer" in f.message], [])
        self.assertEqual(len(report.hard), 3, self.messages(report, "HARD"))

    def test_a_branch_review_turns_soft_once_the_default_branch_changes_the_file_otherwise(self) -> None:
        vc.measure(self.vault, write=True)
        git(self.root, "checkout", "-q", "-b", "feature")
        self.change_the_reader(2)
        vc.measure(self.vault, write=True, restamp={"Modules/crm.md"})
        git(self.root, "checkout", "-q", "main")
        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

        self.change_the_reader(3)

        soft = self.messages(vc.measure(self.vault, write=True), "SOFT")
        self.assertEqual(len(soft), 1, soft)
        self.assertIn("ContactReader.php", soft[0])

    def test_a_stamp_taken_at_a_branch_commit_turns_soft_once_the_default_branch_changes_the_file(self) -> None:
        vc.measure(self.vault, write=True)
        git(self.root, "checkout", "-q", "-b", "feature")
        self.change_the_reader(2)
        branch = git(self.root, "rev-parse", "HEAD").strip()
        blob = git(self.root, "rev-parse", "HEAD:packages/crm/src/Service/ContactReader.php").strip()
        git(self.root, "checkout", "-q", "main")
        stamps = json.loads(self.stamps_text())
        stamps["notes"]["Modules/crm.md"]["packages/crm/src/Service/ContactReader.php"].update(blob=blob, commit=branch)
        (self.state / self.vault.slug / ".anchors.json").write_text(vc.render_stamps(stamps["notes"]))

        self.change_the_reader(3)

        self.assertEqual(len(self.messages(vc.measure(self.vault, write=True), "SOFT")), 1)

    def test_a_history_that_cannot_be_read_is_one_finding_and_not_a_silence(self) -> None:
        vc.measure(self.vault, write=True)
        self.change_the_reader(2)
        real = vaultlib.git_out

        def log_fails(root: Path, *args: str, timeout: int = 180) -> tuple[int, str]:
            return (128, "") if "log" in args else real(root, *args, timeout=timeout)

        with unittest.mock.patch.object(vaultlib, "git_out", log_fails):
            hard = self.messages(vc.measure(self.vault, write=False), "HARD")

        unread = [m for m in hard if "could not be read" in m]
        self.assertEqual(len(unread), 1, hard)
        self.assertIn("history of 1 cited file(s)", unread[0])

    def rewrite_stamps(self, **fields: str) -> dict:
        stamps = json.loads(self.stamps_text())
        for entry in stamps["notes"]["Modules/crm.md"].values():
            entry.update(fields)
        (self.state / self.vault.slug / ".anchors.json").write_text(vc.render_stamps(stamps["notes"]))
        return stamps

    def test_a_stamp_at_a_commit_this_clone_lacks_still_turns_soft_when_the_code_differs(self) -> None:
        vc.measure(self.vault, write=True)
        stamps = self.rewrite_stamps(blob="0" * 40, commit="f" * 40)

        soft = self.messages(vc.measure(self.vault, write=True), "SOFT")

        self.assertEqual(len(soft), 1, soft)
        self.assertEqual(json.loads(self.stamps_text()), stamps)

    def test_a_stamp_at_a_commit_this_clone_lacks_moves_up_while_the_code_is_the_same(self) -> None:
        vc.measure(self.vault, write=True)
        self.rewrite_stamps(commit="f" * 40)

        self.assertEqual(self.messages(vc.measure(self.vault, write=True), "SOFT"), [])

        main = git(self.root, "rev-parse", "main").strip()
        commits = {entry["commit"] for entry in json.loads(self.stamps_text())["notes"]["Modules/crm.md"].values()}
        self.assertEqual(commits, {main})
        self.change_the_reader(2)
        soft = self.messages(vc.measure(self.vault, write=True), "SOFT")
        self.assertEqual(len(soft), 1, soft)
        self.assertIn("(1 commit)", soft[0])

    def test_the_command_line_stamps_by_stem_and_the_brief_reads_the_cache(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(vc.main(["--brief", "--root", str(self.root)]), 0)
            self.assertEqual(vc.main(["--root", str(self.root), "--stamp", "crm", "--quiet"]), 1)
            self.assertEqual(vc.main(["--root", str(self.root), "--stamp", "0001-a-numbered-record"]), 2)
            self.assertEqual(vc.main(["--brief", "--root", str(self.root)]), 0)
        printed = out.getvalue()
        self.assertIn("[VAULT] not checked yet", printed)
        self.assertIn("stamped: Modules/crm.md", printed)
        self.assertIn("[VAULT] 3 hard finding(s) in 1 note(s)", printed)
        self.assertIn("is not a living note", err.getvalue())

    def hold_the_lock(self) -> tuple[Path, vaultlib.HeldLock]:
        lock = self.vault.state / "vault-check.lock"
        held = vaultlib.claim(lock)
        self.assertIsNotNone(held)
        self.addCleanup(held.release)
        return lock, held

    def test_a_background_refresh_gives_way_to_a_running_check(self) -> None:
        lock, _ = self.hold_the_lock()
        self.assertEqual(vc.main(["--refresh", "--root", str(self.root)]), 0)
        self.assertFalse((self.vault.state / "vault-check.txt").exists())
        self.assertTrue(lock.exists())

    def test_a_check_never_removes_the_lock_of_a_process_that_holds_it_after_it(self) -> None:
        lock = self.vault.state / "vault-check.lock"
        other: list = []
        real = vc.measure

        def measure_while_the_lock_changes_hands(*args, **kwargs):
            report = real(*args, **kwargs)
            lock.unlink()  # the lock file this run holds is gone, and another process holds a new one
            other.append(subprocess.Popen([sys.executable, "-c", HOLDER, str(BIN), str(lock)],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
            self.assertEqual(other[0].stdout.readline().strip(), "held")
            return report

        try:
            with unittest.mock.patch.object(vc, "measure", measure_while_the_lock_changes_hands), \
                    contextlib.redirect_stdout(io.StringIO()):
                vc.main(["--quiet", "--root", str(self.root)])
            self.assertTrue(lock.exists(), "the run removed a lock another process holds")
            self.assertIsNone(vaultlib.claim(lock))
        finally:
            for process in other:
                process.communicate("")

    def test_a_foreground_check_waits_for_a_running_one_then_runs(self) -> None:
        lock, held = self.hold_the_lock()
        release = threading.Timer(0.3, held.release)
        release.start()
        poll, vc.LOCK_POLL = vc.LOCK_POLL, 0.05
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vc.main(["--quiet", "--root", str(self.root)]), 1)
        finally:
            vc.LOCK_POLL = poll
            release.cancel()
        self.assertTrue((self.vault.state / "vault-check.txt").is_file())
        self.assertFalse(lock.exists())

    def spin_guard(self, limit: int = 200):
        """A stand-in for time.sleep that sleeps briefly and fails a run that keeps polling."""
        real = vc.time.sleep
        calls: list = []

        def sleep(seconds: float) -> None:
            calls.append(seconds)
            if len(calls) > limit:
                raise AssertionError(f"still waiting after {limit} polls")
            real(min(seconds, 0.01))

        return unittest.mock.patch.object(vc.time, "sleep", sleep)

    def test_a_foreground_check_gives_up_on_a_lock_held_too_long_and_says_so(self) -> None:
        self.hold_the_lock()
        err = io.StringIO()
        with unittest.mock.patch.object(vc, "LOCK_WAIT", 0.3), unittest.mock.patch.object(vc, "LOCK_POLL", 0.05), \
                self.spin_guard(), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(vc.main(["--quiet", "--root", str(self.root)]), 2)
        self.assertIn("another check", err.getvalue())
        self.assertFalse((self.vault.state / "vault-check.txt").exists())

    def test_a_read_only_check_runs_without_a_lock_that_cannot_be_taken(self) -> None:
        out = io.StringIO()
        with unittest.mock.patch.object(vaultlib, "fcntl", None), self.spin_guard(), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(vc.main(["--check", "--quiet", "--root", str(self.root)]), 1)
        self.assertIn("3 hard", out.getvalue())
        self.assertFalse((self.vault.state / "vault-check.txt").exists())

    def test_a_writing_check_refuses_a_lock_that_cannot_be_taken(self) -> None:
        err = io.StringIO()
        with unittest.mock.patch.object(vaultlib, "fcntl", None), self.spin_guard(), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(vc.main(["--quiet", "--root", str(self.root)]), 2)
            self.assertEqual(vc.main(["--root", str(self.root), "--stamp", "crm"]), 2)
        self.assertIn("cannot be taken", err.getvalue())
        self.assertIn("--check", err.getvalue())
        self.assertFalse((self.vault.state / "vault-check.txt").exists())

    def paths_note(self, *spans: str) -> list[str]:
        """The hard findings of a runbook citing each span, and nothing else of the project's."""
        self.write(".claude/kb/Runbooks/Paths.md", "## Steps\n\n" + "\n\n".join(f"See `{s}`." for s in spans) + "\n")
        return [m for m in self.messages(vc.measure(self.vault, write=False), "HARD")
                if m.startswith("Runbooks/Paths.md")]

    def test_a_note_citing_a_note_by_its_path_in_the_vault_is_no_finding(self) -> None:
        self.write("modules/billing/etc/config.ini", "[billing]\n")
        self.write("plugins/board-queue/package.json", "{}\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "a module and a plugin")
        self.write(".claude/kb/Plugins/board-queue.md", "## Purpose\n\nQueues board writes.\n")

        found = self.paths_note("Plugins/board-queue.md", "Modules/crm.md", "Modules/not-yet-written.md",
                                "plugins/board-queue/missing.ts")

        self.assertEqual(len(found), 1, found)
        self.assertIn("`plugins/board-queue/missing.ts` does not exist", found[0])

    def test_a_code_path_in_the_case_of_a_vault_folder_is_still_the_wrong_case(self) -> None:
        self.write("plugins/x/src/Y.ts", "export const y = 1;\n")
        self.write("plugins/board-queue/README.md", "# board-queue\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "a plugin")
        self.write(".claude/kb/Plugins/board-queue.md", "## Purpose\n\nQueues board writes.\n")
        os.symlink(str(self.root / "plugins" / "x"), str(self.root / ".claude" / "kb" / "Plugins" / "out"))

        found = self.paths_note("Plugins/x/src/Y.ts", "Plugins/out/src/Y.ts", "Plugins/board-queue.md",
                                "Plugins/board-queue/README.md")

        self.assertEqual(len(found), 3, found)
        for cited, spelled in (("Plugins/x/src/Y.ts", "plugins/x/src/Y.ts"),
                               ("Plugins/board-queue/README.md", "plugins/board-queue/README.md")):
            wrong = next((m for m in found if f"`{cited}`" in m), "")
            self.assertIn(f"the tree spells it `{spelled}`", wrong, found)
        self.assertTrue(any("`Plugins/out/src/Y.ts` does not exist" in m for m in found), found)

    def test_a_path_whose_first_segment_left_the_repository_is_hard(self) -> None:
        self.write("scripts/old-tool.py", "print('x')\n")
        git(self.root, "add", "scripts")
        git(self.root, "commit", "-q", "-m", "a tool")
        git(self.root, "rm", "-q", "-r", "scripts")
        git(self.root, "commit", "-q", "-m", "the tool goes")

        found = self.paths_note("scripts/old-tool.py", "text/plain", "and/or")

        self.assertEqual(len(found), 1, found)
        self.assertIn("`scripts/old-tool.py` does not exist", found[0])

    def test_a_path_cited_in_the_wrong_case_is_hard_and_names_the_spelling(self) -> None:
        found = self.paths_note("packages/crm/src/service/ContactReader.php",
                                "Packages/crm/src/Service/ContactReader.php",
                                "packages/crm/src/Service/ContactReader.php")

        self.assertEqual(len(found), 2, found)
        for wrong in ("packages/crm/src/service/ContactReader.php", "Packages/crm/src/Service/ContactReader.php"):
            line = next((m for m in found if f"`{wrong}`" in m), "")
            self.assertIn("`packages/crm/src/Service/ContactReader.php`", line, found)

    def test_a_path_with_a_member_is_checked_by_its_path_and_its_member(self) -> None:
        found = self.paths_note("packages/crm/src/Service/ContactReader.php::EnumOnlyCase",
                                "packages/crm/src/Service/ContactReader.php::reportWriter()",
                                "packages/crm/src/Service/ContactReader.php::vanishedMethod()",
                                "packages/crm/src/Service/GoneReader.php::read")

        self.assertEqual(len(found), 2, found)
        self.assertTrue(any("`packages/crm/src/Service/GoneReader.php` does not exist" in m for m in found), found)
        self.assertTrue(any("`vanishedMethod`" in m and "ContactReader.php" in m for m in found), found)

    def module_note(self) -> None:
        """A package whose directory only a note-base rule names, and a note citing one live and one gone path."""
        self.write("modules/Acme/Catalog/etc/settings.ini", "[catalog]\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "a module")
        self.write(".claude/kb/Modules/Acme_Catalog.md",
                   "## Purpose\n\nReads `etc/settings.ini`; the old `etc/retired.ini` is gone.\n")

    def module_findings(self) -> list[str]:
        return [m for m in self.messages(vc.measure(self.vault, write=False), "HARD") if "Acme_Catalog" in m]

    def test_with_no_rule_a_note_outside_the_built_in_layouts_is_not_read_for_paths(self) -> None:
        self.module_note()
        self.assertEqual(self.module_findings(), [])
        self.assertEqual(vc.load_note_bases(self.vault.path), ([], []))

    def test_a_rule_in_the_vaults_git_config_applies(self) -> None:
        self.module_note()
        git(self.root, "config", "--add", "vault-check.noteBase", RULE)
        found = self.module_findings()
        self.assertEqual(len(found), 1, found)
        self.assertIn("`etc/retired.ini` does not exist", found[0])

    def test_a_rule_in_the_users_rule_file_applies(self) -> None:
        self.module_note()
        conf = self.config / "claude-kit" / "vault-check.conf"
        conf.parent.mkdir(parents=True)
        conf.write_text("# package layouts of my vaults\n\n" + RULE + "\n", encoding="utf-8")
        found = self.module_findings()
        self.assertEqual(len(found), 1, found)
        self.assertIn("`etc/retired.ini` does not exist", found[0])

    def test_both_sources_apply_and_a_rule_given_twice_counts_once(self) -> None:
        other = "([a-z]+)-lib libs/{1}/"
        git(self.root, "config", "--add", "vault-check.noteBase", RULE)
        conf = self.config / "claude-kit" / "vault-check.conf"
        conf.parent.mkdir(parents=True)
        conf.write_text(RULE + "\n" + other + "\n", encoding="utf-8")
        rules, problems = vc.load_note_bases(self.vault.path)
        self.assertEqual(problems, [])
        self.assertEqual([(r.pattern.pattern, r.template) for r in rules],
                         [(RULE.split()[0], "modules/{1}/{2}/"), ("([a-z]+)-lib", "libs/{1}/")])

    def test_a_malformed_rule_is_reported_once_and_skipped_while_the_good_one_applies(self) -> None:
        self.module_note()
        conf = self.config / "claude-kit" / "vault-check.conf"
        conf.parent.mkdir(parents=True)
        conf.write_text("([A-Z]+ broken/{1}/\n" + RULE + "\n", encoding="utf-8")
        report = vc.measure(self.vault, write=False)
        self.assertEqual(len(report.config_problems), 1, report.config_problems)
        self.assertIn("vault-check.conf:1", report.config_problems[0])
        self.assertIn("does not compile", report.config_problems[0])
        found = [m for m in self.messages(report, "HARD") if "Acme_Catalog" in m]
        self.assertEqual(len(found), 1, found)
        printed = vc.render(report, quiet=True)
        self.assertEqual(sum("note-base rule" in line for line in printed), 1, printed)
        self.assertTrue(any("1 note-base rule problem(s)" in line for line in vc.brief_lines(report)))

    def test_a_package_note_resolves_through_packages_with_no_rule_configured(self) -> None:
        self.write("packages/billing/src/Service/InvoiceWriter.php", "<?php\nfinal class InvoiceWriter {}\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "billing")
        self.write(".claude/kb/Modules/billing.md",
                   "## Purpose\n\n`InvoiceWriter` lives in `src/Service/InvoiceWriter.php`; `src/Gone.php` is gone.\n")
        report = vc.measure(self.vault, write=False)
        self.assertEqual(report.config_problems, [])
        found = [m for m in self.messages(report, "HARD") if m.startswith("Modules/billing.md")]
        self.assertEqual(len(found), 1, found)
        self.assertIn("`src/Gone.php` does not exist", found[0])

    def test_a_project_outside_git_is_still_read_for_its_links(self) -> None:
        plain = Path(tempfile.mkdtemp()).resolve()
        (plain / "kb" / "Decisions").mkdir(parents=True)
        (plain / "kb" / "To DO.md").write_text("## Now\n[[nowhere]]\n")
        (plain / "CLAUDE.md").write_text("Knowledge-base directory: `kb/`\n")
        report = vc.measure(vaultlib.locate(plain), write=True)
        self.assertEqual([f.message for f in report.hard], ["[[nowhere]] resolves to no note or file in the vault"])


if __name__ == "__main__":
    unittest.main()
