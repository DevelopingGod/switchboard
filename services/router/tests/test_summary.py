"""Long threads (M3a): summary at 75% of max_context_tokens, last 6 messages verbatim, incremental,
stored and sent as a note; never a cloud model for a private thread."""

from dataclasses import replace

import pytest
from sqlalchemy import select

from app.chat import summary
from app.models import Message, Thread
from app.routing import rules as rules_mod
from tests.conftest import ADMIN
from tests.test_chat import first, stack, turn  # noqa: F401  (fixtures)

LONG = "x" * 1200  # ~300 tokens


@pytest.fixture
def small_budget(monkeypatch):
    """max_context_tokens 2000 -> a summary starts at 1500 tokens of history."""
    real = rules_mod.load_rules

    def load(config_dir=None):
        rs = real(config_dir)
        return replace(rs, defaults=replace(rs.defaults, max_context_tokens=2000))

    monkeypatch.setattr(
        "app.routing.rules.load_rules", load
    )  # the base the effective rules start from (rules_versions)


async def chat_until_summary(client, stack, private=False, rounds=4):
    stack.answer = LONG.replace("x", "y ")[:1200]
    ev = await turn(client, text=f"first {LONG}", private=private)
    tid = first(ev, "start")["thread_id"]
    events = [ev]
    for i in range(rounds):
        events.append(await turn(client, text=f"turn {i} {LONG}", thread_id=tid, private=private))
    return tid, events


async def test_summary_written_after_reply_and_used_next_turn(client, stack, small_budget, session):
    tid, events = await chat_until_summary(client, stack)
    first_summary = next(i for i, ev in enumerate(events) if any(e == "summary" for e, _ in ev))
    s = next(d for e, d in events[first_summary] if e == "summary")["summary"]
    assert s["text"].startswith("- The user is planning") and s["model"] == "ollama/llama3.2:3b"
    msgs = (
        await session.execute(select(Message).where(Message.thread_id == tid).order_by(Message.id))
    ).scalars()
    msgs = list(msgs)
    covered = [m for m in msgs if m.id <= s["upto_message_id"]]
    assert len(msgs) - len(covered) >= 6  # the newest six are never folded in
    # the summarizer ran with thinking off on the local tasks model
    call = next(c for c in stack.ollama.calls if c["messages"][0]["content"].startswith("You keep a running"))
    assert call["model"] == "llama3.2:3b" and call["think"] is False
    # the next turn sends the note + only the uncovered messages
    await turn(client, text="and now?", thread_id=tid)
    sent = stack.stream_calls[-1]["messages"]
    assert sent[1]["role"] == "system" and sent[1]["content"].startswith(summary.NOTE)
    t = (await client.get(f"/chat/threads/{tid}", headers=ADMIN)).json()["thread"]
    assert t["summary"]["covers"] >= 1


async def test_keeps_last_six_verbatim_and_is_incremental(client, stack, small_budget, session):
    tid, _ = await chat_until_summary(client, stack, rounds=6)
    t = (await session.execute(select(Thread).where(Thread.id == tid))).scalar_one()
    await session.refresh(t)
    msgs = list((await session.execute(select(Message).where(Message.thread_id == tid))).scalars())
    after = [m for m in msgs if m.id > t.summary_json["upto_message_id"]]
    assert len(after) >= 6
    runs = [c for c in stack.ollama.calls if c["messages"][0]["content"].startswith("You keep a running")]
    assert len(runs) >= 2
    assert "(none yet)" in runs[0]["messages"][0]["content"]
    assert "The user is planning a trip" in runs[-1]["messages"][0]["content"]  # old summary folded in
    assert t.summary_json["incremental"] is True


async def test_private_thread_never_summarized_by_a_cloud_model(client, stack, small_budget):
    stack.ollama.summary_status = 500  # local model fails
    tid, events = await chat_until_summary(client, stack, private=True)
    assert not any(e == "summary" for ev in events for e, _ in ev)
    assert stack.chat_calls == []  # no non-streamed cloud call (titles/summaries)
    assert all(
        b["model"] in ("local", "private") or b["model"].startswith("ollama") for b in stack.stream_calls
    )


async def test_non_private_thread_may_fall_back_to_the_cloud(client, stack, small_budget):
    stack.ollama.summary_status = 500
    tid, events = await chat_until_summary(client, stack)
    assert any(e == "summary" for ev in events for e, _ in ev)
    assert "fast" in stack.chat_calls


def test_build_history_ignores_a_summary_that_covers_the_message_being_answered():
    t = Thread(summary_json={"text": "s", "upto_message_id": 10})
    msgs = [
        Message(id=i, role="user" if i % 2 else "assistant", content=str(i), status="done")
        for i in range(1, 13)
    ]
    h = summary.build_history(t, msgs)
    assert h[0]["role"] == "system" and [m["content"] for m in h[1:]] == ["11", "12"]
    assert summary.build_history(t, msgs[:8], before_id=9)[0]["role"] != "system"
