#!/usr/bin/env python3
"""kb-sync — refresh the managed fact blocks in .claude/kb/Modules/*.md.

Deterministic and idempotent. Owns ONLY the region between the markers;
prose outside them is never touched. Never deletes notes: a note whose
module directory is gone is reported as an orphan for a human to prune.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB = os.path.join(ROOT, ".claude", "kb", "Modules")
PKGS = os.path.join(ROOT, "packages")
START = "<!-- kb:generated:start -->"
END = "<!-- kb:generated:end -->"


def block_for(mod: str) -> str:
    files = []
    for dirpath, _, names in os.walk(os.path.join(PKGS, mod)):
        for n in names:
            if n.endswith(".php"):
                files.append(os.path.relpath(os.path.join(dirpath, n), ROOT))
    lines = [START, f"module: {mod}", "files:"]
    lines += [f"  - {f}" for f in sorted(files)]
    contracts = sorted(os.path.basename(f)[:-4] for f in files if "/Api/" in f)
    lines.append("contracts: " + (", ".join(contracts) if contracts else "none"))
    lines.append(END)
    return "\n".join(lines)


def main() -> int:
    created = updated = 0
    mods = (
        sorted(d for d in os.listdir(PKGS) if os.path.isdir(os.path.join(PKGS, d)))
        if os.path.isdir(PKGS)
        else []
    )
    os.makedirs(KB, exist_ok=True)
    for mod in mods:
        path = os.path.join(KB, f"{mod}.md")
        block = block_for(mod)
        if not os.path.exists(path):
            with open(path, "w") as fh:
                fh.write(
                    f"# {mod}\n\n{block}\n\n## Purpose\n\n## How it fits\n\n"
                    "## Failure modes & risks\n\n## Runbook\n"
                )
            created += 1
            continue
        with open(path) as fh:
            text = fh.read()
        if START in text and END in text:
            new = re.sub(
                re.escape(START) + r".*?" + re.escape(END),
                lambda _m: block,
                text,
                flags=re.S,
            )
        else:
            new = text.rstrip() + "\n\n" + block + "\n"
        if new != text:
            with open(path, "w") as fh:
                fh.write(new)
            updated += 1
    orphans = [
        n for n in sorted(os.listdir(KB)) if n.endswith(".md") and n[:-3] not in mods
    ]
    print(f"{created} created · {updated} updated · {len(orphans)} orphan(s)")
    for o in orphans:
        print(f"  orphan: Modules/{o}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
