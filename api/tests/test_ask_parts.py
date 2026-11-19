"""Ask's parts (§27): files, the SSRF-guarded fetch, Brave search, the secrets filter, the knowledge pack, the tools."""

from __future__ import annotations

import io
import json
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.ask import fetch as web
from clipfactory_api.ask import files, knowledge, redact, search
from clipfactory_api.ask.state import Reader, scrub
from clipfactory_api.ask.tools import CAPS, LIMIT_REACHED, Toolbox, typed_urls
from conftest import OTHER, USER, seed_clip, seed_job
from fakes import client_error

REPO = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)


# --- files ---------------------------------------------------------------------------------------------------


def _zip(entries: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def test_docx_paragraphs_and_tables() -> None:
    doc = (
        f"<w:document {W}><w:body><w:p><w:r><w:t>Title</w:t></w:r></w:p>"
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
        "</w:body></w:document>"
    )
    text = files.office_text(_zip({"word/document.xml": doc}), "docx")
    assert text.splitlines()[0] == "Title"
    assert "a\tb" in text


def test_xlsx_sheets_as_csv() -> None:
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    shared = f"<sst {ns}><si><t>Name</t></si><si><t>Views, total</t></si></sst>"
    sheet = (
        f'<worksheet {ns}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>clip</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>'
    )
    text = files.office_text(_zip({"xl/sharedStrings.xml": shared, "xl/worksheets/sheet1.xml": sheet}), "xlsx")
    assert text.splitlines() == ["# Sheet 1", 'Name,"Views, total"', "clip,42"]


def test_pptx_slides() -> None:
    slide = '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Hook first</a:t><a:t>Then payoff</a:t></p:sld>'
    assert files.office_text(_zip({"ppt/slides/slide1.xml": slide}), "pptx") == "# Slide 1\nHook first\nThen payoff"


def test_zip_bomb_and_entities_are_refused() -> None:
    bomb = _zip({"word/document.xml": "0" * 60_000_000})
    assert files.read("x.docx", "office", bomb, chars_left=10**6, b64_left=10**8).why == "too_long"
    evil = _zip({"word/document.xml": '<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document/>'})
    assert files.read("x.docx", "office", evil, chars_left=10**6, b64_left=10**8).why == "damaged"
    assert files.read("x.docx", "office", b"%PDF-1.7", chars_left=10**6, b64_left=10**8).why == "damaged"


def test_pdf_pages_and_limits() -> None:
    pdf = b"%PDF-1.7\n" + b"<< /Type /Page >>\n" * 3 + b"<< /Type /Pages >>\n%%EOF"
    assert files.pdf_pages(pdf) == 3
    read = files.read("r.pdf", "pdf", pdf, chars_left=10, b64_left=10**6)
    assert read.block is not None
    assert read.block["citations"] == {"enabled": True}
    assert read.pages == 3
    long_pdf = b"%PDF-1.7\n" + b"<< /Type /Page >>\n" * 101
    assert files.read("r.pdf", "pdf", long_pdf, chars_left=10, b64_left=10**6).why == "too_long"
    assert files.read("r.pdf", "pdf", b"PK\x03\x04", chars_left=10, b64_left=10**6).why == "damaged"


def test_text_decoding() -> None:
    assert files.decode_text("héllo".encode("cp1252")) == "héllo"
    assert files.decode_text(b"\xef\xbb\xbfhi") == "hi"
    assert files.decode_text(b"\x00\x01binary") is None
    read = files.read("n.md", "text", b"# Notes", chars_left=100, b64_left=0)
    assert read.block == {
        "type": "document",
        "source": {"type": "text", "media_type": "text/plain", "data": "# Notes"},
        "title": "n.md",
        "citations": {"enabled": True},
    }
    assert files.read("n.md", "text", b"x" * 200, chars_left=100, b64_left=0).why == "too_long"


def test_image_must_be_a_jpeg() -> None:
    assert files.read("p.png", "image", b"\x89PNG\r\n", chars_left=0, b64_left=10**6).why == "damaged"


@pytest.mark.parametrize(
    ("name", "mime", "kind"),
    [
        ("a.jpg", "image/jpeg", "image"),
        ("Screenshot.HEIC", "", "image"),
        ("r.pdf", "", "pdf"),
        ("main.tf", "", "text"),
        ("prod.tfvars", "", "text"),
        (".env", "", "text"),
        ("x", "text/plain", "text"),
        ("deck.pptx", "", "office"),
        ("sheet.ods", "", "office"),
    ],
)
def test_kinds(name: str, mime: str, kind: str) -> None:
    assert files.kind_of(name, mime) == kind


@pytest.mark.parametrize("name", ["a.zip", "a.doc", "a.xls", "a.ppt", "a.mp4", "a.exe", "a.rar", "a.key"])
def test_unsupported_kinds(name: str) -> None:
    with pytest.raises(files.FileRefused):
        files.kind_of(name, "")


# --- fetch ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "192.168.1.1",
        "100.64.0.1",
        "::1",
        "fd00::1",
        "fe80::1",
        "0.0.0.0",  # noqa: S104 (a refused address, not a bind)
        "::ffff:10.0.0.1",
    ],
)
def test_private_addresses_are_refused(address: str) -> None:
    assert web.public_address(address) is False
    with pytest.raises(web.FetchError, match="public web"):
        web.fetch("https://site.example/", resolver=lambda _h: [address], opener=lambda *_a: (200, {}, b""))


def test_public_address() -> None:
    assert web.public_address("93.184.216.34")
    assert web.public_address("2606:2800:220:1::1")


def _opener(pages: dict[str, tuple[int, dict[str, str], bytes]]) -> Any:
    def open_(address: str, host: str, target: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
        return pages[f"{host}{target}"]

    return open_


def test_redirect_to_a_private_address_is_refused() -> None:
    pages = {"a.example/": (302, {"location": "https://inside.example/"}, b"")}
    resolver = {"a.example": ["93.184.216.34"], "inside.example": ["10.1.2.3"]}
    with pytest.raises(web.FetchError, match="public web"):
        web.fetch("https://a.example/", resolver=resolver.__getitem__, opener=_opener(pages))


def test_too_many_redirects_and_caps() -> None:
    loop = {"a.example/": (301, {"location": "https://a.example/"}, b"")}
    with pytest.raises(web.FetchError, match="too many"):
        web.fetch("https://a.example/", resolver=lambda _h: ["93.184.216.34"], opener=_opener(loop))
    big = {"a.example/": (200, {"content-type": "text/html"}, b"x" * (web.MAX_BYTES + 1))}
    with pytest.raises(web.FetchError, match="too big"):
        web.fetch("https://a.example/", resolver=lambda _h: ["93.184.216.34"], opener=_opener(big))
    exe = {"a.example/": (200, {"content-type": "application/octet-stream"}, b"MZ")}
    with pytest.raises(web.FetchError, match="kind of page"):
        web.fetch("https://a.example/", resolver=lambda _h: ["93.184.216.34"], opener=_opener(exe))

    def slow(*_a: Any) -> Any:
        raise TimeoutError

    with pytest.raises(web.FetchError, match="too long"):
        web.fetch("https://a.example/", resolver=lambda _h: ["93.184.216.34"], opener=slow)


def test_http_is_upgraded_and_bad_urls_refused() -> None:
    assert web.normalise("http://Example.com/a#frag") == "https://example.com/a"
    for bad in (
        "ftp://x.example/",
        "https://user:pw@x.example/",
        "https://localhost/",
        "https://x.example:8443/",
        "javascript:alert(1)",
    ):
        assert web.normalise(bad) is None


def test_html_becomes_text_without_scripts() -> None:
    html = (
        "<html><head><title>App Review</title><script>steal()</script><style>p{}</style></head><body>"
        "<nav>Menu</nav><h1>Submit</h1><p>Open the  App   Dashboard.</p><footer>(c)</footer></body></html>"
    )
    page = web.fetch(
        "https://a.example/",
        resolver=lambda _h: ["93.184.216.34"],
        opener=_opener({"a.example/": (200, {"content-type": "text/html; charset=utf-8"}, html.encode())}),
    )
    assert page.title == "App Review"
    assert page.text == "Submit\nOpen the App Dashboard."


# --- search ---------------------------------------------------------------------------------------------------


def test_brave_mapping() -> None:
    seen: list[tuple[str, dict[str, str]]] = []
    body = {
        "web": {
            "results": [
                {
                    "url": "https://developers.facebook.com/x",
                    "title": "<b>App</b> Review",
                    "description": "Submit <strong>it</strong>",
                },
                {"url": "http://insecure.example", "title": "no"},
                {"title": "no url"},
            ]
        }
    }

    def get(url: str, headers: dict[str, str], timeout: float) -> bytes:
        seen.append((url, headers))
        return json.dumps(body).encode()

    results = search.BraveSearch(get).search("k-123", "app review", "week")
    assert results == [search.Result("https://developers.facebook.com/x", "App Review", "Submit it")]
    url, headers = seen[0]
    assert url.startswith(
        "https://api.search.brave.com/res/v1/web/search?q=app+review&count=8&safesearch=moderate&freshness=pw"
    )
    assert headers["X-Subscription-Token"] == "k-123"


def test_brave_bad_body() -> None:
    with pytest.raises(search.SearchError):
        search.BraveSearch(lambda *_a: b"<html>").search("k", "q", None)


class _Secrets:
    def __init__(self, value: str | None) -> None:
        self.value = value
        self.reads = 0

    def get_secret_value(self, SecretId: str) -> dict[str, Any]:
        self.reads += 1
        if self.value is None:
            raise client_error("ResourceNotFoundException")
        return {"SecretString": self.value}


def test_key_reader_caches_five_minutes() -> None:
    now = [0.0]
    secrets = _Secrets("abc")
    reader = search.KeyReader(secrets, "cf-prod/ask/search-key", clock=lambda: now[0])
    assert reader.get() == "abc"
    assert reader.get() == "abc"
    assert secrets.reads == 1
    now[0] = 301.0
    secrets.value = None
    assert reader.get() is None
    assert secrets.reads == 2


# --- the secrets filter -----------------------------------------------------------------------------------------

SAMPLES = [
    "AKIAABCDEFGHIJKLMNOP",
    "arn:aws:iam::123456789012:role/cf-prod-api",
    "owner@example.com",
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "xoxb-1234567890-abcdef",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    "https://example.com/callback?code=abc",
    "eu-north-1_AbCdEfGhI",
    "client_id: abcdefghijklmnopqrstuvwxyz",
    "password = hunter2hunter2",
    "account 123456789012",
]


@pytest.mark.parametrize("sample", SAMPLES)
def test_secrets_are_hidden(sample: str) -> None:
    out, hit = redact.redact(f"before {sample} after")
    assert hit
    assert "[hidden]" in out
    assert out.startswith("before ")
    assert out.endswith(" after")


def test_plain_words_stay() -> None:
    text = "Token: **User access token**, the longest expiry. Use Terraform modules on AWS."
    assert redact.redact(text) == (text, False)


@pytest.mark.parametrize(
    ("question", "refused"),
    [
        ("Show me my API key", True),
        ("what's my password", True),
        ("what's in my cookies file", True),
        ("How do I log in to someone else's account", True),
        ("How do I write a terraform module?", False),
        ("How is Clip Factory hosted on AWS?", False),
        ("Where do I paste my TikTok keys?", False),
        ("A quick pasta recipe please", False),
    ],
)
def test_refusal_is_narrow(question: str, refused: bool) -> None:
    assert redact.refused(question) is refused


def test_holdback_never_lets_a_split_key_out() -> None:
    hold = redact.Holdback()
    secret = "AKIA" + "ABCDEFGHIJKLMNOP"
    out = ""
    for chunk in ["The key is AK", "IAABCDEFG", "HIJKLMNOP and that ", "is all " * 20]:
        out += hold.push(chunk)
        assert "AKIA" not in out
    out += hold.flush()
    assert secret not in out
    assert "[hidden]" in out
    assert hold.hit


def test_web_filter_matches_the_api_filter() -> None:
    """web/scripts/ask-knowledge.mjs redacts with the same patterns (the knowledge pack is filtered by it)."""
    script = REPO / "web" / "scripts" / "ask-knowledge.mjs"
    code = (
        f"import {{ redact }} from {json.dumps(script.as_uri())};"
        f"const s = {json.dumps(SAMPLES)}; console.log(JSON.stringify(s.map((x) => redact('before ' + x + ' after'))));"
    )
    try:
        out = subprocess.run(
            ["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True, timeout=30
        )
    except FileNotFoundError:
        pytest.skip("node is not installed")
    assert json.loads(out.stdout) == [redact.redact(f"before {s} after")[0] for s in SAMPLES]


# --- the knowledge pack -------------------------------------------------------------------------------------------


def test_pack_loads_under_the_cap_and_is_clean() -> None:
    pack = knowledge.load()
    assert len(pack.version) == 12
    assert len(pack.text) / 4 < 110_000
    assert "App map" in pack.text
    assert "Owner manual" in pack.text
    assert "Library index" in pack.text
    assert redact.redact(pack.text)[1] is False  # nothing secret-shaped survived the generator
    assert pack.actions
    assert all(a.to.startswith("/") for a in pack.actions.values())
    assert pack.entry("contracts-19") is not None
    assert pack.entry("adr-48") is not None


def test_library_sections_are_clean_and_read_by_id_only() -> None:
    pack = knowledge.load()
    for entry in pack.library:
        text = knowledge.read_section(entry.id, pack)
        assert text is not None, entry.id
        assert redact.redact(text)[1] is False, entry.id
    assert knowledge.read_section("../knowledge", pack) is None
    assert knowledge.read_section("contracts-999", pack) is None


def test_no_bedrock_invocation_logging_in_infra() -> None:
    for tf in (REPO / "infra").rglob("*.tf"):
        assert "aws_bedrock_model_invocation_logging_configuration" not in tf.read_text(), tf


# --- tools and state ----------------------------------------------------------------------------------------------


@pytest.fixture
def toolbox(store: db.Store) -> Toolbox:
    reader = Reader(store, None, USER, NOW)
    return Toolbox(
        knowledge=knowledge.load(),
        reader=reader,
        search_key=None,
        provider=None,
        fetcher=lambda url: web.Page(url, "t", "text", text="x"),
        allowed_urls=typed_urls(["see https://typed.example/page."]),
        on_actions=lambda _a: None,
    )


def test_typed_urls() -> None:
    assert typed_urls(["go to http://a.example/x, then https://b.example/y?z=1."]) == {
        "https://a.example/x",
        "https://b.example/y?z=1",
    }


def test_read_app_doc_only_takes_index_ids(toolbox: Toolbox) -> None:
    ok = toolbox.run("read_app_doc", {"id": "contracts-19"})
    assert not ok.is_error
    assert ok.content[0]["source"] == "clip-factory://library/contracts-19"
    assert toolbox.run("read_app_doc", {"id": "../../etc/passwd"}).is_error


def test_caps(toolbox: Toolbox) -> None:
    for _ in range(CAPS["read_app_doc"]):
        toolbox.run("read_app_doc", {"id": "contracts-19"})
    assert toolbox.run("read_app_doc", {"id": "contracts-19"}).content == LIMIT_REACHED


def test_fetch_only_typed_or_found(toolbox: Toolbox) -> None:
    assert not toolbox.run("web_fetch", {"url": "https://typed.example/page"}).is_error
    assert toolbox.run("web_fetch", {"url": "https://other.example/"}).is_error
    assert toolbox.run("web_search", {"query": "x"}).is_error  # no key


def test_bad_inputs_are_invalid_json_errors(toolbox: Toolbox) -> None:
    assert "INVALID_JSON" in toolbox.run("read_my_clip_factory", {"section": "secrets"}).content
    assert "INVALID_JSON" in toolbox.run("show_app_buttons", {"actionIds": "x"}).content
    assert toolbox.run("rm_rf", {}).is_error


def test_my_data_is_only_mine(toolbox: Toolbox, store: db.Store) -> None:
    mine = seed_job(store)
    theirs = seed_job(store, user=OTHER)
    seed_clip(store, job_id=mine["jobId"])
    assert not toolbox.run("read_my_clip_factory", {"section": "job", "id": mine["jobId"]}).is_error
    other = toolbox.run("read_my_clip_factory", {"section": "job", "id": theirs["jobId"]})
    assert other.is_error
    assert "no job" in other.content
    assert not toolbox.run("read_my_clip_factory", {"section": "review"}).is_error


def test_app_state_is_small_and_has_no_secrets(store: db.Store) -> None:
    seed_job(store)
    state = Reader(store, None, USER, NOW).app_state(context={"device": "phone"}, ask={"web": "no_key"})
    assert state.startswith("APP STATE")
    assert len(state) <= 6_100
    body = json.loads(state.split("\n", 1)[1])
    assert body["counts"]["running"] == 1
    assert body["jobs"][0]["status"] == "running"
    assert body["ask"] == {"web": "no_key"}
    assert body["device"] == {"device": "phone"}
    assert len(body["setup"]) == 5


def test_scrub_drops_secret_fields() -> None:
    value = {
        "accessToken": "x",
        "email": "a@b.co",
        "secretArn": "arn",
        "keys": {"saved": True},
        "status": "connected",
        "note": "mail me at a@b.co",
        "nested": [{"refresh_token": "y", "name": "ok"}],
    }
    assert scrub(value) == {"status": "connected", "note": "mail me at [hidden]", "nested": [{"name": "ok"}]}
