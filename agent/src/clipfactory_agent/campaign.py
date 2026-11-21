"""Content Rewards campaign clips (docs/CONTRACTS.md §38.13): the rules a campaign job follows.

The API copies the campaign's rules onto the job when it is made (``job.campaign``, a ``JobCampaign``, §38.8); the
agent reads them from there and never asks Content Rewards. Brand text is data, never instructions: it reaches a
model only JSON-encoded inside its own block, with ``<`` and ``>`` written as ``\\u003c`` and ``\\u003e`` so it can
never close the block, and every string that can reach the screen or a caption is checked again here (the API checked
it first, §38.10). A job without a campaign never builds one of these, so it runs exactly as before."""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

DISCLOSURES = ("#Ad", "#ad", "#Sponsored", "#sponsored", "#PaidPartnership")
DEFAULT_DISCLOSURE = "#Ad"
DEFAULT_ON_SCREEN = "Paid partnership"
_ON_SCREEN = re.compile(r"^[A-Za-z0-9 '’&.!-]{2,30}$")
_HASHTAG = re.compile(r"^#\w{1,60}$")
_HANDLE = re.compile(r"^@[\w.]{1,60}$")
MAX_HASHTAGS, MAX_TAGS = 8, 5
CAPTION_TEXT_MAX = 150
MAX_TEXT = 300
MAX_ITEMS = 20
LENGTH_RANGE = (1.0, 600.0)
LOGO_EXTENSIONS = ("png", "jpg", "jpeg", "webp")
LOGO_MISSING = "The campaign's logo is missing. Add it on the campaign page, then tap Try again."
CHANNEL_NOTE = "This video may not be from {who}'s channels. Check before you upload."
SPOKEN_LABEL = "Say “paid partnership” out loud in the first 10 seconds"
SPOKEN_FAILED = "The brand wants “paid partnership” said out loud. Clip Factory can't. This clip may be turned down."
SPOKEN_SECONDS = 10.0


def block_json(value: Any) -> str:
    """``value`` as JSON for a marked block of brand text: ``<`` and ``>`` escaped, so nothing in it can close the
    block (or open another)."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True).replace("<", "\\u003c").replace(">", "\\u003e")


def _text(value: Any, limit: int = MAX_TEXT) -> str | None:
    if not isinstance(value, str):
        return None
    out = " ".join(value.split())
    return out[:limit] if out else None


def _texts(value: Any, limit: int = MAX_TEXT) -> list[str]:
    if not isinstance(value, list):
        return []
    out = [t for t in (_text(v, limit) for v in value[:MAX_ITEMS]) if t]
    return out


def _seconds(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    v = float(value)
    return v if LENGTH_RANGE[0] <= v <= LENGTH_RANGE[1] else None


def _one_line(value: Any, limit: int) -> str | None:
    """Text that may reach a caption: one line, no control, zero-width or bidi characters (§38.10 rule 4)."""
    if not isinstance(value, str):
        return None
    kept = "".join(
        " " if unicodedata.category(ch) in ("Cc", "Zl", "Zp") else ch
        for ch in value
        if unicodedata.category(ch) != "Cf"
    )
    out = " ".join(kept.split())
    return out if 0 < len(out) <= limit else None


@dataclass(frozen=True)
class Campaign:
    """The campaign a job makes clips for, read from ``job.campaign``."""

    campaign_id: str
    name: str
    brand: str
    rules: dict[str, Any]
    plain_rules: list[str]
    platforms_paid: list[str]
    logo_key: str | None
    rules_version: int

    @classmethod
    def from_job(cls, job: Mapping[str, Any]) -> Campaign | None:
        """The job's campaign, or None for a job without one (or with a campaign that has no rules)."""
        raw = job.get("campaign")
        if not isinstance(raw, Mapping):
            return None
        campaign_id = raw.get("campaignId")
        rules = raw.get("rules")
        if not isinstance(campaign_id, str) or not campaign_id or not isinstance(rules, Mapping):
            return None
        logo_key = raw.get("logoKey")
        version = raw.get("rulesVersion")
        return cls(
            campaign_id=campaign_id[:100],
            name=_text(raw.get("name"), 120) or "the campaign",
            brand=_text(raw.get("brand"), 120) or "",
            rules=dict(rules),
            plain_rules=_texts(raw.get("plainRules"), 200)[:12],
            platforms_paid=[str(p) for p in raw.get("platformsPaid") or [] if isinstance(p, str)],
            logo_key=logo_key if isinstance(logo_key, str) and logo_key else None,
            rules_version=int(version) if isinstance(version, int | float) and not isinstance(version, bool) else 0,
        )

    def _rule(self, *path: str) -> Any:
        v: Any = self.rules
        for k in path:
            if not isinstance(v, Mapping):
                return None
            v = v.get(k)
        return v

    # --- length (moments.length_target) ------------------------------------------------------------------------

    @property
    def length(self) -> tuple[float | None, float | None]:
        """``(lengthMinSec, lengthMaxSec)``, each None when the brief does not say (or both, when min > max)."""
        lo, hi = _seconds(self._rule("lengthMinSec")), _seconds(self._rule("lengthMaxSec"))
        if lo is not None and hi is not None and lo > hi:
            return None, None
        return lo, hi

    # --- the disclosure ----------------------------------------------------------------------------------------

    @property
    def disclosure_caption(self) -> str:
        """The caption's disclosure, first in every caption: one of DISCLOSURES, else "#Ad"."""
        v = self._rule("disclosure", "caption")
        return v if v in DISCLOSURES else DEFAULT_DISCLOSURE

    @property
    def on_screen(self) -> str:
        """The words shown at the start of the clip ("Paid partnership"), checked against the contract's pattern."""
        v = self._rule("disclosure", "onScreen")
        text = " ".join(v.split()) if isinstance(v, str) else ""
        return text if _ON_SCREEN.match(text) else DEFAULT_ON_SCREEN

    @property
    def spoken(self) -> bool:
        return self._rule("disclosure", "spoken") is True

    # --- the logo ----------------------------------------------------------------------------------------------

    @property
    def logo_required(self) -> bool:
        return self._rule("logo", "required") is True

    def logo_ext(self, job_id: str) -> str | None:
        """The extension of ``logoKey`` when it is the job's own copy (``jobs/{jobId}/source/campaign-logo.{ext}``,
        §38.11); None for anything else (the agent never reads ``campaigns/``)."""
        key = self.logo_key or ""
        prefix = f"jobs/{job_id}/source/campaign-logo."
        if not key.startswith(prefix):
            return None
        ext = key[len(prefix) :].lower()
        return ext if ext in LOGO_EXTENSIONS else None

    # --- captions ----------------------------------------------------------------------------------------------

    @property
    def hashtags(self) -> list[str]:
        v = self._rule("requiredHashtags")
        return [t for t in (v if isinstance(v, list) else []) if isinstance(t, str) and _HASHTAG.match(t)][
            :MAX_HASHTAGS
        ]

    @property
    def tags(self) -> list[str]:
        v = self._rule("requiredTags")
        return [t for t in (v if isinstance(v, list) else []) if isinstance(t, str) and _HANDLE.match(t)][:MAX_TAGS]

    @property
    def caption_text(self) -> str | None:
        return _one_line(self._rule("requiredCaptionText"), CAPTION_TEXT_MAX)

    @property
    def language(self) -> str | None:
        return _text(self._rule("language"), 40)

    # --- what the models get -----------------------------------------------------------------------------------

    @property
    def banned(self) -> list[str]:
        return _texts(self._rule("bannedContent"))

    @property
    def channels(self) -> list[dict[str, Any]]:
        """``allowedSources.channels``: ``{name, url}`` rows with a name."""
        v = self._rule("allowedSources", "channels")
        out: list[dict[str, Any]] = []
        for row in v if isinstance(v, list) else []:
            if isinstance(row, Mapping) and _text(row.get("name"), 120):
                url = row.get("url")
                out.append({"name": _text(row.get("name"), 120), "url": url if isinstance(url, str) else None})
        return out[:MAX_ITEMS]

    def brief(self) -> dict[str, Any]:
        """The campaign part of the finder's brief (``brief_json``) and of every ``<campaign_rules>`` block."""
        return {"name": self.name, "brand": self.brand, "plainRules": self.plain_rules, "rules": self.rules}

    def rules_block(self) -> str:
        return f"<campaign_rules>\n{block_json(self.brief())}\n</campaign_rules>"

    def channel_note(self) -> str:
        return CHANNEL_NOTE.format(who=self.brand or self.name)
