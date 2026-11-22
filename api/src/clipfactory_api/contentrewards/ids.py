"""Which listed CR campaign a pasted campaign is (docs/CONTRACTS.md §38.9 "Which CR campaign a link is").

CR's API ids (``cmp_`` + 26 characters) look like a TypeID of the page's UUID (Crockford base32 of the 128 bits).
CR's docs say never to build an id, so an encoded id is only ever **looked up** in ``list_my_campaigns``: it is never
sent before it matched a listed one.
"""

from __future__ import annotations

import uuid as uuid_lib
from collections.abc import Iterable, Mapping
from typing import Any

ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def typeid(prefix: str, uuid: str) -> str:
    """``typeid("cmp", "200ea21b-…")`` → ``"cmp_101th1qfm09pwbamme6armgr2e"``."""
    n = uuid_lib.UUID(uuid).int
    chars = [ALPHABET[(n >> (5 * (25 - i))) & 31] for i in range(26)]
    return f"{prefix}_{''.join(chars)}"


def _fold(text: Any) -> str:
    return " ".join(str(text or "").lower().split())


def _rates(platforms: Any) -> list[tuple[str, int | None]]:
    """``[(platform, cents)]`` sorted, from either the MCP shape (``rate: {value}``) or the public one (``rate``)."""
    out = []
    for row in platforms or []:
        if not isinstance(row, Mapping):
            continue
        rate = row.get("rate")
        cents = rate.get("value") if isinstance(rate, Mapping) else rate
        out.append((str(row.get("platform") or ""), cents if isinstance(cents, int) else None))
    return sorted(out, key=lambda r: (r[0], r[1] if r[1] is not None else -1))


def public_access(public: Mapping[str, Any]) -> str | None:
    value = public.get("requiresApplication")
    if value is None:
        return None
    return "application" if value else "open"


def match_campaign(
    listed: Iterable[Mapping[str, Any]],
    uuid: str,
    public: Mapping[str, Any] | None,
    *,
    use_typeid: bool = True,
    org_matches: bool = True,
) -> tuple[Mapping[str, Any] | None, str]:
    """``(listed campaign or None, how)``: how is ``typeid``, ``name``, ``ambiguous`` or ``none``.

    ``use_typeid`` is False after a verified mismatch (only rules 2–4 then). The organization is compared by its
    TypeID when any listed campaign carries it, else (it never matched anything) by the brand name; ``org_matches``
    False forces the brand name."""
    rows = [c for c in listed if isinstance(c, Mapping)]
    if use_typeid:
        wanted = typeid("cmp", uuid)
        for row in rows:
            if row.get("id") == wanted:
                return row, "typeid"
    if not public:
        return None, "none"
    name = _fold(public.get("name"))
    org_id = public.get("organizationId")
    org = typeid("org", str(org_id)) if isinstance(org_id, str) and _is_uuid(org_id) else None
    brand = _fold(
        (public.get("organization") or {}).get("name") if isinstance(public.get("organization"), Mapping) else ""
    )

    by_org = bool(org_matches and org and any(r.get("organization") == org for r in rows))

    def same_org(row: Mapping[str, Any]) -> bool:
        if by_org:
            return row.get("organization") == org
        brand_row = row.get("brand_account") or {}
        listed_brand = _fold(brand_row.get("name") if isinstance(brand_row, Mapping) else row.get("brand"))
        return bool(brand) and listed_brand == brand

    named = [r for r in rows if _fold(r.get("name")) == name and same_org(r)]
    if len(named) >= 2:
        return None, "ambiguous"
    if len(named) == 1:
        row = named[0]
        access = public_access(public)
        public_rates = _rates((public.get("configuration") or {}).get("payoutModel"))
        if (access is None or row.get("access") == access) and (
            not public_rates or _rates(row.get("platforms")) == public_rates
        ):
            return row, "name"
    return None, "none"


def _is_uuid(text: str) -> bool:
    try:
        uuid_lib.UUID(text)
    except ValueError:
        return False
    return True
