"""Rules UI backend (M3b, ADR 0004): merge precedence, validation with plain messages, versioning
(history, diff, rollback, idempotence, stale edits), the draft dry-run, and self-healing when the base
file changes under saved overrides."""

import copy
import json
from pathlib import Path

import pytest

from app import rules_versions
from app.models import RulesVersion
from app.registry import load_registry
from app.routing import overrides as ov
from app.routing import rules as rules_mod
from tests.conftest import ADMIN
from tests.test_chat import stack  # noqa: F401  (fixture)

BASE = rules_mod.load_raw()
REG = load_registry()


def build(doc):
    return ov.build(doc, BASE, REG)[1]


def problems(doc):
    with pytest.raises(ov.RulesInvalid) as e:
        build(doc)
    return {p.path: p.message for p in e.value.problems}


# --- merge ------------------------------------------------------------------------------------------
def test_an_empty_override_is_the_base_file():
    assert build({}).rules == rules_mod.parse(BASE).rules


def test_edit_a_rule_field_keeps_the_others():
    rs = build({"rules": {"writing": {"target": "model:fast", "temperature": 0.3}}})
    w = rs.get("writing")
    base = rules_mod.parse(BASE).get("writing")
    assert (w.target, w.temperature) == ("model:fast", 0.3)
    assert w.fallbacks == base.fallbacks and w.when == base.when and w.autonomy == base.autonomy


def test_disable_a_rule_and_its_slash_command_must_be_repointed():
    p = problems({"rules": {"bulk": {"disabled": True}}})
    assert "slash commands point at unknown rules" in next(iter(p.values()))
    rs = build({"rules": {"bulk": {"disabled": True}}, "slash": {"bulk": None}})
    assert rs.get("bulk") is None and "bulk" not in rs.slash


def test_a_new_rule_goes_before_default_or_before_a_named_rule():
    new = {"when": {"intent": "writing", "quality": "high"}, "target": "model:fast"}
    ids = [r.id for r in build({"rules": {"mine": new}}).rules]
    assert ids.index("mine") == ids.index("default") - 1
    ids = [r.id for r in build({"rules": {"mine": {**new, "before": "image"}}}).rules]
    assert ids.index("mine") == ids.index("image") - 1


def test_slash_defaults_presets_and_classifier_descriptions_merge():
    rs = build(
        {
            "slash": {"quick": "default"},
            "defaults": {"max_cost_usd": 0.2},
            "presets": {"free": {"rules": {"default": {"target": "model:smart-free"}}}},
            "classifier": {"routes": {"sensitive_health": {"description": "My own wording about health."}}},
            "recommender": {"weights": {"cost": 0.3}},
        }
    )
    assert rs.slash["quick"] == "default" and rs.defaults.max_cost_usd == 0.2
    assert rs.presets["free"]["rules"]["default"]["target"] == "model:smart-free"
    assert rs.presets["free"]["rules"]["writing-premium"]  # the base overlay is kept
    assert rs.classifier.route("sensitive_health").description == "My own wording about health."
    assert rs.classifier.route("sensitive_health").facts == {"sensitive": "health"}
    assert rs.recommender.weights["cost"] == 0.3 and rs.recommender.weights["latency"] == 0.15
    assert rs.with_preset("free").get("default").target == "model:smart-free"


def test_merge_never_changes_the_base():
    before = copy.deepcopy(BASE)
    build({"rules": {"default": {"target": "model:local"}}, "slash": {"x": "default"}})
    assert BASE == before


# --- validation -------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("doc", "path", "words"),
    [
        ({"rules": {"default": {"target": "model:nope"}}}, "rules.default.target", "no model alias"),
        ({"rules": {"default": {"target": "fast"}}}, "rules.default.target", "A target looks like"),
        ({"rules": {"default": {"target": "model:zzz/x"}}}, "rules.default.target", "Unknown provider"),
        ({"rules": {"default": {"target": "best:magic"}}}, "rules.default.target", "capability"),
        (
            {"rules": {"default": {"fallbacks": ["model:fast", "model:nope"]}}},
            "rules.default.fallbacks[1]",
            "alias",
        ),
        ({"rules": {"default": {"fallbacks": ["model:fast"] * 11}}}, "rules.default.fallbacks", "at most 10"),
        ({"rules": {"default": {"colour": "red"}}}, "rules.default.colour", "isn't a field"),
        ({"rules": {"default": {"temperature": 9}}}, "rules.default.temperature", "between 0 and 2"),
        ({"rules": {"default": {"autonomy": 1.5}}}, "rules.default.autonomy", "whole number"),
        ({"rules": {"default": {"max_cost_usd": -1}}}, "rules.default.max_cost_usd", "$0 and $100"),
        ({"rules": {"default": {"disabled": True}}}, "rules.default", "can't be removed"),
        ({"rules": {"mine": {"target": "model:fast"}}}, "rules.mine.when", "needs a `when`"),
        ({"rules": {"mine": {"when": {}}}}, "rules.mine.target", "needs a target"),
        ({"rules": {"Bad Id": {"when": {}, "target": "model:fast"}}}, "rules.Bad Id", "lowercase"),
        (
            {"rules": {"writing": {"when": {"intent": "poetry"}}}},
            "rules.writing.when.intent",
            "Intent is one of",
        ),
        ({"rules": {"writing": {"when": {"mood": "x"}}}}, "rules.writing.when.mood", "isn't a condition"),
        ({"rules": {"writing": {"before": "image"}}}, "rules.writing.before", "only positions a new rule"),
        ({"defaults": {"max_cost_usd": 1000}}, "defaults.max_cost_usd", "$0 and $100"),
        ({"defaults": {"private": True}}, "defaults.private", "Settings"),
        ({"defaults": {"colour": 1}}, "defaults.colour", "isn't a field"),
        ({"presets": {"free": {"paid": "sometimes"}}}, "presets.free.paid", "Paid policy"),
        (
            {"presets": {"free": {"rules": {"ghost": {"target": "model:fast"}}}}},
            "presets.free.rules.ghost",
            "no rule",
        ),
        (
            {"presets": {"free": {"rules": {"private": {"target": "model:fast"}}}}},
            "presets.free.rules.private",
            "can't change",
        ),
        (
            {"classifier": {"routes": {"general_chat": {"facts": {"intent": "chat"}}}}},
            "classifier.routes.general_chat.facts",
            "keep their facts",
        ),
        (
            {"classifier": {"routes": {"sensitive_health": {"description": ""}}}},
            "classifier.routes.sensitive_health.description",
            "characters",
        ),
        (
            {"classifier": {"routes": {"fresh": {"description": "x"}}}},
            "classifier.routes.fresh",
            "needs a description and facts",
        ),
        ({"classifier": {"timeout_s": 99}}, "", "timeout_s"),
        ({"quota": {"reroute_at": 2, "block_at": 1}}, "", "reroute_at"),
        ({"slash": {"Bad!": "default"}}, "slash.Bad!", "lowercase"),
        ({"surprise": {}}, "surprise", "can't be overridden"),
    ],
)
def test_validation_names_the_field_and_says_what_to_do(doc, path, words):
    p = problems(doc)
    assert path in p, p
    assert words in p[path], p[path]


def test_every_problem_is_reported_not_just_the_first():
    p = problems({"rules": {"default": {"target": "model:nope", "temperature": 9, "autonomy": 7}}})
    assert {"rules.default.target", "rules.default.temperature", "rules.default.autonomy"} <= set(p)


def test_the_private_rule_can_never_leave_the_machine():
    for o, key in [
        ({"target": "model:fast"}, "rules.private.target"),
        ({"target": "model:groq/openai/gpt-oss-20b"}, "rules.private.target"),
        ({"target": "best:code"}, "rules.private.target"),
        ({"fallbacks": ["model:fast"]}, "rules.private.fallbacks"),
        ({"when": {"intent": "chat"}}, "rules.private.when"),
        ({"job": True}, "rules.private.job"),
        ({"disabled": True}, "rules.private"),
    ]:
        assert key in problems({"rules": {"private": o}}), o
    # local targets are fine
    for t in ("model:local", "model:private", "model:local-code", "model:ollama/qwen3:8b"):
        assert build({"rules": {"private": {"target": t}}}).get("private").target == t


def test_hostile_documents_are_rejected_cleanly():
    for doc in ("rules", [], 7, None):
        with pytest.raises(ov.RulesInvalid):
            ov.build(doc, BASE, REG)
    assert problems({"rules": [1, 2]})["rules"]
    assert "rules.x" in problems({"rules": {"x": "default"}})
    big = {"rules": {"mine": {"when": {}, "target": "model:fast", "x" * 5: "y" * 70_000}}}
    assert "larger than" in problems(big)[""]
    many = {"rules": {f"r{i}": {"when": {"intent": "chat"}, "target": "model:fast"} for i in range(101)}}
    assert "At most 100" in problems(many)["rules"]
    assert any("__proto__" in k for k in problems({"__proto__": {"polluted": True}}))


def test_diff_lists_paths_and_treats_a_chain_as_one_change():
    a = {"rules": {"default": {"target": "model:fast", "fallbacks": ["model:local"]}}}
    b = {
        "rules": {"default": {"target": "model:smart-free", "fallbacks": ["model:local", "model:fast"]}},
        "slash": {"q": "default"},
    }
    d = {c["path"]: c for c in ov.diff(a, b)}
    assert d["rules.default.target"]["kind"] == "changed"
    assert d["rules.default.fallbacks"]["after"] == ["model:local", "model:fast"]
    assert d["slash.q"]["kind"] == "added" and ov.diff(b, b) == []
    assert ov.diff({}, {})[:] == []


# --- API: versions ----------------------------------------------------------------------------------
async def put(client, doc, base_version=None, note=None):
    return await client.put(
        "/rules/overrides", json={"overrides": doc, "base_version": base_version, "note": note}, headers=ADMIN
    )


async def test_get_rules_before_any_edit(client):
    d = (await client.get("/rules")).json()
    assert d["version"] is None and d["overrides"] == {} and d["problems"] == []
    assert d["effective"]["rules"] == BASE["rules"] and d["base"]["rules"] == BASE["rules"]
    assert "fast" in d["vocab"]["aliases"] and "private" in d["vocab"]["protected_rules"]
    assert d["active_preset"] == "balanced"


async def test_writes_need_the_admin_token(client):
    r = await client.put("/rules/overrides", json={"overrides": {}})
    assert r.status_code == 401
    assert (await client.post("/rules/versions/1/rollback")).status_code == 401


async def test_save_creates_versions_and_changes_routing(client, stack):
    before = (
        await client.post("/route/dry-run", json={"text": "what is the capital of France?"}, headers=ADMIN)
    ).json()
    assert before["rule"] == "default" and before["candidates"][0]["target"] == "model:fast"
    r = await put(client, {"rules": {"default": {"target": "model:smart-free"}}}, None, "Prefer Gemini")
    assert r.status_code == 200 and r.json()["created"] and r.json()["version"]["id"] == 1
    after = (
        await client.post("/route/dry-run", json={"text": "what is the capital of France?"}, headers=ADMIN)
    ).json()
    assert after["candidates"][0]["target"] == "model:smart-free"
    d = (await client.get("/rules")).json()
    assert (
        d["version"]["note"] == "Prefer Gemini"
        and d["effective"]["rules"][-1]["target"] == "model:smart-free"
    )
    assert d["base"]["rules"][-1]["target"] == "model:fast"  # the file is untouched


async def test_saving_the_same_document_is_a_no_op(client):
    doc = {"defaults": {"max_cost_usd": 0.3}}
    first = (await put(client, doc, None)).json()
    again = (await put(client, doc, first["version"]["id"])).json()
    assert again["created"] is False and again["version"]["id"] == first["version"]["id"]
    assert len((await client.get("/rules/versions")).json()["versions"]) == 1


async def test_a_stale_edit_is_refused_and_nothing_is_overwritten(client):
    await put(client, {"defaults": {"max_cost_usd": 0.3}}, None)
    r = await put(client, {"defaults": {"max_cost_usd": 0.9}}, None)  # started from "no version"
    assert r.status_code == 409 and r.json()["detail"]["code"] == "rules_stale"
    assert (await client.get("/rules")).json()["overrides"] == {"defaults": {"max_cost_usd": 0.3}}


async def test_an_invalid_edit_is_a_422_with_every_problem_and_saves_nothing(client):
    r = await put(client, {"rules": {"default": {"target": "model:nope", "autonomy": 9}}}, None)
    d = r.json()["detail"]
    assert r.status_code == 422 and d["code"] == "rules_invalid" and len(d["problems"]) == 2
    assert "and 1 more" in d["message"]
    assert (await client.get("/rules")).json()["version"] is None


async def test_validate_endpoint_checks_without_saving(client):
    ok = (await client.post("/rules/validate", json={"overrides": {"defaults": {"temperature": 0.1}}})).json()
    bad = (await client.post("/rules/validate", json={"overrides": {"defaults": {"temperature": 5}}})).json()
    assert ok["ok"] and bad["ok"] is False and bad["problems"][0]["path"] == "defaults.temperature"
    assert (await client.get("/rules")).json()["version"] is None


async def test_history_diff_and_rollback_keep_every_version(client):
    v1 = (await put(client, {"defaults": {"max_cost_usd": 0.3}}, None, "one")).json()["version"]["id"]
    v2 = (
        await put(client, {"defaults": {"max_cost_usd": 0.3}, "slash": {"q": "default"}}, v1, "two")
    ).json()["version"]["id"]
    v3 = (await put(client, {}, v2, "reset")).json()["version"]["id"]
    hist = (await client.get("/rules/versions")).json()
    assert [v["id"] for v in hist["versions"]] == [3, 2, 1] and hist["next_before"] is None
    page = (await client.get("/rules/versions?limit=2")).json()
    assert [v["id"] for v in page["versions"]] == [3, 2] and page["next_before"] == 2
    assert [v["id"] for v in (await client.get("/rules/versions?limit=2&before=2")).json()["versions"]] == [1]
    d = (await client.get(f"/rules/versions/{v2}/diff")).json()  # vs the previous version
    assert [(c["path"], c["kind"]) for c in d["changes"]] == [("slash.q", "added")]
    d = (await client.get(f"/rules/versions/{v2}/diff?against=base")).json()
    assert {c["path"] for c in d["changes"]} == {"defaults.max_cost_usd", "slash.q"}
    assert (await client.get(f"/rules/versions/{v2}/diff?against=current")).json()["changes"]
    assert (await client.get("/rules/versions/99/diff")).status_code == 404

    rb = (await client.post(f"/rules/versions/{v2}/rollback", headers=ADMIN)).json()
    assert rb["created"] and rb["version"]["id"] == 4 and rb["version"]["rolled_back_to"] == 2
    cur = (await client.get("/rules")).json()
    assert cur["overrides"] == {"defaults": {"max_cost_usd": 0.3}, "slash": {"q": "default"}}
    assert (await client.get(f"/rules/versions/{v1}")).json()["overrides"] == {
        "defaults": {"max_cost_usd": 0.3}
    }
    assert len((await client.get("/rules/versions")).json()["versions"]) == 4  # nothing was rewritten
    assert v3 == 3
    # rolling back to what is already current changes nothing
    again = (await client.post("/rules/versions/4/rollback", headers=ADMIN)).json()
    assert again["created"] is False


# --- API: dry run -----------------------------------------------------------------------------------
async def test_dry_run_with_a_draft_does_not_persist_and_shows_the_breakdown(client, stack):
    stack.ollama.route = "code_large"
    draft = {"rules": {"code-heavy": {"target": "model:local-code", "fallbacks": ["model:fast"]}}}
    r = await client.post(
        "/route/dry-run", json={"text": "migrate our app to the new framework", "draft": draft}, headers=ADMIN
    )
    d = r.json()
    assert (
        r.status_code == 200
        and d["rule"] == "code-heavy"
        and d["candidates"][0]["target"] == "model:local-code"
    )
    assert d["classifier"]["source"] == "arch-router" and d["classifier"]["route"] == "code_large"
    assert d["scores"] is not None and "chosen" in d and "runner_up" in d and d["skipped"] is not None
    assert (await client.get("/rules")).json()["version"] is None
    saved = (
        await client.post(
            "/route/dry-run", json={"text": "migrate our app to the new framework"}, headers=ADMIN
        )
    ).json()
    assert saved["candidates"][0]["target"] != "model:local-code"


async def test_dry_run_with_an_invalid_draft_is_a_422(client):
    r = await client.post(
        "/route/dry-run",
        json={"text": "hi", "draft": {"rules": {"private": {"target": "model:fast"}}}},
        headers=ADMIN,
    )
    assert r.status_code == 422 and r.json()["detail"]["problems"][0]["path"] == "rules.private.target"


# --- self-healing -----------------------------------------------------------------------------------
async def test_overrides_that_stop_fitting_the_base_fall_back_to_the_file_and_say_so(client, session, stack):
    """rules.yaml changed under a saved edit (a rule it edits is gone): chat keeps working on the base."""
    session.add(
        RulesVersion(
            source="edit", overrides={"rules": {"ghost-rule": {"target": "model:local"}}}, base_sha=""
        )
    )
    await session.commit()
    d = (await client.get("/rules")).json()
    assert d["problems"] and d["version"]["id"] == 1
    r = await client.post("/route/dry-run", json={"text": "what is the capital of France?"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["rule"] == "default"
    # fixing it (reset) clears the problem
    assert (await put(client, {}, 1)).status_code == 200
    assert (await client.get("/rules")).json()["problems"] == []


async def test_the_build_cache_is_bounded_and_follows_the_version(client, session):
    for i in range(6):
        cur = (await client.get("/rules")).json()["version"]
        await put(client, {"defaults": {"max_cost_usd": 0.1 + i / 10}}, cur["id"] if cur else None)
        await rules_versions.effective_rules(session)
    assert len(rules_versions._built) <= rules_versions.MAX_BUILT
    json.dumps((await client.get("/rules")).json())  # serialisable


def test_targets_already_in_rules_yaml_stay_editable_even_if_their_alias_does_not_exist_yet():
    """rules.yaml's premium writing rule points at model:grok, an alias that needs a key and an alias
    entry first. Editing another field of that rule (or re-sending its chain unchanged) must work; a
    brand-new unknown alias is still refused."""
    assert "model:grok" in ov._base_targets(BASE)
    assert (
        build({"rules": {"writing-premium": {"temperature": 0.5}}}).get("writing-premium").target
        == "model:grok"
    )
    keep = {"rules": {"writing-premium": {"target": "model:grok", "fallbacks": ["model:fast"]}}}
    assert build(keep).get("writing-premium").fallbacks == ("model:fast",)
    assert "rules.writing-premium.target" in problems(
        {"rules": {"writing-premium": {"target": "model:grok2"}}}
    )


# --- contract with the portal's live-preview merge (apps/portal/src/lib/rules-model.ts) ----------------
CONTRACT = json.loads((Path(__file__).parent / "fixtures" / "rules_merge_cases.json").read_text())


def _at(doc, path):
    head, *rest = path.split(".")
    if head == "rules":
        return next(r for r in doc["rules"] if r["id"] == rest[0])
    node = doc[head]
    for k in rest:
        node = node[k]
    return node


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=lambda c: c["name"])
def test_merge_matches_the_shared_contract_cases(case):
    base = copy.deepcopy(CONTRACT["base"])
    out = ov.merge(base, case["overrides"])
    assert base == CONTRACT["base"]  # never changed
    if "rule_ids" in case:
        assert [r["id"] for r in out["rules"]] == case["rule_ids"]
    for path, want in (case.get("check") or {}).items():
        assert _at(out, path) == want, path
