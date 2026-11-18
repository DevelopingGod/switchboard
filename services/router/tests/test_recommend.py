"""Recommender (SPEC §6.4, M3a): hard filters, score terms, the 5-sample rule, explore, reasons and
runner-up, and the dynamic `explore` alias."""

from dataclasses import replace

import pytest

from app.routing.engine import CatalogEntry, RouteRequest, decide, reasons
from app.routing.recommend import Stat, pick_stats, rank, score_one
from app.routing.rules import DEFAULT_WEIGHTS
from tests.test_routing import CATALOG, ctx, targets


def entry(
    i, provider, mid, tags=("chat", "code"), privacy="no-training", stats=None, context=131072, p50=None
):
    return CatalogEntry(i, provider, mid, None, tuple(tags), context, None, None, privacy, p50, stats or {})


PROVEN = {"code": Stat(samples=40, failures=2, p50_ms=400, up=6, down=1)}
NEW = {"code": Stat(samples=2, failures=0, p50_ms=150, up=2, down=0)}


def best_ctx(entries, explore=False, preset="best"):
    c = ctx(connected=("groq", "gemini", "ollama"), preset=preset)
    c.catalog = entries
    c.explore = explore
    return c


def code_rules(c, target="best:code"):
    rules = tuple(
        replace(r, target=target, fallbacks=()) if r.id == "code-light" else r for r in c.rules.rules
    )
    c.rules = replace(c.rules, rules=rules)
    return c


def test_score_terms_are_bounded_and_weighted():
    e = entry(1, "groq", "m", stats=PROVEN)
    s = score_one(
        e, task="code", weights=DEFAULT_WEIGHTS, min_samples=5, free=True, local=False, headroom=0.5
    )
    assert all(0 <= v <= 1 for v in s.parts.values())
    assert s.parts["capability"] == 1.0  # has "code" for a code task
    assert s.parts["feedback"] == pytest.approx(7 / 9)
    assert s.parts["success"] == pytest.approx(39 / 42)
    assert s.parts["latency"] == pytest.approx(1 - 400 / 8000)
    assert s.parts["headroom"] == 0.5 and s.parts["cost"] == 1.0 and s.parts["privacy"] == 1.0
    assert s.proven and 0 < s.score < 1


def test_task_stats_fall_back_to_all_task_types():
    st, test = pick_stats(
        {"chat": Stat(3, 1, 500), "writing": Stat(4, 0, 300), "test": Stat(1, 0, 90)}, "code"
    )
    assert (st.samples, st.failures) == (7, 1) and test.p50_ms == 90


def test_unproven_model_never_beats_a_proven_one_unless_explore():
    # a mediocre proven model vs a new one that scores higher (but has only 2 samples)
    proven = entry(
        1, "groq", "proven", stats={"code": Stat(samples=40, failures=15, p50_ms=3000, up=1, down=5)}
    )
    shiny = entry(2, "groq", "shiny", stats=NEW)
    kw = dict(
        task="code",
        weights=DEFAULT_WEIGHTS,
        min_samples=5,
        is_free=lambda e: True,
        is_local=lambda e: False,
        headroom=lambda e: 1.0,
    )
    assert [s.entry.model_id for s in rank([shiny, proven], explore=False, **kw)] == ["proven", "shiny"]
    assert [s.entry.model_id for s in rank([shiny, proven], explore=True, **kw)] == ["shiny", "proven"]


def test_best_target_uses_scores_and_explains_them():
    c = code_rules(best_ctx([entry(1, "groq", "openai/gpt-oss-120b", stats=PROVEN), *CATALOG[1:4]]))
    dec = decide(RouteRequest("fix this python function"), c)
    assert dec.rule_id == "code-light"
    chosen = dec.candidates[0]
    assert chosen.target == "model:groq/openai/gpt-oss-120b" and chosen.scored is not None
    why = reasons(dec, chosen, c.registry, c.catalog)
    assert len(why) == 3 and why[1].startswith("Best for “code”: score ")
    assert any("answered without error (40 replies)" in r or "ms to first token" in r for r in why[2:])


def test_hard_filters_context_window_privacy_and_tags():
    tiny = entry(5, "groq", "tiny", context=1000, stats=PROVEN)
    big = entry(6, "gemini", "big", privacy="may-train", context=1_000_000)
    c = code_rules(best_ctx([tiny, big]))
    dec = decide(RouteRequest("fix this python function", context_chars=40_000), c)  # ~10k tokens
    assert targets(dec)[0] == "model:gemini/big"  # tiny can't hold the history
    local = entry(7, "ollama", "qwen3:4b", privacy="local")
    c = code_rules(best_ctx([big, local]))
    dec = decide(RouteRequest("fix this python function", private=True), c)
    assert all(t.startswith("model:local") or "ollama" in t for t in targets(dec))


def test_runner_up_carries_its_score():
    from app.chat.service import _chip

    c = code_rules(best_ctx([entry(1, "groq", "a", stats=PROVEN), entry(2, "gemini", "b", stats=PROVEN)]))
    dec = decide(RouteRequest("fix this python function"), c)
    chip = _chip(c, dec, dec.candidates[0], None)
    assert chip["runner_up"].endswith(f"(score {dec.candidates[1].scored.score:.2f})")
    assert chip["score"] == dec.candidates[0].scored.score


def test_explore_flag_is_named_in_the_reason():
    c = code_rules(best_ctx([entry(2, "groq", "shiny", stats=NEW)], explore=True))
    dec = decide(RouteRequest("fix this python function"), c)
    why = reasons(dec, dec.candidates[0], c.registry, c.catalog)
    assert "exploring: new model, 2 samples" in why[1]


# --- dynamic explore alias (M1.5 carry-over: the pinned free model was retired -> 404) ----------
OR = [
    entry(30, "openrouter", "google/gemma-4-31b-it:free", tags=("chat",), privacy="varies"),
    entry(
        31,
        "openrouter",
        "nvidia/nemotron-3.5-lightning:free",
        tags=("chat",),
        privacy="varies",
        stats={"chat": Stat(samples=20, failures=0, p50_ms=600)},
    ),
    entry(32, "openrouter", "anthropic/claude-sonnet-4", tags=("chat",), privacy="varies"),
]


def test_explore_resolves_to_the_best_free_openrouter_model():
    c = ctx(connected=("openrouter",))
    c.catalog = OR
    dec = decide(RouteRequest("hi", target="model:explore"), c)
    assert targets(dec) == ["model:openrouter/nvidia/nemotron-3.5-lightning:free"]  # proven, free
    assert dec.candidates[0].note == "alias:explore" and dec.candidates[0].timeout == 60


def test_explore_never_picks_a_retired_or_paid_model():
    c = ctx(connected=("openrouter",))
    c.catalog = [OR[2]]  # only a paid model is listed: the free ones were retired (status missing)
    dec = decide(RouteRequest("hi", target="model:explore"), c)
    assert dec.candidates == [] and "no available free chat model" in dec.skipped[0].reason


def test_explore_skips_a_model_cooling_down_after_a_404():
    c = ctx(connected=("openrouter",))
    c.catalog = OR
    c.cooldowns.set("model:openrouter/nvidia/nemotron-3.5-lightning:free", "not_found", "404", 3600)
    dec = decide(RouteRequest("hi", target="model:explore"), c)
    assert targets(dec) == ["model:openrouter/google/gemma-4-31b-it:free"]
