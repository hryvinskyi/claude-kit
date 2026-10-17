"""Entry point: `python3 -I <this file> ...`, or `python3 -m vault_merge ...` from the directory above."""
import sys
from pathlib import Path


def run() -> int:
    """The package's directory is put on the path first, so the isolated interpreter finds it."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from vault_merge.cli import main

    return main(sys.argv[1:])


sys.exit(run())
