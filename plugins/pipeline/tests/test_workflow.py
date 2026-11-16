#!/usr/bin/env python3
"""Runs the review workflow's node tests from the plugin's unittest suite, so one command covers both.

The workflow script is JavaScript run by the Workflow tool; its tests (tests/workflow/review.test.mjs)
run it in a sandbox that reproduces the tool's runtime. A missing `node` fails this case rather than
skipping it: the host application runs on Node, so its absence is a broken environment, and a skip
would show the suite green with the script untested.

Run from the plugin directory: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
TEST_FILE = Path("tests") / "workflow" / "review.test.mjs"


class WorkflowScriptTest(unittest.TestCase):
    def test_review_workflow_node_tests_pass(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "node is not on PATH; the review workflow's tests cannot run")
        assert node is not None
        # The file is named, not its directory: newer Node reads positional arguments as globs.
        completed = subprocess.run(
            [node, "--test", str(TEST_FILE)],
            cwd=str(PLUGIN),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            timeout=300,
        )
        self.assertEqual(
            completed.returncode,
            0,
            "node --test {} exited {}:\n{}".format(TEST_FILE, completed.returncode, completed.stdout),
        )


if __name__ == "__main__":
    unittest.main()
