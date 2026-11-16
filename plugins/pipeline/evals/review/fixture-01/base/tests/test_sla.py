import unittest
from dataclasses import replace

from desk.sla import due_at, is_overdue
from desk.ticket import open_ticket

CUSTOMER = "ana@example.invalid"


class SlaTest(unittest.TestCase):
    def test_the_reply_is_due_the_plan_hours_after_opening(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=10)
        self.assertEqual(34, due_at(ticket))

    def test_an_open_ticket_past_its_due_hour_is_overdue(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=10)
        self.assertTrue(is_overdue(ticket, now=35))

    def test_an_open_ticket_at_its_due_hour_is_not_overdue_yet(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=10)
        self.assertFalse(is_overdue(ticket, now=34))

    def test_a_resolved_ticket_is_never_overdue(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=10)
        self.assertFalse(is_overdue(replace(ticket, status="resolved"), now=100))
