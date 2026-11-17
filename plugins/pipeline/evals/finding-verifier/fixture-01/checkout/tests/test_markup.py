import unittest

from desk.markup import escape_text, tidy_entities


class MarkupTest(unittest.TestCase):
    def test_markup_is_escaped(self):
        self.assertEqual("&lt;b&gt;hi&lt;/b&gt;", escape_text("<b>hi</b>"))

    def test_quotes_are_escaped(self):
        self.assertEqual("&quot;x&quot; &#x27;y&#x27;", escape_text("\"x\" 'y'"))

    def test_entities_from_a_mail_client_read_as_typed(self):
        self.assertEqual("Tom & Jerry", tidy_entities("Tom &amp; Jerry"))
