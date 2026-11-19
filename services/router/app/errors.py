"""Plain-language errors (M1.5). The router returns a stable `code` with every failure; the portal maps
the code to one short sentence and one action (apps/portal/src/i18n/errors.ts) and shows the raw
`detail` only in Pro mode, under "Details". Raw provider/LiteLLM text never reaches a card or a chat
reply as the main message.

HTTP errors: `HTTPException(status, {"code", "message", "detail"})`.
"""

from fastapi import HTTPException

from app import secrets

CODES = (
    "gateway_sync",  # registering with LiteLLM failed; the router retries by itself
    "key_rejected",  # the provider refused the key (401/403/invalid)
    "rate_limited",
    "credit_limit",
    "timeout",
    "unreachable",  # could not connect to the provider/service
    "not_found",
    "provider_error",
    "params_missing",  # a generic provider also needs its declared params (e.g. an account id)
    "ollama_down",
    "bad_profile",
    "rules_invalid",  # the Rules UI: the edit failed validation (problems: [{path, message}])
    "rules_stale",  # the rules changed since the editor loaded them
)


def problem(status: int, code: str, message: str, detail: str | None = None) -> HTTPException:
    return HTTPException(
        status, {"code": code, "message": message, "detail": secrets.redact(detail)[:300] if detail else None}
    )


def classify(text: str | None) -> str | None:
    """Best-effort code for a stored error string (connections.last_error)."""
    if not text:
        return None
    t = text.lower()
    if "litellm" in t:
        return "gateway_sync"
    if any(
        s in t
        for s in ("401", "403", "invalid api key", "unauthorized", "forbidden", "key rejected", "permission")
    ):
        return "key_rejected"
    if "429" in t or "rate limit" in t or "too many requests" in t:
        return "rate_limited"
    if "402" in t or "credit" in t or "insufficient" in t:
        return "credit_limit"
    if "timeout" in t or "timed out" in t:
        return "timeout"
    if any(s in t for s in ("connect", "unreachable", "name resolution", "no route", "refused")):
        return "unreachable"
    if "404" in t or "not found" in t:
        return "not_found"
    return "provider_error"


def rules_invalid(e: Exception) -> HTTPException:
    """422 for a Rules UI edit that failed validation. `problems` is [{path, message}], one per mistake,
    each already a plain sentence."""
    problems = [p.as_dict() for p in getattr(e, "problems", [])]
    first = problems[0]["message"] if problems else str(e)
    more = f" (and {len(problems) - 1} more)" if len(problems) > 1 else ""
    return HTTPException(
        422,
        {"code": "rules_invalid", "message": f"{first}{more}", "detail": None, "problems": problems},
    )
