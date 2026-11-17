"""A ticket, and the list of open tickets, as HTML pages the team prints or mails."""

from __future__ import annotations

from typing import Iterable

from desk.markup import escape_text, tidy_entities
from desk.ticket import Ticket

INDEX_HEADING = "TODO: tickets waiting on the team"

STATUS_BADGES = {
    "new": ("New", "badge-new"),
    "open": ("In progress", "badge-open"),
    "resolved": ("Resolved", "badge-done"),
    "closed": ("Closed", "badge-done"),
}


def render_ticket(ticket: Ticket) -> str:
    """The ticket's page: its subject, its status and its thread."""
    label, css_class = STATUS_BADGES[ticket.status]
    thread = "".join(
        f"<li><b>{escape_text(message.author)}</b>"
        f"<p>{tidy_entities(escape_text(message.body))}</p></li>"
        for message in ticket.messages
    )
    return (
        f"<h1>{escape_text(ticket.subject)}</h1>"
        f'<span class="{css_class}">{escape_text(label)}</span>'
        f"<ol>{thread}</ol>"
    )


def open_tickets(tickets: Iterable[Ticket]) -> list[Ticket]:
    """The tickets the index lists: every one still open, oldest first."""
    return sorted((ticket for ticket in tickets if ticket.status != "closed"), key=lambda ticket: ticket.opened_at)


def render_index(tickets: Iterable[Ticket]) -> str:
    """The page listing the open tickets, each by its id and subject."""
    rows = "".join(
        f"<li>#{escape_text(str(ticket.id))} {escape_text(ticket.subject)}</li>"
        for ticket in open_tickets(tickets)
    )
    return f"<h1>{escape_text(INDEX_HEADING)}</h1><ul>{rows}</ul>"


def export_filename(ticket_id: str) -> str:
    """The file name a ticket's page is saved under."""
    return f"ticket-{ticket_id}.html"
