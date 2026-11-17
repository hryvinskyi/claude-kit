import unittest
from dataclasses import replace

from desk.cli import UsageError, export_command
from desk.ticket import Message, open_ticket

CUSTOMER = "ana@example.invalid"


def tickets():
    ticket = open_ticket(7, "Login fails", CUSTOMER, "standard", opened_at=0)
    return {7: replace(ticket, messages=(Message(CUSTOMER, "It fails since Monday."),))}


class ExportCommandTest(unittest.TestCase):
    def test_the_file_is_named_after_the_ticket(self):
        filename, page = export_command("7", tickets())
        self.assertEqual("ticket-7.html", filename)
        self.assertIn("Login fails", page)

    def test_an_id_that_is_not_a_number_is_refused(self):
        for raw_id in ("../../etc/passwd", "7/../../x", "07", "", "7 ", "-7", "\uff17"):
            with self.subTest(raw_id=raw_id), self.assertRaises(UsageError):
                export_command(raw_id, tickets())

    def test_an_unknown_ticket_is_refused(self):
        with self.assertRaises(UsageError):
            export_command("8", tickets())
