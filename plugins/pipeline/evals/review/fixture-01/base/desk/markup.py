"""Text on its way into an HTML page."""

from __future__ import annotations

import html


def escape_text(value: str) -> str:
    """`value` escaped for an HTML text node or a quoted attribute."""
    return html.escape(value, quote=True)
