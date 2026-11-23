"""Activity log (M2.5): every request in one keyset-paged list, filters, title search, privacy, CSV."""

import csv
import io
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.metrics import activity, rollup
from app.models import Cost, Job, MetricsBucket, Project, Request, Thread
from tests.conftest import ADMIN
from tests.test_chat import first, stack, turn  # noqa: F401


def now():
    return datetime.now(UTC)


async def seed(session):
    pub = Thread(title="Plan the =SUM(A1) launch", title_source="user", private=False)
    priv = Thread(title="My blood test results", title_source="user", private=True)
    session.add_all([pub, priv])
    await session.flush()
    t0 = now() - timedelta(hours=1)
    rows = [
        Request(
            kind="chat",
            status="ok",
            rule_id="default",
            thread_id=pub.id,
            model="groq/openai/gpt-oss-120b",
            latency_ms=900,
            created_at=t0,
            decision_json={"chip": {"provider": "groq"}},
            fallbacks_tried_json=[{"code": "rate_limited"}, {"code": "not_connected"}],
        ),
        Request(
            kind="chat",
            status="ok",
            rule_id="private",
            thread_id=priv.id,
            private=True,
            model="ollama/qwen3:4b",
            latency_ms=400,
            created_at=t0 + timedelta(minutes=1),
        ),
        Request(
            kind="aux",
            status="ok",
            thread_id=priv.id,
            private=True,
            model="ollama/llama3.2:3b",
            created_at=t0 + timedelta(minutes=2),
            decision_json={"purpose": "title"},
        ),
        Request(
            kind="aux",
            status="ok",
            thread_id=pub.id,
            model="groq/openai/gpt-oss-20b",
            call_id="sb-aux-1",
            created_at=t0 + timedelta(minutes=3),
            decision_json={"purpose": "summary"},
        ),
        Request(
            kind="test",
            status="error",
            model="gemini/gemini-3.1-flash-lite",
            latency_ms=30000,
            created_at=t0 + timedelta(minutes=4),
            error="timeout",
        ),
        Request(
            kind="chat",
            status="ok",
            rule_id="default",
            model="groq/x",
            created_at=t0 + timedelta(minutes=5),
            decision_json={"tag": "switchboard-demo"},
        ),
    ]
    session.add_all(rows)
    await session.flush()
    session.add_all(
        [
            Cost(
                request_id=rows[0].id,
                source="litellm",
                provider="groq",
                model="groq/openai/gpt-oss-120b",
                cost_usd=0,
                list_price_usd=0.002,
                kind="chat",
                created_at=t0,
            ),
            Cost(
                request_id=None,
                source="litellm",
                provider="groq",
                model="groq/openai/gpt-oss-20b",
                cost_usd=0,
                list_price_usd=0.0001,
                kind="aux",
                external_id="litellm:sb-aux-1",
                created_at=t0,
            ),
        ]
    )
    await session.commit()
    return pub, priv, rows


async def get(client, **params):
    r = await client.get("/activity", params={"range": "today", "tz": "UTC", **params}, headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


async def test_lists_every_kind_newest_first_with_privacy(client, session):
    pub, priv, rows = await seed(session)
    items = (await get(client))["items"]
    assert [i["kind"] for i in items] == ["test", "aux", "aux", "chat", "chat"]  # demo left out
    by = {i["id"]: i for i in items}
    chat = by[rows[0].id]
    assert chat["label"] == "Plan the =SUM(A1) launch" and chat["provider"] == "groq"
    assert chat["value_usd"] == 0.002 and chat["fallbacks"] == 1 and chat["thread_id"] == str(pub.id)
    p = by[rows[1].id]
    assert p["label"] == "Private chat" and p["private"] and p["thread_id"] is None
    assert by[rows[2].id]["label"] == "Title · Private chat"
    s = by[rows[3].id]
    assert s["label"] == "Summary · Plan the =SUM(A1) launch" and s["value_usd"] == 0.0001  # cost by call id
    assert by[rows[4].id]["label"].startswith("Model test") and by[rows[4].id]["status"] == "error"
    assert "blood" not in str(items)
    assert len((await get(client, include_demo="true"))["items"]) == 6


async def test_filters_and_search_never_match_private_titles(client, session):
    await seed(session)
    assert {i["kind"] for i in (await get(client, kind=["aux"]))["items"]} == {"aux"}
    assert len((await get(client, provider="groq"))["items"]) == 2
    assert len((await get(client, status="error"))["items"]) == 1
    assert len((await get(client, rule="private"))["items"]) == 1
    assert len((await get(client, model="ollama/qwen3:4b"))["items"]) == 1
    hits = (await get(client, q="launch"))["items"]
    assert {i["kind"] for i in hits} == {"chat", "aux"}
    assert (await get(client, q="blood"))["items"] == []  # a private chat's title is never searchable
    assert (await get(client, q="%"))["items"] == []  # wildcards are literal
    r = await client.get("/activity", params={"kind": "nope"}, headers=ADMIN)
    assert r.status_code == 400


async def test_keyset_pages(client, session):
    t = Thread(title="many", title_source="user")
    session.add(t)
    await session.flush()
    base = now() - timedelta(minutes=30)
    session.add_all(
        [
            Request(kind="chat", status="ok", thread_id=t.id, created_at=base + timedelta(seconds=i))
            for i in range(7)
        ]
    )
    await session.commit()
    seen, cursor = [], None
    while True:
        p = await get(client, limit=3, **({"cursor": cursor} if cursor else {}))
        seen += [i["id"] for i in p["items"]]
        cursor = p["next"]
        if not cursor:
            break
    assert len(seen) == 7 and len(set(seen)) == 7 and seen == sorted(seen, reverse=True)


async def test_job_rows_link_to_the_job(client, session):
    proj = Project(path="/home/user/x", slug="x", name="x")
    session.add(proj)
    await session.flush()
    req = Request(kind="job", status="running", rule_id="code-heavy", created_at=now() - timedelta(minutes=5))
    session.add(req)
    await session.flush()
    job = Job(
        request_id=req.id,
        project_id=proj.id,
        title="Fix tests",
        prompt="p",
        agent="claude-code",
        agent_chain=["claude-code"],
        autonomy=1,
        budget_list_usd=1,
    )
    session.add(job)
    await session.flush()
    session.add(
        Cost(
            job_id=job.id,
            source="paperclip",
            provider="anthropic",
            model="claude",
            cost_usd=0,
            list_price_usd=0.25,
            kind="job",
            external_id="paperclip-run:1",
        )
    )
    await session.commit()
    item = (await get(client, kind=["job"]))["items"][0]
    assert item["label"] == "Fix tests" and item["job_id"] == job.id and item["value_usd"] == 0.25
    assert item["status"] == "queued"  # the job's own state, not its request row's "running"
    assert len((await get(client, status="queued"))["items"]) == 1
    d = (await client.get(f"/activity/{req.id}", headers=ADMIN)).json()
    assert d == {"id": req.id, "kind": "job", "job_id": job.id}


async def test_csv_is_formula_safe(client, session):
    await seed(session)
    r = await client.get("/activity.csv", params={"range": "today", "tz": "UTC"}, headers=ADMIN)
    assert (
        r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    )
    rows = list(csv.reader(io.StringIO(r.text.lstrip("﻿"))))
    assert rows[0][:3] == ["at", "kind", "label"]
    labels = [row[2] for row in rows[1:]]
    assert "Plan the =SUM(A1) launch" in labels  # starts with P: unchanged
    assert activity.cell("=HYPERLINK(1)") == "'=HYPERLINK(1)" and activity.cell("-1") == "'-1"
    assert activity.cell(-1.5) == "-1.5" and activity.cell("+x") == "'+x" and activity.cell("@a") == "'@a"


async def test_chat_title_and_model_test_appear(client, stack, session):
    ev = await turn(client, text="What is the capital of France?")
    tid = first(ev, "start")["thread_id"]
    items = (await get(client))["items"]
    kinds = [i["kind"] for i in items]
    assert "chat" in kinds and "aux" in kinds
    aux = next(i for i in items if i["kind"] == "aux")
    assert (
        aux["label"].startswith("Title · ")
        and str(tid) == next(i for i in items if i["kind"] == "chat")["thread_id"]
    )
    r = await client.post("/models/test", json={"alias": "fast"}, headers=ADMIN)
    assert r.status_code == 200
    test = (await get(client, kind=["test"]))["items"][0]
    assert test["status"] == "ok" and test["latency_ms"] is not None


async def test_metrics_totals_ignore_activity_only_rows(session):
    """aux/test request rows are for the Activity log: the rollup still counts those calls from costs."""
    t = now().replace(minute=0, second=0, microsecond=0)
    session.add_all(
        [
            Request(kind="aux", status="ok", created_at=t, call_id="sb-aux-9"),
            Request(kind="test", status="ok", created_at=t),
            Cost(
                source="litellm",
                provider="groq",
                model="m",
                kind="aux",
                cost_usd=0,
                list_price_usd=0.001,
                external_id="litellm:sb-aux-9",
                created_at=t,
            ),
        ]
    )
    await session.commit()
    await rollup.write_bucket(session, t)
    await session.commit()
    rows = (await session.execute(select(MetricsBucket))).scalars().all()
    assert sum(b.requests for b in rows) == 1  # the one LiteLLM call, counted once
    assert {b.kind for b in rows} == {"aux"}
