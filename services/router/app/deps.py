"""Shared FastAPI dependencies."""

import hmac

from fastapi import Header, HTTPException, Request

from app.config import get_settings
from app.litellm_admin import LiteLLMAdmin


def require_admin(authorization: str | None = Header(default=None)) -> None:
    """Bearer ROUTER_ADMIN_TOKEN on every write/refresh endpoint."""
    expected = get_settings().router_admin_token.get_secret_value()
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(
            status_code=401, detail="admin token required", headers={"WWW-Authenticate": "Bearer"}
        )


def litellm(request: Request) -> LiteLLMAdmin:
    return request.app.state.litellm
