"""Ids and tags for every call the router makes through LiteLLM (M6, ADR 0012).

Each call carries `x-litellm-call-id: sb-<kind>-<hex>` (LiteLLM v1.108.8 stores it as the spend log's
`litellm_call_id`, verified in docs/m6.md). The router's own `costs` row for a chat turn uses the same id as
`external_id = "litellm:<call id>"`, so the spend-log ingester (app.metrics.ingest_litellm) can insert every
log with `ON CONFLICT DO NOTHING` and nothing is counted twice. Calls without an `sb-` id came from another
LiteLLM client and are counted as "external".
"""

from __future__ import annotations

import uuid
from typing import Any

from app.config import get_settings

HEADER = "x-litellm-call-id"
KINDS = ("chat", "aux", "test")


def new_id(kind: str) -> str:
    if kind not in KINDS:
        raise ValueError(kind)
    return f"sb-{kind}-{uuid.uuid4().hex}"


def kind_of(call_id: str | None) -> str:
    """chat | aux | test for router calls, else external."""
    if call_id and call_id.startswith("sb-"):
        k = call_id.split("-", 2)[1]
        if k in KINDS:
            return k
    return "external"


def external_id(call_id: str) -> str:
    return f"litellm:{call_id}"


def headers(call_id: str) -> dict[str, str]:
    return {HEADER: call_id}


def tag_body(body: dict[str, Any]) -> dict[str, Any]:
    """Demo router (ROUTER_REQUEST_TAG): LiteLLM's `end_user` and `request_tags` carry the tag so Metrics
    can exclude the call."""
    tag = get_settings().router_request_tag
    if tag:
        body["user"] = tag
        body["metadata"] = {"tags": [tag]}
    return body
