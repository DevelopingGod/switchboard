"""Quota guard (M3a): limits from providers.yaml, persisted counters, headers, rerouting before a 429,
spreading to stand-ins, test limits, footer/Status data."""

from datetime import UTC, datetime, timedelta

import pytest

from app import quota
from app.config import get_settings
from app.models import QuotaUsage
from app.registry import load_registry
from app.routing.engine import RouteRequest, decide, reasons
from app.routing.health import Cooldowns
from tests.conftest import ADMIN
from tests.test_chat import first, stack, turn  # noqa: F401  (fixtures)
from tests.test_m15_api import probes  # noqa: F401  (fixture)
from tests.test_routing import CATALOG, ctx, targets

NOW = datetime(2026, 11, 18, 10, 30, 30, tzinfo=UTC)


@pytest.fixture
def test_limits():
    s = get_settings()
    old = s.router_quota_test_limits

    def set_(v: str) -> None:
        s.router_quota_test_limits = v

    yield set_
    s.router_quota_test_limits = old


def view(counters=None, headers=None, now=NOW) -> quota.QuotaView:
    return quota.QuotaView(load_registry(), now, counters or {}, headers or {})


def test_policies_come_from_providers_yaml():
    reg = load_registry()
    g = quota.policy(reg.providers["groq"])
    assert g.scope == "model" and g.default.rpd == 1000 and g.default.rpm == 30 and g.default.tpm == 8000
    assert g.headers == {"requests": "day", "tokens": "minute"}  # Groq's documented header windows
    o = quota.policy(reg.providers["openrouter"])
    assert o.scope == "provider" and o.only_free and o.default.rpd == 50
    gm = quota.policy(reg.providers["gemini"])
    assert gm.tz == "America/Los_Angeles"
    assert quota.policy(reg.providers["ollama"]) is None  # local: unlimited
    # paid OpenRouter models are not counted against the free limit; free ones share one counter
    assert quota.scope_of(reg.providers["openrouter"], o, "anthropic/claude-sonnet-4") is None
    assert quota.scope_of(reg.providers["openrouter"], o, "x/y:free") == "*"


def test_gemini_free_limits_are_the_owners_verified_numbers():
    """AI Studio, free tier, read 2026-11-19. `0` = no free access; globs match after exact ids."""
    gm = quota.policy(load_registry().providers["gemini"])

    def lim(m):
        x = quota.limit_of(gm, m)
        return (x.rpm, x.tpm, x.rpd)

    assert lim("gemini-3.1-flash-lite") == (15, 250_000, 500)
    assert lim("gemini-2.5-flash-lite") == (10, 250_000, 20)
    for m in ("gemini-2.5-flash", "gemini-3-flash", "gemini-3-flash-preview", "gemini-3.6-flash"):
        assert lim(m) == (5, 250_000, 20), m
    for m in ("gemini-2.5-flash-tts", "gemini-3.1-flash-tts", "gemini-3.6-flash-tts"):
        assert lim(m) == (3, 10_000, 10), m
    for m in (
        "gemini-2.5-pro",
        "gemini-3.1-pro-preview",
        "gemini-3-pro-image",
        "gemini-3-flash-image",
        "nano-banana-pro",
    ):
        assert lim(m) == (0, 0, 0), m


def test_a_zero_limit_means_no_free_access():
    v = view()
    u = v.usage("gemini", "gemini-2.5-pro")
    assert u is not None and u.fraction == 1.0 and u.limit == 0
    assert "no free access" in u.describe()
    assert v.headroom("gemini", "gemini-2.5-pro") == 0.0
    assert v.headroom("gemini", "gemini-3.1-flash-lite") == 1.0


def test_day_window_follows_the_provider_time_zone():
    # 10:30 UTC = 02:30 Pacific: Gemini's day started at 08:00 UTC (midnight Pacific, PST)
    assert quota.day_start(NOW, "America/Los_Angeles") == datetime(2026, 11, 18, 8, 0, tzinfo=UTC)
    assert quota.day_start(NOW, "UTC") == datetime(2026, 11, 18, 0, 0, tzinfo=UTC)
    assert quota.next_day_start(NOW, "UTC") == datetime(2026, 11, 19, 0, 0, tzinfo=UTC)


def test_usage_picks_the_window_closest_to_its_limit():
    d0 = quota.day_start(NOW, "UTC")
    m0 = quota.minute_start(NOW)
    v = view(
        {
            ("groq", "openai/gpt-oss-120b", "d", d0): (820, 50_000),
            ("groq", "openai/gpt-oss-120b", "m", m0): (3, 2000),
            ("groq", "openai/gpt-oss-120b", "m", m0 - timedelta(minutes=1)): (10, 6000),
        }
    )
    u = v.usage("groq", "openai/gpt-oss-120b")
    assert u.window == "day" and u.kind == "requests" and u.fraction == pytest.approx(0.82)
    assert "82% of today's limit (820/1000)" in u.describe()
    # sliding minute: 2000 + 6000 * 0.5 = 5000 tokens of 8000
    tpm = next(
        w for w in v.windows("groq", "openai/gpt-oss-120b") if w.kind == "tokens" and w.window == "minute"
    )
    assert tpm.used == 5000
    assert v.headroom("groq", "openai/gpt-oss-20b") == 1.0  # per-model counters


def test_headers_override_counters_until_their_window_resets():
    data = quota.parse_headers(
        {
            "x-ratelimit-limit-requests": "1000",
            "x-ratelimit-remaining-requests": "150",
            "x-ratelimit-reset-requests": "1m26.4s",
            "llm_provider-x-ratelimit-limit-tokens": "8000",
            "llm_provider-x-ratelimit-remaining-tokens": "7923",
            "x-ratelimit-reset-tokens": "577ms",
        }
    )
    assert data["limit_requests"] == 1000 and data["remaining_requests"] == 150
    assert data["reset_requests_s"] == pytest.approx(86.4) and data["reset_tokens_s"] == pytest.approx(0.577)
    v = view(headers={("groq", "openai/gpt-oss-120b"): (data, NOW - timedelta(seconds=10))})
    u = v.usage("groq", "openai/gpt-oss-120b")
    assert u.source == "headers" and u.window == "day" and u.fraction == pytest.approx(0.85)
    later = view(headers={("groq", "openai/gpt-oss-120b"): (data, NOW - timedelta(seconds=100))})
    gone = later.usage("groq", "openai/gpt-oss-120b")  # that window is over: counters only (none yet)
    assert gone.source == "counter" and gone.fraction == 0
    assert quota.parse_headers({"content-type": "text/plain"}) == {}
    assert quota.parse_reset("2m59.56s") == pytest.approx(179.56)


def test_test_limits_override_one_model(test_limits):
    test_limits("groq:openai/gpt-oss-120b=rpd:3,rpm:2;openrouter:*=rpd:5")
    reg = load_registry()
    g = quota.policy(reg.providers["groq"])
    assert quota.limit_of(g, "openai/gpt-oss-120b").rpd == 3
    assert quota.limit_of(g, "openai/gpt-oss-20b").rpd == 1000
    assert quota.policy(reg.providers["openrouter"]).default.rpd == 5
    test_limits("garbage;;groq:x=nope:1")
    assert quota.limit_of(quota.policy(reg.providers["groq"]), "x").rpd == 1000


def _over(fraction=0.85):
    d0 = quota.day_start(datetime.now(UTC), "UTC")
    return {("groq", "openai/gpt-oss-120b", "d", d0): (int(1000 * fraction), 0)}


def test_reroutes_at_80_percent_before_any_429():
    c = ctx()
    c.quota = view(_over(), now=datetime.now(UTC))
    c.catalog = [*CATALOG]
    dec = decide(RouteRequest("hi"), c)
    skip = next(s for s in dec.skipped if s.target == "model:fast")
    assert skip.code == "quota" and "85% of today's limit (850/1000)" in skip.reason
    # spread to the alias's stand-in with the most headroom (equivalent: in providers.yaml)
    assert targets(dec)[0] == "model:groq/openai/gpt-oss-20b"
    assert dec.candidates[0].note == "spread:fast"


def test_below_80_percent_nothing_changes():
    c = ctx()
    c.quota = view(_over(0.79), now=datetime.now(UTC))
    assert targets(decide(RouteRequest("hi"), c))[0] == "model:fast"


def test_manual_pick_may_use_the_reserved_headroom_until_the_limit():
    c = ctx()
    c.quota = view(_over(0.9), now=datetime.now(UTC))
    dec = decide(RouteRequest("hi", target="model:fast"), c)
    assert targets(dec) == ["model:fast"] and "90% of today's limit" in dec.candidates[0].quota_note
    c.quota = view(_over(1.0), now=datetime.now(UTC))
    dec = decide(RouteRequest("hi", target="model:fast"), c)
    assert dec.candidates == [] and dec.skipped[0].code == "quota" and "at its limit" in dec.skipped[0].reason


async def test_counters_persist_in_the_db(session):
    reg = load_registry()
    t = datetime.now(UTC)
    for _ in range(3):
        await quota.record(session, reg, "groq", "openai/gpt-oss-120b", requests=1, now=t)
    await quota.record(session, reg, "groq", "openai/gpt-oss-120b", tokens=500, now=t)
    await quota.record(session, reg, "ollama", "qwen3:4b", requests=1, now=t)  # no limits: not counted
    await quota.record(session, reg, "openrouter", "a/b:free", requests=1, now=t)
    await quota.record(session, reg, "openrouter", "c/d:free", requests=1, now=t)
    await session.commit()
    # a "restart": a brand-new view built only from the DB
    v = await quota.load_view(session, reg, now=t)
    day = next(
        w for w in v.windows("groq", "openai/gpt-oss-120b") if w.window == "day" and w.kind == "requests"
    )
    assert day.used == 3
    tpd = next(
        w for w in v.windows("groq", "openai/gpt-oss-120b") if w.window == "day" and w.kind == "tokens"
    )
    assert tpd.used == 500
    assert v.usage("openrouter", "z/z:free").used == 2  # one shared counter for every :free model
    rows = (await session.execute(QuotaUsage.__table__.select())).all()
    assert {r.provider for r in rows} == {"groq", "openrouter"}


async def test_chat_reroutes_before_the_provider_429s(client, stack, test_limits, probes):
    """Live-demo shape: rpd 3 on Groq's gpt-oss-120b. The first two go to `fast`; once 3 x 0.8 is
    reached, automatic routing moves on, and the fake provider never answers 429."""
    test_limits("groq:openai/gpt-oss-120b=rpd:3")
    served = []
    for i in range(4):
        ev = await turn(client, text=f"hello number {i}")
        served.append(first(ev, "route")["target"])
    # 0/3, 1/3, 2/3 used: still below 80%; 3/3 used: the 4th goes elsewhere
    assert served[:3] == ["model:fast"] * 3 and served[3] != "model:fast"
    done = [d for e, d in ev if e == "done"][0]["route"]
    assert any(s["code"] == "quota" for s in done["skipped"])
    assert all(m != "429" for m in stack.script.values())
    # footer and Status data
    summ = (await client.get("/system/summary")).json()["quota"]
    assert summ["top"]["provider"] == "groq" and summ["top"]["fraction"] >= 0.8
    assert summ["status"] == "limited"


async def test_status_shows_specific_reasons(client, stack, session, test_limits, probes, hostprobe_up):
    from app.routing.health import cooldowns

    cooldowns.set("model:smart-free", "rate_limited", "Rate limited (429)", 600, provider="gemini")
    await cooldowns.persist(session)
    comps = (await client.get("/system/components")).json()["components"]
    row = next(c for c in comps if c["id"] == "provider:gemini")
    assert row["code"] == "rate_limited" and row["status"] == "degraded" and row["until"]
    # restored after a restart
    fresh = Cooldowns()
    assert await fresh.load(session) == 1 and fresh.get("model:smart-free").code == "rate_limited"
    test_limits("groq:openai/gpt-oss-120b=rpd:2")
    await turn(client, text="one")
    await turn(client, text="two")
    comps = (await client.get("/system/components", headers=ADMIN)).json()["components"]
    row = next(c for c in comps if c["id"] == "provider:groq")
    assert row["code"] == "quota_high" and row["quota"]["fraction"] >= 0.8 and row["until"]


# --- one number per limit: provider headers replace our counter for display -----------------------
def _minute_view(counter_tokens=6800, remaining=6400, reset_s=30.0, seen_ago=5, now=NOW):
    """Groq with both numbers for per-minute tokens (limit 8000): our counter and the header."""
    data = {"limit_tokens": 8000, "remaining_tokens": remaining}
    if reset_s is not None:
        data["reset_tokens_s"] = reset_s
    return view(
        {("groq", "openai/gpt-oss-120b", "m", quota.minute_start(now)): (1, counter_tokens)},
        {("groq", "openai/gpt-oss-120b"): (data, now - timedelta(seconds=seen_ago))},
        now,
    )


def _shown_tokens(v):
    ws = v.shown("groq", "openai/gpt-oss-120b")
    assert len({(w.window, w.kind) for w in ws}) == len(ws)  # never two numbers for one limit
    return next(w for w in ws if (w.window, w.kind) == ("minute", "tokens"))


def test_a_fresh_header_replaces_the_counter_for_display_but_routing_takes_the_max():
    v = _minute_view()
    shown = _shown_tokens(v)
    assert shown.source == "headers" and shown.fraction == pytest.approx(0.2)
    u = v.usage("groq", "openai/gpt-oss-120b")
    assert u.source == "counter" and u.fraction == pytest.approx(0.85)


@pytest.mark.parametrize(
    "kw",
    [
        {"reset_s": 2.0, "seen_ago": 5},  # its window is over
        {"reset_s": None, "seen_ago": 45},  # no reset time, seen in the previous minute
    ],
)
def test_an_expired_or_stale_header_falls_back_to_the_counter(kw):
    shown = _shown_tokens(_minute_view(**kw))
    assert shown.source == "counter" and shown.fraction == pytest.approx(0.85)


def test_a_header_without_reset_counts_within_the_current_window():
    assert _shown_tokens(_minute_view(reset_s=None, seen_ago=20)).source == "headers"
    data = {"limit_requests": 1000, "remaining_requests": 900}
    for ago, kept in ((timedelta(hours=2), True), (timedelta(days=1), False)):
        v = view(headers={("groq", "openai/gpt-oss-120b"): (data, NOW - ago)})
        day = [w for w in v.shown("groq", "openai/gpt-oss-120b") if (w.window, w.kind) == ("day", "requests")]
        assert [w.source for w in day] == ["headers" if kept else "counter"]


@pytest.mark.parametrize("target", [None, "model:fast"])
def test_why_this_says_when_our_estimate_moved_the_request(target):
    now = datetime.now(UTC).replace(second=1, microsecond=0)
    c = ctx()
    c.quota = _minute_view(now=now, seen_ago=0)
    c.catalog = [*CATALOG]
    dec = decide(RouteRequest("hi", target=target) if target else RouteRequest("hi"), c)
    note = "Groq: our estimate 85% of per-minute tokens; Groq reports 20%"
    why = reasons(dec, dec.candidates[0], c.registry, c.catalog)
    assert note in why
    if target is None:  # rerouted away from `fast`
        skip = next(s for s in dec.skipped if s.target == "model:fast")
        assert skip.reason.startswith(note)


def test_why_this_uses_plain_wording_when_the_provider_agrees():
    now = datetime.now(UTC).replace(second=1, microsecond=0)
    c = ctx()
    c.quota = _minute_view(remaining=800, now=now, seen_ago=0)  # header says 90%
    c.catalog = [*CATALOG]
    dec = decide(RouteRequest("hi"), c)
    skip = next(s for s in dec.skipped if s.target == "model:fast")
    assert "our estimate" not in skip.reason and "90% of its per-minute token limit" in skip.reason


async def test_every_surface_shows_the_providers_number(
    client, stack, session, test_limits, probes, hostprobe_up, mock_http
):
    """A provider that sends rate-limit headers: Metrics, the footer and Status agree on one number."""
    mock_http.get(url__regex=r"http://hostprobe\.test/accounts/status\?.*").respond(
        200, json={"installed": True, "logged_in": True, "plan": None}
    )
    test_limits("groq:openai/gpt-oss-120b=rpm:10")
    reg = load_registry()
    now = datetime.now(UTC)
    await quota.record(session, reg, "groq", "openai/gpt-oss-120b", requests=9, now=now)
    await quota.record_headers(
        session,
        reg,
        "groq",
        "openai/gpt-oss-120b",
        {
            "x-ratelimit-limit-requests": "1000",
            "x-ratelimit-remaining-requests": "150",
            "x-ratelimit-reset-requests": "1h",
            "x-ratelimit-limit-tokens": "8000",
            "x-ratelimit-remaining-tokens": "6400",
            "x-ratelimit-reset-tokens": "59s",
        },
    )
    await session.commit()
    providers = (await client.get("/metrics/quotas", headers=ADMIN)).json()["providers"]
    groq = next(p for p in providers if p["provider"] == "groq")
    keys = [(w["window"], w["kind"]) for w in groq["windows"]]
    assert len(keys) == len(set(keys))
    by = {(w["window"], w["kind"]): w for w in groq["windows"]}
    assert by[("day", "requests")]["source"] == "headers" and by[("day", "requests")]["used"] == 850
    assert by[("minute", "tokens")]["source"] == "headers" and by[("minute", "tokens")]["used"] == 1600
    assert by[("minute", "requests")]["source"] == "counter"  # no header for this one
    footer = (await client.get("/system/summary")).json()["quota"]["top"]
    row = next(
        c
        for c in (await client.get("/system/components", headers=ADMIN)).json()["components"]
        if c["id"] == "provider:groq"
    )
    for shown in (footer, row["quota"]):
        assert {k: shown[k] for k in groq["windows"][0]} == groq["windows"][0]
    # routing still takes the higher of the two (our 90% counter)
    v = await quota.load_view(session, reg, now=now)
    assert v.usage("groq", "openai/gpt-oss-120b").fraction == pytest.approx(0.9, abs=0.01)
