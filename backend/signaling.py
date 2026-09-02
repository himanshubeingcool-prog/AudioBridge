"""Signaling helpers - WebSocket message validation and token auth."""
from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def validate_token(provided: str | None, expected: str) -> bool:
    """Check if the provided token matches expected (or if no auth required)."""
    if not expected:
        return True
    return provided == expected


def parse_message(raw: str) -> dict[str, Any] | None:
    """Parse a JSON signaling message. Returns None on invalid JSON."""
    try:
        msg = json.loads(raw)
        if not isinstance(msg, dict):
            return None
        return msg
    except (json.JSONDecodeError, ValueError):
        return None
