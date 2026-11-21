"""Lamo Stories agent: the reference package (docs/CONTRACTS.md §45.27, §45.28, §45.7, §45.33).

SCAFFOLD (Phase 1): builder E2 fills it.
"""

from __future__ import annotations

from typing import Any


def register(actions: Any, runner: Any) -> None:
    """Registers this package's actions on the server (see server.register_all)."""
