import unittest
from dataclasses import replace

from desk.export import open_tickets, render_index, render_ticket
from desk.ticket import Message, open_ticket

CUSTOMER = "ana@example.invalid"


def ticket_with(*bodies, status="new", ticket_id=7, subject="Login fails", opened_at=0):
    ticket = open_ticket(ticket_id, subject, CUSTOMER, "standard", opened_at=opened_at)
    return replace(ticket, status=status, messages=tuple(Message(CUSTOMER, body) for body in bodies))


class RenderTicketTest(unittest.TestCase):
    def test_the_page_shows_the_thread(self):
        page = render_ticket(ticket_with("It fails since Monday.", "Still failing."))
        self.assertIn("<p>It fails since Monday.</p>", page)
        self.assertIn("<p>Still failing.</p>", page)

    def test_the_subject_is_escaped(self):
        page = render_ticket(ticket_with("Hi", subject="<script>alert(1)</script>"))
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertNotIn("<script>", page)

    def test_an_entity_pasted_from_a_mail_reads_as_typed(self):
        page = render_ticket(ticket_with("Tom &amp; Jerry"))
        self.assertIn("<p>Tom &amp; Jerry</p>", page)

    def test_the_page_shows_the_status(self):
        page = render_ticket(ticket_with("Hi", status="resolved"))
        self.assertIn('<span class="badge-done">Resolved</span>', page)


class IndexTest(unittest.TestCase):
    def test_the_index_lists_open_tickets_oldest_first(self):
        newer = ticket_with("Hi", ticket_id=2, subject="Second", opened_at=5)
        older = ticket_with("Hi", ticket_id=1, subject="First", opened_at=1)
        self.assertEqual([older, newer], open_tickets([newer, older]))

    def test_the_index_leaves_closed_tickets_out(self):
        self.assertEqual([], open_tickets([ticket_with("Hi", status="closed")]))

    def test_the_index_page_names_each_ticket(self):
        page = render_index([ticket_with("Hi", ticket_id=3, subject="Refund")])
        self.assertIn("<li>#3 Refund</li>", page)
