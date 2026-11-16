import unittest
from dataclasses import replace

from desk.escalation import needs_escalation
from desk.ticket import open_ticket

CUSTOMER = "ana@example.invalid"


class EscalationTest(unittest.TestCase):
    def test_a_ticket_due_within_two_hours_is_escalated(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=0)
        self.assertTrue(needs_escalation(ticket, now=22))

    def test_a_ticket_due_later_is_not_escalated(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=0)
        self.assertFalse(needs_escalation(ticket, now=21))

    def test_a_late_ticket_stays_escalated(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "priority", opened_at=0)
        self.assertTrue(needs_escalation(ticket, now=30))

    def test_a_resolved_ticket_is_not_escalated(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=0)
        self.assertFalse(needs_escalation(replace(ticket, status="resolved"), now=30))
