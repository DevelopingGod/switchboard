"""Classifier (M3a): Arch-Router prompt and parsing, pre-filter, heuristic fallback + breaker, auto-private
with its override, and pasted secrets (always local, masked everywhere)."""

import json
import logging

import httpx
import pytest
from sqlalchemy import select

from app import local_profile
from app.models import Message, Request, Thread
from app.routing import classifier, secrets_detect
from app.routing.rules import load_rules
from tests.conftest import ADMIN
from tests.test_chat import first, names, stack, turn  # noqa: F401  (fixtures)

CFG = load_rules().classifier
SECRET = "sk-proj-abcdEFGHijklMNOPqrstUVWX1234567890"  # gitleaks:allow


# --- prompt + parsing ----------------------------------------------------------------------------
def test_prompt_follows_the_model_card():
    p = classifier.build_prompt(CFG.routes, "write a linkedin post")
    assert p.startswith("\nYou are a helpful assistant designed to find the best suited route.")
    routes = json.loads(p.split("<routes>\n\n", 1)[1].split("\n\n</routes>", 1)[0])
    assert {r["name"] for r in routes} >= {"code_small", "code_large", "writing", "sensitive_health"}
    conv = json.loads(p.split("<conversation>\n\n", 1)[1].split("\n\n</conversation>", 1)[0])
    assert conv == [{"role": "user", "content": "write a linkedin post"}]
    assert p.rstrip().endswith('{"route": "route_name"}')


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ('{"route": "writing"}', "writing"),
        ("{'route': 'sensitive_health'}", "sensitive_health"),  # what the Q4 GGUF really answers
        ('```json\n{"route": "code_large"}\n```', "code_large"),
        ('{"route": "other"}', "other"),
        ('{"route": "made_up"}', None),
        ("writing", "writing"),
        ("", None),
    ],
)
def test_parse_route(raw, want):
    assert classifier.parse_route(raw, CFG) == want


def test_routes_map_to_facts():
    assert classifier.to_intent("code_large", CFG, "x").intent == "code"
    assert classifier.to_intent("code_large", CFG, "x").size == "large"
    s = classifier.to_intent("sensitive_health", CFG, "my blood test results")
    assert (s.intent, s.sensitive) == ("chat", "health")
    assert classifier.to_intent("other", CFG, "hello").intent == "chat"


def test_prefilter_decides_strong_signals_without_a_model():
    assert classifier.prefilter("make me a logo for my bakery").intent == "image"
    assert classifier.prefilter("```py\nprint(1)\n```\nwhy?").intent == "code"
    assert classifier.prefilter("write a linkedin post about python") is None  # ambiguous: ask the model
    assert classifier.prefilter("design a thumbnail for my video") is None  # image and video words


# --- fallback --------------------------------------------------------------------------------------
async def test_arch_router_answer_is_used(ollama_fake):
    ollama_fake.route = "writing"
    r = await classifier.classify("announce my new job to my network", CFG)
    assert r.intent.intent == "writing" and r.info["source"] == "arch-router" and r.info["route"] == "writing"
    call = ollama_fake.classifier_calls()[0]
    assert call["keep_alive"] == -1 and call["options"]["temperature"] == 0


async def test_falls_back_to_heuristics_and_opens_the_breaker(ollama_fake):
    ollama_fake.route = None  # 404: model not pulled
    r = await classifier.classify("research our competitors", CFG)
    assert r.info["source"] == "heuristic" and r.intent.intent == "research"
    assert "not pulled" in r.info["fallback_reason"]
    n = len(ollama_fake.classifier_calls())
    r = await classifier.classify("anything else", CFG)
    assert len(ollama_fake.classifier_calls()) == n  # breaker: no second 1.5 s wait
    assert r.info["source"] == "heuristic"


async def test_slow_classifier_times_out_at_the_limit(ollama_fake):
    from dataclasses import replace

    ollama_fake.route, ollama_fake.classifier_delay = "writing", 0.5
    r = await classifier.classify("announce my new job", replace(CFG, timeout_s=0.1))
    assert r.info["source"] == "heuristic" and "slower than 0.1 s" in r.info["fallback_reason"]


async def test_no_classifier_in_the_none_profile(ollama_fake):
    local_profile.set_active("none")
    r = await classifier.classify("announce my new job", CFG)
    assert r.info["fallback_reason"] == "no classifier in this local-model profile"
    assert not ollama_fake.classifier_calls()


# --- auto-private ---------------------------------------------------------------------------------
async def test_sensitive_message_stays_local_with_a_notice_and_can_be_overridden(client, stack, session):
    stack.ollama.routes = {"blood test": "sensitive_health"}
    ev = await turn(client, text="my blood test shows high cholesterol, what should I eat?")
    assert first(ev, "route")["local"] is True
    route = [d for e, d in ev if e == "done"][0]["route"]
    assert route["matched_by"] == "auto_private"
    assert route["sensitive"] == {"source": "classifier", "category": "health", "overridable": True}
    assert route["reasons"][0] == "Looks sensitive (health) → kept on this machine"
    tid = first(ev, "start")["thread_id"]
    t = (await client.get(f"/chat/threads/{tid}", headers=ADMIN)).json()["thread"]
    assert t["private"] and t["private_source"] == "auto"
    # "Not sensitive — use cloud": re-run with normal routing, thread un-marked, override logged
    ev = await turn(client, f"/chat/threads/{tid}/regenerate", cloud_override=True)
    assert first(ev, "route")["local"] is False
    t = (await client.get(f"/chat/threads/{tid}", headers=ADMIN)).json()["thread"]
    assert not t["private"] and t["private_source"] is None
    reqs = (await session.execute(select(Request).order_by(Request.id))).scalars().all()
    assert reqs[0].decision_json["sensitive"]["overridden"] is True
    assert reqs[0].decision_json["classifier"]["route"] == "sensitive_health"
    assert reqs[1].decision_json["sensitive"] is None  # the re-run skipped auto-detection


async def test_auto_detect_can_be_turned_off(client, stack):
    stack.ollama.routes = {"salary": "sensitive_finance"}
    r = await client.put("/settings", json={"auto_private": False}, headers=ADMIN)
    assert r.json()["auto_private"] is False
    ev = await turn(client, text="my salary is 90k, how much should I save?")
    assert first(ev, "route")["local"] is False


async def test_override_is_refused_for_user_private_threads(client, stack):
    ev = await turn(client, text="hello", private=True)
    tid = first(ev, "start")["thread_id"]
    r = await client.post(f"/chat/threads/{tid}/regenerate", json={"cloud_override": True}, headers=ADMIN)
    assert r.status_code == 409


# --- secrets ----------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "kind"),
    [
        (f"my key is {SECRET}", "api_key"),
        ("token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB please", "api_key"),  # gitleaks:allow
        ("password: hunter2!x", "password"),
        ("my password is Tr0ub4dor&3", "password"),
        ("postgres://app:s3cretpw@db:5432/x", "password"),
        ("card 4111 1111 1111 1111 exp 12/29", "card"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "token"),
    ],
)
def test_secret_kinds(text, kind):
    masked, kinds = secrets_detect.mask(text)
    assert kind in kinds and "[secret masked:" in masked


@pytest.mark.parametrize(
    "text",
    [
        'password = os.environ["DB_PASSWORD"]',
        "the password is required",
        "set api_key = ${API_KEY} in .env",
        "my order number is 1234 5678 9012 3456",  # fails the Luhn check
        "explain how JWT tokens work",
    ],
)
def test_not_secrets(text):
    assert secrets_detect.mask(text) == (text, [])


async def test_secret_stays_local_masked_everywhere_with_no_override(client, stack, session, caplog):
    caplog.set_level(logging.DEBUG)
    stack.answer = "Rotate it now."
    ev = await turn(client, text=f"why does {SECRET} give 401 from the api?")
    assert first(ev, "route")["local"] is True
    tid = first(ev, "start")["thread_id"]
    done = [d for e, d in ev if e == "done"][0]["route"]
    assert done["matched_by"] == "secret" and done["sensitive"]["overridable"] is False
    # the local model got the original text for this turn only
    assert SECRET in json.dumps(stack.stream_calls[-1]["messages"][-1])
    assert all(m.startswith("model:local") or m.startswith("ollama") for m in [first(ev, "route")["target"]])
    body = (await client.get(f"/chat/threads/{tid}", headers=ADMIN)).json()
    user = body["messages"][0]
    assert SECRET not in user["content"] and user["secret"] == {"kinds": ["api_key"]}
    assert body["thread"]["private_source"] == "secret"
    # no override
    r = await client.post(f"/chat/threads/{tid}/regenerate", json={"cloud_override": True}, headers=ADMIN)
    assert r.status_code == 409
    # not in: stored rows, the Why data, the title, exports, logs
    rows = [
        *(await session.execute(select(Message))).scalars(),
        *(await session.execute(select(Request))).scalars(),
    ]
    dumped = json.dumps([[getattr(r, c.name) for c in r.__table__.columns] for r in rows], default=str)
    assert SECRET not in dumped
    t = (await session.execute(select(Thread))).scalar_one()
    assert SECRET not in t.title
    title_calls = [c for c in stack.ollama.calls if c["messages"][0]["content"].startswith("Write a title")]
    assert all(SECRET not in json.dumps(c) for c in title_calls)
    for fmt in ("json", "md"):
        r = await client.get(f"/chat/export?format={fmt}&include_private=true", headers=ADMIN)
        assert SECRET not in r.text
    assert SECRET not in caplog.text
    # a later regenerate of the masked message never sees the secret either
    await turn(client, f"/chat/threads/{tid}/regenerate")
    assert SECRET not in json.dumps(stack.stream_calls[-1]["messages"])


async def test_dry_run_masks_and_uses_the_classifier(client, stack):
    stack.ollama.route = "code_large"
    r = await client.post(
        "/route/dry-run", json={"text": "migrate our app to the new framework"}, headers=ADMIN
    )
    body = r.json()
    assert body["rule"] == "code-heavy" and body["classifier"]["source"] == "arch-router"
    r = await client.post("/route/dry-run", json={"text": f"is {SECRET} valid?"}, headers=ADMIN)
    assert r.json()["rule"] == "private" and SECRET not in r.text


async def test_classifier_unreachable_is_not_fatal(client, stack, mock_http):
    mock_http.post("http://ollama.test/api/chat").mock(side_effect=httpx.ConnectError("refused"))
    ev = await turn(client, text="research our competitors in India")
    assert "done" in names(ev)
    done = [d for e, d in ev if e == "done"][0]["route"]
    assert done["classifier"]["source"] == "heuristic" and done["intent"] == "research"


async def test_start_event_carries_the_masked_text(client, stack):
    ev = await turn(client, text=f"is {SECRET} still valid?")
    start = first(ev, "start")
    assert start["user_text"] == "is [secret masked: API key] still valid?"
    assert start["secret"] == {"kinds": ["api_key"]}
    assert SECRET not in json.dumps([d for _, d in ev])  # nothing in the stream echoes it
