"""Generic OpenAI-compatible adapter (M3a): a new provider is a providers.yaml entry only.

The config dir used here differs from the real one by one appended provider, written in YAML, with a
URL placeholder, a custom model-list URL and field names, and free limits. No code knows about it:
key add (validated by fetching the list), catalog, LiteLLM credential + wildcard, routing, a streamed
chat, quota counting and the Connections listing all work."""

import shutil
from pathlib import Path

import httpx
import pytest
import yaml

from app import quota
from app.config import get_settings
from app.models import ModelCatalog
from app.registry import load_registry
from app.routing.context import build_context
from app.routing.engine import RouteRequest, decide
from tests.conftest import ADMIN
from tests.test_chat import first, turn

ACME = """
  acme:
    adapter: openai-compatible
    name: Acme AI
    base_url: https://api.acme.test/accounts/{account_id}/v1
    models_url: https://api.acme.test/accounts/{account_id}/catalog
    models_fields: { id: slug, name: title, context: limits.ctx, output_modalities: outputs }
    params: [account_id]
    free_tier: true
    privacy: no-training
    free_limits: "10 req/day"
    limits: { scope: model, default: { rpm: 5, rpd: 10 } }
"""
KEY = "acme-key-0123456789abcdef"  # gitleaks:allow
CATALOG = [  # a bare array with its own field names
    {"slug": "acme/chat-large", "title": "Acme Chat Large", "limits": {"ctx": 131072}, "outputs": ["text"]},
    {"slug": "acme/paint-1", "title": "Acme Paint", "outputs": ["image"]},
]


@pytest.fixture
def acme_config(tmp_path: Path):
    real = get_settings().config_dir
    for f in real.glob("*.yaml"):
        shutil.copy(f, tmp_path / f.name)
    text = (tmp_path / "providers.yaml").read_text()
    head, tail = text.split("\ngoals:", 1)
    (tmp_path / "providers.yaml").write_text(head.rstrip() + "\n" + ACME + "\ngoals:" + tail)
    s = get_settings()
    s.config_dir = tmp_path
    yield tmp_path
    s.config_dir = real


def test_registry_reads_the_new_entry(acme_config):
    p = load_registry().providers["acme"]
    assert (p.kind, p.catalog, p.litellm_prefix) == ("api_key", "openai", "openai")
    filled = p.with_params({"account_id": "a b/c"})
    assert filled.models_url == "https://api.acme.test/accounts/a%20b%2Fc/catalog"
    assert filled.chat_base_url == "https://api.acme.test/accounts/a%20b%2Fc/v1"
    assert yaml.safe_load(ACME)["acme"]["adapter"] == "openai-compatible"


def test_bad_adapter_entries_are_rejected(acme_config):
    path = acme_config / "providers.yaml"
    path.write_text(path.read_text().replace("adapter: openai-compatible", "adapter: soap"))
    with pytest.raises(ValueError, match="unknown adapter"):
        load_registry()


async def test_yaml_only_provider_end_to_end(acme_config, client, litellm, mock_http, session, hostprobe_up):
    seen = []

    def catalog(request):
        seen.append(request)
        return httpx.Response(200, json=CATALOG)

    mock_http.get("https://api.acme.test/accounts/acct-42/catalog").mock(side_effect=catalog)

    # the key form asks for the declared param too
    r = await client.put("/connections/acme/key", json={"api_key": KEY}, headers=ADMIN)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "params_missing"
    r = await client.put(
        "/connections/acme/key", json={"api_key": KEY, "params": {"account_id": "acct-42"}}, headers=ADMIN
    )
    assert r.status_code == 200, r.text
    assert seen[-1].headers["authorization"] == f"Bearer {KEY}"

    rows = {m.model_id: m for m in (await session.execute(ModelCatalog.__table__.select())).all()}
    assert set(rows) == {"acme/chat-large", "acme/paint-1"}
    assert (
        rows["acme/chat-large"].context == 131072
        and rows["acme/chat-large"].display_name == "Acme Chat Large"
    )
    assert "chat" in rows["acme/chat-large"].tags_json and "image" in rows["acme/paint-1"].tags_json

    # LiteLLM: one credential with the filled-in base URL, one wildcard deployment
    assert litellm.credentials["sb-acme"] == {
        "api_key": KEY,
        "api_base": "https://api.acme.test/accounts/acct-42/v1",
    }
    wild = next(d for d in litellm.deployments() if d["model_name"] == "acme/*")
    assert wild["litellm_params"]["model"] == "openai/*"

    # Connections listing shows the param (not the key)
    conns = (await client.get("/connections")).json()["providers"]
    acme = next(c for c in conns if c["provider"] == "acme")
    assert acme["params"] == ["account_id"] and acme["param_values"] == {"account_id": "acct-42"}

    # routing + a streamed chat through the wildcard
    ctx = await build_context(session)
    dec = decide(RouteRequest("hi", target="model:acme/acme/chat-large"), ctx)
    assert dec.candidates[0].litellm_model == "acme/acme/chat-large" and dec.candidates[0].free_tier
    ev = await turn(client, text="hello acme", target="model:acme/acme/chat-large")
    done = [d for e, d in ev if e == "done"][0]
    assert done["status"] == "done" and done["route"]["provider"] == "acme"
    assert first(ev, "route")["target"] == "model:acme/acme/chat-large"

    # quota limits from the YAML apply to the new provider
    view = await quota.load_view(session, load_registry())
    u = view.usage("acme", "acme/chat-large")
    assert u.limit in (5, 10) and u.used >= 1
