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
class RuleSet:
    defaults: Defaults
    rules: tuple[Rule, ...]
    slash: dict[str, str]
    preset: str
    paid: PaidPolicy
    presets: dict[str, dict[str, Any]] = field(default_factory=dict, compare=False)

    def get(self, rule_id: str) -> Rule | None:
        return next((r for r in self.rules if r.id == rule_id), None)

    def with_preset(self, preset: str | None) -> RuleSet:
        """Overlay a preset's rule overrides and paid policy (unknown/None -> balanced)."""
        name = preset if preset in self.presets else DEFAULT_PRESET
        spec = self.presets.get(name) or {}
        overrides = spec.get("rules") or {}
        rules = tuple(_overlay(r, overrides[r.id]) if r.id in overrides else r for r in self.rules)
        return replace(self, rules=rules, preset=name, paid=spec.get("paid", "manual"))


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
        defaults=defaults, rules=tuple(rules), slash=slash, preset="", paid="manual", presets=presets
    )
    return base.with_preset(DEFAULT_PRESET)


_cache: dict[Path, tuple[float, RuleSet]] = {}


def load_rules(config_dir: Path | None = None) -> RuleSet:
    path = (config_dir or get_settings().config_dir) / "rules.yaml"
    mtime = path.stat().st_mtime
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    rs = parse(yaml.safe_load(path.read_text()) or {})
    _cache[path] = (mtime, rs)
    return rs
