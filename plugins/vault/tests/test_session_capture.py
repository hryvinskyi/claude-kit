#!/usr/bin/env python3
"""Tests for bin/session_capture.py.

Pinned, each against the way a real session goes wrong:
- a commit made with `git commit -q` is the session's own when its subject was in the command, and one
  whose hash the committing call printed is too; a commit merely shown by `git log`, made by a parallel
  session, is not; nothing made before the session began is;
- fixing a link in an old journal entry is not journaling the session, creating or editing today's is;
- the inbox of a vault the project does not own lives in state, never in the project's tree;
- a vault is committed only when it is a repository of its own — a project's repository never is;
- the hook defers to a project with its own SessionEnd hook and refuses a payload it cannot trust.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
import session_capture as sc  # noqa: E402
import vaultlib  # noqa: E402

SESSION = "07a27783-9167-4a1c-9d84-de57fac2b535"
BEGAN = "2026-09-11T10:00:00.000Z"


def use(tool_id: str, name: str, **tool_input: str) -> str:
    return json.dumps({"type": "assistant", "timestamp": BEGAN, "message": {"content": [
        {"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}]}})


def result(tool_id: str, text: str, ts: str = BEGAN) -> str:
    return json.dumps({"type": "user", "timestamp": ts, "message": {"content": [
        {"type": "tool_result", "tool_use_id": tool_id, "content": text}]}})


def git(repo: Path, *args: str, when: str = "") -> str:
    env = dict(os.environ)
    if when:
        env.update(GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True, env=env).stdout


def make_repo(root: Path) -> None:
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "tests@example.com")
    git(root, "config", "user.name", "Tests")
    git(root, "config", "commit.gpgsign", "false")


def commit(repo: Path, message: str, when: str, name: str = "file.txt") -> str:
    (repo / name).write_text(message)
    git(repo, "add", "--", name)  # only the file: a vault beside it must stay as the test built it
    git(repo, "commit", "-q", "-m", message, when=when)
    return git(repo, "rev-parse", "HEAD").strip()


def epoch(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


class EvidenceTests(unittest.TestCase):
    def test_a_subject_is_read_from_m_and_from_a_heredoc_fed_to_F(self) -> None:
        self.assertEqual(sc.subjects_of('git commit -m "feat: loud one"'), {"feat: loud one"})
        self.assertEqual(sc.subjects_of("git commit -q -m 'fix: single quoted'"), {"fix: single quoted"})
        self.assertEqual(sc.subjects_of("git commit -q -F - <<'EOF'\nfeat(x): quiet one\n\nbody\n\nRefs #1\nEOF\n"
                                        "git log -1 --format='%h %s'"), {"feat(x): quiet one"})
        self.assertEqual(sc.subjects_of("cat > notes.md <<'EOF'\nnot a subject\nEOF"), set())

    def test_only_what_committing_calls_printed_or_carried_is_evidence(self) -> None:
        lines = [
            use("t1", "Bash", command="git commit -q -m 'feat: quiet'"), result("t1", ""),
            use("t2", "Bash", command="git log --oneline -3"), result("t2", "def5678 somebody else's commit"),
            use("t3", "Bash", command="git commit -q -F - <<'EOF'\nfeat: printed\nEOF\ngit log -1 --format=%h"),
            result("t3", "abc1234"),
        ]
        hashes, subjects = sc.commit_evidence(lines)
        self.assertIn("abc1234", hashes)
        self.assertNotIn("def5678", hashes)
        self.assertEqual(subjects, {"feat: quiet", "feat: printed"})

    def test_the_session_is_credited_with_its_own_commits_and_nobody_elses(self) -> None:
        repo = Path(tempfile.mkdtemp()).resolve()
        make_repo(repo)
        earlier = commit(repo, "chore: yesterday's work", "2026-09-11T09:00:00+00:00", "a.txt")
        quiet = commit(repo, "feat: quiet one\n\nRefs #241", "2026-09-11T10:05:00+00:00", "b.txt")
        parallel = commit(repo, "feat: a parallel session's", "2026-09-11T10:06:00+00:00", "c.txt")
        printed = commit(repo, "fix: printed hash", "2026-09-11T10:07:00+00:00", "d.txt")

        found = sc.session_commits(repo, epoch(BEGAN), {printed[:9]}, {"feat: quiet one", "chore: yesterday's work"})

        self.assertEqual([c["sha"] for c in found], [quiet, printed])
        self.assertEqual(found[0]["tickets"], ["241"])
        self.assertNotIn(parallel, [c["sha"] for c in found])
        self.assertNotIn(earlier, [c["sha"] for c in found])
        self.assertEqual(sc.session_commits(repo, None, {printed}, set()), [])


class JournalTests(unittest.TestCase):
    def test_only_creating_an_entry_or_editing_one_dated_in_the_session_journals_it(self) -> None:
        vault = Path(tempfile.mkdtemp()).resolve()
        days = {"2026-09-11"}
        self.assertFalse(sc.journal_written([use("t", "Edit", file_path=str(vault / "Journal" / "2026-07-16 old.md"))], vault, days))
        self.assertTrue(sc.journal_written([use("t", "Edit", file_path=str(vault / "Journal" / "2026-09-11 today.md"))], vault, days))
        self.assertTrue(sc.journal_written([use("t", "Write", file_path=str(vault / "Journal" / "shipped.md"))], vault, days))
        self.assertFalse(sc.journal_written([use("t", "Write", file_path=str(vault / "Decisions" / "x.md"))], vault, days))

    def test_the_session_spans_every_day_from_its_first_moment_to_today(self) -> None:
        lines = [result("t", "x", "2026-09-09T12:00:00.000Z")]
        self.assertEqual(sc.session_days(lines, date(2026, 9, 11)), {"2026-09-09", "2026-09-10", "2026-09-11"})
        self.assertEqual(sc.session_days([], date(2026, 9, 11)), {"2026-09-11"})


class ProjectTests(unittest.TestCase):
    """A real project repository with a vault inside it."""

    def setUp(self) -> None:
        self.env = {k: os.environ.get(k) for k in ("CLAUDE_VAULT_STATE", "CLAUDE_VAULT_NO_SPAWN")}
        self.state = Path(tempfile.mkdtemp()).resolve()
        os.environ["CLAUDE_VAULT_STATE"] = str(self.state)
        os.environ["CLAUDE_VAULT_NO_SPAWN"] = "1"
        self.root = Path(tempfile.mkdtemp()).resolve()
        make_repo(self.root)
        commit(self.root, "init", "2026-09-01T10:00:00+00:00", "README.txt")
        (self.root / ".claude" / "kb" / "Decisions").mkdir(parents=True)
        (self.root / ".claude" / "kb" / "To DO.md").write_text("## Now\n")

    def tearDown(self) -> None:
        for key, value in self.env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_a_quiet_commit_without_a_journal_is_filed_in_state_and_cleared_by_todays_entry(self) -> None:
        commit(self.root, "feat: shipped quietly\n\nRefs #7", "2026-09-11T10:05:00+00:00", "work.txt")
        vault = vaultlib.locate(self.root)
        self.assertEqual(vault.mode, "untracked")
        lines = [result("t0", "start"), use("t1", "Bash", command="git commit -q -m 'feat: shipped quietly'"),
                 result("t1", ""), use("t2", "Edit", file_path=str(vault.path / "Journal" / "2026-07-16 old.md"))]

        self.assertTrue(sc.capture(vault, SESSION, lines, "2026-09-11", today=date(2026, 9, 11)))
        inbox = self.state / vault.slug / "Inbox.md"
        self.assertIn("feat: shipped quietly — Refs #7", inbox.read_text())
        self.assertFalse((vault.path / "Inbox.md").exists())

        brief = sc.brief_lines(vault, inbox.read_text(), False, None, 0)
        self.assertIn("[INBOX] 1 session committed work with no journal entry (oldest 2026-09-11)", brief[0])
        self.assertIn(str(inbox), brief[0])
        self.assertIn("neither versioned by the project nor a repository of its own", brief[1])

        journaled = lines + [use("t3", "Write", file_path=str(vault.path / "Journal" / "2026-09-11 shipped.md"))]
        self.assertFalse(sc.capture(vault, SESSION, journaled, "2026-09-11", today=date(2026, 9, 11)))
        self.assertNotIn(SESSION, inbox.read_text())

    def test_a_vault_the_project_versions_is_never_committed(self) -> None:
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "the vault", when="2026-09-02T10:00:00+00:00")
        vault = vaultlib.locate(self.root)
        self.assertEqual(vault.mode, "tracked")
        (vault.path / "To DO.md").write_text("## Now\n- [ ] changed\n")
        head = git(self.root, "rev-parse", "HEAD")
        self.assertFalse(sc.commit_vault(vault, SESSION))
        self.assertEqual(git(self.root, "rev-parse", "HEAD"), head)
        self.assertEqual(sc.backup_line(vault, False, None, 1), "[VAULT] 1 vault change not yet committed with the project")

    def test_a_vault_that_is_its_own_repository_is_committed_when_it_changed(self) -> None:
        make_repo(self.root / ".claude" / "kb")
        vault = vaultlib.locate(self.root)
        self.assertEqual(vault.mode, "own-repo")
        self.assertTrue(sc.commit_vault(vault, SESSION))
        self.assertRegex(git(vault.path, "log", "-1", "--format=%s"), r"^session \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(07a27783\)$")
        self.assertFalse(sc.commit_vault(vault, SESSION))
        self.assertEqual(sc.backup_line(vault, False, None, 0), "[VAULT] no copy off this machine — the vault's repository has no remote")
        self.assertIn("2 vault commits not pushed", sc.backup_line(vault, True, 2, 0))
        self.assertIsNone(sc.backup_line(vault, True, 0, 0))

    def test_the_hook_hands_off_defers_to_the_project_and_drops_what_it_cannot_trust(self) -> None:
        spawned: list[list[str]] = []
        payload = {"session_id": SESSION, "cwd": str(self.root), "transcript_path": "/x.jsonl"}
        self.assertEqual(sc.hook(json.dumps(payload), spawn=lambda args, cwd: spawned.append(args)), 0)
        self.assertEqual(len(spawned), 1)
        saved = Path(spawned[0][-1])
        self.assertTrue(str(saved).startswith(str(self.state)))
        self.assertEqual(json.loads(saved.read_text())["session_id"], SESSION)

        for stdin in ("not json", "[]", json.dumps({"session_id": "../../etc", "cwd": str(self.root)}),
                      json.dumps({"session_id": SESSION, "cwd": tempfile.mkdtemp()})):
            sc.hook(stdin, spawn=lambda args, cwd: spawned.append(args))
        self.assertEqual(len(spawned), 1)

        (self.root / ".claude" / "settings.json").write_text('{"hooks": {"SessionEnd": []}}')
        sc.hook(json.dumps(payload), spawn=lambda args, cwd: spawned.append(args))
        self.assertEqual(len(spawned), 1)


class NeverTheProjectTests(unittest.TestCase):
    """A session end commits and pushes a vault that is a repository of its own — and never the
    project's repository, a sibling's, or one the environment names."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        empty = self.tmp / "gitconfig"
        empty.write_text("")
        self.env = unittest.mock.patch.dict(os.environ, {
            "CLAUDE_VAULT_STATE": str(self.tmp / "state"), "CLAUDE_VAULT_NO_SPAWN": "1",
            "GIT_CONFIG_GLOBAL": str(empty), "GIT_CONFIG_NOSYSTEM": "1"})
        self.env.start()
        for key in ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        self.env.stop()

    def published(self, name: str) -> Path:
        """A repository with a commit, pushed to a bare remote, holding an untracked secret."""
        repo = self.tmp / name
        repo.mkdir()
        make_repo(repo)
        commit(repo, "init", "2026-09-01T10:00:00+00:00", "README.txt")
        remote = self.tmp / f"{name}.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
        git(repo, "remote", "add", "origin", str(remote))
        git(repo, "push", "-q", "-u", "origin", "main")
        (repo / ".env.local").write_text("SECRET=1\n")
        return repo

    def end_session(self, root: Path) -> None:
        payload = self.tmp / "state" / "payload.json"
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_text(json.dumps({"session_id": SESSION, "cwd": str(root), "transcript_path": "/none.jsonl"}))
        self.assertEqual(sc.worker(payload), 0)

    def assertUntouched(self, repo: Path) -> None:
        self.assertEqual(git(repo, "rev-list", "--count", "HEAD").strip(), "1", f"{repo} was committed")
        self.assertEqual(git(repo, "rev-list", "--count", "origin/main").strip(), "1")
        remote = self.tmp / f"{repo.name}.git"
        self.assertEqual(git(remote, "rev-list", "--count", "main").strip(), "1", f"{repo} was pushed")
        self.assertIn("?? .env.local", git(repo, "status", "--porcelain"))

    def test_a_declaration_naming_the_root_or_a_place_outside_it_commits_nothing(self) -> None:
        project, sibling = self.published("project"), self.published("sibling")
        os.symlink(str(sibling), str(project / "linked"))
        for declared in ("./", ".", "../sibling/", str(sibling) + "/", "linked/"):
            with self.subTest(declared=declared):
                (project / "CLAUDE.md").write_text(f"Knowledge-base directory: `{declared}`\n")
                self.end_session(project)
                self.assertUntouched(project)
                self.assertUntouched(sibling)

    def test_a_vault_commit_never_lands_in_the_repository_a_git_hook_handed_down(self) -> None:
        project = self.published("project")
        vault_dir = project / "kb"
        (vault_dir / "Decisions").mkdir(parents=True)
        (vault_dir / "To DO.md").write_text("## Now\n")
        make_repo(vault_dir)
        (project / "CLAUDE.md").write_text("Knowledge-base directory: `kb/`\n")
        with unittest.mock.patch.dict(os.environ, {"GIT_DIR": str(project / ".git"),
                                                   "GIT_INDEX_FILE": str(project / ".git" / "index")}):
            vault = vaultlib.locate(project)
            self.assertEqual(vault.mode, "own-repo")
            self.assertTrue(sc.commit_vault(vault, SESSION))
        self.assertUntouched(project)
        self.assertEqual(git(vault_dir, "rev-list", "--count", "HEAD").strip(), "1")
        self.assertIn("To DO.md", git(vault_dir, "ls-files"))

    def test_an_inbox_whose_lock_stays_taken_is_not_written_and_the_brief_says_so(self) -> None:
        project = self.published("project")
        vault_dir = project / "kb"
        (vault_dir / "Decisions").mkdir(parents=True)
        (vault_dir / "To DO.md").write_text("## Now\n")
        (project / "CLAUDE.md").write_text("Knowledge-base directory: `kb/`\n")
        sha = commit(project, "feat: shipped quietly", datetime.now().astimezone().isoformat(), "work.txt")
        transcript = self.tmp / "session.jsonl"
        now = datetime.now().astimezone().isoformat()
        transcript.write_text("\n".join([
            result("t0", "start", now), use("t1", "Bash", command="git commit -q -m 'feat: shipped quietly'"),
            result("t1", sha[:9], now)]) + "\n")
        vault = vaultlib.locate(project)
        payload = vault.state / "payload.json"
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_text(json.dumps({"session_id": SESSION, "cwd": str(project),
                                       "transcript_path": str(transcript)}))
        inbox = vault.machine_file("Inbox.md")
        with vaultlib.holding(sc.lock_path(vault)) as held, \
                unittest.mock.patch.object(sc, "CAPTURE_WAIT", 0.0):
            self.assertIsNotNone(held)
            self.assertEqual(sc.worker(payload), 0)
            self.assertFalse(inbox.exists(), "the inbox was written without the lock")
        self.assertTrue(any("was not checked for the inbox" in line for line in sc.sync_lines(vault)))

        payload.write_text(json.dumps({"session_id": SESSION, "cwd": str(project),
                                       "transcript_path": str(transcript)}))
        self.assertEqual(sc.worker(payload), 0)
        self.assertIn("feat: shipped quietly", inbox.read_text())


class InboxTests(unittest.TestCase):
    COMMITS = [{"sha": "39a095653ddefbd50fa8", "subject": "first", "tickets": ["241"], "time": 1}]

    def test_a_session_that_ends_twice_has_one_entry(self) -> None:
        first = sc.upsert_entry("", SESSION, sc.render_entry(SESSION, "2026-09-11", self.COMMITS))
        again = sc.upsert_entry(first, SESSION, sc.render_entry(SESSION, "2026-09-11", self.COMMITS * 2))
        self.assertEqual(again.count(f"<!-- session:{SESSION} -->"), 1)
        self.assertIn("## 2026-09-11 · 2 commits · #241", again)
        self.assertNotIn(SESSION, sc.remove_entry(again, SESSION))


if __name__ == "__main__":
    unittest.main()
