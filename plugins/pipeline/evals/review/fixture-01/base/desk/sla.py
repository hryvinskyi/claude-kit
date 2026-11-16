"""When a ticket's first reply is due, and whether it is late."""

from __future__ import annotations

from desk.ticket import Ticket


def due_at(ticket: Ticket) -> int:
    """The hour the first reply is due."""
    return ticket.opened_at + ticket.sla_hours


def is_overdue(ticket: Ticket, now: int) -> bool:
    """Whether the first reply is late: the ticket is still open and its due hour has passed."""
    return ticket.is_open() and now > due_at(ticket)
