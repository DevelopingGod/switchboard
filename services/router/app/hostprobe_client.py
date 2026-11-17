"""Client for hostprobe (services/hostprobe), the WSL-side CLI detector.

The router must work when hostprobe is down: every call returns a result, never raises, and CLI
rows then report `unknown`.
"""

from typing import Any

import httpx

from app.config import get_settings


async def probe(path: str = "/cli", timeout: float = 30) -> tuple[bool, dict[str, Any] | None, str | None]:
    """Returns (reachable, json, error)."""
    s = get_settings()
    if s.hostprobe_token is None:
        return False, None, "HOSTPROBE_TOKEN not set"
    try:
        async with httpx.AsyncClient(base_url=s.hostprobe_url, timeout=timeout) as c:
            r = await c.get(path, headers={"X-Probe-Token": s.hostprobe_token.get_secret_value()})
    except httpx.HTTPError as e:
        return False, None, f"hostprobe unreachable ({type(e).__name__})"
    if r.status_code != 200:
        return True, None, f"hostprobe HTTP {r.status_code}"
    return True, r.json(), None


async def alive() -> bool:
    ok, data, _ = await probe("/health", timeout=3)
    return ok and bool(data and data.get("status") == "ok")


def _headers() -> dict[str, str]:
    return {"X-Probe-Token": get_settings().hostprobe_token.get_secret_value()}  # type: ignore[union-attr]


async def call(
    method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 60
) -> tuple[int, dict[str, Any]]:
    """A hostprobe action (install plan/run/cancel). Returns (status, json); 503 when unreachable."""
    s = get_settings()
    if s.hostprobe_token is None:
        return 503, {"error": "HOSTPROBE_TOKEN not set"}
    try:
        async with httpx.AsyncClient(base_url=s.hostprobe_url, timeout=timeout) as c:
            r = await c.request(method, path, json=body, headers=_headers())
    except httpx.HTTPError as e:
        return 503, {"error": f"hostprobe unreachable ({type(e).__name__})"}
    try:
        return r.status_code, r.json()
    except ValueError:
        return 502, {"error": "hostprobe returned a non-JSON response"}


async def open_stream(path: str) -> tuple[httpx.AsyncClient, httpx.Response]:
    """Open a long-lived hostprobe response (install log SSE). The caller closes both."""
    s = get_settings()
    client = httpx.AsyncClient(base_url=s.hostprobe_url, timeout=httpx.Timeout(10, read=None))
    try:
        resp = await client.send(client.build_request("GET", path, headers=_headers()), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise
    return client, resp
