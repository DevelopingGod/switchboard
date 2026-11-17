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
