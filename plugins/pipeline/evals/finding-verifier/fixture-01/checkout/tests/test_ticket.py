import unittest
from dataclasses import replace

from desk.ticket import open_ticket

CUSTOMER = "ana@example.invalid"


class TicketTest(unittest.TestCase):
    def test_a_new_ticket_is_open(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=0)
        self.assertTrue(ticket.is_open())

    def test_a_resolved_ticket_is_not_open(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "standard", opened_at=0)
        self.assertFalse(replace(ticket, status="resolved").is_open())

    def test_the_plan_sets_the_reply_deadline(self):
        ticket = open_ticket(1, "Login fails", CUSTOMER, "priority", opened_at=0)
        self.assertEqual(4, ticket.sla_hours)

    def test_an_unknown_plan_is_refused(self):
        with self.assertRaises(KeyError):
            open_ticket(1, "Login fails", CUSTOMER, "gold", opened_at=0)
