"""vault_merge — git merge drivers for the files of a Markdown knowledge vault that change most.

Three drivers, each called by git as `vault-merge <driver> %O %A %B %P`:

- `keyed`      line-item Markdown (a TODO board, an inbox, a list of records): every row is merged
               by its identity, so two people editing different rows never conflict.
- `stamps`     the vault check's review stamps (`.anchors.json`): merged entry by entry.
- `generated`  notes holding a machine-written region: a conflict inside it is resolved and the
               note is listed for regeneration; a conflict anywhere else is left to a person.

`vault-merge selfcheck FILE…` reads a file the way `keyed` does and fails unless writing it back
gives the same bytes.

Standard library only; Python 3.9 or later.
"""
