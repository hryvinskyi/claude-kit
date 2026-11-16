"""A support ticket, and the questions about it that only the ticket answers."""

from __future__ import annotations

from dataclasses import dataclass

OPEN_STATUSES = frozenset({"new", "open"})

PLAN_SLA_HOURS = {
    "standard": 24,
    "priority": 4,
}


@dataclass(frozen=True)
class Message:
    """One message of a ticket's thread, as its author wrote it."""

    author: str
    body: str


@dataclass
class Ticket:
    """A customer's request and its thread.

    `sla_hours` is how many hours after `opened_at` the team's first reply is due.
    `opened_at` and every `now` are whole hours on one clock.
    """

    id: int
    subject: str
    customer: str
    plan: str
    status: str
    opened_at: int
    sla_hours: int
    messages: tuple[Message, ...] = ()

    def is_open(self) -> bool:
        """Whether the team still owes the customer an answer."""
        return self.status in OPEN_STATUSES


def open_ticket(ticket_id: int, subject: str, customer: str, plan: str, opened_at: int) -> Ticket:
    """A new ticket on `plan`, its first reply due as the plan promises; an unknown plan raises KeyError."""
    return Ticket(
        id=ticket_id,
        subject=subject,
        customer=customer,
        plan=plan,
        status="new",
        opened_at=opened_at,
        sla_hours=PLAN_SLA_HOURS[plan],
    )
