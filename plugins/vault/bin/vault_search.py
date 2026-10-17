#!/usr/bin/env python3
"""vault_search.py — give a project's vault a qmd search index of its own. Global.

Usage:
    vault-search ensure [--root DIR] [--detach]   # create the index if there is none
    vault-search refresh [--root DIR]             # re-index, embed, drop replaced vectors

Every project gets a project-local qmd index in `<root>/.qmd/`. qmd adopts it for anything run inside
the tree — the `qmd mcp` server Claude Code starts in the project included — so one project's notes
never answer a search made in another. `.qmd/` is excluded through `.git/info/exclude`, which is local
to the clone and changes no tracked file. The collection covers the vault's Markdown and gives each
folder it recognises a context, which qmd returns with every hit from that folder.

Does nothing without qmd or a vault. `ensure` does nothing when the index already covers the vault.
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vaultlib  # noqa: E402

ROOT_CONTEXT = ("Knowledge vault of the {project} project — decisions, journal, notes on its code and the "
                "working board. The code is the source of truth; these notes describe it.")
FOLDER_CONTEXTS = {
    "Decisions": "Decision records: what was decided, why, and the alternatives that lost. A record marked "
                 "superseded is history, not current policy.",
    "Journal": "Dated work-journal entries: what a session changed, why, and what it left to do. Each "
               "describes the code as it was on that day.",
    "Modules": "One note per module or package: what it owns, how it fits, what fails and how to operate it.",
    "Bridges": "One note per bridge package, the integration that lets two modules cooperate without "
               "knowing each other.",
    "Plugins": "One note per plugin or connector.",
    "Kernel": "One note per shared kernel package the project builds on.",
    "Runbooks": "Operating procedures: deploy, operate, observe, test.",
    "deferred": "Bodies of queued outward actions, such as comments and evidence, waiting to be retried.",
}


def collection_name(vault: vaultlib.Vault) -> str:
    return re.sub(r"[^a-z0-9]+", "-", vault.root.name.lower()).strip("-") or "vault"


def has_index(root: Path) -> bool:
    return (root / ".qmd" / "index.yml").is_file() or (root / ".qmd" / "index.yaml").is_file()


def exclude_locally(root: Path, entry: str) -> bool:
    """Add an entry to the clone's own exclude file; False when the project is not a git repository."""
    code, out = vaultlib.git_out(root, "rev-parse", "--git-path", "info/exclude")
    if code != 0 or not out.strip():
        return False
    exclude = Path(out.strip())
    if not exclude.is_absolute():
        exclude = root / exclude
    try:
        lines = exclude.read_text(encoding="utf-8").splitlines() if exclude.is_file() else []
        if entry not in lines:
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text("\n".join([*lines, entry]) + "\n", encoding="utf-8")
    except OSError:
        return False
    return True


def covered(qmd: str, vault: vaultlib.Vault) -> bool:
    code, out = vaultlib.run([qmd, "collection", "list"], cwd=vault.root, timeout=60)
    return code == 0 and re.search(r"(?m)^\s*%s\s" % re.escape(collection_name(vault)), out) is not None


def ensure(vault: vaultlib.Vault, qmd: str) -> bool:
    """Create the project's index and its collection over the vault, then embed; True when anything was made."""
    if has_index(vault.root) and covered(qmd, vault):
        return False
    lock = vault.state / "search.lock"
    if not vaultlib.take_lock(lock, 3600):
        return False
    try:
        exclude_locally(vault.root, ".qmd/")
        if not has_index(vault.root):
            code, out = vaultlib.run([qmd, "init"], cwd=vault.root, timeout=120)
            if code != 0:
                vaultlib.log(vault, "search.log", f"qmd init failed: {out.strip()[:300]}")
                return False
        name = collection_name(vault)
        code, out = vaultlib.run([qmd, "collection", "add", str(vault.path), "--name", name, "--mask", "**/*.md"],
                                 cwd=vault.root, timeout=600)
        if code != 0:
            vaultlib.log(vault, "search.log", f"qmd collection add failed: {out.strip()[:300]}")
            return False
        vaultlib.run([qmd, "context", "add", f"qmd://{name}", ROOT_CONTEXT.format(project=vault.root.name)],
                     cwd=vault.root, timeout=60)
        for folder, text in FOLDER_CONTEXTS.items():
            if (vault.path / folder).is_dir():
                vaultlib.run([qmd, "context", "add", f"qmd://{name}/{folder}", text], cwd=vault.root, timeout=60)
        code, out = vaultlib.run([qmd, "embed"], cwd=vault.root, timeout=3600)
        if code != 0:
            vaultlib.log(vault, "search.log", f"qmd embed failed: {out.strip()[:300]}")
        return True
    finally:
        lock.unlink(missing_ok=True)


def refresh(vault: vaultlib.Vault, qmd: str) -> None:
    """Bring an existing project index up to date: re-index, embed, drop the vectors edits replaced."""
    if not has_index(vault.root):
        return
    for step in ("update", "embed", "cleanup"):
        code, out = vaultlib.run([qmd, step], cwd=vault.root, timeout=3600)
        if code != 0:
            vaultlib.log(vault, "search.log", f"qmd {step} failed: {out.strip()[:300]}")
            return


def main(argv: list[str]) -> int:
    if vaultlib.disabled() or not argv or argv[0] not in ("ensure", "refresh"):
        return 0
    root: Optional[str] = argv[argv.index("--root") + 1] if "--root" in argv and argv.index("--root") + 1 < len(argv) else None
    qmd = shutil.which("qmd")
    vault = vaultlib.locate(root)
    if not qmd or vault is None:
        return 0
    if argv[0] == "refresh":
        refresh(vault, qmd)
        return 0
    if "--detach" in argv:
        if not (has_index(vault.root) and covered(qmd, vault)):
            vaultlib.spawn([str(Path(__file__).resolve()), "ensure", "--root", str(vault.root)], vault.root)
        return 0
    ensure(vault, qmd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
