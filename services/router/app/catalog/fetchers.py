"""Live model-list fetchers, one per provider API shape (SPEC §6.4).

Provider APIs are called directly (not through LiteLLM): their /models responses carry context
window, output limit, modalities, prices and deprecation, which LiteLLM's listing drops.
Keys go in headers only — never in URLs (they would end up in access logs).
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.registry import Provider

TIMEOUT = httpx.Timeout(20, connect=5)


class FetchError(RuntimeError):
    pass


@dataclass
class FetchedModel:
    model_id: str
    display_name: str | None = None
    context: int | None = None
    max_output: int | None = None
    prices: dict[str, Any] = field(default_factory=dict)
    free: bool = False
    input_modalities: list[str] = field(default_factory=list)
    output_modalities: list[str] = field(default_factory=list)
    deprecated: bool = False
    meta: dict[str, Any] = field(default_factory=dict)


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _per_million(prompt: Any, completion: Any) -> dict[str, float]:
    """Per-token USD strings -> per-1M-token floats."""
    out: dict[str, float] = {}
    for k, v in (("input_per_1m", prompt), ("output_per_1m", completion)):
        f = _float(v)
        if f is not None:
            out[k] = round(f * 1_000_000, 6)
    return out


def _modality(kind: str) -> str:
    """Normalise 'image/png' and friends to 'image'."""
    return kind.split("/", 1)[0]


async def _get(client: httpx.AsyncClient, url: str, headers: dict[str, str], **kw: Any) -> Any:
    try:
        r = await client.get(url, headers=headers, timeout=TIMEOUT, **kw)
    except httpx.HTTPError as e:
        raise FetchError(f"{type(e).__name__} contacting {httpx.URL(url).host}") from e
    if r.status_code in (401, 403):
        raise FetchError(f"HTTP {r.status_code}: key rejected")
    if r.status_code >= 400:
        raise FetchError(f"HTTP {r.status_code}: {r.text[:200]}")
    return r.json()


def _dig(obj: Any, path: str | None) -> Any:
    """`limits.max_input_tokens` -> obj["limits"]["max_input_tokens"] (None when absent)."""
    if not path:
        return None
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def _model_list(data: Any) -> list[dict[str, Any]]:
    """OpenAI-style `{data: [...]}`, `{models: [...]}`, or a bare array."""
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("data") if isinstance(data.get("data"), list) else data.get("models") or []
    else:
        items = []
    return [m for m in items if isinstance(m, dict)]


def _modalities(v: Any) -> list[str]:
    return sorted({_modality(str(x)) for x in v}) if isinstance(v, list) and v else []


async def fetch_openai(client: httpx.AsyncClient, p: Provider, key: str | None) -> list[FetchedModel]:
    """OpenAI-compatible model list (Groq, Cerebras, Mistral, and any `adapter: openai-compatible`
    provider). `models_url` and `models_fields` in providers.yaml cover lists that live elsewhere or
    name their fields differently."""
    url = p.models_url or f"{p.base_url}/models"
    data = await _get(client, url, {"Authorization": f"Bearer {key}"})
    f = p.models_fields
    out = []
    for m in _model_list(data):
        mid = _dig(m, f.get("id")) if f.get("id") else m.get("id")
        if not mid:
            continue
        caps = m.get("capabilities") if isinstance(m.get("capabilities"), dict) else {}
        inputs = _modalities(_dig(m, f.get("input_modalities"))) or list(
            m.get("input_modalities") or m.get("supported_input_modalities") or ["text"]
        )
        if caps.get("vision") and "image" not in inputs:
            inputs.append("image")
        outputs = _modalities(_dig(m, f.get("output_modalities"))) or list(
            m.get("output_modalities") or m.get("supported_output_modalities") or ["text"]
        )
        pricing = m.get("pricing") if isinstance(m.get("pricing"), dict) else {}
        context = _dig(m, f.get("context")) if f.get("context") else None
        context = context or (
            m.get("context_window")
            or m.get("context_length")
            or m.get("max_context_length")
            or _dig(m, "limits.max_input_tokens")
        )
        max_out = _dig(m, f.get("max_output")) if f.get("max_output") else None
        max_out = max_out or (
            m.get("max_completion_tokens")
            or m.get("max_output_length")
            or _dig(m, "limits.max_output_tokens")
        )
        out.append(
            FetchedModel(
                model_id=str(mid),
                display_name=(_dig(m, f.get("name")) if f.get("name") else None) or m.get("name") or str(mid),
                context=_int(context),
                max_output=_int(max_out),
                prices=_per_million(pricing.get("prompt"), pricing.get("completion")),
                free=p.is_free_tier(str(mid)) if p.free_tier else not p.paid,
                input_modalities=inputs,
                output_modalities=outputs,
                deprecated=m.get("active") is False or bool(m.get("deprecation")),
                meta={k: m[k] for k in ("owned_by", "supported_features", "deprecation") if m.get(k)},
            )
        )
    return out


async def fetch_gemini(client: httpx.AsyncClient, p: Provider, key: str | None) -> list[FetchedModel]:
    out: list[FetchedModel] = []
    params: dict[str, Any] = {"pageSize": 1000}
    for _ in range(10):  # pagination guard
        data = await _get(client, f"{p.base_url}/models", {"x-goog-api-key": key or ""}, params=params)
        for m in data.get("models", []):
            mid = m["name"].removeprefix("models/")
            methods = m.get("supportedGenerationMethods") or []
            out.append(
                FetchedModel(
                    model_id=mid,
                    display_name=m.get("displayName"),
                    context=_int(m.get("inputTokenLimit")),
                    max_output=_int(m.get("outputTokenLimit")),
                    free=True,
                    input_modalities=["text"],
                    output_modalities=["text"] if "generateContent" in methods else [],
                    deprecated="deprecated" in (m.get("description") or "").lower(),
                    meta={"methods": methods, "version": m.get("version")},
                )
            )
        token = data.get("nextPageToken")
        if not token:
            break
        params["pageToken"] = token
    return out


async def fetch_openrouter(client: httpx.AsyncClient, p: Provider, key: str | None) -> list[FetchedModel]:
    data = await _get(client, f"{p.base_url}/models", {"Authorization": f"Bearer {key}"})
    out = []
    for m in data.get("data", []):
        pricing = m.get("pricing") or {}
        prices = _per_million(pricing.get("prompt"), pricing.get("completion"))
        arch = m.get("architecture") or {}
        top = m.get("top_provider") or {}
        out.append(
            FetchedModel(
                model_id=m["id"],
                display_name=m.get("name"),
                context=_int(m.get("context_length")),
                max_output=_int(top.get("max_completion_tokens")),
                prices=prices,
                free=m["id"].endswith(":free") or (bool(prices) and not any(prices.values())),
                input_modalities=list(arch.get("input_modalities") or ["text"]),
                output_modalities=list(arch.get("output_modalities") or ["text"]),
                deprecated=bool(m.get("expiration_date")),
                meta={k: m[k] for k in ("expiration_date", "supported_parameters") if m.get(k)},
            )
        )
    return out


async def fetch_zen(client: httpx.AsyncClient, p: Provider, key: str | None) -> list[FetchedModel]:
    data = await _get(client, f"{p.base_url}/models", {"Authorization": f"Bearer {key}"})
    out = []
    for m in data.get("data", []):
        text_cost = (m.get("cost") or {}).get("text") or {}
        cin = _float((text_cost.get("input") or {}).get("price"))
        cout = _float((text_cost.get("output") or {}).get("price"))
        limit = m.get("limit") or {}
        mods = m.get("modalities") or {}
        caps = m.get("capabilities") or {}
        out.append(
            FetchedModel(
                model_id=m["id"],
                display_name=m.get("name"),
                context=_int(limit.get("context")),
                max_output=_int(limit.get("output")),
                prices={k: v for k, v in (("input_per_1m", cin), ("output_per_1m", cout)) if v is not None},
                free=cin == 0 and cout == 0,
                input_modalities=sorted({_modality(x) for x in mods.get("input") or ["text"]}),
                output_modalities=sorted({_modality(x) for x in mods.get("output") or ["text"]}),
                meta={
                    "type": m.get("type"),
                    "family": m.get("family"),
                    "reasoning": bool((caps.get("reasoning") or {}).get("supported")),
                    "tools": bool((caps.get("tools") or {}).get("supported")),
                },
            )
        )
    return out


async def _ollama_caps(client: httpx.AsyncClient, base: str, name: str) -> list[str] | None:
    """What a local model can do, from Ollama's /api/show `capabilities` (e.g. completion, vision, tools,
    thinking). None when Ollama doesn't say (older versions) or the call fails: the catalog then keeps the
    curated tags only."""
    try:
        r = await client.post(f"{base}/api/show", json={"model": name}, timeout=5)
        if r.status_code != 200:
            return None
        caps = r.json().get("capabilities")
        return [str(c) for c in caps] if isinstance(caps, list) else None
    except (httpx.HTTPError, ValueError):
        return None


async def fetch_ollama(client: httpx.AsyncClient, p: Provider, key: str | None) -> list[FetchedModel]:
    data = await _get(client, f"{p.base_url}/api/tags", {})
    models = data.get("models", [])[:200]
    # M2.5: capabilities, so a local model that can read images is tagged `vision` without a code change.
    sem = asyncio.Semaphore(4)

    async def caps(name: str) -> list[str] | None:
        async with sem:
            return await _ollama_caps(client, p.base_url, name)

    all_caps = await asyncio.gather(*(caps(m["name"]) for m in models))
    out = []
    for m, c in zip(models, all_caps, strict=True):
        d = m.get("details") or {}
        inputs, outputs = [], []
        if c is not None:
            inputs = ["text", *(["image"] if "vision" in c else [])]
            outputs = ["text"] if "completion" in c else []
        out.append(
            FetchedModel(
                model_id=m["name"],
                display_name=m["name"],
                free=True,
                input_modalities=inputs,
                output_modalities=outputs,
                meta={
                    **{k: d[k] for k in ("family", "parameter_size", "quantization_level") if d.get(k)},
                    **({"capabilities": c} if c is not None else {}),
                },
            )
        )
    return out


FETCHERS = {
    "openai": fetch_openai,
    "gemini": fetch_gemini,
    "openrouter": fetch_openrouter,
    "zen": fetch_zen,
    "ollama": fetch_ollama,
}


async def fetch(client: httpx.AsyncClient, p: Provider, key: str | None) -> list[FetchedModel]:
    if p.catalog not in FETCHERS:
        raise FetchError(f"no catalog fetcher for {p.id}")
    return await FETCHERS[p.catalog](client, p, key)
