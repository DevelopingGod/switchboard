"""Thin adapter over the LiteLLM proxy admin API (pinned v1.108.8; SPEC §8f "thin adapter").

Verified endpoints on v1.108.8: POST/PATCH/DELETE /credentials, POST /model/new, POST /model/delete,
GET /model/info, GET /health/liveliness, POST /v1/chat/completions.
"""

import hashlib
import json
from typing import Any

import httpx

from app.config import get_settings

MANAGED_BY = "switchboard"


def credential_name(provider: str) -> str:
    return f"sb-{provider}"


class LiteLLMError(RuntimeError):
    pass


class LiteLLMAdmin:
    def __init__(self, client: httpx.AsyncClient | None = None):
        s = get_settings()
        self._client = client or httpx.AsyncClient(
            base_url=s.litellm_url,
            headers={"Authorization": f"Bearer {s.litellm_master_key.get_secret_value()}"},
            timeout=30,
        )

    @property
    def client(self) -> httpx.AsyncClient:
        """The authenticated client (base URL = LiteLLM), used for streaming chat."""
        return self._client

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _req(self, method: str, path: str, **kw: Any) -> Any:
        r = await self._client.request(method, path, **kw)
        if r.status_code >= 400:
            # Never echo request bodies (they may contain keys); the response is safe to keep short.
            raise LiteLLMError(f"LiteLLM {method} {path} -> {r.status_code}: {r.text[:200]}")
        return r.json() if r.content else None

    async def alive(self) -> bool:
        try:
            r = await self._client.get("/health/liveliness", timeout=3)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    # --- credentials ---
    async def upsert_credential(self, provider: str, values: dict[str, str]) -> None:
        name = credential_name(provider)
        body = {"credential_name": name, "credential_info": {"managed_by": MANAGED_BY}}
        r = await self._client.post("/credentials", json={**body, "credential_values": values})
        if r.status_code == 409 or (r.status_code >= 400 and "already exists" in r.text):
            await self._req("PATCH", f"/credentials/{name}", json={**body, "credential_values": values})
        elif r.status_code >= 400:
            raise LiteLLMError(f"LiteLLM POST /credentials -> {r.status_code}: {r.text[:200]}")

    async def delete_credential(self, provider: str) -> None:
        r = await self._client.delete(f"/credentials/{credential_name(provider)}")
        if r.status_code >= 400 and r.status_code != 404 and "not found" not in r.text.lower():
            raise LiteLLMError(f"LiteLLM DELETE /credentials -> {r.status_code}: {r.text[:200]}")

    async def credential_names(self) -> set[str]:
        data = await self._req("GET", "/credentials")
        return {c["credential_name"] for c in data.get("credentials", [])}

    # --- deployments ---
    async def model_info(self) -> list[dict[str, Any]]:
        return (await self._req("GET", "/model/info")).get("data", [])

    async def managed_deployments(self) -> list[dict[str, Any]]:
        return [m for m in await self.model_info() if m.get("model_info", {}).get("managed_by") == MANAGED_BY]

    async def add_model(self, model_name: str, litellm_params: dict[str, Any], model_info: dict[str, Any]):
        info = {**model_info, "managed_by": MANAGED_BY}
        body = {"model_name": model_name, "litellm_params": litellm_params, "model_info": info}
        return await self._req("POST", "/model/new", json=body)

    async def delete_model(self, model_id: str) -> None:
        await self._req("POST", "/model/delete", json={"id": model_id})

    async def chat(self, model: str, timeout: float = 60) -> str | None:
        """1-token call through LiteLLM; returns the deployment that served it (header), not the alias."""
        body = {"model": model, "max_tokens": 16, "messages": [{"role": "user", "content": "Reply: pong"}]}
        r = await self._client.post("/v1/chat/completions", json=body, timeout=timeout)
        if r.status_code >= 400:
            raise LiteLLMError(f"LiteLLM chat {model} -> {r.status_code}: {r.text[:200]}")
        return r.headers.get("x-litellm-model-name") or r.json().get("model")


def spec_hash(model_name: str, litellm_params: dict[str, Any], model_info: dict[str, Any]) -> str:
    """Hash of the desired deployment; LiteLLM returns params encrypted, so we compare this instead."""
    blob = json.dumps([model_name, litellm_params, model_info], sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]
