#!/usr/bin/env python3
"""Tests for what the session end holds back from a vault's commit because it looks like a credential.

Every value that must be held is built when the test runs, so no token-shaped literal sits in this file.

Pinned, each against the way a shared vault leaks:
- a `.env`, a private key file and a note with a live token never reach the remote, stay in the work
  tree, and the next brief names each with its reason and never its value;
- a placeholder, a truncated token and prose about token formats are committed and pushed as before;
- a held file never blocks the rest: the other notes of the same pass land;
- a held edit of a tracked note is committed once the value is taken out, and leaves the brief;
- a held new file does not stop the session start's fast-forward, and a held tracked edit that stops
  a rebase is named on the brief.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import string
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
cf = importlib.import_module("credential_filter")
sc = importlib.import_module("session_capture")
vaultlib = importlib.import_module("vaultlib")

SESSION = "07a27783-9167-4a1c-9d84-de57fac2b535"
ALNUM = string.ascii_letters + string.digits
UPPER = string.ascii_uppercase + string.digits


def shaped(prefix: str, length: int, alphabet: str = ALNUM, step: int = 7) -> str:
    """A token-shaped value made up here: a prefix and `length` characters spread over the alphabet."""
    return prefix + "".join(alphabet[(at * step + 3) % len(alphabet)] for at in range(length))


HOST_TOKEN = shaped("ghp_", 36)
CI_TOKEN = shaped("glpat-", 20)
CHAT = shaped("xoxb-", 24, step=5)
PAYMENT = shaped("sk_" + "live_", 24, step=11)
MODEL = shaped("sk-" + "ant-", 40, step=13)
CLOUD = shaped("AK" + "IA", 16, UPPER)
SIGNED = ".".join(shaped("eyJ", 20, step=s) for s in (3, 5)) + "." + shaped("", 30, step=17)
BEARER = shaped("", 32, step=19)
URI_SECRET = "S3cr3t-Passw0rd"
KEY_BODY = shaped("", 70, ALNUM + "+/", step=23)
KEY_FILE = "\n".join(["-----BEGIN OPENSSH " + "PRIVATE KEY-----", KEY_BODY, KEY_BODY, "-----END OPENSSH PRIVATE KEY-----"])
VALUES = (HOST_TOKEN, CI_TOKEN, CHAT, PAYMENT, MODEL, CLOUD, SIGNED, BEARER, URI_SECRET, KEY_BODY)

PLACEHOLDERS = "\n".join([
    "# Deploy settings", "",
    "DB_PASSWORD=changeme", "API_KEY=${API_KEY}", "api_key: <your key>", "password: ***", "secret: REDACTED",
    "REPO_TOKEN=your_token_here", "token: …", "password: %(password)s", "auth_token: {token}",
    "PASSWORD=short1", "DATABASE_URL=postgres://app:${DB_PASS}@db/app", "local: postgres://app:app@localhost/app",
    "token = os.getenv(\"TOKEN\")", "secret: settings.SECRET_KEY", "password: DB_PASSWORD_FROM_ENV",
    "password: xxxxxxxxxxxx", "documented sample key id: " + "AK" + "IAIOSFODNN7EXAMPLE", ""])
PROSE = "\n".join([
    "# Token formats", "",
    "A personal access token starts with `ghp_` and 36 characters follow it; notes show it as `ghp_…`.",
    "A JWT is three base64url parts, `eyJ….eyJ….…`, and a call sends `Authorization: Bearer <token>`.",
    "A connection string with a password reads `scheme://user:pass@host`; we never write one down.",
    "The token: regenerated weekly. Its max_tokens: 4096 and tokens_per_minute: 10000000.",
    "bypass_until: 2026-10-01T10:00 — and a key file starts with `-----BEGIN OPENSSH PRIVATE KEY-----`.", ""])


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


class FilterTests(unittest.TestCase):
    """The shapes the filter holds, and the prose and placeholders it lets through."""

    def test_files_named_like_credentials_are_held_and_their_templates_are_not(self) -> None:
        for path in (".env", "config/.env.local", "Journal/id_ed25519", "keys/id_rsa", "id_ecdsa_work", "server.pem",
                     "tls.key", "cert.p12", "cert.pfx", "release.keystore", "passwords.kdbx", ".netrc", ".pgpass",
                     "credentials.json", "client_secret_123.json"):
            self.assertTrue(cf.named_like_credentials(path), path)
        for path in (".env.example", ".env.dist", "id_ed25519.pub", "Decisions/Secrets in CI.md", "Modules/keys.md",
                     ".envrc.md", "Journal/2026-10-01.md"):
            self.assertFalse(cf.named_like_credentials(path), path)

    def test_every_common_shape_of_a_live_value_is_held_with_its_reason(self) -> None:
        cases = {
            "REPO_TOKEN=" + HOST_TOKEN: cf.ACCESS_TOKEN,
            "token " + shaped("github_" + "pat_", 30): cf.ACCESS_TOKEN,
            "runner: " + CI_TOKEN: cf.ACCESS_TOKEN,
            "export HOOK=" + CHAT: cf.ACCESS_TOKEN,
            "charges with " + PAYMENT: cf.ACCESS_TOKEN,
            "model key " + MODEL: cf.ACCESS_TOKEN,
            "CLOUD_ACCESS_KEY_ID=" + CLOUD: cf.ACCESS_KEY,
            "cookie " + SIGNED: cf.SIGNED_TOKEN,
            "curl -H 'Authorization: Bearer " + BEARER + "' https://api.internal/": cf.BEARER,
            "DATABASE_URL=postgres://app:" + URI_SECRET + "@db:5432/app": cf.URI_PASSWORD,
            "DB_PASSWORD=Tr0ub4dor&3x": cf.ASSIGNED_SECRET,
            "smtpPass: \"Kx9-pq2_Lm7\"": cf.ASSIGNED_SECRET,
            "\"client_secret\": \"a8f5f167f44f4964e6c998dee827110c\"": cf.ASSIGNED_SECRET,
            "**Password:** Hunter2abc!": cf.ASSIGNED_SECRET,
            "https://api.internal/v1?api_key=9f8e7d6c5b4a3": cf.ASSIGNED_SECRET,
            "\"private_key\": \"-----BEGIN " + "PRIVATE KEY-----\\n" + KEY_BODY + "\\n\"": cf.PRIVATE_KEY,
        }
        for line, reason in cases.items():
            self.assertEqual(cf.content_reason([line]), reason, line)
        self.assertEqual(cf.content_reason(KEY_FILE.splitlines()), cf.PRIVATE_KEY)

    def test_placeholders_truncated_tokens_and_prose_about_formats_pass(self) -> None:
        code = ['"wait_token": "wait_01HXY...",', "$waitToken = Ulid::generate()->toString();",
                "Authorization: Bearer en_<engine_api_token>", "{ wait_token: waitToken, values }",
                "The container's compiler pass: `ResolvesContractsPass` runs last.",
                "A check at `PassConfig::TYPE_BEFORE_REMOVING` sees every definition."]
        for line in PLACEHOLDERS.splitlines() + PROSE.splitlines() + code:
            self.assertIsNone(cf.content_reason([line]), line)

    def test_unreadable_lines_never_count_as_clean_and_a_name_decides_without_reading(self) -> None:
        self.assertEqual(cf.why_held("Modules/a.md", lambda: None), "could not be read")
        self.assertEqual(cf.why_held(".env", lambda: self.fail("read although the name decided")),
                         cf.NAMED_LIKE_CREDENTIALS)
        self.assertIsNone(cf.why_held("Modules/a.md", lambda: ["a plain note"]))


class HoldTests(unittest.TestCase):
    """A project whose vault is a clone of a bare remote, ended by the session-end worker."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="vault-hold-")).resolve()
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
        seed = self.clone("seed")
        self.write(seed, "To DO.md", "## Now\n- [ ] first\n## Next\n## Done\n")
        self.write(seed, "Decisions/README.md", "decisions\n")
        self.write(seed, "Modules/deploy.md", "# Deploy\n\nRuns on push.\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-q", "-m", "seed")
        git(seed, "push", "-q", "origin", "main")
        self.project = self.tmp / "project"
        self.project.mkdir()
        (self.project / "CLAUDE.md").write_text("Knowledge-base directory: `kb/`\n")
        self.clone("project/kb")
        self.vault = vaultlib.locate(self.project)
        self.assertEqual(self.vault.mode, "own-repo")

    def tearDown(self) -> None:
        self.env.stop()

    def clone(self, where: str) -> Path:
        path = self.tmp / where
        subprocess.run(["git", "clone", "-q", str(self.remote), str(path)], check=True, capture_output=True)
        git(path, "config", "user.name", "Alice")
        git(path, "config", "user.email", "alice@example.com")
        git(path, "config", "commit.gpgsign", "false")
        return path

    @staticmethod
    def write(repo: Path, name: str, text: str) -> None:
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(text)

    def end_session(self) -> None:
        payload = self.vault.state / "payloads" / f"{SESSION}.json"
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_text(json.dumps({"session_id": SESSION, "cwd": str(self.project),
                                       "transcript_path": str(self.tmp / "none.jsonl")}))
        self.assertEqual(sc.worker(payload), 0)

    def next_brief(self) -> str:
        """What the next session's brief prints, run as the session-start hook runs it."""
        done = subprocess.run([sys.executable, str(Path(sc.__file__)), "--brief"], cwd=str(self.project),
                              capture_output=True, text=True, check=True)
        return done.stdout

    def remote_files(self) -> set:
        return set(git(self.remote, "ls-tree", "-r", "--name-only", "main").splitlines())

    def published(self) -> str:
        """Everything the remote ever received, every version of every file."""
        return git(self.remote, "log", "--all", "-p", "--format=%H %s")

    def assertNoValue(self, text: str, where: str) -> None:
        for value in VALUES:
            self.assertNotIn(value, text, f"a held value reached {where}")

    def test_credentials_stay_here_and_everything_else_reaches_the_remote(self) -> None:
        kb = self.vault.path
        self.write(kb, ".env", f"CLOUD_ACCESS_KEY_ID={CLOUD}\nREPO_TOKEN={HOST_TOKEN}\n")
        self.write(kb, ".env.example", "CLOUD_ACCESS_KEY_ID=\nREPO_TOKEN=your_token_here\n")
        self.write(kb, "Journal/id_ed25519", KEY_FILE + "\n")
        self.write(kb, "Modules/runner.md", f"# Runner\n\nregistered with {CI_TOKEN}\n")
        self.write(kb, "Modules/database.md", f"# Database\n\nDATABASE_URL=postgres://app:{URI_SECRET}@db/app\n")
        self.write(kb, "Modules/settings.md", PLACEHOLDERS)
        self.write(kb, "Decisions/Token formats.md", PROSE)
        self.write(kb, "Modules/plain.md", "# Plain\n\nNothing secret here.\n")

        self.end_session()

        held = {".env", "Journal/id_ed25519", "Modules/runner.md", "Modules/database.md"}
        landed = {".env.example", "Modules/settings.md", "Decisions/Token formats.md", "Modules/plain.md"}
        self.assertLessEqual(landed, self.remote_files())
        self.assertFalse(held & self.remote_files(), held & self.remote_files())
        self.assertNoValue(self.published(), "the remote")
        status = git(kb, "status", "--porcelain", "--untracked-files=all").splitlines()
        self.assertEqual(sorted(line[3:] for line in status), sorted(held))
        self.assertTrue(all(line.startswith("?? ") for line in status), status)
        self.assertIn(HOST_TOKEN, (kb / ".env").read_text(), "the held file was changed in the work tree")

        brief = self.next_brief()
        tail = " — take the value out, or commit it by hand if it is no credential"
        for path, reason in ((".env", cf.NAMED_LIKE_CREDENTIALS), ("Journal/id_ed25519", cf.NAMED_LIKE_CREDENTIALS),
                             ("Modules/runner.md", cf.ACCESS_TOKEN), ("Modules/database.md", cf.URI_PASSWORD)):
            self.assertIn(f"[VAULT] not committed: {path} ({reason}){tail}", brief)
        self.assertNotIn("Modules/settings.md", brief)
        self.assertNoValue(brief, "the brief")
        self.assertNoValue((self.vault.state / "session-capture.log").read_text(), "the log")
        self.assertNoValue((self.vault.state / sc.SYNC_STATE).read_text(), "the state file")

    def test_a_held_edit_of_a_tracked_note_is_committed_once_the_value_is_out(self) -> None:
        kb = self.vault.path
        self.write(kb, "Modules/deploy.md", f"# Deploy\n\nRuns on push.\nREPO_TOKEN={HOST_TOKEN}\n")
        self.write(kb, "Modules/next.md", "# Next\n")

        self.end_session()

        self.assertIn("Modules/next.md", self.remote_files())
        self.assertNotIn(HOST_TOKEN, self.published())
        self.assertEqual(git(kb, "status", "--porcelain"), " M Modules/deploy.md\n")
        self.assertIn(f"[VAULT] not committed: Modules/deploy.md ({cf.ACCESS_TOKEN})", self.next_brief())

        self.end_session()
        self.assertIn("[VAULT] not committed: Modules/deploy.md", self.next_brief(), "a second pass forgot it")

        self.write(kb, "Modules/deploy.md", "# Deploy\n\nRuns on push.\nREPO_TOKEN=${REPO_TOKEN}\n")
        self.end_session()

        self.assertIn("REPO_TOKEN=${REPO_TOKEN}", git(self.remote, "show", "main:Modules/deploy.md"))
        self.assertEqual(git(kb, "status", "--porcelain"), "")
        self.assertNotIn("[VAULT] not committed", self.next_brief())

    def test_a_held_rename_keeps_both_paths_out_of_the_commit(self) -> None:
        kb = self.vault.path
        body = "# Deploy\n\n" + "".join(f"- step {n}: runs on push\n" for n in range(12))
        self.write(kb, "Modules/deploy.md", body)
        git(kb, "commit", "-q", "-am", "a longer note")
        git(kb, "mv", "Modules/deploy.md", "Modules/release.md")
        self.write(kb, "Modules/release.md", f"{body}REPO_TOKEN={HOST_TOKEN}\n")
        self.write(kb, "Modules/other.md", "other\n")

        self.assertTrue(sc.commit_vault(self.vault, SESSION))

        self.assertEqual(git(kb, "show", "--name-status", "--format=", "HEAD"), "A\tModules/other.md\n")
        self.assertEqual(sc.read_state(self.vault)["held"], [
            {"path": "Modules/release.md", "reason": cf.ACCESS_TOKEN},
            {"path": "Modules/deploy.md", "reason": "renamed to Modules/release.md"}])

    def test_a_held_new_file_does_not_stop_the_session_start_fast_forward(self) -> None:
        self.write(self.vault.path, ".env", f"REPO_TOKEN={HOST_TOKEN}\n")
        self.assertFalse(sc.commit_vault(self.vault, SESSION))
        teammate = self.clone("bob")
        self.write(teammate, "Modules/b.md", "bob's note\n")
        git(teammate, "add", "-A")
        git(teammate, "commit", "-q", "-m", "bob")
        git(teammate, "push", "-q", "origin", "main")

        self.assertEqual(sc.update_vault(self.vault, sleep=lambda _s: None),
                         ["[VAULT] brought up to date — 1 commit from the remote"])
        self.assertTrue((self.vault.path / ".env").is_file())

    def test_a_held_tracked_edit_that_stops_a_rebase_is_named(self) -> None:
        kb = self.vault.path
        self.write(kb, "Modules/deploy.md", f"# Deploy\n\nREPO_TOKEN={HOST_TOKEN}\n")
        self.write(kb, "Modules/mine.md", "my note\n")
        self.assertTrue(sc.commit_vault(self.vault, SESSION))
        teammate = self.clone("bob")
        self.write(teammate, "Modules/b.md", "bob's note\n")
        git(teammate, "add", "-A")
        git(teammate, "commit", "-q", "-m", "bob")
        git(teammate, "push", "-q", "origin", "main")

        self.assertEqual(sc.integrate_vault(self.vault, sleep=lambda _s: None), "deferred")
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            sc.brief(self.vault)
        self.assertIn("not rebased: edits held back from the commit stand in the way (Modules/deploy.md)",
                      printed.getvalue())
        self.assertNoValue(printed.getvalue(), "the brief")


if __name__ == "__main__":
    unittest.main()
