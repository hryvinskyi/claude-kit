"""Text on its way into an HTML page."""

from __future__ import annotations

import html


def escape_text(value: str) -> str:
    """`value` escaped for an HTML text node or a quoted attribute."""
    return html.escape(value, quote=True)


def tidy_entities(value: str) -> str:
    """Turn the entities a mail client wrote into the characters they stand for, so a reply
    pasted from a mail reads on the page as the customer typed it."""
    return html.unescape(value)
