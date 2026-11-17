"""Fetcher parsing, tagging, and the catalog refresh rules (missing/deprecated/no_key)."""

import httpx
import pytest
from sqlalchemy import select

from app import secrets
from app.catalog import fetchers
from app.catalog.job import refresh_all, refresh_provider
from app.models import Connection, ModelCatalog
from app.registry import load_registry, load_tag_rules
from tests import fixtures as fx

GROQ = "https://api.groq.com/openai/v1/models"
GEMINI = "https://generativelanguage.googleapis.com/v1beta/models"


@pytest.fixture
def reg():
    return load_registry()


async def test_openai_fetcher(mock_http, reg):
    route = mock_http.get(GROQ).respond(200, json=fx.GROQ_MODELS)
    async with httpx.AsyncClient() as c:
        models = await fetchers.fetch(c, reg.get("groq"), "gsk_testkey12345")
    assert route.calls.last.request.headers["authorization"] == "Bearer gsk_testkey12345"
    by_id = {m.model_id: m for m in models}
    assert by_id["openai/gpt-oss-120b"].context == 131072
    assert by_id["openai/gpt-oss-120b"].prices == {"input_per_1m": 0.15, "output_per_1m": 0.6}
    assert by_id["qwen/qwen3.8-27b"].input_modalities == ["text", "image"]
    assert by_id["allam-2-7b"].deprecated  # active: false


async def test_gemini_fetcher_key_in_header_and_paginates(mock_http, reg):
    route = mock_http.get(GEMINI).mock(
        side_effect=[httpx.Response(200, json=fx.GEMINI_PAGE_1), httpx.Response(200, json=fx.GEMINI_PAGE_2)]
    )
    async with httpx.AsyncClient() as c:
        models = await fetchers.fetch(c, reg.get("gemini"), "AIzaTESTKEY0000000000000000")
    assert [m.model_id for m in models] == [
        "gemini-3.5-flash",
        "gemini-embedding-2",
        "gemini-2.5-computer-use-preview-10-2025",
    ]
    for call in route.calls:
        assert call.request.headers["x-goog-api-key"] == "AIzaTESTKEY0000000000000000"
        assert "key=" not in str(call.request.url) and "AIza" not in str(call.request.url)
    assert route.calls[1].request.url.params["pageToken"] == "p2"


async def test_openrouter_and_zen_free_flags(mock_http, reg):
    mock_http.get("https://openrouter.ai/api/v1/models").respond(200, json=fx.OPENROUTER_MODELS)
    mock_http.get("https://opencode.ai/zen/v1/models").respond(200, json=fx.ZEN_MODELS)
    async with httpx.AsyncClient() as c:
        orr = {m.model_id: m for m in await fetchers.fetch(c, reg.get("openrouter"), "sk-or-test12345")}
        zen = {m.model_id: m for m in await fetchers.fetch(c, reg.get("opencode-zen"), "zen-test-12345")}
    assert orr["openai/gpt-oss-120b:free"].free and not orr["tencent/hy4-flash"].free
    assert orr["tencent/hy4-flash"].deprecated  # has expiration_date
    assert zen["big-pickle"].free and not zen["claude-sonnet-5-5"].free
    assert zen["claude-sonnet-5-5"].input_modalities == ["image", "text"]


async def test_fetch_error_on_bad_key(mock_http, reg):
    mock_http.get(GROQ).respond(401, json={"error": {"message": "Invalid API Key"}})
    async with httpx.AsyncClient() as c:
        with pytest.raises(fetchers.FetchError, match="key rejected"):
            await fetchers.fetch(c, reg.get("groq"), "gsk_bad_key_123456")


def test_tagging_curated_metadata_untagged():
    from app.catalog.job import tag

    rules = load_tag_rules()
    m = fetchers.FetchedModel("openai/gpt-oss-120b", context=131072, output_modalities=["text"])
    assert tag("groq", m, rules) == (["chat", "code", "reasoning", "fast"], "curated")
    m = fetchers.FetchedModel(
        "brand-new-x", context=400_000, input_modalities=["text", "image"], output_modalities=["text"]
    )
    assert tag("cerebras", m, rules) == (["chat", "vision", "long-context"], "metadata")
    assert tag("ollama", fetchers.FetchedModel("mystery:1b"), rules) == ([], "untagged")


async def test_refresh_marks_missing_and_deprecated(mock_http, session, reg):
    rules = load_tag_rules()
    await secrets.store_key(session, "groq", "gsk_testkey12345")
    await session.commit()
    route = mock_http.get(GROQ)
    route.respond(200, json=fx.GROQ_MODELS)
    async with httpx.AsyncClient() as c:
        r = await refresh_provider(session, c, reg.get("groq"), rules)
    assert r["added"] == 4
    rows = {m.model_id: m for m in (await session.execute(select(ModelCatalog))).scalars()}
    assert rows["allam-2-7b"].status == "deprecated"
    assert rows["openai/gpt-oss-120b"].status == "available"
    assert rows["whisper-large-v3"].tags_json == ["audio"]

    # A model disappears from a successful fetch -> missing.
    route.respond(200, json={"data": fx.GROQ_MODELS["data"][1:]})
    async with httpx.AsyncClient() as c:
        r = await refresh_provider(session, c, reg.get("groq"), rules)
    assert r["missing"] == 1
    await session.refresh(rows["openai/gpt-oss-120b"])
    assert rows["openai/gpt-oss-120b"].status == "missing"

    # A failed fetch never marks anything missing.
    route.respond(500, text="upstream down")
    async with httpx.AsyncClient() as c:
        r = await refresh_provider(session, c, reg.get("groq"), rules)
    assert "error" in r
    await session.refresh(rows["qwen/qwen3.8-27b"])
    assert rows["qwen/qwen3.8-27b"].status == "available"
    conn = (await session.execute(select(Connection).where(Connection.provider == "groq"))).scalar_one()
    assert conn.status == "error" and "500" in conn.last_error

    # It comes back -> available again.
    route.respond(200, json=fx.GROQ_MODELS)
    async with httpx.AsyncClient() as c:
        await refresh_provider(session, c, reg.get("groq"), rules)
    await session.refresh(rows["openai/gpt-oss-120b"])
    assert rows["openai/gpt-oss-120b"].status == "available"


async def test_curated_deprecated_list(mock_http, session, reg):
    await secrets.store_key(session, "gemini", "AIzaTESTKEY0000000000000000")
    await session.commit()
    mock_http.get(GEMINI).mock(
        side_effect=[httpx.Response(200, json=fx.GEMINI_PAGE_1), httpx.Response(200, json=fx.GEMINI_PAGE_2)]
    )
    async with httpx.AsyncClient() as c:
        await refresh_provider(session, c, reg.get("gemini"), load_tag_rules())
    rows = {m.model_id: m for m in (await session.execute(select(ModelCatalog))).scalars()}
    assert rows["gemini-2.5-computer-use-preview-10-2025"].status == "deprecated"
    assert rows["gemini-embedding-2"].tags_json == ["embedding"]
    assert "long-context" in rows["gemini-3.5-flash"].tags_json


async def test_refresh_all_skips_unkeyed(mock_http, session, reg):
    mock_http.get("http://ollama.test/api/tags").respond(200, json=fx.OLLAMA_TAGS)
    async with httpx.AsyncClient() as c:
        results = await refresh_all(session, c, reg)
    by = {r["provider"]: r for r in results}
    assert by["groq"] == {"provider": "groq", "skipped": "no_key"}
    assert by["ollama"]["added"] == 2
    assert not any(c.request.url.host == "api.groq.com" for c in mock_http.calls)
