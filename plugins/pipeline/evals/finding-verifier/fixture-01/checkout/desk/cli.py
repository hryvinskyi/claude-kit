"""Commands a staff member types; each returns its result and writes nothing."""

from __future__ import annotations

import re
from typing import Mapping

from desk.export import export_filename, render_ticket
from desk.ticket import Ticket

TICKET_ID = re.compile(r"[1-9][0-9]{0,8}")


class UsageError(Exception):
    """A command was given an argument it cannot use; the message says which and why."""


def export_command(raw_id: str, tickets: Mapping[int, Ticket]) -> tuple[str, str]:
    """The file name and the page of the ticket whose id was typed as `raw_id`."""
    if TICKET_ID.fullmatch(raw_id) is None:
        raise UsageError(f"A ticket id is a number such as 42, not {raw_id!r}.")
    ticket = tickets.get(int(raw_id))
    if ticket is None:
        raise UsageError(f"There is no ticket {raw_id}.")
    return export_filename(raw_id), render_ticket(ticket)
