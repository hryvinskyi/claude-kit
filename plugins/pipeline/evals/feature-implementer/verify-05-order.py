#!/usr/bin/env python3
"""Order check for feature-implementer/fixture-05 (E2): red before green, read from the transcript.

    python3 <evals>/feature-implementer/verify-05-order.py <transcript.jsonl>

Passes when the session ran the new tests and saw them fail **before** its first write of
src/late-fee.js. A write is a Write/Edit/MultiEdit on that path, or a Bash command whose redirect
(`>`, `>>`), `tee`, `cp`/`mv` destination or `sed -i` target is that path; a path only mentioned in a
command (an import line inside a heredoc, a `cat` of it) is not a write. A test run is a Bash command that runs
`npm test`, `node --test` or `npm run test`; it counts as red when its result is an error or its
output reports a failure. One command that both writes the module and runs the tests is read as
writing first: its output reached the agent only after the code existed. Prints the timeline it
judged by and exits 0 (pass) or 1 (fail).
"""
import json
import re
import sys

MODULE = "src/late-fee.js"
TEST_FILE = "test/late-fee.test.js"
RUN = re.compile(r"\bnpm (?:run )?test\b|\bnode\b[^|;&]*--test\b")
TARGETS = [
    re.compile(r"(?<![0-9&])>>?\s*['\"]?([^\s'\";|&<>]+)"),
    re.compile(r"\btee\s+(?:-a\s+)?['\"]?([^\s'\";|&<>]+)"),
    re.compile(r"\b(?:cp|mv)\s+(?:-\w+\s+)*\S+\s+['\"]?([^\s'\";|&<>]+)"),
    re.compile(r"\bsed\s+-i(?:\s+''|\s+\"\")?\s+(?:-e\s+)?(?:'[^']*'|\"[^\"]*\"|\S+)\s+['\"]?([^\s'\";|&<>]+)"),
]


def written_paths(command):
    """The files a shell command writes: redirect, tee, cp/mv destination and sed -i targets.

    Heredoc bodies are dropped first, so a path inside the written text is not a target.
    """
    lines, kept, fence = command.split("\n"), [], None
    for line in lines:
        if fence is not None:
            if line.strip() == fence:
                fence = None
            continue
        kept.append(line)
        match = re.search(r"<<-?\s*['\"]?(\w+)['\"]?", line)
        if match:
            fence = match.group(1)
    head = "\n".join(kept)
    found = []
    for pattern in TARGETS:
        found.extend(pattern.findall(head))
    return found
FAILED = re.compile(r"(^|\n)\s*(not ok|ℹ fail [1-9]|# fail [1-9])|ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export", re.I)


def result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def main(path):
    uses, results = [], {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("message") or {}
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "tool_use":
                    uses.append(part)
                elif part.get("type") == "tool_result":
                    results[part.get("tool_use_id")] = part

    timeline = []
    for use in uses:
        name, args = use.get("name", ""), use.get("input") or {}
        target = str(args.get("file_path", ""))
        command = str(args.get("command", ""))
        if name in ("Write", "Edit", "MultiEdit"):
            if target.endswith(MODULE):
                timeline.append(("write-module", target))
            elif target.endswith(TEST_FILE):
                timeline.append(("write-test", target))
        elif name == "Bash":
            targets = written_paths(command)
            if any(t.endswith("late-fee.test.js") for t in targets):
                timeline.append(("write-test", command[:80]))
            if any(t.endswith("late-fee.js") and not t.endswith("late-fee.test.js") for t in targets):
                timeline.append(("write-module", command[:80]))
            if RUN.search(command):
                result = results.get(use.get("id"), {})
                text = result_text(result.get("content"))
                red = bool(result.get("is_error")) or bool(FAILED.search(text))
                timeline.append(("run-red" if red else "run-green", command[:80]))

    for kind, what in timeline:
        print(f"{kind:12} {what}")
    first_module = next((i for i, (k, _) in enumerate(timeline) if k == "write-module"), None)
    first_test = next((i for i, (k, _) in enumerate(timeline) if k == "write-test"), None)
    if first_module is None:
        print("FAIL: the module was never written")
        return 1
    if first_test is None or first_test > first_module:
        print("FAIL: the module was written before the tests")
        return 1
    red_before = any(k == "run-red" for k, _ in timeline[first_test:first_module])
    if not red_before:
        print("FAIL: no failing test run between the first test write and the first module write")
        return 1
    print("PASS: tests written, run and seen red before the module existed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
