#!/usr/bin/env python3
"""Tests for how bin/session_capture.py keeps a shared vault in step with its remote.

Every case runs real git: clones of a bare repository in a temporary directory stand for the
members' machines, so a push, a refusal and a rebase are git's own.

Pinned, each against the way a shared vault goes wrong:
- two clones pushing at once both land, the later one after a fresh fetch and rebase;
- notes that do not rebase go to a conflict branch on the remote, the clone steps back to the
  remote, and the brief says where the notes are; with an unsaved edit in the tree it does not step
  back, and says so; a conflict branch merged or deleted on the remote leaves the brief;
- a push refused twice lands on the third attempt, after jittered waits that are never slept here;
- with the remote unreachable the notes stay committed on this machine and the brief says so;
- the session start fast-forwards only a clean clone without commits of its own, and says why not;
- the session start and the session end never work on one clone at once;
- the inbox counts only the reader's entries;
- what the merge drivers report — notes to regenerate, rows kept twice — reaches the brief.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import contextlib
import functools
import importlib
import io
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
sc = importlib.import_module("session_capture")
vaultlib = importlib.import_module("vaultlib")

SESSION = "07a27783-9167-4a1c-9d84-de57fac2b535"
MOMENT = datetime(2026, 10, 17, 18, 40, tzinfo=timezone.utc)
BOARD = "# To DO\n\n## Now\n- [ ] **#1 first row**\n- [ ] **#2 second row**\n\n## Done\n"
ANNOTATION = "<!-- vault-merge: two versions of this row; keep one -->"


def git(repo: Path, *args: str, check: bool = True) -> str:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=check)
    return done.stdout


def head(repo: Path, ref: str = "HEAD") -> str:
    return git(repo, "rev-parse", ref).strip()


def no_wait(record: list):
    """A sleep that only notes what it was asked for."""
    return record.append


class SharedVault(unittest.TestCase):
    """A bare remote holding a vault, and members who clone it."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="vault-sync-")).resolve()
        empty = self.tmp / "gitconfig"
        empty.write_text("")
        self.env = unittest.mock.patch.dict(os.environ, {
            "CLAUDE_VAULT_STATE": str(self.tmp / "state"), "CLAUDE_VAULT_NO_SPAWN": "1",
            "GIT_CONFIG_GLOBAL": str(empty), "GIT_CONFIG_NOSYSTEM": "1"})
        self.env.start()
        for key in ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "VAULT_HANDLE"):
            os.environ.pop(key, None)
        self.remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.remote)], check=True)
        seed = self.tmp / "seed"
        subprocess.run(["git", "clone", "-q", str(self.remote), str(seed)], check=True, capture_output=True)
        self.identify(seed, "Seed", "seed@example.com")
        (seed / "To DO.md").write_text(BOARD)
        (seed / "Decisions").mkdir()
        (seed / "Decisions" / "README.md").write_text("decisions\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-q", "-m", "seed")
        git(seed, "push", "-q", "origin", "main")

    def tearDown(self) -> None:
        self.env.stop()

    @staticmethod
    def identify(repo: Path, name: str, email: str) -> None:
        git(repo, "config", "user.name", name)
        git(repo, "config", "user.email", email)
        git(repo, "config", "commit.gpgsign", "false")

    def member(self, name: str, email: str = "") -> vaultlib.Vault:
        """A member's project with the vault cloned into it."""
        root = self.tmp / name
        root.mkdir()
        path = root / "kb"
        subprocess.run(["git", "clone", "-q", str(self.remote), str(path)], check=True, capture_output=True)
        self.identify(path, name.capitalize(), email or f"{name}@example.com")
        return vaultlib.Vault(root=root, path=path, mode="own-repo")

    def note(self, vault: vaultlib.Vault, name: str, text: str) -> None:
        (vault.path / name).parent.mkdir(parents=True, exist_ok=True)
        (vault.path / name).write_text(text)

    def edit_row(self, vault: vaultlib.Vault, row: str) -> None:
        board = (vault.path / "To DO.md").read_text()
        self.note(vault, "To DO.md", re.sub(r"\*\*#1 [^*]*\*\*", f"**#1 {row}**", board))

    def remote_files(self) -> set:
        return set(git(self.remote, "ls-tree", "-r", "--name-only", "main").split())


class IntegrationTests(SharedVault):
    def test_two_clones_pushing_at_once_both_land(self) -> None:
        alice, bob = self.member("alice"), self.member("bob")
        self.note(alice, "Modules/a.md", "alice's note\n")
        self.note(bob, "Modules/b.md", "bob's note\n")
        self.assertTrue(sc.commit_vault(alice, SESSION))
        self.assertTrue(sc.commit_vault(bob, SESSION))

        outcomes: dict = {}

        def integrate(vault: vaultlib.Vault) -> None:
            outcomes[vault.root.name] = sc.integrate_vault(vault, sleep=no_wait([]), now=lambda: MOMENT)

        threads = [threading.Thread(target=integrate, args=(v,)) for v in (alice, bob)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(outcomes, {"alice": "pushed", "bob": "pushed"})
        self.assertLessEqual({"Modules/a.md", "Modules/b.md"}, self.remote_files())

    def test_a_push_beaten_by_another_member_is_rebased_onto_theirs_and_lands(self) -> None:
        alice, bob = self.member("alice"), self.member("bob")
        self.note(alice, "Modules/a.md", "alice's note\n")
        self.note(bob, "Modules/b.md", "bob's note\n")
        sc.commit_vault(alice, SESSION)
        sc.commit_vault(bob, SESSION)
        original, beaten = sc.net, []

        def bob_pushes_first(vault, *args, **kwargs):
            if vault is alice and args[0] == "push" and not beaten:
                beaten.append(sc.integrate_vault(bob, sleep=no_wait([])))
            return original(vault, *args, **kwargs)

        waits: list = []
        with unittest.mock.patch.object(sc, "net", bob_pushes_first):
            outcome = sc.integrate_vault(alice, sleep=no_wait(waits), jitter=random.uniform)

        self.assertEqual((beaten, outcome), (["pushed"], "pushed"))
        self.assertEqual(len(waits), 1)
        self.assertTrue(1.0 <= waits[0] <= 4.0)
        self.assertEqual(head(alice.path), head(self.remote, "main"))
        self.assertEqual(git(self.remote, "log", "--format=%an", "main").split()[:2], ["Alice", "Bob"])

    def test_a_push_refused_twice_lands_on_the_third_attempt(self) -> None:
        counter = self.tmp / "refusals"
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text(f"#!/bin/sh\nn=$(cat '{counter}' 2>/dev/null || echo 0)\necho $((n + 1)) > '{counter}'\n"
                        f"[ \"$n\" -ge 2 ] && exit 0\necho 'busy, try again' >&2\nexit 1\n")
        hook.chmod(0o755)
        alice = self.member("alice")
        self.note(alice, "Modules/a.md", "note\n")
        sc.commit_vault(alice, SESSION)
        waits: list = []

        self.assertEqual(sc.integrate_vault(alice, sleep=no_wait(waits), jitter=random.uniform), "pushed")

        self.assertEqual(counter.read_text().strip(), "3")
        self.assertEqual(len(waits), 2)
        self.assertTrue(all(1.0 <= w <= 4.0 for w in waits))
        self.assertIn("Modules/a.md", self.remote_files())
        self.assertEqual(sc.sync_lines(alice), [])

    def test_a_push_refused_every_time_is_reported_and_kept(self) -> None:
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        alice = self.member("alice")
        self.note(alice, "Modules/a.md", "note\n")
        sc.commit_vault(alice, SESSION)
        waits: list = []

        self.assertEqual(sc.integrate_vault(alice, sleep=no_wait(waits), jitter=lambda a, b: a, now=lambda: MOMENT),
                         "rejected")

        self.assertEqual(waits, [1.0, 1.0])
        self.assertEqual(sc.unpushed(alice), 1)
        line = sc.sync_lines(alice)[0]
        self.assertTrue(line.startswith("[VAULT] the vault's remote refused 3 pushes at "), line)

    def test_an_unreachable_remote_leaves_the_notes_committed_here_and_says_so(self) -> None:
        alice = self.member("alice")
        git(alice.path, "remote", "set-url", "origin", str(self.tmp / "gone.git"))
        self.note(alice, "Modules/a.md", "note\n")
        self.assertTrue(sc.commit_vault(alice, SESSION))

        self.assertEqual(sc.integrate_vault(alice, sleep=no_wait([]), now=lambda: MOMENT), "offline")

        self.assertEqual(git(alice.path, "status", "--porcelain"), "")
        self.assertEqual(sc.unpushed(alice), 1)
        self.assertIn("could not be reached", sc.sync_lines(alice)[0])
        self.assertIn("committed on this machine", sc.sync_lines(alice)[0])
        self.assertIn("vault fetch failed", (alice.state / "session-capture.log").read_text())

    def test_a_clean_push_clears_what_a_failed_one_left_for_the_brief(self) -> None:
        alice = self.member("alice")
        url = git(alice.path, "remote", "get-url", "origin").strip()
        git(alice.path, "remote", "set-url", "origin", str(self.tmp / "gone.git"))
        self.note(alice, "Modules/a.md", "note\n")
        sc.commit_vault(alice, SESSION)
        sc.integrate_vault(alice, sleep=no_wait([]))
        git(alice.path, "remote", "set-url", "origin", url)

        self.assertEqual(sc.integrate_vault(alice, sleep=no_wait([])), "pushed")
        self.assertEqual(sc.sync_lines(alice), [])

    def test_nothing_of_ours_to_deliver_touches_no_remote(self) -> None:
        alice = self.member("alice")
        with unittest.mock.patch.object(sc, "net", side_effect=AssertionError("no network wanted")):
            self.assertEqual(sc.integrate_vault(alice), "current")


class ConflictTests(SharedVault):
    def setUp(self) -> None:
        super().setUp()
        self.alice, self.bob = self.member("alice"), self.member("bob")
        git(self.alice.path, "config", "vault.handle", "Alice A.")
        self.edit_row(self.bob, "bob renamed the first row")
        sc.commit_vault(self.bob, SESSION)
        self.assertEqual(sc.integrate_vault(self.bob, sleep=no_wait([])), "pushed")
        self.edit_row(self.alice, "alice renamed it too")
        sc.commit_vault(self.alice, SESSION)
        self.notes = head(self.alice.path)

    def test_notes_that_do_not_rebase_go_to_a_branch_of_their_own_and_the_clone_steps_back(self) -> None:
        self.assertEqual(sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT), "conflict")

        branch = "conflict/alice-a/20261017-1840"
        self.assertEqual(head(self.remote, branch), self.notes)
        self.assertEqual(head(self.alice.path), head(self.remote, "main"))
        self.assertEqual(git(self.alice.path, "status", "--porcelain"), "")
        self.assertFalse(sc.rebasing(self.alice))
        when = MOMENT.astimezone().strftime("%Y-%m-%d %H:%M")
        self.assertEqual(sc.sync_lines(self.alice),
                         [f"[VAULT CONFLICT] your notes from {when} are on branch {branch} — merge them"])

    def test_a_second_conflict_in_the_same_minute_gets_a_branch_of_its_own(self) -> None:
        sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT)
        self.edit_row(self.alice, "alice tries again")
        sc.commit_vault(self.alice, SESSION)
        self.edit_row(self.bob, "bob moves on")
        sc.commit_vault(self.bob, SESSION)
        sc.integrate_vault(self.bob, sleep=no_wait([]))

        self.assertEqual(sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT), "conflict")
        self.assertTrue(head(self.remote, "conflict/alice-a/20261017-1840-2"))
        self.assertEqual(len(sc.sync_lines(self.alice)), 2)

    def test_an_unsaved_edit_in_the_tree_keeps_the_clone_where_it_is(self) -> None:
        self.note(self.alice, "Modules/unsaved.md", "another session's note, not committed yet\n")

        self.assertEqual(sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT), "conflict-dirty")

        self.assertEqual(head(self.alice.path), self.notes)
        self.assertEqual(head(self.remote, "conflict/alice-a/20261017-1840"), self.notes)
        self.assertTrue((self.alice.path / "Modules" / "unsaved.md").is_file())
        line = sc.sync_lines(self.alice)[0]
        self.assertIn("are on branch conflict/alice-a/20261017-1840 — merge them", line)
        self.assertIn("not reset to the remote", line)

    def test_a_tracked_edit_while_the_remote_moved_defers_the_rebase(self) -> None:
        self.note(self.alice, "Decisions/README.md", "edited, unsaved\n")

        self.assertEqual(sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT), "deferred")

        self.assertEqual(head(self.alice.path), self.notes)
        self.assertFalse(sc.rebasing(self.alice))
        self.assertIn("uncommitted edits", sc.sync_lines(self.alice)[0])

    def test_a_conflict_branch_merged_on_the_remote_leaves_the_brief(self) -> None:
        sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT)
        branch = "conflict/alice-a/20261017-1840"
        git(self.bob.path, "fetch", "-q", "origin")
        git(self.bob.path, "merge", "-q", "-s", "ours", "-m", "merge alice's notes", f"origin/{branch}")
        git(self.bob.path, "push", "-q", "origin", "main")

        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])),
                         ["[VAULT] brought up to date — 2 commits from the remote"])
        self.assertEqual(sc.sync_lines(self.alice), [])

    def test_a_conflict_branch_deleted_on_the_remote_leaves_the_brief(self) -> None:
        sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT)
        git(self.remote, "branch", "-D", "conflict/alice-a/20261017-1840")

        sc.update_vault(self.alice, sleep=no_wait([]))
        self.assertEqual(sc.sync_lines(self.alice), [])

    def test_the_brief_prints_the_conflict_line(self) -> None:
        sc.integrate_vault(self.alice, sleep=no_wait([]), now=lambda: MOMENT)
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            sc.brief(self.alice)
        self.assertIn("[VAULT CONFLICT] your notes from ", printed.getvalue())
        self.assertIn("are on branch conflict/alice-a/20261017-1840 — merge them", printed.getvalue())


class UpdateTests(SharedVault):
    def setUp(self) -> None:
        super().setUp()
        self.alice, self.bob = self.member("alice"), self.member("bob")
        self.note(self.bob, "Modules/b.md", "bob's note\n")
        sc.commit_vault(self.bob, SESSION)
        sc.integrate_vault(self.bob, sleep=no_wait([]))

    def test_a_clean_clone_without_commits_of_its_own_is_fast_forwarded(self) -> None:
        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])),
                         ["[VAULT] brought up to date — 1 commit from the remote"])
        self.assertEqual(head(self.alice.path), head(self.remote, "main"))
        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])), [])

    def test_uncommitted_edits_are_left_alone_and_named(self) -> None:
        self.note(self.alice, "Modules/a.md", "unsaved\n")
        before = head(self.alice.path)
        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])),
                         ["[VAULT] the remote has 1 vault commit this clone lacks — not merged: the vault has "
                          "uncommitted edits; the next session end integrates them"])
        self.assertEqual(head(self.alice.path), before)

    def test_commits_of_its_own_are_left_for_the_session_end_to_rebase(self) -> None:
        self.note(self.alice, "Modules/a.md", "alice's note\n")
        sc.commit_vault(self.alice, SESSION)
        before = head(self.alice.path)
        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])),
                         ["[VAULT] the remote has 1 vault commit this clone lacks — not merged: this clone has "
                          "1 commit of its own; the next session end rebases them"])
        self.assertEqual(head(self.alice.path), before)
        self.assertFalse(sc.rebasing(self.alice))

    def test_an_unreachable_remote_is_said_and_the_local_copy_used(self) -> None:
        git(self.alice.path, "remote", "set-url", "origin", str(self.tmp / "gone.git"))
        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])),
                         ["[VAULT] the vault's remote could not be reached — this session reads the local copy"])

    def test_a_vault_without_a_remote_is_not_fetched(self) -> None:
        git(self.alice.path, "remote", "remove", "origin")
        self.assertEqual(sc.update_vault(self.alice, sleep=no_wait([])), [])


class LockTests(SharedVault):
    def setUp(self) -> None:
        super().setUp()
        self.alice, self.bob = self.member("alice"), self.member("bob")

    def test_the_session_start_does_not_touch_a_clone_the_session_end_is_working_on(self) -> None:
        self.note(self.bob, "Modules/b.md", "bob's note\n")
        sc.commit_vault(self.bob, SESSION)
        sc.integrate_vault(self.bob, sleep=no_wait([]))
        before = head(self.alice.path)
        with vaultlib.holding(sc.lock_path(self.alice)) as held:
            self.assertIsNotNone(held)
            with unittest.mock.patch.object(sc, "net", side_effect=AssertionError("fetched under a held lock")):
                lines = sc.update_vault(self.alice, wait=0.0)
        self.assertEqual(lines, ["[VAULT] not brought up to date — another session is syncing the vault"])
        self.assertEqual(head(self.alice.path), before)

    def test_the_session_end_waits_for_the_session_start_to_finish(self) -> None:
        self.note(self.alice, "Modules/a.md", "note\n")
        sc.commit_vault(self.alice, SESSION)
        events: list = []
        lock = sc.lock_path(self.alice)
        holder = vaultlib.holding(lock)
        self.assertIsNotNone(holder.__enter__())
        original = sc.net

        def brief_finishes(seconds: float) -> None:
            events.append("waited")
            if lock.exists():
                holder.__exit__(None, None, None)
                events.append("released")

        def recording(vault, *args, **kwargs):
            events.append(args[0])
            return original(vault, *args, **kwargs)

        with unittest.mock.patch.object(sc, "net", recording):
            self.assertEqual(sc.integrate_vault(self.alice, wait=60.0, sleep=brief_finishes), "pushed")
        self.assertEqual(events[:3], ["waited", "released", "fetch"])
        self.assertFalse(lock.exists())

    def test_the_commit_waits_for_the_lock_and_never_races_it(self) -> None:
        self.note(self.alice, "Modules/a.md", "note\n")
        lock = sc.lock_path(self.alice)
        with vaultlib.holding(lock):
            self.assertFalse(sc.commit_vault(self.alice, SESSION))
        self.assertTrue(git(self.alice.path, "status", "--porcelain").strip())

        holder = vaultlib.holding(lock)
        holder.__enter__()
        self.assertTrue(sc.commit_vault(self.alice, SESSION, wait=60.0,
                                        sleep=lambda s: holder.__exit__(None, None, None)))
        self.assertEqual(git(self.alice.path, "status", "--porcelain"), "")


class InboxTests(SharedVault):
    def entry(self, session: str, day: str, by: str = "") -> str:
        commits = [{"sha": "39a095653ddefbd50fa8", "subject": "work", "tickets": [], "time": 1}]
        return sc.render_entry(session, day, commits, by)

    def test_an_inbox_counts_only_the_readers_entries(self) -> None:
        alice = self.member("alice")
        git(alice.path, "config", "vault.handle", "alice")
        mine = sc.upsert_entry(sc.INBOX_HEAD, "aaaaaaaa-legacy-alice", self.entry("aaaaaaaa-legacy-alice", "2026-09-01"))
        self.note(alice, "Inbox.md", mine)
        git(alice.path, "add", "Inbox.md")
        git(alice.path, "commit", "-q", "-m", "alice's entry, written before entries named their author")
        theirs = sc.upsert_entry(mine, "bbbbbbbb-legacy-bob", self.entry("bbbbbbbb-legacy-bob", "2026-09-02"))
        self.note(alice, "Inbox.md", theirs)
        git(alice.path, "commit", "-q", "-am", "bob's entry, the same", "--author", "Bob <bob@example.com>")
        text = sc.upsert_entry(theirs, "cccccccc-by-bob", self.entry("cccccccc-by-bob", "2026-09-03", "bob"))
        text = sc.upsert_entry(text, "dddddddd-by-alice", self.entry("dddddddd-by-alice", "2026-09-05", "alice"))
        text = sc.upsert_entry(text, "eeeeeeee-not-committed", self.entry("eeeeeeee-not-committed", "2026-09-04"))
        self.note(alice, "Inbox.md", text)

        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            sc.brief(alice)
        inbox = [line for line in printed.getvalue().splitlines() if line.startswith("[INBOX]")]
        self.assertEqual(len(inbox), 1)
        self.assertIn("[INBOX] 3 sessions committed work with no journal entry (oldest 2026-09-01)", inbox[0])
        self.assertIn("yours are the entries by alice", inbox[0])

        unattributed = functools.partial(sc.blamed_sessions, alice.path, "Inbox.md", "bob@example.com")
        bob = sc.brief_lines(alice, text, True, 0, 0, "bob", unattributed)
        self.assertIn("[INBOX] 3 sessions committed work with no journal entry (oldest 2026-09-02)", bob[0])

    def test_an_inbox_in_state_is_one_machines_and_counted_whole(self) -> None:
        text = sc.upsert_entry("", "cccccccc-by-bob", self.entry("cccccccc-by-bob", "2026-09-03", "bob"))
        vault = vaultlib.Vault(root=self.tmp, path=self.tmp / "kb", mode="untracked")
        self.assertIn("[INBOX] 1 session committed", sc.brief_lines(vault, text, False, None, 0)[0])

    def test_an_entry_records_its_author_and_either_shape_is_read(self) -> None:
        self.assertIn("\n- by: alice\n", self.entry(SESSION, "2026-09-11", "alice"))
        marked = f"<!-- session:{SESSION} by:carol -->\n## 2026-09-11 · 1 commit\n\n<!-- /session -->\n"
        self.assertEqual(sc.inbox_entries(marked), [{"session": SESSION, "day": "2026-09-11", "author": "carol"}])
        self.assertEqual(sc.remove_entry(sc.INBOX_HEAD + "\n" + marked, SESSION).count("session:"), 0)
        replaced = sc.upsert_entry(sc.INBOX_HEAD + "\n" + marked, SESSION, self.entry(SESSION, "2026-09-12", "carol"))
        self.assertEqual(replaced.count(f"session:{SESSION}"), 1)
        self.assertIn("2026-09-12", replaced)

    def test_capture_writes_the_author_into_the_entry(self) -> None:
        alice = self.member("alice")
        git(alice.path, "config", "vault.handle", "alice")
        project = alice.root
        git(project, "init", "-q", "-b", "main")
        self.identify(project, "Alice", "alice@example.com")
        (project / "work.txt").write_text("x")
        git(project, "add", "work.txt")
        git(project, "commit", "-q", "-m", "feat: shipped")
        sha = head(project)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        lines = [
            '{"type": "assistant", "timestamp": "%s", "message": {"content": [{"type": "tool_use", "id": "t1", '
            '"name": "Bash", "input": {"command": "git commit -q -m x"}}]}}' % stamp,
            '{"type": "user", "timestamp": "%s", "message": {"content": [{"type": "tool_result", '
            '"tool_use_id": "t1", "content": "%s"}]}}' % (stamp, sha[:9]),
        ]
        self.assertTrue(sc.capture(alice, SESSION, lines, "2026-10-17"))
        self.assertIn("- by: alice\n", (alice.path / "Inbox.md").read_text())


class MergeReportTests(SharedVault):
    def test_notes_to_regenerate_and_rows_kept_twice_reach_the_brief(self) -> None:
        alice = self.member("alice")
        found = sc.git_dir(alice)
        (found / "vault-regenerate").write_text("Modules/a.md\nModules/b.md\nModules/a.md\n\n")
        board = BOARD.replace("- [ ] **#2", f"{ANNOTATION}\n- [ ] **#1 again**\n{ANNOTATION}\n- [ ] **#2")
        self.note(alice, "To DO.md", board)
        self.note(alice, "Inbox.md", f"# Inbox\n\n  {ANNOTATION}\n- entry\n")
        self.note(alice, "Decisions/Merging.md", f"A quoted `{ANNOTATION}` in prose is no row.\n")
        git(alice.path, "add", "-A")
        git(alice.path, "commit", "-q", "-m", "merged")

        self.assertEqual(sc.merge_lines(alice), [
            f"[VAULT] regenerate: Modules/a.md, Modules/b.md — refresh their generated facts, then delete "
            f"{alice.shown(found / 'vault-regenerate')}",
            "[VAULT] 3 rows have two versions — keep one · Inbox.md (1), To DO.md (2)",
        ])

    def test_nothing_reported_says_nothing(self) -> None:
        self.assertEqual(sc.merge_lines(self.member("alice")), [])


class HandleTests(SharedVault):
    def test_a_configured_handle_wins_then_the_environment_then_the_git_user_name(self) -> None:
        alice = self.member("alice")
        git(alice.path, "config", "user.name", "Ada  Lovelace")
        self.assertEqual(vaultlib.handle(alice.path), "ada-lovelace")
        with unittest.mock.patch.dict(os.environ, {"VAULT_HANDLE": "Countess_1815"}):
            self.assertEqual(vaultlib.handle(alice.path), "countess-1815")
            git(alice.path, "config", "vault.handle", "ada")
            self.assertEqual(vaultlib.handle(alice.path), "ada")


if __name__ == "__main__":
    unittest.main()
