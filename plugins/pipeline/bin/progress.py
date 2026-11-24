"""progress.py — where a /pipeline:feature run stands, kept beside its plan so another session can go on.

Usage:
    pipeline-progress phase <slug> <1-5>
    pipeline-progress task <slug> <task> started
    pipeline-progress task <slug> <task> blocked --note TEXT
    pipeline-progress task <slug> <task> accepted [--deviation TEXT] [--no-red TEXT]
    pipeline-progress set-aside <slug> <task> <path>...
    pipeline-progress resume [<slug>] [--json]

A session that plans a feature holds the state of the run in its own context: which phase is finished,
which task an implementer holds, which one was accepted. When that session ends early, the plan
directory and the uncommitted work are still on disk and nothing says how far the run got. This script
writes that down at every step, in `.claude/plans/<slug>/_progress.json`, and reads it back.

`phase` records that a phase of the pipeline is finished: 1 the plan is written, 2 the adversarial
review is applied, 3 the plan is approved, 4 every task is accepted, 5 the change is verified and
reviewed. Phase 6 deletes the plan directory, so it is never recorded.

`task` records one task: `started` when an implementer (or the session itself) takes it, `blocked`
with the question that stopped it, `accepted` when its work is audited and stands. A task is accepted
only on the evidence its hash files give, read from the repository root:

    _contract-<task>.sha256   every file must match; a changed frozen file is never accepted
    _red-<task>.sha256        every file must match, or --deviation says which test changed after
                              its red run and why
    neither file              --no-red says why the task has no red run (no criterion and no logic)

`phase`, a task that starts and a task that is accepted each take a checkpoint: the id of a tree
that holds the working tree as it stands, committed, uncommitted and untracked (not ignored) files
alike. It is built in a copy of the index, so what is staged stays as it was. A task keeps the
checkpoint of its start as its base while it is started or blocked; a task started again after it
was accepted takes a new one, which holds the work that was accepted.

`set-aside` takes the half-done work of a task that is started or blocked out of the working tree,
so the task can run again from a clean start: of the paths given, every file that differs from the
task's base is written into one patch under the git directory (`pipeline-set-aside/<slug>/`, outside
the work tree, so it survives the plan directory) and put back as it was at the base — restored when
the base holds it, removed when the base does not. The task's `_red-<task>.sha256` is moved beside
the patch, since the tests it vouched for are gone, and the task leaves the record as if it never
started. `git apply <patch>` brings the work back. A file a frozen contract names is never set
aside, nor is anything of an accepted task or anything under the plan directory.

`resume` prints the record: the last finished phase, every recorded task with its status and what
its hash files say now, what was set aside, and the files that changed (the plan directory left out)
since the first task still in flight started — or, when none is, since the last checkpoint. Those
files are the work of whatever was in flight when the run stopped, and of anyone who edited the tree
meanwhile. Without a slug it takes the only recorded run, and lists them when there are several. It
writes nothing to the record, the index or the working tree.

The repository root is the top level of the checkout the command runs in, or --root.

Exit status: 0 done; 1 `resume` found no recorded run; 2 the request is unusable or refused — a bad
slug, task or phase, no plan directory, a record that is not valid, a task whose evidence does not
allow accepting it, work that may not be set aside, a directory that is not a git checkout; 3 `resume` without a slug found several
recorded runs and printed them.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

RECORD = "_progress.json"
PLANS = Path(".claude") / "plans"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
HASH_LINE = re.compile(r"^([0-9a-fA-F]{64}) [ *](.+)$")
PHASES = {
    1: "the plan is written",
    2: "the adversarial review is applied",
    3: "the plan is approved",
    4: "every task is accepted",
    5: "the change is verified and reviewed",
}
STATUSES = ("started", "blocked", "accepted")
IN_FLIGHT = ("started", "blocked")
SET_ASIDE = "pipeline-set-aside"
CHANGED_LIMIT = 200


class Refused(Exception):
    """The request cannot be carried out; the message says why."""


def git_raw(root: Path, *args: str, env: Optional[Dict[str, str]] = None) -> bytes:
    """Run git in the checkout and return its standard output as it came."""
    done = subprocess.run(
        ["git", "-c", "core.quotePath=false", *args], cwd=str(root), env=env, capture_output=True,
    )
    if done.returncode != 0:
        cause = (done.stderr or done.stdout).decode("utf-8", "replace").strip()
        raise Refused("git %s failed: %s" % (" ".join(args), cause))
    return done.stdout


def git(root: Path, *args: str, env: Optional[Dict[str, str]] = None) -> str:
    """Run git in the checkout and return its standard output as text, stripped."""
    return git_raw(root, *args, env=env).decode("utf-8", "replace").strip()


def tree_known(root: Path, tree: str) -> bool:
    """Whether a checkpoint is still in the object store."""
    done = subprocess.run(["git", "cat-file", "-e", tree + "^{tree}"], cwd=str(root), capture_output=True)
    return done.returncode == 0


def differing(root: Path, old: str, new: str, paths: List[str]) -> List[Tuple[str, str]]:
    """The files under the paths that differ between two trees, each with its status letter."""
    listing = git_raw(root, "diff", "--name-status", "--no-renames", "-z", old, new, "--", *paths)
    fields = listing.decode("utf-8", "surrogateescape").split("\0")
    return [(fields[at], fields[at + 1]) for at in range(0, len(fields) - 1, 2)]


def find_root(given: Optional[str]) -> Path:
    """The checkout's top level: --root when given, else the one the command runs in."""
    start = Path(given) if given else Path.cwd()
    if not start.is_dir():
        raise Refused("not a directory: %s" % start)
    done = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], cwd=str(start), capture_output=True, text=True,
    )
    if done.returncode != 0:
        raise Refused("not a git checkout: %s" % start)
    return Path(done.stdout.strip())


def checkpoint(root: Path) -> str:
    """The id of a tree holding the working tree as it stands; the index itself is left alone."""
    index = Path(git(root, "rev-parse", "--git-path", "index"))
    if not index.is_absolute():
        index = root / index
    handle, name = tempfile.mkstemp(prefix="pipeline-progress-index-")
    os.close(handle)
    scratch = Path(name)
    try:
        if index.is_file():
            # With its time: git doubts an entry as old as its index, and a copy stamped now would
            # hide a file rewritten to the same size in the second the index was written.
            shutil.copy2(str(index), str(scratch))
        else:
            scratch.unlink()
        env = dict(os.environ, GIT_INDEX_FILE=str(scratch))
        git(root, "add", "-A", env=env)
        return git(root, "write-tree", env=env)
    finally:
        if scratch.exists():
            scratch.unlink()


def now() -> str:
    """The current time in UTC, to the second."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def plan_dir(root: Path, slug: str) -> Path:
    """The plan directory of a slug, which must exist."""
    if not NAME.match(slug):
        raise Refused("not a plan slug: %r" % slug)
    directory = root / PLANS / slug
    if not directory.is_dir():
        raise Refused("no plan directory: %s" % (PLANS / slug))
    return directory


def load(directory: Path) -> Dict[str, Any]:
    """The record of a plan directory; an empty one when nothing was recorded yet."""
    path = directory / RECORD
    if not path.is_file():
        return {"version": 1, "phase": 0, "tasks": {}}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refused("%s is not readable JSON: %s" % (path.name, error))
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("tasks"), dict)
        or not isinstance(record.get("phase"), int)
        or not all(isinstance(task, dict) and task.get("status") in STATUSES for task in record["tasks"].values())
    ):
        raise Refused("%s does not hold a progress record" % path.name)
    return record


def save(directory: Path, record: Dict[str, Any]) -> None:
    """Write the record whole: a reader never sees half of it."""
    path = directory / RECORD
    scratch = directory / (RECORD + ".tmp")
    scratch.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(str(scratch), str(path))


def check_hashes(root: Path, hash_file: Path) -> List[Tuple[str, str]]:
    """Each file a hash file names with what it is now: ok, changed, missing or outside the checkout.

    A hash file with no usable line gives one entry for the file itself, marked unreadable.
    """
    results: List[Tuple[str, str]] = []
    try:
        lines = hash_file.read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        return [(hash_file.name, "unreadable")]
    base = root.resolve()
    for line in lines:
        if not line.strip():
            continue
        match = HASH_LINE.match(line)
        if not match:
            results.append((line.strip()[:80], "unreadable"))
            continue
        wanted, name = match.group(1).lower(), match.group(2)
        target = (root / name).resolve()
        if base != target and base not in target.parents:
            results.append((name, "outside"))
        elif not target.is_file():
            results.append((name, "missing"))
        else:
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            results.append((name, "ok" if actual == wanted else "changed"))
    return results or [(hash_file.name, "unreadable")]


def evidence(root: Path, directory: Path, task: str) -> Dict[str, Optional[List[Tuple[str, str]]]]:
    """What the task's contract and red hash files say now; None for a file that does not exist."""
    found: Dict[str, Optional[List[Tuple[str, str]]]] = {}
    for kind in ("contract", "red"):
        path = directory / ("_%s-%s.sha256" % (kind, task))
        found[kind] = check_hashes(root, path) if path.is_file() else None
    return found


def not_ok(results: Optional[List[Tuple[str, str]]]) -> List[str]:
    """The entries of a hash check that are not ok, as `name (state)`."""
    return ["%s (%s)" % (name, state) for name, state in results or [] if state != "ok"]


def record_phase(root: Path, slug: str, phase: int) -> str:
    """Record a finished phase with a checkpoint of the tree."""
    if phase not in PHASES:
        raise Refused("a phase is 1 to 5: %s" % phase)
    directory = plan_dir(root, slug)
    record = load(directory)
    record["phase"] = phase
    record["phase_at"] = now()
    record["checkpoint"] = {"tree": checkpoint(root), "at": record["phase_at"], "after": "phase %d finished" % phase}
    save(directory, record)
    return "phase %d finished (%s)" % (phase, PHASES[phase])


def record_task(root: Path, slug: str, task: str, status: str, note: str, deviation: str, no_red: str) -> str:
    """Record a task's status; an accepted task must have the evidence its hash files give."""
    if not NAME.match(task):
        raise Refused("not a task id: %r" % task)
    if status not in STATUSES:
        raise Refused("a status is one of %s: %r" % (", ".join(STATUSES), status))
    directory = plan_dir(root, slug)
    record = load(directory)
    entry: Dict[str, Any] = {"status": status, "at": now()}
    earlier = record["tasks"].get(task, {})
    if earlier.get("status") in IN_FLIGHT and earlier.get("base"):
        entry["base"], entry["base_at"] = earlier["base"], earlier.get("base_at", "")
        entry["base_order"] = earlier.get("base_order", 0)
    elif status in IN_FLIGHT:
        entry["base"], entry["base_at"] = checkpoint(root), entry["at"]
        record["steps"] = entry["base_order"] = int(record.get("steps", 0)) + 1
        record["checkpoint"] = {"tree": entry["base"], "at": entry["at"], "after": "task %s started" % task}
    if status == "blocked":
        if not note.strip():
            raise Refused("a blocked task needs --note with the question that stopped it")
        entry["note"] = note.strip()
    elif note.strip():
        entry["note"] = note.strip()
    if status == "accepted":
        found = evidence(root, directory, task)
        broken = not_ok(found["contract"])
        if broken:
            raise Refused(
                "task %s is not accepted: its frozen contract changed — %s. Restore the files, "
                "or freeze the contract again when it was the contract that was wrong." % (task, ", ".join(broken))
            )
        if found["red"] is not None:
            moved = not_ok(found["red"])
            if moved and not deviation.strip():
                raise Refused(
                    "task %s is not accepted: tests changed after their red run — %s. Pass --deviation "
                    "with the change and its reason when the test still pins its criterion; "
                    "send it back otherwise." % (task, ", ".join(moved))
                )
            entry["red"] = "deviation: %s" % deviation.strip() if moved else "ok"
        elif found["contract"] is not None:
            entry["red"] = "contract"
        elif no_red.strip():
            entry["red"] = "none: %s" % no_red.strip()
        else:
            raise Refused(
                "task %s is not accepted: it has no _red-%s.sha256 and no _contract-%s.sha256. Pass "
                "--no-red with the reason when the task owns no criterion and adds no logic; "
                "send it back otherwise." % (task, task, task)
            )
        entry["tree"] = checkpoint(root)
        record["checkpoint"] = {"tree": entry["tree"], "at": entry["at"], "after": "task %s accepted" % task}
    record["tasks"][task] = entry
    save(directory, record)
    return "task %s %s" % (task, status)


def recorded_runs(root: Path) -> List[str]:
    """The slugs under the plans directory that hold a record."""
    plans = root / PLANS
    if not plans.is_dir():
        return []
    return sorted(entry.name for entry in plans.iterdir() if (entry / RECORD).is_file())


def inside(root: Path, given: str) -> str:
    """A path as given on the command line, relative to the checkout's root; it must lie inside it."""
    base = root.resolve()
    target = (Path.cwd() / given).resolve() if not os.path.isabs(given) else Path(given).resolve()
    if base != target and base not in target.parents:
        raise Refused("outside the checkout: %s" % given)
    relative = target.relative_to(base).as_posix()
    plans = PLANS.as_posix()
    if relative == "." or relative == ".claude" or relative == plans or relative.startswith(plans + "/"):
        raise Refused("not set aside: %s holds the plan directory" % given)
    return relative


def prune_empty(root: Path, directory: Path) -> None:
    """Remove a directory left empty, and each parent it leaves empty, never the checkout's root."""
    while directory != root and root in directory.parents:
        try:
            directory.rmdir()
        except OSError:
            return
        directory = directory.parent


def set_aside(root: Path, slug: str, task: str, paths: List[str]) -> str:
    """Take a started task's half-done work out of the tree, kept as a patch, and forget the task."""
    if not NAME.match(task):
        raise Refused("not a task id: %r" % task)
    directory = plan_dir(root, slug)
    record = load(directory)
    entry = record["tasks"].get(task)
    if entry is None:
        raise Refused("task %s is not recorded: there is nothing of it to set aside" % task)
    if entry["status"] not in IN_FLIGHT:
        raise Refused("task %s is accepted: its work stands. Send a correction back instead." % task)
    base = entry.get("base", "")
    if not base or not tree_known(root, base):
        raise Refused("task %s has no base checkpoint in the object store: set its work aside by hand" % task)
    if not paths:
        raise Refused("name the paths task %s left" % task)
    found = checkpoint(root)
    files = differing(root, base, found, [":(literal)%s" % inside(root, given) for given in paths])
    contract = directory / ("_contract-%s.sha256" % task)
    frozen = {name for name, _ in check_hashes(root, contract)} if contract.is_file() else set()
    held = sorted(name for _, name in files if name in frozen)
    if held:
        raise Refused("not set aside: the frozen contract of task %s names %s" % (task, ", ".join(held)))
    nested = sorted(name for _, name in files if (root / name).is_dir() and not (root / name).is_symlink())
    if nested:
        raise Refused("not set aside: %s is a directory git holds as one entry; move it by hand" % ", ".join(nested))
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    store = Path(git(root, "rev-parse", "--git-path", "%s/%s" % (SET_ASIDE, slug)))
    if not store.is_absolute():
        store = root / store
    kept: Dict[str, Any] = {"task": task, "at": now(), "files": [name for _, name in files]}
    if files:
        store.mkdir(parents=True, exist_ok=True)
        patch = store / ("task-%s-%s.patch" % (task, stamp))
        names = [":(literal)%s" % name for _, name in files]
        patch.write_bytes(git_raw(root, "diff", "--binary", "--no-renames", base, found, "--", *names))
        for status, name in files:
            if status == "A":
                (root / name).unlink()
                prune_empty(root, (root / name).parent)
            else:
                git(root, "restore", "--source=%s" % base, "--worktree", "--", ":(literal)%s" % name)
        kept["patch"] = str(patch)
    red = directory / ("_red-%s.sha256" % task)
    if red.is_file():
        store.mkdir(parents=True, exist_ok=True)
        os.replace(str(red), str(store / ("task-%s-%s.red.sha256" % (task, stamp))))
    del record["tasks"][task]
    record.setdefault("set_aside", []).append(kept)
    save(directory, record)
    if not files:
        return "task %s left nothing under those paths; it is recorded as never started" % task
    lines = ["task %s set aside: %d file(s) put back as they were when it started" % (task, len(files))]
    lines += ["  %s %s" % (status, name) for status, name in files]
    lines.append("patch: %s" % kept["patch"])
    return "\n".join(lines)


def changed_since(root: Path, tree: str) -> Dict[str, Any]:
    """The files that differ between a checkpoint and the working tree, the plan directory left out."""
    if not tree_known(root, tree):
        return {"known": False, "files": []}
    files = differing(root, tree, checkpoint(root), [".", ":(exclude)%s" % PLANS.as_posix()])
    return {"known": True, "files": ["%s %s" % (status, name) for status, name in files]}


def resume(root: Path, slug: Optional[str]) -> Tuple[int, Dict[str, Any]]:
    """The record of a run, with what its hash files and the tree say now."""
    if slug is None:
        runs = recorded_runs(root)
        if not runs:
            return 1, {"runs": []}
        if len(runs) > 1:
            return 3, {"runs": [{"slug": name, "phase": load(root / PLANS / name)["phase"]} for name in runs]}
        slug = runs[0]
    directory = plan_dir(root, slug)
    if not (directory / RECORD).is_file():
        return 1, {"runs": [], "slug": slug}
    record = load(directory)
    tasks = []
    for task, entry in record["tasks"].items():
        found = evidence(root, directory, task)
        tasks.append({
            "task": task,
            "status": entry["status"],
            "at": entry.get("at", ""),
            "note": entry.get("note", ""),
            "red": entry.get("red", ""),
            "contract_now": None if found["contract"] is None else not_ok(found["contract"]),
            "red_now": None if found["red"] is None else not_ok(found["red"]),
        })
    mark = record.get("checkpoint")
    flying = [
        (entry.get("base_order", 0), task, entry["base"], entry.get("base_at", ""))
        for task, entry in record["tasks"].items()
        if entry["status"] in IN_FLIGHT and entry.get("base")
    ]
    if flying:
        _, first, base, started_at = min(flying)
        mark = {"tree": base, "at": started_at, "after": "task %s started" % first}
    report: Dict[str, Any] = {
        "slug": slug,
        "plan": (PLANS / slug).as_posix(),
        "phase": record["phase"],
        "phase_at": record.get("phase_at", ""),
        "tasks": tasks,
        "set_aside": record.get("set_aside", []),
        "checkpoint": mark,
        "changed": changed_since(root, mark["tree"]) if isinstance(mark, dict) and mark.get("tree") else None,
    }
    return 0, report


def hash_words(label: str, broken: Optional[List[str]]) -> str:
    """One hash file's state in words."""
    if broken is None:
        return "no %s file" % label
    return "%s intact" % label if not broken else "%s CHANGED: %s" % (label, ", ".join(broken))


def render(code: int, report: Dict[str, Any]) -> str:
    """The resume report as text."""
    if code == 1:
        if report.get("slug"):
            return "no recorded run for %s" % report["slug"]
        return "no recorded run"
    if code == 3:
        lines = ["several recorded runs — name one:"]
        lines += ["  %s  (phase %d finished)" % (run["slug"], run["phase"]) for run in report["runs"]]
        return "\n".join(lines)
    phase = report["phase"]
    lines = ["plan: %s" % report["plan"]]
    if phase:
        lines.append("finished: phase %d — %s (%s)" % (phase, PHASES.get(phase, "?"), report["phase_at"]))
    else:
        lines.append("finished: no phase recorded")
    lines.append("tasks:" if report["tasks"] else "tasks: none recorded")
    for task in report["tasks"]:
        words = [hash_words("contract", task["contract_now"]), hash_words("red", task["red_now"])]
        line = "  %s  %s  (%s)  now: %s" % (task["task"], task["status"], task["at"], "; ".join(words))
        if task["red"]:
            line += "  accepted with red: %s" % task["red"]
        if task["note"]:
            line += "  note: %s" % task["note"]
        lines.append(line)
    for kept in report["set_aside"]:
        where = kept.get("patch") or "nothing was left"
        lines.append("set aside: task %s (%s) — %s" % (kept["task"], kept["at"], where))
    mark, changed = report["checkpoint"], report["changed"]
    if not mark or changed is None:
        lines.append("no checkpoint recorded")
    elif not changed["known"]:
        lines.append(
            "the checkpoint of %s (%s) is no longer in the object store: compare the tree by hand"
            % (mark["after"], mark["tree"])
        )
    elif not changed["files"]:
        lines.append("nothing changed since %s (%s)" % (mark["after"], mark["tree"]))
    else:
        lines.append("changed since %s (%s):" % (mark["after"], mark["tree"]))
        lines += ["  %s" % name for name in changed["files"][:CHANGED_LIMIT]]
        if len(changed["files"]) > CHANGED_LIMIT:
            lines.append("  … and %d more" % (len(changed["files"]) - CHANGED_LIMIT))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    """Parse the command line and run one command."""
    parser = argparse.ArgumentParser(prog="pipeline-progress", description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", help="the checkout (default: the one the command runs in)")
    commands = parser.add_subparsers(dest="command", required=True)
    phase = commands.add_parser("phase", help="record a finished phase")
    phase.add_argument("slug")
    phase.add_argument("phase", type=int)
    task = commands.add_parser("task", help="record a task's status")
    task.add_argument("slug")
    task.add_argument("task")
    task.add_argument("status")
    task.add_argument("--note", default="")
    task.add_argument("--deviation", default="")
    task.add_argument("--no-red", default="", dest="no_red")
    aside = commands.add_parser("set-aside", help="take a started task's half-done work out of the tree")
    aside.add_argument("slug")
    aside.add_argument("task")
    aside.add_argument("paths", nargs="*")
    again = commands.add_parser("resume", help="print the record of a run")
    again.add_argument("slug", nargs="?")
    again.add_argument("--json", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 2
    try:
        root = find_root(args.root)
        if args.command == "phase":
            print(record_phase(root, args.slug, args.phase))
            return 0
        if args.command == "task":
            print(record_task(root, args.slug, args.task, args.status, args.note, args.deviation, args.no_red))
            return 0
        if args.command == "set-aside":
            print(set_aside(root, args.slug, args.task, args.paths))
            return 0
        code, report = resume(root, args.slug)
        print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else render(code, report))
        return code
    except Refused as refusal:
        print(str(refusal), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
