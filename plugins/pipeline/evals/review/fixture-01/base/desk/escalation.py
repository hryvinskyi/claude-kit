"""Which open tickets page the on-call team."""

from __future__ import annotations

from desk.sla import due_at
from desk.ticket import Ticket

ESCALATE_HOURS_BEFORE = 2


def needs_escalation(ticket: Ticket, now: int) -> bool:
    """Whether an open ticket pages the on-call team: its first reply is due within two hours, or late."""
    return ticket.is_open() and due_at(ticket) - now <= ESCALATE_HOURS_BEFORE
