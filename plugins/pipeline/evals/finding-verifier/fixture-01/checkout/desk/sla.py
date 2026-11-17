"""When a ticket's first reply is due, and whether it is late."""

from __future__ import annotations

from desk.ticket import Ticket


def due_at(ticket: Ticket) -> int:
    """The hour the first reply is due."""
    return ticket.opened_at + ticket.sla_hours


def has_deadline(ticket: Ticket) -> bool:
    """Whether the ticket's plan promises a first reply by a set hour."""
    return ticket.sla_hours > 0


def is_overdue(ticket: Ticket, now: int) -> bool:
    """Whether the first reply is late: the ticket is still open, its plan promises a deadline,
    and the due hour has passed."""
    if not has_deadline(ticket):
        return False
    due = due_at(ticket)
    return ticket.is_open() and now > due
