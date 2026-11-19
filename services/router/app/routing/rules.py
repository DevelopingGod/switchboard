"""config/rules.yaml: defaults, rules, slash commands and presets (SPEC §7.2, §8b, §8d).

Re-read when the file's mtime changes. A preset overlays individual rules (target/fallbacks/...)
and sets the paid policy; the active preset is the one the wizard saved (system_meta `onboarding`).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

import yaml

from app.config import get_settings

PaidPolicy = Literal["never", "manual", "allowed"]
PRESETS = ("free", "balanced", "best")
DEFAULT_PRESET = "balanced"
WHEN_KEYS = {"private", "intent", "size", "quality", "command"}
FACT_KEYS = {"intent", "size", "quality", "sensitive"}
INTENTS = {"chat", "code", "research", "writing", "image", "video", "audio"}
SENSITIVE = {"health", "finance", "legal", "personal"}


@dataclass(frozen=True)
class Defaults:
    temperature: float = 0.4
    autonomy: int = 1
    max_cost_usd: float = 0.50
    daily_cap_usd: float = 1.00
    max_context_tokens: int = 8000
    max_output_tokens: int = 4096
    private: bool = False


@dataclass(frozen=True)
class Rule:
    id: str
    when: dict[str, Any]
    target: str
    fallbacks: tuple[str, ...] = ()
    temperature: float | None = None
    autonomy: int | None = None
    max_cost_usd: float | None = None
    job: bool = False

    @property
    def chain(self) -> list[str]:
        return [self.target, *self.fallbacks]


@dataclass(frozen=True)
class Route:
    """One Arch-Router route: what the classifier reads, and the facts it maps to."""

    name: str
    description: str
    facts: dict[str, Any]


@dataclass(frozen=True)
class ClassifierCfg:
    timeout_s: float = 1.5
    breaker_s: float = 60
    max_chars: int = 2000
    routes: tuple[Route, ...] = ()

    def route(self, name: str) -> Route | None:
        return next((r for r in self.routes if r.name == name), None)


DEFAULT_WEIGHTS = {
    "capability": 0.25,
    "feedback": 0.15,
    "latency": 0.15,
    "success": 0.15,
    "headroom": 0.10,
    "cost": 0.10,
    "privacy": 0.10,
}


@dataclass(frozen=True)
class RecommenderCfg:
    min_samples: int = 5
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))


@dataclass(frozen=True)
class QuotaCfg:
    reroute_at: float = 0.8
    block_at: float = 1.0


@dataclass(frozen=True)
class SummaryCfg:
    start_at: float = 0.75
    keep_last: int = 6


@dataclass(frozen=True)
class RuleSet:
    defaults: Defaults
    rules: tuple[Rule, ...]
    slash: dict[str, str]
    preset: str
    paid: PaidPolicy
    presets: dict[str, dict[str, Any]] = field(default_factory=dict, compare=False)
    classifier: ClassifierCfg = field(default_factory=ClassifierCfg)
    recommender: RecommenderCfg = field(default_factory=RecommenderCfg)
    quota: QuotaCfg = field(default_factory=QuotaCfg)
    summary: SummaryCfg = field(default_factory=SummaryCfg)

    def get(self, rule_id: str) -> Rule | None:
        return next((r for r in self.rules if r.id == rule_id), None)

    def with_preset(self, preset: str | None) -> RuleSet:
        """Overlay a preset's rule overrides and paid policy (unknown/None -> balanced)."""
        name = preset if preset in self.presets else DEFAULT_PRESET
        spec = self.presets.get(name) or {}
        overrides = spec.get("rules") or {}
        rules = tuple(_overlay(r, overrides[r.id]) if r.id in overrides else r for r in self.rules)
        return replace(self, rules=rules, preset=name, paid=spec.get("paid", "manual"))

    def with_settings(self, s: dict[str, Any]) -> RuleSet:
        """Owner overrides from the Settings page (app/user_settings.py). A per-request cap also
        lowers any rule cap above it: the stricter limit always wins."""
        d = self.defaults
        cap = s.get("max_cost_usd")
        defaults = replace(
            d,
            max_cost_usd=cap if cap is not None else d.max_cost_usd,
            daily_cap_usd=s.get("daily_cap_usd", d.daily_cap_usd),
        )
        rules = self.rules
        if cap is not None:
            rules = tuple(
                replace(r, max_cost_usd=min(r.max_cost_usd, cap)) if r.max_cost_usd is not None else r
                for r in rules
            )
        return replace(self, defaults=defaults, rules=rules)


def _overlay(rule: Rule, o: dict[str, Any]) -> Rule:
    return replace(
        rule,
        target=o.get("target", rule.target),
        fallbacks=tuple(o.get("fallbacks", rule.fallbacks)),
        temperature=o.get("temperature", rule.temperature),
        autonomy=o.get("autonomy", rule.autonomy),
        max_cost_usd=o.get("max_cost_usd", rule.max_cost_usd),
    )


def parse(data: dict[str, Any]) -> RuleSet:
    d = data.get("defaults") or {}
    defaults = Defaults(**{k: d[k] for k in Defaults.__dataclass_fields__ if k in d})
    rules: list[Rule] = []
    for r in data.get("rules") or []:
        when = dict(r.get("when") or {})
        bad = set(when) - WHEN_KEYS
        if bad:
            raise ValueError(f"rule {r.get('id')}: unknown `when` keys {sorted(bad)}")
        rules.append(
            Rule(
                id=str(r["id"]),
                when=when,
                target=str(r["target"]),
                fallbacks=tuple(str(f) for f in r.get("fallbacks") or ()),
                temperature=r.get("temperature"),
                autonomy=r.get("autonomy"),
                max_cost_usd=r.get("max_cost_usd"),
                job=bool(r.get("job", False)),
            )
        )
    ids = [r.id for r in rules]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate rule ids in rules.yaml")
    if "default" not in ids:
        raise ValueError("rules.yaml needs a rule with id `default`")
    slash = {str(k): str(v) for k, v in (data.get("slash") or {}).items()}
    missing = set(slash.values()) - set(ids)
    if missing:
        raise ValueError(f"slash commands point at unknown rules: {sorted(missing)}")
    presets = {str(k): dict(v or {}) for k, v in (data.get("presets") or {}).items()}
    base = RuleSet(
        defaults=defaults,
        rules=tuple(rules),
        slash=slash,
        preset="",
        paid="manual",
        presets=presets,
        classifier=_classifier(data.get("classifier") or {}),
        recommender=_recommender(data.get("recommender") or {}),
        quota=_quota(data.get("quota") or {}),
        summary=_summary(data.get("summary") or {}),
    )
    return base.with_preset(DEFAULT_PRESET)


def _classifier(c: dict[str, Any]) -> ClassifierCfg:
    routes: list[Route] = []
    for r in c.get("routes") or []:
        name, facts = str(r["name"]), dict(r.get("facts") or {})
        if not name.replace("_", "").isalnum() or name == "other":
            raise ValueError(f"classifier route name {name!r}: letters, digits and _ only (not `other`)")
        if bad := set(facts) - FACT_KEYS:
            raise ValueError(f"classifier route {name}: unknown facts {sorted(bad)}")
        if "intent" in facts and facts["intent"] not in INTENTS:
            raise ValueError(f"classifier route {name}: unknown intent {facts['intent']!r}")
        if "sensitive" in facts and facts["sensitive"] not in SENSITIVE:
            raise ValueError(f"classifier route {name}: sensitive must be one of {sorted(SENSITIVE)}")
        if not facts:
            raise ValueError(f"classifier route {name}: needs facts")
        routes.append(Route(name, " ".join(str(r.get("description") or "").split()), facts))
    if len({r.name for r in routes}) != len(routes):
        raise ValueError("duplicate classifier route names")
    timeout = float(c.get("timeout_s", 1.5))
    if not 0.1 <= timeout <= 30:
        raise ValueError("classifier.timeout_s must be between 0.1 and 30")
    return ClassifierCfg(
        timeout_s=timeout,
        breaker_s=float(c.get("breaker_s", 60)),
        max_chars=int(c.get("max_chars", 2000)),
        routes=tuple(routes),
    )


def _recommender(c: dict[str, Any]) -> RecommenderCfg:
    weights = {**DEFAULT_WEIGHTS, **{str(k): float(v) for k, v in (c.get("weights") or {}).items()}}
    if bad := set(weights) - set(DEFAULT_WEIGHTS):
        raise ValueError(f"recommender.weights: unknown terms {sorted(bad)}")
    if any(w < 0 for w in weights.values()) or sum(weights.values()) <= 0:
        raise ValueError("recommender.weights must be >= 0 and not all 0")
    return RecommenderCfg(min_samples=int(c.get("min_samples", 5)), weights=weights)


def _quota(c: dict[str, Any]) -> QuotaCfg:
    q = QuotaCfg(reroute_at=float(c.get("reroute_at", 0.8)), block_at=float(c.get("block_at", 1.0)))
    if not 0 < q.reroute_at <= q.block_at <= 1.5:
        raise ValueError("quota: need 0 < reroute_at <= block_at")
    return q


def _summary(c: dict[str, Any]) -> SummaryCfg:
    s = SummaryCfg(start_at=float(c.get("start_at", 0.75)), keep_last=int(c.get("keep_last", 6)))
    if not 0.2 <= s.start_at <= 1 or s.keep_last < 2:
        raise ValueError("summary: start_at between 0.2 and 1, keep_last >= 2")
    return s


_cache: dict[Path, tuple[float, RuleSet]] = {}
_raw_cache: dict[Path, tuple[float, dict[str, Any]]] = {}


def load_raw(config_dir: Path | None = None) -> dict[str, Any]:
    """rules.yaml as a plain dict (the base the Rules UI's overrides are merged onto). Treat as
    read-only: callers that change it must deepcopy."""
    path = (config_dir or get_settings().config_dir) / "rules.yaml"
    mtime = path.stat().st_mtime
    hit = _raw_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    data = yaml.safe_load(path.read_text()) or {}
    _raw_cache[path] = (mtime, data)
    return data


def load_rules(config_dir: Path | None = None) -> RuleSet:
    path = (config_dir or get_settings().config_dir) / "rules.yaml"
    mtime = path.stat().st_mtime
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    rs = parse(yaml.safe_load(path.read_text()) or {})
    _cache[path] = (mtime, rs)
    return rs
