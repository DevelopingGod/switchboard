"""Local-model profiles (M3a): detection -> recommendation, aliases follow the profile, owner override,
at most `max_loaded` models in GPU memory, and the `none` profile (no classifier, cloud titles unless
private)."""

import pytest

from app import local_profile, ollama
from app.registry import load_registry
from tests.conftest import ADMIN
from tests.test_chat import first, stack, turn  # noqa: F401  (fixtures)


@pytest.mark.parametrize(
    ("vram", "want"),
    [(None, "small"), (2.0, "none"), (4.0, "small"), (6.0, "small"), (12.0, "medium"), (24, "large")],
)
def test_recommend(vram, want):
    assert local_profile.recommend(vram) == want


def test_local_aliases_follow_the_profile():
    def models():
        reg = load_registry()
        return {a: reg.alias(a)[0].model for a in ("local", "private", "local-code")}

    assert models() == {"local": "qwen3:4b", "private": "qwen3:4b", "local-code": "qwen3:4b"}
    local_profile.set_active("large")
    assert models() == {"local": "qwen3:14b", "private": "qwen3:14b", "local-code": "qwen2.5-coder:14b"}
    local_profile.set_active("none")
    assert models()["local"] == "llama3.2:3b" and local_profile.active().classifier is None


@pytest.fixture
def hw(mock_http):
    route = mock_http.get("http://hostprobe.test/hw")
    route.respond(200, json={"gpu": "RTX 3050", "vram_mb": 4096, "ram_mb": 14000, "source": "nvidia-smi"})
    return route


async def test_first_start_detects_and_owner_choice_sticks(session, hw, ollama_fake):
    state = await local_profile.init(session)
    assert state["active"] == "small" and state["detected"]["vram_gb"] == 4.0 and not state["overridden"]
    await local_profile.choose(session, "medium")
    hw.respond(200, json={"vram_mb": 24576, "ram_mb": 64000})
    state = await local_profile.init(session, redetect=True)  # new GPU detected: recommendation changes...
    assert state["recommended"] == "large" and state["active"] == "medium"  # ...but the pick is kept
    state = await local_profile.choose(session, None)  # back to the detected one
    assert state["active"] == "large" and not state["overridden"]


async def test_detection_unavailable_uses_the_fallback(session, mock_http):
    mock_http.get("http://hostprobe.test/hw").respond(503)
    state = await local_profile.init(session)
    assert state["active"] == "small" and state["detected"]["vram_gb"] is None


async def test_profile_api(client, litellm, session, hw):
    ollama_fake = litellm.ollama
    ollama_fake.installed = ["qwen3:4b"]  # Arch-Router not pulled yet
    await local_profile.init(session)
    v = (await client.get("/system/local-profile")).json()
    assert v["active"] == "small" and v["detected"]["vram_gb"] == 4.0
    assert v["missing"] == ["hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M", "llama3.2:3b"]
    assert {p["name"] for p in v["profiles"]} == {"none", "small", "medium", "large"}
    r = await client.put("/system/local-profile", json={"profile": "large"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["active"] == "large" and r.json()["overridden"]
    # reconcile pointed LiteLLM's local alias at the new profile's model
    local = next(d for d in litellm.deployments("local"))
    assert local["litellm_params"]["model"] == "ollama_chat/qwen3:14b"
    r = await client.put("/system/local-profile", json={"profile": "huge"}, headers=ADMIN)
    assert r.status_code == 400
    assert (await client.put("/system/local-profile", json={"profile": None})).status_code == 401


async def test_enforce_max_loaded_never_evicts_the_classifier(ollama_fake):
    arch = "hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M"
    ollama_fake.loaded = [arch, "qwen3:4b", "qwen2.5-coder:3b"]
    out = await ollama.enforce_max_loaded([arch, "qwen2.5-coder:3b"], 2)
    assert out == ["qwen3:4b"] and ollama_fake.loaded == [arch, "qwen2.5-coder:3b"]
    assert await ollama.enforce_max_loaded([arch], 2) == []


async def test_none_profile_titles_use_the_cloud_only_for_non_private_threads(client, stack):
    local_profile.set_active("none")
    ev = await turn(client, text="how do I center a div in CSS?")
    assert "fast" in stack.chat_calls  # free cloud model wrote the title
    assert not stack.ollama.classifier_calls()  # no classifier in this profile
    stack.chat_calls.clear()
    ev = await turn(client, text="a private question", private=True)
    assert stack.chat_calls == [] and "title" not in [e for e, _ in ev]
    assert first(ev, "route")["local"] is True


async def test_classifier_is_reloaded_after_the_tasks_model_ran(client, stack):
    """4 GB GPU: qwen3 (title) evicts Arch-Router; it is loaded back in the background right away."""
    import asyncio

    from app.routing import classifier

    arch = local_profile.active().classifier
    stack.ollama.loaded = []
    await turn(client, text="how do I center a div in CSS?")
    await asyncio.gather(*classifier._tasks)
    warm = [c for c in stack.ollama.calls if c["model"] == arch and c["options"].get("num_predict") == 1]
    assert warm and warm[-1]["keep_alive"] == -1
    # a private thread never triggers it
    n = len(stack.ollama.calls)
    stack.ollama.loaded = []
    await turn(client, text="something private", private=True)
    await asyncio.gather(*classifier._tasks)
    assert not [c for c in stack.ollama.calls[n:] if c["model"] == arch]
