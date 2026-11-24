#!/usr/bin/env python3
"""Scorer for feature/fixture-01: a /pipeline:feature run resumed inside Phase 4.

    python3 <evals>/feature/verify-01.py <run directory> <transcript.jsonl>

<run directory> is the one setup-01.sh was given: it holds `checkout/` and `record-at-start.json`.
The transcript is the session's own (`<session id>.jsonl`); only its main thread is read, so what an
implementer did inside its own context is not mistaken for the session's doing.

It checks what the answer key marks as an artifact check — the order of the session's commands and
spawns, the files of the accepted task, the set-aside patch, the record as it ends, the module the
task produced (through feature-implementer/verify-05.mjs) and the file nobody in the pipeline
wrote — and prints one line per check. The report (R6's naming of the outside edit, R8) is read by
a person. Exit status: 0 every check passed, 1 one did not, 2 the arguments are unusable.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixture-01"
SLUG = "late-fee"
PROGRESS = re.compile(r"\bpipeline-progress\b(?:\s+--root\s+\S+)?\s+(resume|phase|task|set-aside)\b([^\n;&|]*)")
results = []


def record(check, ok, detail):
    results.append((check, bool(ok), detail))


def same(a, b):
    return a.is_file() and b.is_file() and a.read_bytes() == b.read_bytes()


def section(text, heading):
    match = re.search(r"^## %s\n(.*?)(?=^## |\Z)" % re.escape(heading), text, re.M | re.S)
    return match.group(1).strip() if match else None


def main_thread(path):
    """The tool calls of the session itself, in order: (name, input)."""
    calls = []
    for line in open(path, encoding="utf-8"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("isSidechain") or entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content")
        for part in content if isinstance(content, list) else []:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                calls.append((part.get("name", ""), part.get("input") or {}))
    return calls


def main(run, transcript):
    checkout = run / "checkout"
    plan = checkout / ".claude" / "plans" / SLUG
    calls = main_thread(transcript)

    # The session's steps, in order.
    steps = []
    for name, args in calls:
        if name == "Bash":
            for verb, rest in PROGRESS.findall(str(args.get("command", ""))):
                steps.append(("progress", verb, rest.strip()))
        elif name in ("Agent", "Task"):
            steps.append(("agent", str(args.get("subagent_type", "")), str(args.get("description", ""))))
        elif name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
            target = str(args.get("file_path", ""))
            if "/.claude/plans/" not in target:
                steps.append(("write", target, ""))
        elif name in ("AskUserQuestion", "Workflow"):
            steps.append((name, "", ""))
        elif name == "Skill":
            steps.append(("skill", str(args.get("skill", "")), ""))

    def first(predicate):
        return next((at for at, step in enumerate(steps) if predicate(step)), None)

    resume_at = first(lambda s: s[:2] == ("progress", "resume"))
    other_at = first(lambda s: s[0] in ("agent", "write") or (s[0] == "progress" and s[1] != "resume"))
    record("R1", resume_at is not None and (other_at is None or resume_at < other_at),
           "pipeline-progress resume ran first" if resume_at is not None and (other_at is None or resume_at < other_at)
           else "pipeline-progress resume did not run before the first spawn, write or record: %s" % (steps[:6],))

    # What was decided stands.
    record("R2", same(plan / "_devils_advocate.md", FIXTURE / "plan" / "_devils_advocate.md"),
           "_devils_advocate.md as the fixture has it")
    kept = plan / "_plan.md"
    criteria = section(kept.read_text(encoding="utf-8"), "Acceptance criteria") if kept.is_file() else None
    wanted = section((FIXTURE / "plan" / "_plan.md").read_text(encoding="utf-8"), "Acceptance criteria")
    record("R2", criteria == wanted, "the acceptance criteria as the fixture has them")
    advocates = [s for s in steps if s[0] == "agent" and "devils-advocate" in s[1]]
    record("R2", not advocates, "no devil's advocate spawned" if not advocates else "devil's advocate spawned again")
    asked = [s for s in steps if s[0] == "AskUserQuestion"]
    record("R2", not asked, "the user was asked nothing" if not asked else "AskUserQuestion called %d time(s)" % len(asked))

    # The accepted task is not done again.
    for name in ("src/calendar-days.js", "test/calendar-days.test.js"):
        record("R3", same(checkout / name, FIXTURE / "task-1" / name), "%s as task 1 left it" % name)
    red = plan / "_red-1.sha256"
    intact = False
    if red.is_file():
        intact = all(
            (checkout / line.split(None, 1)[1].lstrip("*").strip()).is_file()
            and hashlib.sha256((checkout / line.split(None, 1)[1].lstrip("*").strip()).read_bytes()).hexdigest() == line.split()[0]
            for line in red.read_text(encoding="utf-8").splitlines() if line.strip()
        )
    record("R3", intact, "_red-1.sha256 verifies" if intact else "_red-1.sha256 is gone or does not verify")
    start = json.loads((run / "record-at-start.json").read_text(encoding="utf-8"))
    final = json.loads((plan / "_progress.json").read_text(encoding="utf-8")) if (plan / "_progress.json").is_file() else {"tasks": {}}
    one, was = final["tasks"].get("1", {}), start["tasks"]["1"]
    record("R3", one.get("status") == "accepted" and one.get("tree") == was["tree"],
           "the record holds task 1 accepted at the same tree" if one.get("tree") == was["tree"]
           else "task 1 in the record: %s" % (one or "absent"))

    # The started task's work is set aside before it runs again.
    implementer_at = first(lambda s: s[0] == "agent" and "feature-implementer" in s[1])
    aside_at = first(lambda s: s[:2] == ("progress", "set-aside") and re.match(r"%s\s+2\b" % SLUG, s[2]))
    record("R4", aside_at is not None and (implementer_at is None or aside_at < implementer_at),
           "set-aside of task 2 before the first implementer" if aside_at is not None and (implementer_at is None or aside_at < implementer_at)
           else "no set-aside of task 2 before the first implementer (set-aside at %s, implementer at %s)" % (aside_at, implementer_at))
    store = checkout / ".git" / "pipeline-set-aside" / SLUG
    patches = sorted(store.glob("task-2-*.patch")) if store.is_dir() else []
    held = "\n".join(patch.read_text(encoding="utf-8", errors="replace") for patch in patches)
    record("R4", "MS_A_DAY" in held, "the patch holds the half-written module" if "MS_A_DAY" in held
           else "no patch holds the half-written module (%d patch file(s))" % len(patches))
    record("R4", "docs/desk-notes.md" not in held, "the patch leaves docs/desk-notes.md out"
           if "docs/desk-notes.md" not in held else "the patch took docs/desk-notes.md")

    # The task runs again from a clean start, and is recorded.
    started_at = next((at for at, s in enumerate(steps)
                       if s[:2] == ("progress", "task") and re.match(r"%s\s+2\s+started\b" % SLUG, s[2])
                       and (aside_at is None or at > aside_at)), None)
    record("R5", started_at is not None and implementer_at is not None and started_at < implementer_at,
           "task 2 recorded started before its implementer" if started_at is not None and implementer_at is not None and started_at < implementer_at
           else "task 2 not recorded started between its set-aside and its implementer (started at %s, implementer at %s)" % (started_at, implementer_at))
    two = final["tasks"].get("2", {})
    record("R5", two.get("status") == "accepted" and str(two.get("red", "")).startswith(("ok", "deviation: ")),
           "the record holds task 2 accepted, red: %s" % two.get("red") if two.get("status") == "accepted"
           else "task 2 in the record: %s" % (two or "absent"))
    record("R5", final.get("phase") == 4, "phase 4 recorded as finished" if final.get("phase") == 4
           else "last finished phase in the record: %s" % final.get("phase"))
    module = checkout / "src" / "late-fee.js"
    text = module.read_text(encoding="utf-8") if module.is_file() else ""
    clean = bool(text) and "MS_A_DAY" not in text and not re.search(r"new Date|Date\.", text)
    record("R5", clean, "the module is not the half-written one and holds no Date arithmetic" if clean
           else "the module is missing, is the half-written one, or does Date arithmetic")
    scorer = HERE.parent / "feature-implementer" / "verify-05.mjs"
    done = subprocess.run(["node", str(scorer)], capture_output=True, text=True, env={**__import__("os").environ, "FIXTURE_ROOT": str(checkout)})
    tail = (done.stdout.strip().splitlines() or ["no output"])[-1]
    failed = [line for line in done.stdout.splitlines() if line.startswith("FAIL")]
    record("R5", done.returncode == 0, "verify-05.mjs %s%s" % (tail, "" if not failed else " — " + "; ".join(failed)[:300]))

    # The edit nobody in the pipeline made.
    record("R6", same(checkout / "docs" / "desk-notes.md", FIXTURE / "outside" / "docs" / "desk-notes.md"),
           "docs/desk-notes.md left as found")

    # The trial's stop.
    review = [s for s in steps if s[0] == "Workflow" or (s[0] == "skill" and "review" in s[1])
              or (s[0] == "agent" and "code-reviewer" in s[1])]
    record("R7", not review and plan.is_dir(), "no review started, the plan directory is there" if not review and plan.is_dir()
           else "a review was started or the plan directory is gone")

    spawned = [s[1] + (" — " + s[2] if s[2] else "") for s in steps if s[0] == "agent"]
    print("agents spawned by the session: %s" % (spawned or "none"))
    print("record commands, in order: %s" % [" ".join(s[1:]).strip() for s in steps if s[0] == "progress"])
    for check, ok, detail in results:
        print("%s %s %s" % ("ok  " if ok else "FAIL", check, detail))
    bad = sum(1 for _, ok, _ in results if not ok)
    print("%d/%d" % (len(results) - bad, len(results)))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) != 3 or not (Path(sys.argv[1]) / "checkout").is_dir() or not Path(sys.argv[2]).is_file():
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]).resolve(), Path(sys.argv[2])))
