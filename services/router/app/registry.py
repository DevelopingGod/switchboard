"""Loads config/providers.yaml and config/model-tags.yaml (re-read on every call; files are small)."""

import fnmatch
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from app.config import get_settings


@dataclass(frozen=True)
class Provider:
    id: str
    kind: str  # cli | api_key | local
    name: str
    privacy: str
    base_url: str | None = None
    catalog: str | None = None
    litellm_prefix: str | None = None
    env_key: str | None = None
    free_limits: str | None = None
    notes: str | None = None
    bin: str | None = None
    login_hint: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class AliasDeployment:
    alias: str
    provider: str
    model: str
    order: int | None = None
    timeout: int | None = None

    @property
    def key(self) -> str:
        """Stable identity of a managed LiteLLM deployment."""
        return f"{self.alias}|{self.provider}|{self.model}"


@dataclass(frozen=True)
class Registry:
    providers: dict[str, Provider]
    aliases: list[AliasDeployment]

    def api_providers(self) -> list[Provider]:
        return [p for p in self.providers.values() if p.kind == "api_key"]

    def get(self, provider_id: str) -> Provider | None:
        return self.providers.get(provider_id)


def _config_dir(config_dir: Path | None) -> Path:
    return config_dir or get_settings().config_dir


def load_registry(config_dir: Path | None = None) -> Registry:
    data = yaml.safe_load((_config_dir(config_dir) / "providers.yaml").read_text())
    providers: dict[str, Provider] = {}
    for pid, p in (data.get("providers") or {}).items():
        base_url = p.get("base_url")
        if p.get("base_url_env") == "OLLAMA_API_BASE":
            base_url = get_settings().ollama_api_base
        providers[pid] = Provider(
            id=pid,
            kind=p["kind"],
            name=p.get("name", pid),
            privacy=p.get("privacy", "varies"),
            base_url=base_url,
            catalog=p.get("catalog"),
            litellm_prefix=p.get("litellm_prefix"),
            env_key=p.get("env_key"),
            free_limits=p.get("free_limits"),
            notes=p.get("notes"),
            bin=p.get("bin"),
            login_hint=p.get("login_hint"),
            raw=p,
        )
    aliases = [
        AliasDeployment(
            alias=alias,
            provider=d["provider"],
            model=str(d["model"]),
            order=d.get("order"),
            timeout=d.get("timeout"),
        )
        for alias, deployments in (data.get("aliases") or {}).items()
        for d in deployments
    ]
    unknown = {a.provider for a in aliases} - providers.keys()
    if unknown:
        raise ValueError(f"aliases reference unknown providers: {sorted(unknown)}")
    return Registry(providers=providers, aliases=aliases)


@dataclass(frozen=True)
class TagRules:
    rules: list[dict[str, Any]]
    deprecated: frozenset[str]

    def curated(self, provider: str, model_id: str) -> list[str] | None:
        """Tags from matching rules, in first-seen order; None if no rule matched."""
        tags: list[str] = []
        matched = False
        mid = model_id.lower()
        for rule in self.rules:
            if rule.get("provider") not in (None, provider):
                continue
            if fnmatch.fnmatchcase(mid, str(rule["match"]).lower()):
                matched = True
                tags += [t for t in rule.get("tags", []) if t not in tags]
        return tags if matched else None


def load_tag_rules(config_dir: Path | None = None) -> TagRules:
    data = yaml.safe_load((_config_dir(config_dir) / "model-tags.yaml").read_text()) or {}
    return TagRules(rules=data.get("rules") or [], deprecated=frozenset(data.get("deprecated") or []))
