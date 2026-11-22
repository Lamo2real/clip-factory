"""The campaign finder's golden cases and trimmed fixtures (docs/CONTRACTS.md §41.3, §41.6 Tests).

``uv run python tests/finder_cases.py <finder-samples dir>`` (from ``api/``) writes ``tests/fixtures/finder/``:

* ``samples.json``: ``cards-and-details.json`` with ``topClips``, ``topEarners``, ``chartPoints`` and every
  ``username`` removed (other creators' data never enters the repo);
* the pages: only the ``self.__next_f.push`` scripts and the robots meta kept, each stream rebuilt with those parts
  emptied and every ``username`` removed, ``T`` row lengths recomputed; ``page-open.html`` is built in the same stream
  shape from the Pickleball pair (no open page was saved), ``page-changed.html`` from it with the query keys renamed
  (a format change), ``page-challenge.html`` is a bot wall (no stream);
* ``robots.txt`` (the 21 Nov file), ``sitemap.xml`` (cut to about 30 entries, ``lastmod`` = ``listedAt``) and
  ``sitemap-index.xml``;
* ``match_cases.json``, ``normalize_cases.json`` and ``plan_cases.json``: the expectations below, written by hand
  from §41.3 and the samples (never computed by the code they test). ``test_finder_fixtures.py`` checks the committed
  case files equal what this module writes.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parent / "fixtures" / "finder"
NOW = datetime(2026, 11, 21, 12, 0, 0, tzinfo=UTC)
DROP = ("username", "whopUsername")
EMPTY = ("topClips", "topEarners", "chartPoints")

COD = "a1cefc3b-4533-438f-8e70-a7299550f1cf"
KAI = "1d2bcb00-c904-415f-aa82-f95b96baad86"
KREEK = "2eaa14fb-6927-4136-897e-b096e0d907d6"
LANCO = "d5d8b659-68ac-41d5-9e53-ab89545f437d"
SPLIT = "6e8cb2c6-7724-44a4-83da-66697acb20af"
SANTA = "c49840ae-ca22-4745-8a42-b675847e0355"
TRADE = "c9617009-53cb-4885-8ffc-b655f7c128b3"
UNGODLY = "0d341d7d-e390-4807-9149-9b5294dff3e6"
WEEKND = "4c7d1ede-2fca-406a-971d-f651880168aa"
HABLANDO = "e815a623-badd-4516-906c-b6cfce227ff9"
MACK = "79d6abae-b305-42e9-9ebe-82e47583adb5"
FUNDING = "c0c37381-e244-4643-98bd-edbff4bc1465"
FORGE = "1db63081-715e-4e04-9b11-fbc1d4e8e700"
PICKLE = "3d9ef19f-1256-47ca-b630-e33e2c923969"
ENERGY = "e4a9465f-d415-4e30-bf53-e46014958bc6"
FORGE_A = "52a937dd-2e14-4e4b-8eaf-971ac5921208"  # ForgeGUI's sibling with its own sitemap entry
FORGE_B = "237c2143-cbcc-4296-81f1-7da057a53264"  # ForgeGUI's sibling missing from the 21 Nov sitemap
LANCO_B = "e7b7aa0d-8d5c-460b-bb1e-803ad0492bc5"  # 8lanco's sibling
OLD = "14f743b2-c5ca-4f3e-8c0d-3010c485005d"  # listed 2025-12-01

TIKTOK_NOTE = "Also pays on TikTok, once TikTok checks Clip Factory."
AUDIENCE = "This brand only counts viewers from some countries. Check where yours are first."
SOUND = "It may need its own sound. Clip Factory can't add one."
SET_UP = ["youtube", "instagram", "facebook", "x"]


# --- cleaning -------------------------------------------------------------------------------------------------------


def clean(value: Any, *, empty: bool) -> Any:
    """Other creators' parts out: ``username`` keys dropped; ``topClips``, ``topEarners``, ``chartPoints`` emptied
    (``empty``) or dropped."""
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            if key in DROP:
                continue
            if key in EMPTY:
                if empty:
                    out[key] = []
                continue
            out[key] = clean(child, empty=empty)
        return out
    if isinstance(value, list):
        return [clean(v, empty=empty) for v in value]
    return value


_PUSH = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', re.DOTALL)
_ROBOTS_META = re.compile(r'<meta name="robots"[^>]*>')


def stream_rows(stream: str) -> list[tuple[str, str, str]]:
    """``(id, "T" | "J", text)`` (an independent reader of the RSC stream, so the fixtures don't depend on rsc.py)."""
    data = stream.encode("utf-8")
    out: list[tuple[str, str, str]] = []
    pos = 0
    while pos < len(data):
        m = re.compile(rb"([0-9a-f]{1,8}):").match(data, pos)
        if m is None:
            nxt = data.find(b"\n", pos)
            pos = len(data) if nxt < 0 else nxt + 1
            continue
        row_id, pos = m.group(1).decode(), m.end()
        t = re.compile(rb"T([0-9a-f]{1,8}),").match(data, pos)
        if t:
            size = int(t.group(1), 16)
            out.append((row_id, "T", data[t.end() : t.end() + size].decode("utf-8")))
            pos = t.end() + size
            continue
        nxt = data.find(b"\n", pos)
        end = len(data) if nxt < 0 else nxt
        out.append((row_id, "J", data[pos:end].decode("utf-8")))
        pos = end + 1
    return out


def build_stream(rows: list[tuple[str, str, str]]) -> str:
    parts = []
    for row_id, kind, text in rows:
        if kind == "T":
            parts.append(f"{row_id}:T{len(text.encode('utf-8')):x},{text}")
        else:
            parts.append(f"{row_id}:{text}\n")
    return "".join(parts)


def clean_rows(rows: list[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    out = []
    for row_id, kind, text in rows:
        if kind == "J" and text[:1] in ("[", "{", '"'):
            try:
                value = json.loads(text)
            except ValueError:
                out.append((row_id, kind, text))
                continue
            out.append((row_id, kind, json.dumps(clean(value, empty=True), ensure_ascii=False, separators=(",", ":"))))
            continue
        out.append((row_id, kind, text))
    return out


def push_literal(chunk: str) -> str:
    text = json.dumps(chunk, ensure_ascii=False)
    for raw, escaped in (
        ("<", "\\u003c"),
        (">", "\\u003e"),
        ("&", "\\u0026"),
        ("\u2028", "\\u2028"),
        ("\u2029", "\\u2029"),
    ):
        text = text.replace(raw, escaped)
    return f"<script>self.__next_f.push([1,{text}])</script>"


def page_html(chunks: list[str], robots_meta: list[str]) -> str:
    head = '<meta charSet="utf-8"/>' + "".join(robots_meta)
    body = "<script>(self.__next_f=self.__next_f||[]).push([0])</script>" + "".join(push_literal(c) for c in chunks)
    return f'<!DOCTYPE html><html lang="en"><head>{head}</head><body>{body}</body></html>\n'


def split_rows(stream: str, parts: int) -> list[str]:
    """The stream cut into ``parts`` pushes at row ends (``\\n``), like the saved pages."""
    size = max(1, len(stream) // parts)
    chunks, start = [], 0
    while start < len(stream):
        cut = stream.find("\n", start + size)
        end = len(stream) if cut < 0 or len(chunks) == parts - 1 else cut + 1
        chunks.append(stream[start:end])
        start = end
    return chunks


def saved_page(path: Path) -> tuple[list[tuple[str, str, str]], list[str], int]:
    html = path.read_text(encoding="utf-8")
    pushes = [json.loads(m.group(1)) for m in _PUSH.finditer(html)]
    return clean_rows(stream_rows("".join(pushes))), _ROBOTS_META.findall(html), len(pushes)


def _query_row(rows: list[tuple[str, str, str]]) -> tuple[int, Any]:
    for i, (_rid, kind, text) in enumerate(rows):
        if kind == "J" and '"queries"' in text and '"campaigns","detail"' in text:
            return i, json.loads(text)
    raise ValueError("no campaign query row")


def open_page(template: list[tuple[str, str, str]], pair: dict[str, Any]) -> tuple[str, str]:
    """``page-open.html`` and ``page-changed.html``: the Pickleball pair in the saved pages' stream shape (the user
    query row, the campaign query row with the detail and the Discover card, the description as a ``T`` row)."""
    index, row = _query_row(template)
    queries = row[3]["state"]["queries"]
    detail = dict(pair["detail"])
    card = dict(pair["card"])
    card["metrics"] = {**card["metrics"], "topClips": [], "topEarners": [], "chartPoints": []}
    text_id = "5a"
    description = detail["description"]
    detail["description"] = f"${text_id}"
    for q in queries:
        key = q.get("queryKey")
        if isinstance(key, list) and key[:2] == ["campaigns", "detail"]:
            q["queryKey"], q["state"]["data"] = ["campaigns", "detail", PICKLE], detail
        elif isinstance(key, list) and key[:2] == ["campaigns", "discover-card"]:
            q["queryKey"], q["state"]["data"] = ["campaigns", "discover-card", PICKLE], card
        if isinstance(q.get("queryKey"), list):
            q["queryHash"] = json.dumps(q["queryKey"], separators=(",", ":"))
    head = [r for r in template[:index] if r[0] in {"1", "d", "11"}]
    body = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
    rows = [*head, (text_id, "T", description), (template[index][0], "J", body)]
    stream = build_stream(rows)
    cut = stream.index('"campaigns","discover-card"')
    first_end = stream.index(f"{text_id}:T")
    chunks = [stream[:first_end], stream[first_end:cut], stream[cut:]]
    meta = ['<meta name="robots" content="index, follow, max-image-preview:large"/>']
    changed = stream.replace('"campaigns","detail"', '"campaign","page"').replace(
        '"campaigns","discover-card"', '"campaign","card"'
    )
    return page_html(chunks, meta), page_html(split_rows(changed, 2), meta)


CHALLENGE = (
    '<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title></head><body>'
    "<noscript>Enable JavaScript and cookies to continue</noscript>"
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>\n'
)


def sitemap_xml(source: str, samples: dict[str, Any]) -> str:
    """About 30 entries of the 21 Nov sitemap: its first pages, every sample (``lastmod`` = ``listedAt``), the group
    siblings it lists, and a few more campaigns (only uuids and dates: public listing data)."""
    listed = {pair["detail"]["id"]: pair["card"]["listedAt"] for pair in samples.values()}
    keep = {*listed, FORGE_A, LANCO_B, OLD}
    blocks = re.findall(r"<url>.*?</url>", source, re.DOTALL)
    pages = [b for b in blocks if "/c/campaigns/" not in b][:8]
    others = 0
    chosen = []
    for block in blocks:
        m = re.search(r"/c/campaigns/([0-9a-f-]{36})", block)
        if not m:
            continue
        uuid = m.group(1)
        if uuid in keep or others < 4:
            if uuid not in keep:
                others += 1
            if uuid in listed:
                lastmod = re.search(r"<lastmod>(.*?)</lastmod>", block)
                assert lastmod, uuid
                assert lastmod.group(1) == listed[uuid], uuid  # lastmod is the first listing
            chosen.append(block)
    assert FORGE_B not in "".join(chosen)
    body = "\n".join(pages[:8] + chosen)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}\n</urlset>\n'


SITEMAP_INDEX = """<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://contentrewards.com/sitemap-campaigns-1.xml</loc><lastmod>2026-11-21T15:33:26.000Z</lastmod></sitemap>
<sitemap><loc>https://elsewhere.example/sitemap.xml</loc></sitemap>
<sitemap><loc>https://contentrewards.com/sitemap-campaigns-2.xml</loc></sitemap>
</sitemapindex>
"""


# --- the golden cases (by hand, from §41.3 and the samples) ---------------------------------------------------------


def _lines(
    why: str,
    notes: list[str],
    heads: list[str] | None = None,
    cant: list[str] | None = None,
    pay: list[str] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"why": why, "notes": notes, "headsUp": heads or [], "cantTell": cant or []}
    if pay is not None:
        out["pay"] = pay
    return out


def match_cases() -> dict[str, Any]:
    now = "2026-11-21T12:00:00.000Z"
    rules4, rule1, rules2 = (
        "It has 4 rules you see once you join.",
        "It has 1 rule you see once you join.",
        "It has 2 rules you see once you join.",
    )

    def case(name: str, want: dict[str, Any], expect: dict[str, Any], **extra: Any) -> dict[str, Any]:
        return {
            "name": name,
            "want": want,
            "places": extra.get("places", SET_UP),
            "tiktokOk": extra.get("tiktokOk", False),
            "own": extra.get("own", []),
            "hidden": extra.get("hidden", []),
            "now": now,
            "expect": expect,
        }

    default_lines = {
        FUNDING: _lines(
            "Pays $6.00 per 1,000 views on YouTube and Instagram. Some of the money is left. Anyone can join.",
            [rules4, TIKTOK_NOTE],
            pay=["$6.00 per 1,000 views · up to $100 a clip", "$6.00 per 1,000 views · up to $100 a clip"],
        ),
        COD: _lines(
            "Pays $1.50 per 1,000 views on Instagram. Some of the money is left. Anyone can join.",
            [TIKTOK_NOTE],
            pay=["$1.50 per 1,000 views · up to $1,200 a clip"],
        ),
        PICKLE: _lines(
            "Pays $1.50 per 1,000 views on YouTube and Instagram. Most of the money is left. Anyone can join.",
            [TIKTOK_NOTE],
            pay=["$1.50 per 1,000 views · up to $250 a clip", "$1.50 per 1,000 views · up to $250 a clip"],
        ),
        SANTA: _lines(
            "Pays $1.00 per 1,000 views on YouTube and Instagram. Some of the money is left. Anyone can join.",
            [TIKTOK_NOTE],
        ),
        ENERGY: _lines(
            "Pays $1.00 per 1,000 views on YouTube, Instagram and X. Most of the money is left. Anyone can join.",
            [rule1, TIKTOK_NOTE],
            [AUDIENCE],
        ),
        LANCO: _lines(
            "Pays $1.00 per 1,000 views on Instagram. Most of the money is left. Anyone can join.",
            [rules2, TIKTOK_NOTE],
            [SOUND],
        ),
    }
    six = [FUNDING, COD, PICKLE, SANTA, ENERGY, LANCO]
    return {
        "now": now,
        "places": SET_UP,
        "cases": [
            case(
                "default",
                {},
                {
                    "order": six,
                    "skipped": [
                        ["cant_make", 4, "4 need something Clip Factory can't make."],
                        ["apply", 2, "2 want you to apply first."],
                        ["budget_gone", 1, "1 campaign has almost no money left."],
                        ["other_pay", 1, "1 campaign pays per post or shares a prize."],
                        ["budget_low", 1, "1 campaign has only a little money left."],
                    ],
                    "looked": 15,
                    "refused": {
                        KREEK: "cant_make",
                        TRADE: "cant_make",
                        MACK: "cant_make",
                        WEEKND: "cant_make",
                        UNGODLY: "apply",
                        HABLANDO: "apply",
                        KAI: "other_pay",
                        SPLIT: "budget_low",
                        FORGE: "budget_gone",
                    },
                    "lines": default_lines,
                },
            ),
            case(
                "also apply",
                {"access": "any"},
                {
                    "order": [FUNDING, COD, PICKLE, SANTA, HABLANDO, UNGODLY, ENERGY, LANCO],
                    "skipped": [["cant_make", 4], ["budget_gone", 1], ["other_pay", 1], ["budget_low", 1]],
                    "looked": 15,
                    "lines": {
                        HABLANDO: _lines(
                            "Pays $1.00 per 1,000 views on Instagram. Some of the money is left. You apply first.",
                            [TIKTOK_NOTE],
                            pay=[
                                "$0.20 per 1,000 views · up to $30 a clip",
                                "$1.00 per 1,000 views · up to $100 a clip",
                            ],
                        ),
                        UNGODLY: _lines(
                            "Pays $1.75 per 1,000 views on YouTube. Most of the money is left. You apply first.",
                            [TIKTOK_NOTE],
                            [AUDIENCE],
                        ),
                    },
                },
            ),
            case(
                "gaming",
                {"access": "any", "categories": ["gaming"]},
                {
                    "order": [UNGODLY],
                    "skipped": [
                        ["topic", 7],
                        ["cant_make", 4],
                        ["budget_gone", 1],
                        ["other_pay", 1],
                        ["budget_low", 1],
                    ],
                    "looked": 15,
                    "refused": {MACK: "cant_make"},
                    "lines": {
                        UNGODLY: _lines(
                            "Pays $1.75 per 1,000 views on YouTube. Gaming. Most of the money is left. You apply first.",
                            [TIKTOK_NOTE],
                            [AUDIENCE],
                        )
                    },
                },
            ),
            case(
                "other pay, any money",
                {"otherPay": True, "minLeftPct": 0},
                {
                    "order": [FUNDING, COD, PICKLE, SANTA, KAI, SPLIT, ENERGY, LANCO],
                    "skipped": [["cant_make", 4], ["apply", 2], ["budget_gone", 1]],
                    "looked": 15,
                    "lines": {
                        KAI: _lines(
                            "Shares the prize money on YouTube, Instagram and X. All the money is left. Anyone can join.",
                            [TIKTOK_NOTE],
                            pay=["Shares the prize money", "Shares the prize money", "Shares the prize money"],
                        ),
                        SPLIT: _lines(
                            "Pays up to $3.00 per 1,000 views on YouTube, Instagram and X. A little money is left. Anyone can join.",
                            [rule1, TIKTOK_NOTE],
                            [AUDIENCE],
                        ),
                    },
                },
            ),
            case(
                "$2 and up",
                {"minPer1kCents": 200, "access": "any", "minLeftPct": 0},
                {
                    "order": [FUNDING, SPLIT],
                    "skipped": [
                        ["low_pay", 7, "7 pay less than $2.00 per 1,000 views."],
                        ["cant_make", 4],
                        ["budget_gone", 1],
                        ["other_pay", 1],
                    ],
                    "looked": 15,
                    "lines": {
                        SPLIT: _lines(
                            "Pays $3.00 per 1,000 views on Instagram and X. A little money is left. Anyone can join.",
                            [rule1, TIKTOK_NOTE],
                            [AUDIENCE],
                            pay=[
                                "$1.50 per 1,000 views · up to $500 a clip",
                                "$3.00 per 1,000 views · up to $500 a clip",
                                "$3.00 per 1,000 views · up to $500 a clip",
                            ],
                        )
                    },
                },
            ),
            case(
                "YouTube only",
                {"places": ["youtube"]},
                {
                    "order": [FUNDING, PICKLE, SANTA, ENERGY],
                    "skipped": [
                        ["cant_make", 4],
                        ["not_your_places", 2, "2 don't pay for the places you post."],
                        ["apply", 2],
                        ["budget_gone", 1],
                        ["other_pay", 1],
                        ["budget_low", 1],
                    ],
                    "looked": 15,
                    "refused": {COD: "not_your_places", LANCO: "not_your_places"},
                    "lines": {
                        FUNDING: _lines(
                            "Pays $6.00 per 1,000 views on YouTube. Some of the money is left. Anyone can join.",
                            [rules4, "Also pays on Instagram.", TIKTOK_NOTE],
                        ),
                        ENERGY: _lines(
                            "Pays $1.00 per 1,000 views on YouTube. Most of the money is left. Anyone can join.",
                            [rule1, "Also pays on Instagram and X.", TIKTOK_NOTE],
                            [AUDIENCE],
                        ),
                    },
                },
            ),
            case(
                "TikTok after its audit",
                {},
                {
                    "order": six,
                    "skipped": [
                        ["cant_make", 4],
                        ["apply", 2],
                        ["budget_gone", 1],
                        ["other_pay", 1],
                        ["budget_low", 1],
                    ],
                    "looked": 15,
                    "noNote": TIKTOK_NOTE,
                    "lines": {
                        COD: _lines(
                            "Pays up to $2.00 per 1,000 views on TikTok and Instagram. Some of the money is left. Anyone can join.",
                            ["Pays less in some countries."],
                            pay=[
                                "Up to $2.00 per 1,000 views · up to $1,200 a clip",
                                "$1.50 per 1,000 views · up to $1,200 a clip",
                            ],
                        ),
                        FUNDING: _lines(
                            "Pays $6.00 per 1,000 views on YouTube, TikTok and Instagram. Some of the money is left. Anyone can join.",
                            [rules4],
                        ),
                    },
                },
                places=["youtube", "tiktok", "instagram", "facebook", "x"],
                tiktokOk=True,
            ),
            case(
                "English",
                {"languages": ["en"], "access": "any", "minLeftPct": 0},
                {
                    "order": [FUNDING, COD, PICKLE, SPLIT, UNGODLY, ENERGY, SANTA, LANCO, HABLANDO],
                    "skipped": [["cant_make", 4], ["budget_gone", 1], ["other_pay", 1]],
                    "looked": 15,
                    "lines": {
                        SPLIT: _lines(
                            "Pays up to $3.00 per 1,000 views on YouTube, Instagram and X. A little money is left. Anyone can join.",
                            [rule1, TIKTOK_NOTE],
                            [AUDIENCE],
                        ),
                        HABLANDO: _lines(
                            "Pays $1.00 per 1,000 views on Instagram. Some of the money is left. You apply first.",
                            [TIKTOK_NOTE],
                            [],
                            ["I can't tell the language."],
                        ),
                    },
                },
            ),
            case(
                "hidden and own",
                {},
                {
                    "order": [PICKLE, SANTA, ENERGY, LANCO],
                    "skipped": [
                        ["cant_make", 4],
                        ["apply", 2],
                        ["own", 1, "1 campaign is in your campaigns already."],
                        ["hidden", 1, "1 campaign you said Not for me."],
                        ["budget_gone", 1],
                        ["other_pay", 1],
                        ["budget_low", 1],
                    ],
                    "looked": 15,
                    "refused": {FUNDING: "hidden", COD: "own"},
                },
                hidden=[FUNDING],
                own=[COD],
            ),
        ],
    }


def _row(
    platform: str, per1k: int | None, most: int | None, other: int | None = None, geo: list[int] | None = None
) -> list[Any]:
    return [platform, per1k, None, most, other, geo or []]


def _budget(total: int, spent: int) -> dict[str, int]:
    return {"totalCents": total, "spentCents": spent, "leftCents": total - spent}


_OFF = {"preApproval": False, "sound": False, "logoRequired": False, "faceOnCamera": False}


def _norm(uuid: str, **fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "uuid": uuid,
        "kind": "cpm",
        "access": "open",
        "onDiscover": True,
        "toggles": dict(_OFF),
        "contentTypes": ["clipping"],
        "overlay": None,
        "sound": None,
        "audience": False,
        "namedLanguages": [],
        "pageLanguage": None,
        "groupIds": [],
    }
    base.update(fields)
    return base


def normalize_cases() -> dict[str, Any]:
    """Every sample's ``FinderCard`` facts (``pay`` rows: platform, per1k, perPost, max a clip, other countries, the
    country rates)."""
    return {
        "now": "2026-11-21T12:00:00.000Z",
        "cases": {
            "d04-cod-dmz": _norm(
                COD,
                platformsPaid=["tiktok", "instagram"],
                pay=[_row("tiktok", 0, 120000, 200, [0]), _row("instagram", 150, 120000)],
                budget=_budget(3000000, 1613583),
                categories=["entertainment"],
                pageLanguage="en",
                hiddenRules=0,
                launchedAt="2026-11-09T17:59:40.000Z",
            ),
            "d05-kai-pool": _norm(
                KAI,
                kind="pool",
                platformsPaid=["youtube", "tiktok", "instagram", "x"],
                pay=[_row(p, None, None) for p in ("youtube", "tiktok", "instagram", "x")],
                budget=_budget(1000000, 0),
                categories=["streamer", "personal-brand"],
                pageLanguage="en",
                hiddenRules=0,
            ),
            "d06-kreekcraft": _norm(
                KREEK,
                platformsPaid=["youtube", "tiktok", "instagram"],
                pay=[_row(p, 50, 50000) for p in ("youtube", "tiktok", "instagram")],
                budget=_budget(682460, 263048),
                categories=["twitch", "personal-brand", "streamer"],
                overlay="needed",
                hiddenRules=0,
            ),
            "d07-8lanco-sound": _norm(
                LANCO,
                platformsPaid=["tiktok", "instagram"],
                pay=[_row("tiktok", 100, 20000), _row("instagram", 100, 20000)],
                budget=_budget(300000, 971),
                contentTypes=["clipping", "sound"],
                categories=["music"],
                sound="maybe",
                hiddenRules=2,
                groupIds=[LANCO_B],
            ),
            "d08-ugc-splitscreen": _norm(
                SPLIT,
                platformsPaid=["youtube", "tiktok", "instagram", "x"],
                pay=[
                    _row("youtube", 150, 50000),
                    _row("tiktok", 300, 50000),
                    _row("instagram", 300, 50000),
                    _row("x", 300, 50000),
                ],
                budget=_budget(1800000, 1415711),
                contentTypes=[],
                categories=[],
                audience=True,
                namedLanguages=["en"],
                hiddenRules=1,
            ),
            "d09-santacruz-brand": _norm(
                SANTA,
                platformsPaid=["youtube", "tiktok", "instagram"],
                pay=[_row(p, 100, 20000) for p in ("youtube", "tiktok", "instagram")],
                budget=_budget(1186463, 660584),
                categories=["health-wellness"],
                hiddenRules=0,
            ),
            "d10-tradelens-slides": _norm(
                TRADE,
                platformsPaid=["tiktok"],
                pay=[_row("tiktok", 125, 40000)],
                budget=_budget(600000, 290585),
                contentTypes=["slideshows"],
                categories=["trading", "finance"],
                hiddenRules=1,
            ),
            "d11-ungodly-apply": _norm(
                UNGODLY,
                access="application",
                platformsPaid=["youtube", "tiktok"],
                pay=[_row("youtube", 175, 17500), _row("tiktok", 175, 17500)],
                budget=_budget(200000, 8527),
                categories=["gaming"],
                audience=True,
                pageLanguage="en",
                hiddenRules=None,
            ),
            "d13-weeknd-music": _norm(
                WEEKND,
                platformsPaid=["tiktok", "instagram"],
                pay=[_row("tiktok", 150, 15000), _row("instagram", 150, 15000)],
                budget=_budget(150000, 25217),
                contentTypes=["clipping", "ugc-with-face", "ugc-faceless", "sound", "reposting"],
                categories=["music"],
                sound="needed",
                pageLanguage="en",
                hiddenRules=0,
            ),
            "d14-hablando-es-apply": _norm(
                HABLANDO,
                access="application",
                platformsPaid=["youtube", "tiktok", "instagram"],
                pay=[_row("youtube", 20, 3000), _row("tiktok", 30, 5000), _row("instagram", 100, 10000)],
                budget=_budget(1000000, 704648),
                categories=["personal-brand"],
                hiddenRules=None,
            ),
            "d15-mack-twitch-apply": _norm(
                MACK,
                access="application",
                platformsPaid=["tiktok"],
                pay=[_row("tiktok", 100, 50000)],
                budget=_budget(200000, 0),
                toggles={**_OFF, "preApproval": True},
                categories=["pc-gaming", "gaming"],
                hiddenRules=None,
            ),
            "d16-fundingpips": _norm(
                FUNDING,
                platformsPaid=["youtube", "tiktok", "instagram"],
                pay=[_row(p, 600, 10000) for p in ("youtube", "tiktok", "instagram")],
                budget=_budget(400000, 233121),
                categories=["technology"],
                pageLanguage="en",
                hiddenRules=4,
                launchedAt="2026-05-26T11:21:33.000Z",
            ),
            "d17-forgegui-group": _norm(
                FORGE,
                platformsPaid=["youtube", "tiktok", "instagram"],
                pay=[_row("youtube", 50, 50000), _row("tiktok", 100, 100000), _row("instagram", 100, 100000)],
                budget=_budget(22465300, 21961265),
                contentTypes=["clipping", "ugc-faceless"],
                categories=["technology"],
                hiddenRules=1,
                groupIds=[FORGE_A, FORGE_B],
                groupName="ForgeGUI [UNLIMITED]",
            ),
            "d18-pickleball": _norm(
                PICKLE,
                platformsPaid=["youtube", "tiktok", "instagram"],
                pay=[_row(p, 150, 25000) for p in ("youtube", "tiktok", "instagram")],
                budget=_budget(250000, 8990),
                categories=["sports-highlights", "sports"],
                pageLanguage="en",
                hiddenRules=0,
                listedAt="2026-11-14T17:23:44.000Z",
            ),
            "d19-energy-product": _norm(
                ENERGY,
                platformsPaid=["youtube", "tiktok", "instagram", "x"],
                pay=[_row(p, 100, 20000) for p in ("youtube", "tiktok", "instagram", "x")],
                budget=_budget(1000000, 11248),
                categories=["product", "consumer-brand"],
                audience=True,
                pageLanguage="en",
                hiddenRules=1,
            ),
        },
    }


def _ago(**delta: float) -> str:
    return (NOW - timedelta(**delta)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _n(i: int) -> str:
    return f"00000000-0000-4000-8000-{i:012d}"


def _ok(
    read: str, *, live: bool = True, groups: list[str] | None = None, fails: int = 0, tried: str | None = None
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "state": "ok",
        "readAt": read,
        "fails": fails,
        "card": {"onDiscover": live, "groupIds": groups or []},
    }
    if tried:
        item["triedAt"] = tried
    return item


def plan_cases() -> dict[str, Any]:
    """``source.plan`` cases: ``entries`` are ``[uuid, lastmod ISO]`` (``lastmod`` = ``listedAt``)."""
    listed = {
        PICKLE: "2026-11-14T17:23:44.000Z",
        COD: "2026-11-09T17:59:40.000Z",
        FUNDING: "2026-05-26T11:21:33.000Z",
        KAI: "2026-11-18T19:58:55.000Z",
        SANTA: "2026-11-09T00:27:40.000Z",
        FORGE: "2026-05-06T18:28:44.000Z",
        FORGE_A: "2026-10-23T06:45:40.000Z",
        OLD: "2025-12-01T14:58:37.000Z",
    }

    def entries(*uuids: str) -> list[list[str | None]]:
        return [[u, listed.get(u)] for u in uuids]

    stale12 = {_n(i): _ok(_ago(hours=13 + i)) for i in range(1, 13)}
    return {
        "now": "2026-11-21T12:00:00.000Z",
        "cases": [
            {
                "name": "first fill: never read, newest listing first, every entry whatever its age",
                "entries": entries(PICKLE, COD, FUNDING, KAI, OLD),
                "cache": {},
                "matched": [],
                "expect": [KAI, PICKLE, COD, FUNDING, OLD],
            },
            {
                "name": "cap",
                "entries": entries(PICKLE, COD, FUNDING, KAI, OLD),
                "cache": {},
                "matched": [],
                "cap": 2,
                "expect": [KAI, PICKLE],
            },
            {
                "name": "stale matches first, then never read, then live rechecks after 2 days",
                "entries": entries(PICKLE, COD, FUNDING, KAI, SANTA),
                "cache": {
                    PICKLE: _ok(_ago(hours=13)),
                    COD: _ok(_ago(hours=20)),
                    FUNDING: _ok(_ago(hours=1)),
                    SANTA: _ok(_ago(days=3)),
                },
                "matched": [PICKLE, COD, FUNDING],
                "expect": [COD, PICKLE, KAI, SANTA],
            },
            {
                "name": "at most 10 stale matches",
                "entries": [[u, None] for u in stale12],
                "cache": stale12,
                "matched": list(stale12),
                "expect": [_n(i) for i in range(12, 2, -1)],
            },
            {
                "name": "missing group siblings after the never-read entries",
                "entries": entries(FORGE, FORGE_A),
                "cache": {FORGE: _ok(_ago(hours=1), groups=[FORGE_A, FORGE_B])},
                "matched": [],
                "expect": [FORGE_A, FORGE_B],
            },
            {
                "name": "live after 2 days, others and failing ones after 14 days",
                "entries": [[_n(i), None] for i in range(1, 8)],
                "cache": {
                    _n(1): _ok(_ago(days=3)),
                    _n(2): _ok(_ago(days=1)),
                    _n(3): _ok(_ago(days=15), live=False),
                    _n(4): _ok(_ago(days=10), live=False),
                    _n(5): {"state": "unreadable", "readAt": _ago(days=20), "fails": 0},
                    _n(6): _ok(_ago(days=20), fails=3, tried=_ago(days=16)),
                    _n(7): _ok(_ago(days=30), fails=3, tried=_ago(days=2)),
                },
                "matched": [],
                "expect": [_n(1), _n(5), _n(6), _n(3)],
            },
            {
                "name": "gone only when its lastmod changes",
                "entries": [[_n(1), "2026-11-01T00:00:00.000Z"], [_n(2), "2026-11-20T00:00:00.000Z"]],
                "cache": {
                    _n(1): {"state": "gone", "readAt": _ago(days=30), "fails": 0, "lastmod": 1793491200},
                    _n(2): {"state": "gone", "readAt": _ago(days=30), "fails": 0, "lastmod": 1793491200},
                },
                "matched": [],
                "expect": [_n(2)],
            },
            {
                "name": "a never-read page that failed under 3 times is tried again; 3 fails wait 14 days",
                "entries": [[_n(1), None], [_n(2), None]],
                "cache": {
                    _n(1): {"state": "unreadable", "fails": 1, "triedAt": _ago(hours=1)},
                    _n(2): {"state": "unreadable", "fails": 3, "triedAt": _ago(days=1)},
                },
                "matched": [],
                "expect": [_n(1)],
            },
            {
                "name": "a card the sitemap no longer lists is not read again",
                "entries": [[_n(2), None]],
                "cache": {_n(1): _ok(_ago(days=3))},
                "matched": [_n(1)],
                "expect": [_n(2)],
            },
        ],
    }


# --- writing --------------------------------------------------------------------------------------------------------


def write_json(name: str, value: Any) -> None:
    (FIXTURES / name).write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def write_cases() -> None:
    write_json("match_cases.json", match_cases())
    write_json("normalize_cases.json", normalize_cases())
    write_json("plan_cases.json", plan_cases())


def write_all(samples_dir: Path) -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    raw = json.loads((samples_dir / "cards-and-details.json").read_text(encoding="utf-8"))
    samples = clean(raw, empty=False)
    write_json("samples.json", samples)
    for source, target in (
        ("page-cod-dmz-geo.html", "page-geo.html"),
        ("page-kai-pool.html", "page-pool.html"),
        ("page-ungodly-apply.html", "page-apply.html"),
        ("page-removed-soft-404.html", "page-soft-404.html"),
    ):
        rows, meta, count = saved_page(samples_dir / source)
        (FIXTURES / target).write_text(page_html(split_rows(build_stream(rows), count), meta), encoding="utf-8")
    template, _meta, _count = saved_page(samples_dir / "page-cod-dmz-geo.html")
    opened, changed = open_page(template, samples["d18-pickleball"])
    (FIXTURES / "page-open.html").write_text(opened, encoding="utf-8")
    (FIXTURES / "page-changed.html").write_text(changed, encoding="utf-8")
    (FIXTURES / "page-challenge.html").write_text(CHALLENGE, encoding="utf-8")
    (FIXTURES / "robots.txt").write_text(
        (samples_dir / "robots-2026-11-21.txt").read_text(encoding="utf-8"), encoding="utf-8"
    )
    sitemap = (samples_dir / "sitemap-2026-11-21.xml").read_text(encoding="utf-8")
    (FIXTURES / "sitemap.xml").write_text(sitemap_xml(sitemap, samples), encoding="utf-8")
    (FIXTURES / "sitemap-index.xml").write_text(SITEMAP_INDEX, encoding="utf-8")
    write_cases()


if __name__ == "__main__":
    if len(sys.argv) == 2:
        write_all(Path(sys.argv[1]))
    else:
        write_cases()
