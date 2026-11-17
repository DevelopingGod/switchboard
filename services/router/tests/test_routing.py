"""Rules engine (SPEC §7.1): precedence, slash commands, intent, presets, health, budget, private."""

import pytest

from app.registry import load_registry
from app.routing import heuristics
from app.routing.engine import CatalogEntry, Context, RouteRequest, decide, reasons
from app.routing.health import Cooldowns
from app.routing.rules import load_rules

CATALOG = [
    CatalogEntry(
        1,
        "groq",
        "openai/gpt-oss-120b",
        None,
        ("chat", "code", "reasoning", "fast"),
        131072,
        0.15,
        0.6,
        "no-training",
        340,
    ),
    CatalogEntry(
        2,
        "groq",
        "openai/gpt-oss-20b",
        None,
        ("chat", "reasoning", "fast", "small"),
        131072,
        0.075,
        0.3,
        "no-training",
        210,
    ),
    CatalogEntry(
        3,
        "gemini",
        "gemini-3.1-flash-lite",
        None,
        ("chat", "fast", "long-context"),
        1_000_000,
        None,
        None,
        "may-train",
        1200,
    ),
    CatalogEntry(
        4, "ollama", "qwen3:4b", None, ("chat", "reasoning", "small"), 40960, None, None, "local", None
    ),
    CatalogEntry(5, "mistral", "mistral-small-latest", None, ("chat",), 128000, 0.2, 0.6, "may-train", None),
    CatalogEntry(6, "xai", "grok-4", None, ("chat", "reasoning"), 256000, 3.0, 15.0, "varies", None),
    CatalogEntry(
        7,
        "groq",
        "meta-llama/llama-prompt-guard-2-22m",
        None,
        ("moderation", "chat"),
        512,
        None,
        None,
        "no-training",
        50,
    ),
]


def ctx(connected=("groq", "gemini", "ollama"), preset=None, spent=0.0, cooldowns=None) -> Context:
    return Context(
        registry=load_registry(),
        rules=load_rules().with_preset(preset),
        connected=set(connected),
        catalog=CATALOG,
        cooldowns=cooldowns or Cooldowns(),
        spent_today=spent,
    )


def targets(dec):
    return [c.target for c in dec.candidates]


def skipped(dec):
    return {s.target: s.code for s in dec.skipped}


def test_default_chain_skips_unconnected_with_reasons():
    dec = decide(RouteRequest("what's the capital of France?"), ctx())
    assert dec.rule_id == "default" and dec.matched_by == "default"
    assert targets(dec) == ["model:fast", "model:smart-free", "model:local"]
    assert skipped(dec) == {"model:general": "not_connected", "model:explore": "not_connected"}
    general = next(s for s in dec.skipped if s.target == "model:general")
    assert "Mistral" in general.reason and "Connections" in general.reason


@pytest.mark.parametrize(
    ("text", "rule", "first", "intent"),
    [
        ("/chat write a python function", "default", "model:fast", "chat"),
        ("/code reverse a string", "code-light", "model:fast", "code"),  # code-free not keyed
        ("/research vector databases", "research", "model:smart-free", "research"),
        ("/bulk summarise these 40 lines", "bulk", "model:fast", "bulk"),
        ("/private my medical notes", "private", "model:local", "chat"),
    ],
)
def test_each_slash_command_routes(text, rule, first, intent):
    dec = decide(RouteRequest(text), ctx())
    assert dec.matched_by in ("slash", "private") and dec.rule_id == rule
    assert dec.candidates[0].target == first and dec.intent == intent
    assert not dec.prompt.startswith("/")


@pytest.mark.parametrize(
    ("text", "kind"), [("/image a red fox", "image"), ("/video 8s product spin", "video")]
)
def test_media_slash_commands_go_to_studio(text, kind):
    dec = decide(RouteRequest(text), ctx())
    assert dec.media == kind and dec.candidates == [] and dec.intent == kind


def test_research_is_job_like_and_skips_agents_with_reason():
    dec = decide(RouteRequest("/research competitors of Notion"), ctx())
    assert dec.job_suggested
    assert skipped(dec)["agent:hermes"] == "agent" and "M4" in dec.skipped[0].reason


@pytest.mark.parametrize(
    ("text", "rule"),
    [
        ("Can you refactor this python function to be faster?", "code-light"),
        ("Fix the failing tests in the repo switchboard", "code-heavy"),
        ("Write a LinkedIn post about our launch", "writing"),
        ("Write a polished, publication-ready blog post about tea", "writing-premium"),
        ("Make an image of a lighthouse at dusk", "image"),
        ("Research the competitors of Linear", "research"),
        ("How are you today?", "default"),
    ],
)
def test_keyword_intent_picks_rule(text, rule):
    assert decide(RouteRequest(text), ctx()).rule_id == rule


def test_heuristic_cue_is_explained():
    i = heuristics.detect("Traceback (most recent call last):\n  File x")
    assert i.intent == "code" and i.cue


def test_manual_pick_beats_slash_and_intent():
    dec = decide(RouteRequest("/code fix my python", target="model:smart-free"), ctx())
    assert dec.rule_id == "manual" and dec.matched_by == "manual"
    assert targets(dec) == ["model:smart-free"]
    assert dec.prompt == "fix my python"


def test_manual_pick_of_a_specific_catalog_model():
    dec = decide(RouteRequest("hi", target="model:groq/openai/gpt-oss-20b"), ctx())
    c = dec.candidates[0]
    assert c.litellm_model == "groq/openai/gpt-oss-20b" and c.catalog_id == 2 and c.free_tier


def test_bad_target_rejected():
    with pytest.raises(ValueError):
        decide(RouteRequest("hi", target="agent:claude-code"), ctx())


def test_private_never_leaves_the_machine():
    for req in [
        RouteRequest("hello", private=True),
        RouteRequest("hello", private=True, target="model:fast"),
        RouteRequest("/code refactor this", private=True),
        RouteRequest("/research something", private=True),
        RouteRequest("hello", private=True, target="model:groq/openai/gpt-oss-120b"),
    ]:
        dec = decide(req, ctx(connected=("groq", "gemini", "ollama", "mistral")))
        assert dec.private and dec.candidates
        reg = load_registry()
        for c in dec.candidates:
            assert c.local and all(reg.providers[p].kind == "local" for p in c.providers), c.target
    picked = decide(RouteRequest("hello", private=True, target="model:fast"), ctx())
    assert picked.rule_id == "private" and skipped(picked)["model:fast"] == "private"
    assert "your pick was not used" in picked.skipped[0].reason


def test_private_with_a_local_pick_is_honoured():
    dec = decide(RouteRequest("hello", private=True, target="model:local-code"), ctx())
    assert targets(dec)[0] == "model:local-code" and dec.rule_id == "manual"


def test_cooldown_skips_target():
    cd = Cooldowns()
    cd.set("model:fast", "rate_limited", "Rate limited (429)", 60)
    dec = decide(RouteRequest("hi"), ctx(cooldowns=cd))
    assert targets(dec)[0] == "model:smart-free"
    s = next(s for s in dec.skipped if s.target == "model:fast")
    assert s.code == "cooldown" and "429" in s.reason and "cooling down" in s.reason


def test_free_preset_never_routes_paid_even_when_picked():
    dec = decide(RouteRequest("hi", target="model:xai/grok-4"), ctx(connected=("groq", "xai"), preset="free"))
    assert dec.candidates == [] and skipped(dec)["model:xai/grok-4"] == "paid"


def test_balanced_preset_allows_paid_only_when_picked():
    c = ctx(connected=("groq", "xai"), preset="balanced")
    assert targets(decide(RouteRequest("hi", target="model:xai/grok-4"), c)) == ["model:xai/grok-4"]


def test_best_preset_uses_best_capability_with_runner_up():
    dec = decide(RouteRequest("explain monads"), ctx(preset="best"))
    assert dec.rule_id == "default" and dec.preset == "best"
    # free first, then fastest measured: gpt-oss-20b (210 ms) beats gpt-oss-120b (340 ms)
    assert targets(dec)[:2] == ["model:groq/openai/gpt-oss-20b", "model:groq/openai/gpt-oss-120b"]
    assert dec.candidates[0].note == "best:reasoning"
    why = reasons(dec, dec.candidates[0], load_registry(), CATALOG)
    assert any("reasoning" in r for r in why)


def test_best_never_picks_moderation_models():
    dec = decide(RouteRequest("explain monads"), ctx(preset="best"))
    assert all("prompt-guard" not in t for t in targets(dec))


def test_daily_cap_blocks_paid_but_not_free():
    c = ctx(connected=("groq", "mistral", "ollama"), spent=1.5)
    paid = decide(RouteRequest("hi", target="model:general"), c)
    assert paid.blocked_by_budget and skipped(paid)["model:general"] == "budget_daily"
    assert "$1.00" in paid.skipped[0].reason
    free = decide(RouteRequest("hi"), c)  # fast = Groq free tier
    assert targets(free)[0] == "model:fast" and not free.blocked_by_budget


def test_per_request_cap_blocks_expensive_model():
    dec = decide(
        RouteRequest("x" * 800_000, target="model:xai/grok-4"), ctx(connected=("xai",), preset="best")
    )
    assert dec.blocked_by_budget and skipped(dec)["model:xai/grok-4"] == "budget_request"


def test_per_request_cap_bounds_max_tokens():
    dec = decide(RouteRequest("hi", target="model:xai/grok-4"), ctx(connected=("xai",), preset="best"))
    # $0.50 / $15 per 1M output tokens ≈ 33k tokens, so the 4096 default stands
    assert dec.candidates[0].max_tokens == 4096
    tight = ctx(connected=("xai",), preset="best")
    rules = tight.rules
    from dataclasses import replace

    tight.rules = replace(rules, defaults=replace(rules.defaults, max_cost_usd=0.01))
    dec = decide(RouteRequest("hi", target="model:xai/grok-4"), tight)
    assert 256 <= dec.candidates[0].max_tokens < 700


def test_unknown_alias_is_explained():
    dec = decide(RouteRequest("Write a polished, publication-ready blog post about tea"), ctx())
    assert skipped(dec)["model:grok"] == "not_configured"
    assert targets(dec)[0] == "model:smart-free"


def test_cooling_target_is_a_last_resort_not_a_dead_end():
    cd = Cooldowns()
    cd.set("model:local", "error", "Provider error (500)", 15)
    dec = decide(RouteRequest("secret", private=True), ctx(cooldowns=cd))
    assert targets(dec) == ["model:local"] and "model:local" not in skipped(dec)
