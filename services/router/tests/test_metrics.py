"""M6 Metrics: call ids and dedupe, LiteLLM ingest, 15-minute rollups, time zones, demo exclusion, honest
savings, privacy of per-request rows, forecasts, paging, caching and index use."""

import json
import os
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select, text

from app import litellm_calls
from app.api import metrics as metrics_api
from app.litellm_spend import LiteLLMSpend, SpendLog
from app.metrics import hist, ingest_litellm, insights, queries, ranges, rollup, subscriptions
from app.models import Cost, Job, Message, MetricsBucket, MetricsDirty, Project, Request, SystemMeta, Thread
from tests.conftest import ADMIN
from tests.test_chat import first, stack, turn  # noqa: F401  (stack is a fixture)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _fresh_cache():
    metrics_api.cache.clear()
    yield
    metrics_api.cache.clear()


def now() -> datetime:
    return datetime.now(UTC)


async def summary(client, **q):
    q.setdefault("range", "7d")
    q.setdefault("tz", "UTC")
    r = await client.get("/metrics/summary", params=q, headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


async def add_request(session, *, at=None, status="ok", tag=None, private=False, title="A chat", **cost):
    t = Thread(title=title, private=private)
    session.add(t)
    await session.flush()
    req = Request(
        kind="chat",
        status=status,
        latency_ms=1200,
        ttft_ms=300,
        rule_id="quick",
        intent="chat",
        thread_id=t.id,
        private=private,
        created_at=at or now(),
        decision_json={"tag": tag} if tag else {},
        fallbacks_tried_json=cost.pop("skips", []),
    )
    session.add(req)
    await session.flush()
    if cost is not None and cost.get("provider"):
        session.add(
            Cost(
                request_id=req.id,
                source="litellm",
                kind="chat",
                tag=tag,
                created_at=at or now(),
                external_id=litellm_calls.external_id(litellm_calls.new_id("chat")),
                **cost,
            )
        )
    await session.commit()
    return req, t


# --- histograms and time zones --------------------------------------------------------------------
def test_histogram_percentiles_stay_within_one_bucket():
    samples = list(range(100, 20000, 37))
    h = hist.empty()
    for s in samples:
        hist.add(h, s)
    for p in (0.5, 0.95):
        exact = sorted(samples)[int(p * len(samples)) - 1]
        est = hist.percentile(h, p)
        i = hist.slot(exact)
        lo = hist.EDGES_MS[i - 1] if i else 0
        hi = hist.EDGES_MS[i]
        assert lo <= est <= hi, (p, exact, est)
    assert hist.percentile(hist.empty(), 0.5) is None
    assert hist.merge([[1, 2], None, [0, 1, 5]])[:3] == [1, 3, 5]
    assert hist.slot(250) == 1 and hist.slot(249) == 0 and hist.slot(10**9) == len(hist.EDGES_MS)


@pytest.mark.parametrize(
    "tz, offset",
    [("Asia/Kolkata", 330), ("Asia/Kathmandu", 345), ("America/St_Johns", -150), ("UTC", 0)],
)
def test_today_starts_at_local_midnight_on_a_15_minute_boundary(tz, offset):
    at = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)
    r = ranges.resolve("today", tz, now=at)
    local = r.start.astimezone(r.tz)
    assert (local.hour, local.minute) == (0, 0) and r.slot == "hour"
    assert r.start == rollup.bucket_of(r.start)  # 15-minute buckets line up exactly
    assert ranges.resolve("7d", tz, now=at).days == 7 and ranges.resolve("30d", tz, now=at).days == 30
    with pytest.raises(ranges.RangeError):
        ranges.resolve("today", "Mars/Olympus")
    with pytest.raises(ranges.RangeError):
        ranges.resolve("custom", tz, first="2026-01-01", last="2027-06-01")


# --- the chat path: one call id, one cost row, one rollup row ---------------------------------------
async def test_chat_turn_sends_a_call_id_and_rolls_up_once(client, stack, session, litellm):  # noqa: F811
    await turn(client, text="hello there")
    sent = [c for c in litellm.call_ids if c and c.startswith("sb-chat-")]
    assert len(sent) == 1
    cost = (await session.execute(select(Cost))).scalar_one()
    assert cost.external_id == f"litellm:{sent[0]}" and cost.kind == "chat"
    value = float(cost.list_price_usd or 0)
    assert await rollup.drain(session) >= 1
    s = await summary(client, range="today")
    assert s["totals"]["requests"] == 1 and s["totals"]["chats"] == 1
    assert s["totals"]["value_usd"] == pytest.approx(value, abs=1e-6)
    # Recomputing the same bucket again changes nothing (idempotent).
    before = (await session.execute(select(func.sum(MetricsBucket.requests)))).scalar()
    await rollup.mark_range(session, now() - timedelta(days=1))
    await rollup.drain(session)
    after = (await session.execute(select(func.sum(MetricsBucket.requests)))).scalar()
    assert before == after == 1


# --- LiteLLM spend logs ----------------------------------------------------------------------------
def spend_row(
    call_id, *, at, status="success", spend=0.002, model="groq/openai/gpt-oss-120b", user="", tags=()
):
    return {
        "request_id": f"chatcmpl-{uuid.uuid4().hex}",
        "litellm_call_id": call_id,
        "status": status,
        "spend": spend,
        "prompt_tokens": 10,
        "completion_tokens": 5,
        "startTime": at.isoformat(),
        "model": model,
        "custom_llm_provider": model.split("/")[0],
        "model_group": "fast",
        "end_user": user,
        "request_tags": list(tags),
    }


def test_spend_log_contract_matches_the_recorded_response():
    rec = json.loads((FIXTURES / "litellm_spend_logs_v2.json").read_text())
    assert {"data", "total_pages", "page"} <= rec.keys()
    logs = [SpendLog.parse(r) for r in rec["data"]]
    assert all(lg is not None for lg in logs)
    assert logs[0].call_id == "sbtest-1795223808" and logs[0].end_user == "sb-verify"
    assert logs[0].model.startswith("ollama_chat/") and logs[0].status == "success"


async def test_ingest_dedupes_and_adds_aux_external_and_demo(client, stack, session, litellm):  # noqa: F811
    await turn(client, text="hello")
    chat_id = next(c for c in litellm.call_ids if c and c.startswith("sb-chat-"))
    old = now() - timedelta(minutes=30)
    litellm.spend_logs = [
        spend_row(chat_id, at=old),  # the router already wrote this one
        spend_row(litellm_calls.new_id("aux"), at=old, spend=0.0001),
        spend_row("3f2c-external", at=old, spend=0.05, model="mistral/mistral-small"),
        spend_row("demo-1", at=old, user="switchboard-demo", tags=["switchboard-demo"]),
        spend_row("failed-1", at=old, status="failure"),
    ]
    spend = LiteLLMSpend()
    # Not the first run (see the next test): ingest has been running since before these calls.
    await ingest_litellm._save_cursor(session, old - timedelta(minutes=5))
    await ingest_litellm._save_cursor(session, old - timedelta(hours=1), ingest_litellm.START_KEY)
    n = await ingest_litellm.run_once(session, spend)
    assert n == 3
    rows = {c.external_id: c for c in (await session.execute(select(Cost))).scalars()}
    assert len(rows) == 4 and f"litellm:{chat_id}" in rows and "litellm:failed-1" not in rows
    aux = next(c for c in rows.values() if c.kind == "aux")
    assert aux.provider == "groq" and float(aux.cost_usd) == 0 and float(aux.list_price_usd) == 0.0001
    assert (
        rows["litellm:3f2c-external"].kind == "external"
        and float(rows["litellm:3f2c-external"].cost_usd) == 0.05
    )
    assert rows["litellm:demo-1"].tag == "switchboard-demo"
    # A second run (the overlap window) adds nothing; the cursor is stored.
    assert await ingest_litellm.run_once(session, spend) == 0
    assert await session.scalar(select(SystemMeta.value).where(SystemMeta.key == ingest_litellm.CURSOR_KEY))
    await spend.aclose()

    await rollup.drain(session)
    s = await summary(client, range="today")
    assert s["totals"]["requests"] == 3  # chat + aux + external; the demo call is left out
    assert s["totals"]["demo_requests"] == 1
    assert (await summary(client, range="today", include_demo="true"))["totals"]["requests"] == 4
    kinds = {
        i["key"]: i["requests"]
        for i in (
            await client.get("/metrics/breakdown", params={"by": "kind", "range": "today"}, headers=ADMIN)
        ).json()["items"]
    }
    assert kinds == {"chat": 1, "aux": 1, "external": 1}


async def test_first_run_skips_unmarked_calls_from_before_m6(session, litellm):
    """Before M6 the router's chat calls had no `sb-` id: on the first run they'd look external (and be
    counted twice), so only `sb-` calls are taken then. Later runs take every call."""
    at = now() - timedelta(minutes=20)
    aux = litellm_calls.new_id("aux")
    litellm.spend_logs = [spend_row("pre-m6-chat", at=at), spend_row(aux, at=at)]
    spend = LiteLLMSpend()
    assert await ingest_litellm.run_once(session, spend) == 1
    ids = set((await session.execute(select(Cost.external_id))).scalars())
    assert ids == {f"litellm:{aux}"}
    litellm.spend_logs.append(spend_row("new-external", at=now()))
    assert await ingest_litellm.run_once(session, spend) == 1
    await spend.aclose()


async def test_young_chat_logs_wait_for_the_router(session, litellm, stack):  # noqa: F811
    young = litellm_calls.new_id("chat")
    litellm.spend_logs = [spend_row(young, at=now() - timedelta(minutes=2))]
    spend = LiteLLMSpend()
    assert await ingest_litellm.run_once(session, spend) == 0
    # 20 minutes later the router never wrote it (a crash): it is counted, once.
    later = now() + timedelta(minutes=20)
    assert await ingest_litellm.run_once(session, spend, now=later) == 1
    assert await ingest_litellm.run_once(session, spend, now=later) == 0
    await spend.aclose()


async def test_ingest_survives_litellm_being_down(session, litellm):
    litellm.spend_down = True
    spend = LiteLLMSpend()
    with pytest.raises(ingest_litellm.SpendLogError):
        await ingest_litellm.run_once(session, spend)
    assert (
        await session.scalar(select(SystemMeta.value).where(SystemMeta.key == ingest_litellm.CURSOR_KEY))
        is None
    )
    await spend.aclose()


# --- rollups: late rows, feedback, jobs -------------------------------------------------------------
async def test_late_rows_and_feedback_reach_old_buckets(client, session):
    three_days = now() - timedelta(days=3)
    await add_request(session, at=three_days, provider="groq", model="m", cost_usd=0, list_price_usd=0.01)
    await rollup.drain(session)
    assert (await summary(client))["totals"]["requests"] == 1
    # A cost ingested days later lands in its own (old) bucket.
    session.add(
        Cost(
            source="litellm",
            kind="external",
            provider="x",
            cost_usd=0.5,
            list_price_usd=0.5,
            created_at=three_days,
        )
    )
    await session.commit()
    assert await session.scalar(select(func.count()).select_from(MetricsDirty)) >= 1
    await rollup.drain(session)
    metrics_api.cache.clear()
    s = await summary(client)
    assert s["totals"]["requests"] == 2 and s["totals"]["spent_usd"] == 0.5
    # 👍 on that old reply.
    req = (await session.execute(select(Request))).scalars().first()
    m = Message(thread_id=req.thread_id, role="assistant", content="hi", request_id=req.id)
    session.add(m)
    await session.commit()
    m.feedback = 1
    await session.commit()
    await rollup.drain(session)
    metrics_api.cache.clear()
    assert (await summary(client))["totals"]["thumbs_up"] == 1
    assert await session.scalar(select(func.count()).select_from(MetricsDirty)) == 0


async def test_deletes_and_reruns_take_numbers_back_out(client, session):
    from sqlalchemy import delete, update

    await add_request(session, provider="groq", model="m", cost_usd=0.4, list_price_usd=0.4)
    await make_job(session, status="done")
    await rollup.drain(session)
    s = await summary(client, range="today")
    assert s["totals"]["spent_usd"] == 0.4 and s["totals"]["jobs_done"] == 1
    await session.execute(delete(Cost).where(Cost.source == "litellm"))
    await session.execute(update(Job).values(status="queued", finished_at=None))  # run again
    await session.commit()
    await rollup.drain(session)
    metrics_api.cache.clear()
    s = await summary(client, range="today")
    assert s["totals"]["spent_usd"] == 0 and s["totals"]["jobs_done"] == 0


async def test_rollup_is_skipped_while_another_holds_the_lock(session):
    from app import db

    await add_request(session, provider="groq", model="m", cost_usd=0, list_price_usd=0.01)
    async with db.sessionmaker()() as other:
        await other.execute(select(func.pg_advisory_xact_lock(rollup.LOCK_KEY)))
        assert await rollup.run_once(session) == 0
        await other.rollback()
    assert await rollup.run_once(session) == 1


async def make_job(session, *, agent="claude-code", status="done", tag=None, list_price=0.2):
    p = await session.scalar(select(Project).limit(1))
    if p is None:
        p = Project(name="Play", path=f"/home/user/p-{uuid.uuid4().hex}", slug=uuid.uuid4().hex[:8])
        session.add(p)
        await session.flush()
    req = Request(kind="job", status="ok", rule_id="code", intent="code")
    session.add(req)
    await session.flush()
    j = Job(
        request_id=req.id,
        project_id=p.id,
        title="Fix the failing tests in api/ (token sk-abcdefghijklmnopqrstuvwxyz0123)",
        prompt="secret prompt body",
        agent=agent,
        autonomy=1,
        status=status,
        budget_list_usd=5,
        tag=tag,
        finished_at=now(),
    )
    session.add(j)
    await session.flush()
    session.add(
        Cost(
            request_id=req.id,
            job_id=j.id,
            source="paperclip",
            kind="job",
            provider="anthropic",
            model="claude",
            cost_usd=0,
            list_price_usd=list_price,
            external_id=f"paperclip-run:{uuid.uuid4()}",
            tag=tag,
        )
    )
    await session.commit()
    return j


async def test_jobs_by_agent_project_and_success_rate(client, session):
    await make_job(session, status="done")
    await make_job(session, status="failed")
    await make_job(session, agent="codex", status="done", tag="switchboard-demo")
    await rollup.drain(session)
    items = (
        await client.get("/metrics/breakdown", params={"by": "agent", "range": "today"}, headers=ADMIN)
    ).json()["items"]
    assert [(i["key"], i["jobs_done"], i["jobs_failed"]) for i in items] == [("claude-code", 1, 1)]
    assert items[0]["job_success_rate"] == 0.5 and items[0]["value_usd"] == pytest.approx(0.4)
    assert items[0]["label"] == "Claude Code"
    proj = (
        await client.get("/metrics/breakdown", params={"by": "project", "range": "today"}, headers=ADMIN)
    ).json()["items"]
    assert proj[0]["label"] == "Play"
    s = await summary(client, range="today")
    assert s["totals"]["jobs_done"] == 1 and any("finished 1 of 2 jobs" in i for i in s["insights"])


# --- honest savings ---------------------------------------------------------------------------------
def test_subscription_fees_are_prorated_by_calendar_month():
    sub = subscriptions.Subscription(name="Claude Pro", monthly_usd=20, start=date(2026, 11, 16))
    free = subscriptions.Subscription(name="ChatGPT Free", monthly_usd=0, start=date(2026, 1, 1))
    # Nov 16-30 = 15 of 30 days; Dec 1-31 whole; Feb (28 days) whole.
    assert subscriptions.fees([sub, free], date(2026, 11, 1), date(2026, 11, 30)) == pytest.approx(10)
    assert subscriptions.fees([sub], date(2026, 12, 1), date(2026, 12, 31)) == pytest.approx(20)
    assert subscriptions.fees([sub], date(2027, 2, 1), date(2027, 2, 14)) == pytest.approx(10)
    assert subscriptions.fees([sub], date(2026, 10, 1), date(2026, 10, 31)) == 0
    ended = sub.model_copy(update={"end": date(2026, 11, 20)})
    assert subscriptions.fees([ended], date(2026, 11, 1), date(2026, 11, 30)) == pytest.approx(20 * 5 / 30)
    with pytest.raises(ValueError):
        subscriptions.Subscription(name="x", monthly_usd=1, start=date(2026, 2, 1), end=date(2026, 1, 1))


def test_savings_sentences_never_overclaim():
    assert "ahead" in insights.savings(value=30, fees=20, spent=1, has_subs=True)
    neg = insights.savings(value=5, fees=20, spent=1, has_subs=True)
    assert neg.startswith("Subscriptions cost more than they saved") and "ahead" not in neg
    no_subs = insights.savings(value=3, fees=0, spent=1, has_subs=False)
    assert "Add your subscriptions" in no_subs and "saved" not in no_subs.split(".")[0]
    assert insights.savings(0, 0, 0, False) is None


async def test_net_saved_uses_fees_for_the_range(client, session):
    await add_request(session, provider="groq", model="m", cost_usd=0, list_price_usd=3)
    await add_request(session, provider="mistral", model="m", cost_usd=1, list_price_usd=1)
    await rollup.drain(session)
    r = await client.put(
        "/settings/subscriptions",
        json={"items": [{"name": "Claude Pro", "monthly_usd": 30, "start": "2020-01-01"}]},
        headers=ADMIN,
    )
    assert r.status_code == 200
    s = await summary(client, range="today")
    t = s["totals"]
    assert t["value_usd"] == 4 and t["spent_usd"] == 1 and t["has_subscriptions"]
    assert t["net_saved_usd"] == pytest.approx(4 - t["subscriptions_usd"] - 1)
    assert 0.9 < t["subscriptions_usd"] < 1.1  # one day of a $30 month
    assert any("ahead" in i for i in s["insights"])
    bad = await client.put(
        "/settings/subscriptions",
        json={"items": [{"name": "", "monthly_usd": -1, "start": "x"}]},
        headers=ADMIN,
    )
    assert bad.status_code == 422


# --- privacy of per-request rows --------------------------------------------------------------------
async def test_top_requests_show_titles_only_and_hide_private_chats(client, session):
    await add_request(
        session, title="Plan my trip to Goa", provider="groq", model="m", cost_usd=0, list_price_usd=0.3
    )
    await add_request(
        session,
        title="My diagnosis and meds",
        private=True,
        provider="ollama",
        model="m",
        cost_usd=0,
        list_price_usd=0.2,
    )
    await add_request(
        session,
        title="Rotate key sk-abcdefghijklmnopqrstuvwxyz0123",
        provider="groq",
        model="m",
        cost_usd=0,
        list_price_usd=0.1,
    )
    req = (await session.execute(select(Request).order_by(Request.id))).scalars().first()
    session.add(
        Message(
            thread_id=req.thread_id, role="user", content="the full private prompt text", request_id=req.id
        )
    )
    await make_job(session)
    await session.commit()
    r = await client.get("/metrics/top-requests", params={"range": "today", "limit": 2}, headers=ADMIN)
    page1 = r.json()
    nxt = page1["next"]
    page2 = (
        await client.get(
            "/metrics/top-requests", params={"range": "today", "limit": 2, "cursor": nxt}, headers=ADMIN
        )
    ).json()
    items = page1["items"] + page2["items"]
    body = json.dumps(items)
    assert [i["label"] for i in items][:1] == ["Plan my trip to Goa"]
    assert "Private chat" in body and "diagnosis" not in body
    assert "sk-abcdefghijklmnopqrstuvwxyz0123" not in body and "Rotate key" in body
    assert "the full private prompt text" not in body and "secret prompt body" not in body
    assert len({i["id"] for i in items}) == len(items) == 4 and page2["next"] is None


# --- budgets, quotas, paging, auth, cache, plans ----------------------------------------------------
def test_forecast_edges():
    t0 = datetime(2026, 11, 21, 0, 0, tzinfo=UTC)
    reset = t0 + timedelta(days=1)
    at = t0 + timedelta(hours=6)
    f = queries.forecast(0.5, 1.0, t0, reset, at)
    assert f["state"] == "will_reach" and f["hits_at"] == (t0 + timedelta(hours=12)).isoformat()
    assert queries.forecast(0.1, 1.0, t0, reset, at)["state"] == "on_track"
    assert queries.forecast(0, 1.0, t0, reset, at)["state"] == "idle"
    assert queries.forecast(1.2, 1.0, t0, reset, at)["state"] == "reached"
    assert queries.forecast(3, None, t0, reset, at)["state"] == "no_cap"
    assert insights.cap_forecast(f, ranges.zone("Asia/Kolkata")) == (
        "At this rate you'll reach your daily cap ($1.00) at 17:30."
    )


async def test_budgets_and_quotas_endpoints(client, stack, mock_http):  # noqa: F811
    # The budgets view asks hostprobe for each subscription account's plan. Answer it here, so the test
    # doesn't depend on another test having filled accounts' one-minute status cache first.
    mock_http.get(url__regex=r"http://hostprobe\.test/accounts/status\?.*").respond(
        200, json={"installed": True, "logged_in": True, "plan": None}
    )
    b = (await client.get("/metrics/budgets", headers=ADMIN)).json()
    assert b["chat"]["cap"] > 0 and b["chat"]["state"] in ("idle", "on_track", "will_reach", "reached")
    assert {a["agent"] for a in b["agents"]} >= {"claude-code"}
    assert all(a["month"]["state"] == "no_cap" or a["month"]["cap"] for a in b["agents"])
    q = (await client.get("/metrics/quotas", headers=ADMIN)).json()["providers"]
    assert all(w["resets_at"] for p in q for w in p["windows"] if w.get("resets_at") is not None)


async def test_breakdown_pages_without_overlap(client, session):
    for i in range(5):
        await add_request(
            session, provider="groq", model=f"model-{i}", cost_usd=0, list_price_usd=0.01 * (i + 1)
        )
    await rollup.drain(session)
    seen, cursor = [], None
    while True:
        params = {"by": "model", "range": "today", "limit": 2, **({"cursor": cursor} if cursor else {})}
        d = (await client.get("/metrics/breakdown", params=params, headers=ADMIN)).json()
        seen += [i["key"] for i in d["items"]]
        cursor = d["next"]
        if not cursor:
            break
    assert seen == [f"model-{i}" for i in (4, 3, 2, 1, 0)]


async def test_metrics_require_admin_and_validate_input(client):
    assert (await client.get("/metrics/summary")).status_code == 401
    assert (
        await client.get("/metrics/summary", params={"tz": "Nope/Zone"}, headers=ADMIN)
    ).status_code == 400
    assert (await client.get("/metrics/breakdown", params={"by": "prompt"}, headers=ADMIN)).status_code == 422


async def test_answers_are_cached_briefly(client, session):
    await rollup.drain(session)
    a = await summary(client, range="today")
    await add_request(session, provider="groq", model="m", cost_usd=0, list_price_usd=0.01)
    await rollup.drain(session)
    assert (await summary(client, range="today"))["totals"]["requests"] == a["totals"]["requests"]
    metrics_api.cache.clear()
    assert (await summary(client, range="today"))["totals"]["requests"] == a["totals"]["requests"] + 1


async def test_metric_reads_can_use_their_indexes(session):
    await session.execute(text("SET LOCAL enable_seqscan = off"))
    plans = []
    for sql in (
        "SELECT sum(requests) FROM metrics_15m WHERE bucket_start >= now() - interval '7 days'",
        "SELECT id FROM costs WHERE created_at >= now() - interval '1 day' ORDER BY created_at",
        "SELECT id FROM requests WHERE created_at >= now() - interval '1 day' "
        "ORDER BY created_at DESC, id DESC",
        "SELECT count(*) FROM jobs WHERE finished_at >= now() - interval '1 day'",
    ):
        plans.append("\n".join(r[0] for r in (await session.execute(text("EXPLAIN " + sql))).all()))
    for p in plans:
        assert "Index" in p, p
    await session.rollback()


# --- live contract (pytest -m live; needs the running LiteLLM) --------------------------------------
LIVE = os.environ.get("LITELLM_LIVE_URL", "http://litellm:4000")


@pytest.mark.live
def test_live_spend_logs_v2_shape():
    key = os.environ.get("LITELLM_LIVE_KEY", "")
    end = datetime.now(UTC) + timedelta(days=1)
    r = httpx.get(
        f"{LIVE}/spend/logs/v2",
        params={
            "start_date": (end - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S"),
            "end_date": end.strftime("%Y-%m-%d %H:%M:%S"),
            "page": 1,
            "page_size": 5,
            "sort_by": "startTime",
            "sort_order": "asc",
        },
        headers={"Authorization": f"Bearer {key}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert {"data", "total_pages"} <= body.keys()
    for row in body["data"]:
        assert {
            "litellm_call_id",
            "status",
            "spend",
            "startTime",
            "model",
            "end_user",
            "request_tags",
        } <= row.keys()
        assert SpendLog.parse(row) is not None
