"""Make LiteLLM's DB match config/providers.yaml `aliases:` + the stored keys.

LiteLLM's DB is the single source of truth for routable models, and the router is its only writer
(docs/m1a.md). Only deployments tagged model_info.managed_by=switchboard are touched; anything added
by hand in the LiteLLM UI is left alone. Idempotent: a no-op when nothing changed.
"""

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app import credits, secrets
from app.litellm_admin import LiteLLMAdmin, credential_name, spec_hash
from app.registry import AliasDeployment, Provider, Registry, load_registry

log = logging.getLogger("app.reconcile")


def deployment_spec(d: AliasDeployment, registry: Registry) -> tuple[dict[str, Any], dict[str, Any]]:
    p = registry.providers[d.provider]
    params: dict[str, Any] = {"model": f"{p.litellm_prefix}/{d.model}"}
    if p.kind == "local":
        params["api_base"] = "os.environ/OLLAMA_API_BASE"
    else:
        params["litellm_credential_name"] = credential_name(p.id)
    if d.timeout:
        params["timeout"] = d.timeout
        params["stream_timeout"] = d.timeout
    if d.num_retries is not None:
        params["num_retries"] = d.num_retries
    if d.order:
        params["order"] = d.order
    info = {"sb_key": d.key, "provider": p.id, "privacy": p.privacy}
    return params, info


WILDCARD_TIMEOUT = {"local": 300, "api_key": 60}


def wildcard_spec(p: Provider) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
    """One `<provider>/*` deployment per connected provider, so a rule or a manual pick can name any
    catalog model (`model:groq/openai/gpt-oss-20b`). Verified on v1.108.8: LiteLLM's pattern router
    maps `<provider>/<model>` to `<litellm_prefix>/<model>` with the provider's stored credential."""
    name = f"{p.id}/*"
    params: dict[str, Any] = {"model": f"{p.litellm_prefix}/*"}
    if p.kind == "local":
        params["api_base"] = "os.environ/OLLAMA_API_BASE"
    else:
        params["litellm_credential_name"] = credential_name(p.id)
    params["timeout"] = params["stream_timeout"] = WILDCARD_TIMEOUT[p.kind]
    key = f"*|{p.id}|*"
    return key, name, params, {"sb_key": key, "provider": p.id, "privacy": p.privacy}


def credential_values(registry: Registry, provider: str, key: str) -> dict[str, str]:
    p = registry.providers[provider]
    values = {"api_key": key}
    if p.raw.get("chat_base_url"):
        values["api_base"] = p.raw["chat_base_url"]
    return values


async def reconcile(
    session: AsyncSession, admin: LiteLLMAdmin, registry: Registry | None = None
) -> dict[str, list[str]]:
    registry = registry or load_registry()
    keys: dict[str, str] = {}
    for p in registry.api_providers():
        k = await secrets.load_key(session, p.id)
        if k:
            keys[p.id] = k

    # 1. Credentials: one per keyed provider; drop ours for providers whose key was removed.
    for pid, k in keys.items():
        await admin.upsert_credential(pid, credential_values(registry, pid, k))
    ours = {credential_name(p.id): p.id for p in registry.api_providers()}
    for name in await admin.credential_names():
        if name in ours and ours[name] not in keys:
            await admin.delete_credential(ours[name])

    # 2. Deployments. Credit providers whose balance is used up get none (LiteLLM can't pick them).
    used_up = set(await credits.exhausted(session, registry))
    desired: dict[str, tuple[str, dict[str, Any], dict[str, Any]]] = {}
    for d in registry.aliases:
        p = registry.providers[d.provider]
        if (p.kind == "api_key" and d.provider not in keys) or d.provider in used_up:
            continue
        params, info = deployment_spec(d, registry)
        info["sb_hash"] = spec_hash(d.alias, params, info)
        desired[d.key] = (d.alias, params, info)
    for p in registry.providers.values():
        if p.kind == "local" or (p.kind == "api_key" and p.id in keys and p.id not in used_up):
            key, name, params, info = wildcard_spec(p)
            info["sb_hash"] = spec_hash(name, params, info)
            desired[key] = (name, params, info)

    result: dict[str, list[str]] = {"added": [], "removed": [], "kept": []}
    seen: set[str] = set()
    for dep in await admin.managed_deployments():
        info = dep.get("model_info", {})
        k, model_id = info.get("sb_key"), info.get("id")
        want = desired.get(k) if k else None
        if want is None or k in seen or info.get("sb_hash") != want[2]["sb_hash"]:
            await admin.delete_model(model_id)
            result["removed"].append(f"{dep.get('model_name')} ({k})")
        else:
            seen.add(k)
            result["kept"].append(k)
    for k, (alias, params, info) in desired.items():
        if k not in seen:
            await admin.add_model(alias, params, info)
            result["added"].append(k)
    if result["added"] or result["removed"]:
        log.info("reconcile: +%d -%d", len(result["added"]), len(result["removed"]))
    return result
