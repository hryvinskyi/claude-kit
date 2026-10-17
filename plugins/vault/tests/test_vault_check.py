#!/usr/bin/env python3
"""Tests for bin/vault_check.py.

Pinned: which code spans count as a class or a path, and that a path counts only when it is about the
repository (its first segment exists at the root or in the note's package); which notes are living;
that a vault is held to the dated decision template only when its records keep it, so a numbered-ADR
vault is not flooded with findings; that links resolve as Obsidian resolves them; and, against a real
throwaway project whose vault the project does not version, that a vanished class is hard while a
class that exists as a word in code or under vendor/ is not, that an ignored path is never a finding,
that the stamps live outside the project, and that a changed file flags the note until it is stamped;
and that a note-base rule, from the vault's git config or the user's rule file, adds a package layout
while a rule that does not parse is reported and skipped.

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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
import vault_check as vc  # noqa: E402
import vaultlib  # noqa: E402


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


class ScopeTests(unittest.TestCase):
    def test_a_path_is_about_the_repository_only_when_its_first_segment_exists(self) -> None:
        entries = {"packages", "scripts", ".claude"}
        exists = {"modules/Acme/Catalog/etc"}.__contains__
        self.assertTrue(vc.names_the_repository("scripts/x.py", [], entries, exists))
        self.assertFalse(vc.names_the_repository("text/plain", [], entries, exists))
        self.assertTrue(vc.names_the_repository("etc/settings.ini", ["modules/Acme/Catalog/"], entries, exists))

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

    def hold_the_lock(self) -> Path:
        lock = self.vault.state / "vault-check.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text("1", encoding="utf-8")
        return lock

    def test_a_background_refresh_gives_way_to_a_running_check(self) -> None:
        lock = self.hold_the_lock()
        self.assertEqual(vc.main(["--refresh", "--root", str(self.root)]), 0)
        self.assertFalse((self.vault.state / "vault-check.txt").exists())
        self.assertTrue(lock.exists())

    def test_a_foreground_check_waits_for_a_running_one_then_runs(self) -> None:
        lock = self.hold_the_lock()
        release = threading.Timer(0.3, lock.unlink)
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
