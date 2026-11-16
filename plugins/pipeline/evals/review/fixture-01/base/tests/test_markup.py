import unittest

from desk.markup import escape_text


class MarkupTest(unittest.TestCase):
    def test_markup_is_escaped(self):
        self.assertEqual("&lt;b&gt;hi&lt;/b&gt;", escape_text("<b>hi</b>"))

    def test_quotes_are_escaped(self):
        self.assertEqual("&quot;x&quot; &#x27;y&#x27;", escape_text("\"x\" 'y'"))
