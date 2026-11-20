"""Rules UI overrides (M3b, ADR 0004): merge, validate and diff. Pure functions, no I/O.

`config/rules.yaml` stays the read-only base. The owner's edits are one JSON document (the *overrides*)
that is merged onto the base's raw dict, and the result goes through the same `rules.parse()` that
loads the file, so there is one set of validation rules (principle 2). On top of that this module checks
what `parse()` doesn't: field names, number ranges, target syntax against the registry, sizes, and the
privacy invariants (the `private` rule can't be changed to leave the machine).

Document shape (every key optional):

    defaults:    { temperature, autonomy, max_cost_usd, daily_cap_usd, max_context_tokens, max_output_tokens }
    rules:       { <id>: { when, target, fallbacks, temperature, autonomy, max_cost_usd, job },   # edit
                   <id>: { disabled: true },                                                  # remove
                   <new id>: { when, target, ..., before: <id> } }                            # add
    slash:       { <command>: <rule id> | null }
    presets:     { <name>: { paid, rules: { <id>: { target, fallbacks, temperature, autonomy,
                                                    max_cost_usd } } } }
    classifier:  { timeout_s, breaker_s, max_chars,
                   routes: { <name>: { description } | { description, facts } } }
    recommender: { min_samples, weights: { <term>: number } }
    quota:       { reroute_at, block_at }
    summary:     { start_at, keep_last }
"""

from __future__ import annotations

import json
import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from app.registry import Registry
from app.routing import rules as rules_mod
from app.routing.rules import FACT_KEYS, INTENTS, PRESETS, SENSITIVE, WHEN_KEYS

TOP_KEYS = ("defaults", "rules", "slash", "presets", "classifier", "recommender", "quota", "summary")
RULE_FIELDS = {"when", "target", "fallbacks", "temperature", "autonomy", "max_cost_usd", "job"}
PRESET_RULE_FIELDS = {"target", "fallbacks", "temperature", "autonomy", "max_cost_usd"}
DEFAULT_FIELDS = {
    "temperature",
    "autonomy",
    "max_cost_usd",
    "daily_cap_usd",
    "max_context_tokens",
    "max_output_tokens",
}
CAPABILITIES = (
    "chat",
    "code",
    "reasoning",
    "vision",
    "long-context",
    "fast",
    "small",
    "image",
    "video",
    "audio",
    "embedding",
    "moderation",
)
PAID_POLICIES = ("never", "manual", "allowed")
PROTECTED_RULES = ("private", "default")  # can't be removed
LOCAL_ALIASES = ("local", "private", "local-code", "local-think")

MAX_BYTES = 64_000
MAX_RULES = 100
MAX_FALLBACKS = 10
MAX_TEXT = 1500
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
PRESET_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,29}$")
TARGET_RE = re.compile(r"^(model|best|agent|media):[\w.:/@-]{1,200}$")


@dataclass(frozen=True)
class Problem:
    path: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "message": self.message}


class RulesInvalid(ValueError):
    def __init__(self, problems: list[Problem]):
        self.problems = problems
        super().__init__("; ".join(f"{p.path}: {p.message}" if p.path else p.message for p in problems))


# --- merge -----------------------------------------------------------------------------------------
def merge(base: dict[str, Any], ov: dict[str, Any]) -> dict[str, Any]:
    """Base rules.yaml dict + overrides -> the dict `rules.parse()` reads. Doesn't validate."""
    out = deepcopy(base)
    for block in ("defaults", "quota", "summary"):
        if ov.get(block):
            out[block] = {**(out.get(block) or {}), **ov[block]}
    if ov.get("recommender"):
        r = ov["recommender"]
        cur = out.get("recommender") or {}
        out["recommender"] = {
            **cur,
            **{k: v for k, v in r.items() if k != "weights"},
            "weights": {**(cur.get("weights") or {}), **(r.get("weights") or {})},
        }
    if ov.get("classifier"):
        out["classifier"] = _merge_classifier(out.get("classifier") or {}, ov["classifier"])
    if ov.get("rules"):
        out["rules"] = _merge_rules(out.get("rules") or [], ov["rules"])
    if ov.get("slash"):
        slash = dict(out.get("slash") or {})
        for cmd, rid in ov["slash"].items():
            if rid is None:
                slash.pop(cmd, None)
            else:
                slash[cmd] = rid
        out["slash"] = slash
    if ov.get("presets"):
        out["presets"] = _merge_presets(out.get("presets") or {}, ov["presets"])
    return out


def _merge_rules(base_rules: list[dict[str, Any]], ov: dict[str, Any]) -> list[dict[str, Any]]:
    rules = [dict(r) for r in base_rules]
    by_id = {r["id"]: r for r in rules}
    added: list[tuple[str | None, dict[str, Any]]] = []
    for rid, o in ov.items():
        if rid in by_id:
            if o.get("disabled"):
                rules = [r for r in rules if r["id"] != rid]
            else:
                by_id[rid].update({k: v for k, v in o.items() if k in RULE_FIELDS})
        elif not o.get("disabled"):
            added.append((o.get("before"), {"id": rid, **{k: v for k, v in o.items() if k in RULE_FIELDS}}))
    for before, rule in added:  # new rules go before `before`, else just before the catch-all `default`
        ids = [r["id"] for r in rules]
        at = ids.index(before) if before in ids else (ids.index("default") if "default" in ids else len(ids))
        rules.insert(at, rule)
    return rules


def _merge_classifier(base: dict[str, Any], ov: dict[str, Any]) -> dict[str, Any]:
    out = {**base, **{k: v for k, v in ov.items() if k != "routes"}}
    routes = [dict(r) for r in base.get("routes") or []]
    for name, o in (ov.get("routes") or {}).items():
        hit = next((r for r in routes if r.get("name") == name), None)
        if hit is not None:
            hit.update({k: v for k, v in o.items() if k in ("description", "facts")})
        else:
            routes.append({"name": name, **{k: v for k, v in o.items() if k in ("description", "facts")}})
    out["routes"] = routes
    return out


def _merge_presets(base: dict[str, Any], ov: dict[str, Any]) -> dict[str, Any]:
    out = {k: deepcopy(v or {}) for k, v in base.items()}
    for name, o in ov.items():
        cur = out.setdefault(name, {})
        if "paid" in o:
            cur["paid"] = o["paid"]
        if o.get("rules"):
            rules = cur.setdefault("rules", {})
            for rid, ro in o["rules"].items():
                rules[rid] = {**(rules.get(rid) or {}), **ro}
    return out


# --- validate --------------------------------------------------------------------------------------
def _num(v: Any, lo: float, hi: float, integer: bool = False) -> bool:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return False
    if integer and (isinstance(v, float) and not v.is_integer()):
        return False
    return lo <= v <= hi


def _check_target(t: Any, reg: Registry, path: str, out: list[Problem], known: frozenset[str]) -> None:
    if not isinstance(t, str) or not TARGET_RE.match(t):
        out.append(
            Problem(
                path,
                "A target looks like model:fast, model:groq/openai/gpt-oss-20b, best:code, "
                "agent:<id> or media:<id>.",
            )
        )
        return
    if t in known:  # already used by rules.yaml (e.g. model:grok, an alias that needs a key first)
        return
    kind, _, rest = t.partition(":")
    if kind == "model":
        if "/" in rest:
            provider = rest.split("/", 1)[0]
            if provider not in reg.providers:
                out.append(Problem(path, f"Unknown provider {provider!r} in {t}."))
        elif not reg.alias(rest):
            known = sorted({a.alias for a in reg.aliases})
            out.append(Problem(path, f"There is no model alias {rest!r}. Known aliases: {', '.join(known)}."))
    elif kind == "best" and rest not in CAPABILITIES:
        out.append(Problem(path, f"best:{rest} isn't a capability. Use one of: {', '.join(CAPABILITIES)}."))


def _check_chain(
    o: dict[str, Any], reg: Registry, path: str, out: list[Problem], known: frozenset[str]
) -> None:
    if "target" in o:
        _check_target(o["target"], reg, f"{path}.target", out, known)
    if "fallbacks" in o:
        fb = o["fallbacks"]
        if not isinstance(fb, list) or len(fb) > MAX_FALLBACKS:
            out.append(
                Problem(f"{path}.fallbacks", f"Fallbacks are a list of at most {MAX_FALLBACKS} targets.")
            )
        else:
            for i, t in enumerate(fb):
                _check_target(t, reg, f"{path}.fallbacks[{i}]", out, known)


def _check_numbers(o: dict[str, Any], path: str, out: list[Problem], allow: set[str]) -> None:
    rng = {
        "temperature": (0, 2, False, "Temperature is between 0 and 2."),
        "autonomy": (0, 3, True, "Autonomy is a whole number from 0 to 3."),
        "max_cost_usd": (0, 100, False, "A cost cap is between $0 and $100."),
        "daily_cap_usd": (0, 100, False, "A cost cap is between $0 and $100."),
        "max_context_tokens": (512, 1_000_000, True, "Context is a whole number between 512 and 1,000,000."),
        "max_output_tokens": (16, 200_000, True, "Output is a whole number between 16 and 200,000."),
    }
    for k, (lo, hi, integer, msg) in rng.items():
        if k in o and k in allow and o[k] is not None and not _num(o[k], lo, hi, integer):
            out.append(Problem(f"{path}.{k}", msg))


def _unknown(o: Any, allowed: set[str], path: str, out: list[Problem], what: str) -> bool:
    if not isinstance(o, dict):
        out.append(Problem(path, f"{what} must be an object."))
        return True
    for k in sorted(set(o) - allowed):
        out.append(
            Problem(f"{path}.{k}", f"{k!r} isn't a field of {what}. Allowed: {', '.join(sorted(allowed))}.")
        )
    return False


def _base_targets(base: dict[str, Any]) -> frozenset[str]:
    found: set[str] = set()
    for r in base.get("rules") or []:
        found.update([r.get("target"), *(r.get("fallbacks") or [])])
    for p in (base.get("presets") or {}).values():
        for r in ((p or {}).get("rules") or {}).values():
            found.update([r.get("target"), *(r.get("fallbacks") or [])])
    return frozenset(t for t in found if isinstance(t, str))


def validate_document(ov: Any, base: dict[str, Any], reg: Registry) -> list[Problem]:
    """Everything that can be checked on the override document itself and against the base."""
    out: list[Problem] = []
    if not isinstance(ov, dict):
        return [Problem("", "The overrides must be an object.")]
    if len(json.dumps(ov)) > MAX_BYTES:
        return [Problem("", f"The overrides are larger than {MAX_BYTES // 1000} KB.")]
    for k in sorted(set(ov) - set(TOP_KEYS)):
        out.append(Problem(k, f"{k!r} can't be overridden. Allowed: {', '.join(TOP_KEYS)}."))

    base_ids = {r["id"] for r in base.get("rules") or []}
    known = _base_targets(base)
    if "defaults" in ov and not _unknown(ov["defaults"], DEFAULT_FIELDS, "defaults", out, "the defaults"):
        _check_numbers(ov["defaults"], "defaults", out, DEFAULT_FIELDS)
        if "private" in ov["defaults"]:  # reachable only through Settings (a default, not a lock)
            out.append(Problem("defaults.private", "Use Settings → Privacy for the private default."))

    rules = ov.get("rules") or {}
    if not isinstance(rules, dict):
        out.append(Problem("rules", "Rules must be an object keyed by rule id."))
        rules = {}
    if len(base_ids | set(rules)) > MAX_RULES:
        out.append(Problem("rules", f"At most {MAX_RULES} rules."))
    for rid, o in rules.items():
        path = f"rules.{rid}"
        if not isinstance(rid, str) or not ID_RE.match(rid):
            out.append(Problem(path, "A rule id uses lowercase letters, digits, - and _ (up to 40)."))
            continue
        if _unknown(o, RULE_FIELDS | {"disabled", "before"}, path, out, "a rule"):
            continue
        if o.get("disabled") and rid in PROTECTED_RULES:
            out.append(Problem(path, f"The `{rid}` rule can't be removed."))
        if o.get("disabled"):
            continue
        is_new = rid not in base_ids
        if is_new and "target" not in o:
            out.append(Problem(f"{path}.target", "A new rule needs a target."))
        if is_new and "when" not in o:
            out.append(Problem(f"{path}.when", "A new rule needs a `when` condition."))
        if "before" in o and not is_new:
            out.append(Problem(f"{path}.before", "`before` only positions a new rule."))
        _check_chain(o, reg, path, out, known)
        _check_numbers(o, path, out, {"temperature", "autonomy", "max_cost_usd"})
        if "when" in o:
            _check_when(o["when"], f"{path}.when", out)
        if "job" in o and not isinstance(o["job"], bool):
            out.append(Problem(f"{path}.job", "`job` is true or false."))
        if rid == "private":
            _check_private(o, f"{path}", out)

    slash = ov.get("slash") or {}
    if isinstance(slash, dict):
        for cmd in slash:
            if not re.match(r"^[a-z][a-z0-9_-]{0,19}$", str(cmd)):
                out.append(Problem(f"slash.{cmd}", "A slash command is lowercase letters, digits, - and _."))
    else:
        out.append(Problem("slash", "Slash commands must be an object."))

    for name, p in (ov.get("presets") or {}).items():
        path = f"presets.{name}"
        if not PRESET_RE.match(str(name)):
            out.append(Problem(path, "A preset name uses lowercase letters, digits, - and _."))
            continue
        if _unknown(p, {"paid", "rules"}, path, out, "a preset"):
            continue
        if "paid" in p and p["paid"] not in PAID_POLICIES:
            out.append(Problem(f"{path}.paid", f"Paid policy is one of: {', '.join(PAID_POLICIES)}."))
        for rid, ro in (p.get("rules") or {}).items():
            rp = f"{path}.rules.{rid}"
            if rid == "private":
                out.append(Problem(rp, "A preset can't change the private rule."))
            elif rid not in base_ids and rid not in rules:
                out.append(Problem(rp, f"There is no rule {rid!r}."))
            elif not _unknown(ro, PRESET_RULE_FIELDS, rp, out, "a preset rule"):
                _check_chain(ro, reg, rp, out, known)
                _check_numbers(ro, rp, out, {"temperature", "autonomy", "max_cost_usd"})

    c = ov.get("classifier") or {}
    if c and not _unknown(
        c, {"timeout_s", "breaker_s", "max_chars", "routes"}, "classifier", out, "the classifier"
    ):
        base_routes = {r["name"]: r for r in (base.get("classifier") or {}).get("routes") or []}
        for name, ro in (c.get("routes") or {}).items():
            rp = f"classifier.routes.{name}"
            if _unknown(ro, {"description", "facts"}, rp, out, "a route"):
                continue
            if "description" in ro and (
                not isinstance(ro["description"], str)
                or not ro["description"].strip()
                or len(ro["description"]) > MAX_TEXT
            ):
                out.append(Problem(f"{rp}.description", f"A description is 1–{MAX_TEXT} characters."))
            if name in base_routes and "facts" in ro:
                out.append(
                    Problem(f"{rp}.facts", "Built-in routes keep their facts; edit the description instead.")
                )
            if name not in base_routes and ("facts" not in ro or "description" not in ro):
                out.append(Problem(rp, "A new route needs a description and facts."))
            if "facts" in ro:
                _check_facts(ro["facts"], f"{rp}.facts", out)
    for block, fields in (
        ("recommender", {"min_samples", "weights"}),
        ("quota", {"reroute_at", "block_at"}),
        ("summary", {"start_at", "keep_last"}),
    ):
        if block in ov:
            _unknown(ov[block], fields, block, out, f"`{block}`")
    return out


def _check_when(w: Any, path: str, out: list[Problem]) -> None:
    if not isinstance(w, dict):
        out.append(Problem(path, "`when` is an object, e.g. { intent: code, size: small }."))
        return
    for k in sorted(set(w) - WHEN_KEYS):
        out.append(Problem(f"{path}.{k}", f"{k!r} isn't a condition. Use: {', '.join(sorted(WHEN_KEYS))}."))
    if "intent" in w and w["intent"] not in INTENTS:
        out.append(Problem(f"{path}.intent", f"Intent is one of: {', '.join(sorted(INTENTS))}."))
    if "size" in w and w["size"] not in ("small", "large"):
        out.append(Problem(f"{path}.size", "Size is small or large."))
    if "quality" in w and w["quality"] not in ("normal", "high"):
        out.append(Problem(f"{path}.quality", "Quality is normal or high."))
    if "private" in w and not isinstance(w["private"], bool):
        out.append(Problem(f"{path}.private", "`private` is true or false."))


def _check_facts(f: Any, path: str, out: list[Problem]) -> None:
    if not isinstance(f, dict) or not f:
        out.append(Problem(path, "Facts are an object such as { intent: code, size: small }."))
        return
    for k in sorted(set(f) - FACT_KEYS):
        out.append(Problem(f"{path}.{k}", f"{k!r} isn't a fact. Use: {', '.join(sorted(FACT_KEYS))}."))
    if "intent" in f and f["intent"] not in INTENTS:
        out.append(Problem(f"{path}.intent", f"Intent is one of: {', '.join(sorted(INTENTS))}."))
    if "sensitive" in f and f["sensitive"] not in SENSITIVE:
        out.append(Problem(f"{path}.sensitive", f"Sensitive is one of: {', '.join(sorted(SENSITIVE))}."))


def _check_private(o: dict[str, Any], path: str, out: list[Problem]) -> None:
    """Privacy invariant: the private rule stays local-only. (The engine enforces it in code too; this
    keeps the UI from showing a rule that looks like it could send private chats away.)"""
    if "when" in o and o["when"] != {"private": True}:
        out.append(Problem(f"{path}.when", "The private rule always applies to private chats."))
    t = o.get("target")
    if t is not None:
        rest = str(t).removeprefix("model:")
        if not (str(t).startswith("model:") and (rest in LOCAL_ALIASES or rest.startswith("ollama/"))):
            out.append(
                Problem(
                    f"{path}.target",
                    "Private chats stay on this machine: use model:local, model:private, "
                    "model:local-code or model:ollama/<model>.",
                )
            )
    if o.get("fallbacks"):
        out.append(Problem(f"{path}.fallbacks", "Private chats never fall back to another model."))
    if o.get("job"):
        out.append(Problem(f"{path}.job", "Private chats can't be sent as jobs."))


def build(
    ov: dict[str, Any], base: dict[str, Any], reg: Registry
) -> tuple[dict[str, Any], rules_mod.RuleSet]:
    """Validate `ov`, merge and parse. Raises RulesInvalid with every problem found."""
    problems = validate_document(ov, base, reg)
    if problems:
        raise RulesInvalid(problems)
    merged = merge(base, ov)
    try:
        rs = rules_mod.parse(merged)
    except (ValueError, TypeError, KeyError) as e:
        raise RulesInvalid([Problem("", _plain(str(e)))]) from e
    problems = _check_result(merged, rs, reg)
    if problems:
        raise RulesInvalid(problems)
    return merged, rs


def _plain(msg: str) -> str:
    if "slash commands point at unknown rules" in msg:
        return msg.replace("rules.yaml", "the rules") + " (re-point or remove the slash command)."
    return msg


def _check_result(merged: dict[str, Any], rs: rules_mod.RuleSet, reg: Registry) -> list[Problem]:
    out: list[Problem] = []
    private = rs.get("private")
    if private is None or private.when != {"private": True}:
        out.append(Problem("rules.private", "The private rule is required."))
    for name, spec in rs.presets.items():
        for rid in spec.get("rules") or {}:
            if rs.get(rid) is None:
                out.append(
                    Problem(
                        f"presets.{name}.rules.{rid}", f"There is no rule {rid!r}; it was removed or renamed."
                    )
                )
        if spec.get("paid", "manual") not in PAID_POLICIES:
            out.append(Problem(f"presets.{name}.paid", f"Paid policy is one of: {', '.join(PAID_POLICIES)}."))
    for preset in PRESETS:
        if preset not in rs.presets:
            out.append(Problem(f"presets.{preset}", f"The {preset} preset is built in and can't be removed."))
    return out


# --- diff ------------------------------------------------------------------------------------------
def flatten(doc: Any, prefix: str = "") -> dict[str, Any]:
    """Leaf paths of an override document. Lists and empty objects are leaves, so a changed fallback
    chain shows as one change."""
    if isinstance(doc, dict) and doc:
        out: dict[str, Any] = {}
        for k, v in doc.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
        return out
    return {prefix: doc}


def diff(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    """Changes from `a` to `b`: [{path, kind: added|removed|changed, before, after}], sorted by path."""
    fa, fb = flatten(a or {}), flatten(b or {})
    fa.pop("", None)
    fb.pop("", None)
    out: list[dict[str, Any]] = []
    for path in sorted(set(fa) | set(fb)):
        if path in fa and path in fb:
            if fa[path] != fb[path]:
                out.append({"path": path, "kind": "changed", "before": fa[path], "after": fb[path]})
        elif path in fb:
            out.append({"path": path, "kind": "added", "before": None, "after": fb[path]})
        else:
            out.append({"path": path, "kind": "removed", "before": fa[path], "after": None})
    return out
