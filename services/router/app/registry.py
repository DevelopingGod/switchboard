"""Loads config/providers.yaml and config/model-tags.yaml (re-read on every call; files are small)."""

import fnmatch
import re
import urllib.parse
from dataclasses import dataclass, field, replace
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
    paid: bool = False
    # Free tier: calls are recorded at $0 (the list price is kept as `list_price_usd`). True for the
    # whole provider, or a model-id suffix (OpenRouter ":free").
    free_tier: bool | str = False
    # "credits": one-time free credits tracked against a user-entered balance (app/credits.py).
    billing: str | None = None
    # M3a generic adapter (`adapter: openai-compatible`): where the model list lives and how to read
    # it, plus extra non-secret values asked for with the key (`{name}` placeholders in the URLs).
    adapter: str | None = None
    models_url: str | None = None
    models_fields: dict[str, str] = field(default_factory=dict, compare=False)
    params: tuple[str, ...] = ()
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def is_free_tier(self, model_id: str) -> bool:
        if isinstance(self.free_tier, str):
            return model_id.endswith(self.free_tier)
        return bool(self.free_tier)

    @property
    def chat_base_url(self) -> str | None:
        """OpenAI-compatible chat endpoint base, when it differs from (or must be given to) LiteLLM."""
        return self.raw.get("chat_base_url") or (self.base_url if self.adapter else None)

    @property
    def limits(self) -> dict[str, Any]:
        return self.raw.get("limits") or {}

    def with_params(self, values: dict[str, str] | None) -> "Provider":
        """Fill `{param}` placeholders in the URLs with the values stored next to the key."""
        if not self.params:
            return self

        def fill(url: str | None) -> str | None:
            if not url:
                return url

            def sub(m: re.Match[str]) -> str:
                name = m.group(1)
                if name in self.params and (values or {}).get(name):
                    return urllib.parse.quote(str(values[name]), safe="")
                return m.group(0)

            return re.sub(r"\{(\w+)\}", sub, url)

        raw = dict(self.raw)
        if raw.get("chat_base_url"):
            raw["chat_base_url"] = fill(raw["chat_base_url"])
        elif self.adapter and self.base_url:
            raw["chat_base_url"] = fill(self.base_url)
        return replace(self, base_url=fill(self.base_url), models_url=fill(self.models_url), raw=raw)


@dataclass(frozen=True)
class AliasDeployment:
    alias: str
    provider: str
    model: str
    order: int | None = None
    timeout: int | None = None
    num_retries: int | None = None  # overrides router_settings.num_retries for this deployment
    # Dynamic alias (M3a): `pick: best-free` = the recommender chooses a model of `provider` with
    # these tags per request (never registered in LiteLLM; dispatched through `<provider>/*`).
    pick: str | None = None
    tags: tuple[str, ...] = ()

    @property
    def dynamic(self) -> bool:
        return self.pick is not None

    @property
    def key(self) -> str:
        """Stable identity of a managed LiteLLM deployment."""
        return f"{self.alias}|{self.provider}|{self.model}"


@dataclass(frozen=True)
class Registry:
    providers: dict[str, Provider]
    aliases: list[AliasDeployment]
    goals: dict[str, list[str]] = field(default_factory=dict)
    equivalent: dict[str, list[str]] = field(default_factory=dict)  # alias -> "provider/model" stand-ins

    def api_providers(self) -> list[Provider]:
        return [p for p in self.providers.values() if p.kind == "api_key"]

    def get(self, provider_id: str) -> Provider | None:
        return self.providers.get(provider_id)

    def alias(self, name: str) -> list[AliasDeployment]:
        return sorted((a for a in self.aliases if a.alias == name), key=lambda a: a.order or 0)

    def static_aliases(self) -> list[AliasDeployment]:
        """Deployments registered in LiteLLM (dynamic aliases are resolved per request instead)."""
        return [a for a in self.aliases if not a.dynamic]

    def provider_for_litellm_model(self, name: str, prefer: str | None = None) -> Provider | None:
        """`groq/openai/gpt-oss-120b` (a served deployment) -> the provider with that LiteLLM prefix.
        Several providers can share a prefix (`openai` for every OpenAI-compatible one): `prefer` (the
        provider the router asked) wins among them, otherwise the answer is ambiguous (None)."""
        prefix = name.split("/", 1)[0]
        matches = [p for p in self.providers.values() if p.litellm_prefix == prefix]
        if prefer and any(p.id == prefer for p in matches):
            return self.providers[prefer]
        return matches[0] if len(matches) == 1 else None


def _config_dir(config_dir: Path | None) -> Path:
    return config_dir or get_settings().config_dir


def load_registry(config_dir: Path | None = None) -> Registry:
    data = yaml.safe_load((_config_dir(config_dir) / "providers.yaml").read_text())
    providers: dict[str, Provider] = {}
    for pid, p in (data.get("providers") or {}).items():
        base_url = p.get("base_url")
        if p.get("base_url_env") == "OLLAMA_API_BASE":
            base_url = get_settings().ollama_api_base
        adapter = p.get("adapter")
        if adapter not in (None, "openai-compatible"):
            raise ValueError(f"provider {pid}: unknown adapter {adapter!r}")
        generic = adapter == "openai-compatible"
        if generic and (p.get("kind", "api_key") != "api_key" or not base_url):
            raise ValueError(f"provider {pid}: an openai-compatible adapter needs kind api_key and base_url")
        providers[pid] = Provider(
            id=pid,
            kind=p.get("kind", "api_key") if generic else p["kind"],
            name=p.get("name", pid),
            privacy=p.get("privacy", "varies"),
            base_url=base_url,
            catalog=p.get("catalog") or ("openai" if generic else None),
            litellm_prefix=p.get("litellm_prefix") or ("openai" if generic else None),
            env_key=p.get("env_key"),
            free_limits=p.get("free_limits"),
            notes=p.get("notes"),
            bin=p.get("bin"),
            login_hint=p.get("login_hint"),
            paid=bool(p.get("paid", False)),
            free_tier=p.get("free_tier", False),
            billing=p.get("billing"),
            adapter=adapter,
            models_url=p.get("models_url"),
            models_fields={str(k): str(v) for k, v in (p.get("models_fields") or {}).items()},
            params=tuple(str(x) for x in p.get("params") or ()),
            raw=p,
        )
    aliases = []
    for alias, deployments in (data.get("aliases") or {}).items():
        for d in deployments:
            pick = d.get("pick")
            if pick not in (None, "best-free", "best"):
                raise ValueError(f"alias {alias}: unknown pick {pick!r} (best-free | best)")
            if pick is None and not d.get("model"):
                raise ValueError(f"alias {alias}: each deployment needs `model` or `pick`")
            aliases.append(
                AliasDeployment(
                    alias=alias,
                    provider=d["provider"],
                    model=str(d.get("model") or ""),
                    order=d.get("order"),
                    timeout=d.get("timeout"),
                    num_retries=d.get("num_retries"),
                    pick=pick,
                    tags=tuple(d.get("tags") or ("chat",)),
                )
            )
    unknown = {a.provider for a in aliases} - providers.keys()
    if unknown:
        raise ValueError(f"aliases reference unknown providers: {sorted(unknown)}")
    goals = {g: list(ids) for g, ids in (data.get("goals") or {}).items()}
    bad = {pid for ids in goals.values() for pid in ids} - providers.keys()
    if bad:
        raise ValueError(f"goals reference unknown providers: {sorted(bad)}")
    equivalent = {str(a): [str(x) for x in v or []] for a, v in (data.get("equivalent") or {}).items()}
    for name, targets in equivalent.items():
        for t in targets:
            if t.split("/", 1)[0] not in providers or "/" not in t:
                raise ValueError(f"equivalent.{name}: {t!r} must be <provider>/<model id>")
    from app import local_profile  # late import: local_profile reads config but not the registry

    aliases = local_profile.apply(aliases)
    return Registry(providers=providers, aliases=aliases, goals=goals, equivalent=equivalent)


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
