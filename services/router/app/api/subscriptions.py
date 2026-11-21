"""Accounts, usage windows and paid overflow (M6.5, ADRs 0013-0015).

GET    /accounts                         every subscription CLI with its accounts, login state and plan
POST   /accounts                         {cli, name, label}: an empty folder the vendor CLI logs into
POST   /accounts/{cli}/{name}/check      check the login again now
DELETE /accounts/{cli}/{name}            soft delete (refused while something uses it; the folder stays)
GET    /subscriptions/windows            every account's usage windows (reported or estimated)
GET    /settings/overflow                paid overflow: on/off, monthly budget, model, spent and left
PUT    /settings/overflow                {enabled, monthly_usd, model}
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import accounts, fleet, overflow, subscriptions, user_settings
from app.config import get_settings
from app.db import get_session
from app.deps import require_admin
from app.registry import load_registry

router = APIRouter(tags=["subscriptions"], dependencies=[Depends(require_admin)])


class AccountIn(BaseModel):
    cli: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=1, max_length=32)
    label: str | None = Field(default=None, max_length=80)


class OverflowIn(BaseModel):
    enabled: bool
    monthly_usd: float | None = Field(default=None, gt=0, le=10_000)
    model: str | None = Field(default=None, max_length=200)


def _err(e: accounts.AccountError) -> HTTPException:
    return HTTPException(e.status, e.message)


@router.get("/accounts")
async def list_accounts(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = await fleet.refresh(session)
    return {"clis": await accounts.listing(session, reg)}


@router.post("/accounts", status_code=201)
async def add_account(body: AccountIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = await fleet.refresh(session)
    try:
        return await accounts.create(session, reg, body.cli, body.name, body.label)
    except accounts.AccountError as e:
        raise _err(e) from e


@router.post("/accounts/{cli}/{name}/check")
async def check_account(cli: str, name: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = await fleet.refresh(session)
    if cli not in reg.clis:
        raise HTTPException(404, "no such CLI")
    st = await accounts.status(cli, name, fresh=True)
    return {"cli": cli, "name": name, **{k: st.get(k) for k in ("logged_in", "plan", "installed", "error")}}


@router.delete("/accounts/{cli}/{name}")
async def remove_account(cli: str, name: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = await fleet.refresh(session)
    try:
        await accounts.remove(session, reg, cli, name)
    except accounts.AccountError as e:
        raise _err(e) from e
    return {"removed": True}


@router.get("/subscriptions/windows")
async def windows(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = await fleet.refresh(session)
    by_cli = {c: await accounts.names(session, c) for c in reg.clis}
    out = await subscriptions.overview(session, reg, by_cli)
    for row in out:
        st = await accounts.status(row["cli"], row["account"])
        cli = reg.clis[row["cli"]]
        row["plan_label"] = cli.plan_label(st.get("plan")) if st.get("plan") else cli.label
        row["logged_in"] = st.get("logged_in")
    return {
        "accounts": out,
        "guard": {"save_at": reg.defaults.guard.save_at, "block_at": reg.defaults.guard.block_at},
    }


def paid_models() -> list[dict[str, Any]]:
    """Models paid overflow may use: aliases served only by paid providers (plus free ones in test mode)."""
    reg = load_registry()
    allow_free = get_settings().router_overflow_allow_free
    out = []
    for name in sorted({a.alias for a in reg.static_aliases()}):
        deps = reg.alias(name)
        provs = [reg.get(d.provider) for d in deps]
        paid = bool(deps) and all(p is not None and p.paid for p in provs)
        if paid or allow_free:
            out.append({"model": name, "paid": paid, "providers": sorted({d.provider for d in deps})})
    return out


@router.get("/settings/overflow")
async def get_overflow(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    st = await overflow.status(session)
    models = paid_models()
    chosen = next((m for m in models if m["model"] == st["model"]), None)
    return {**st, "models": models, "test_free_model": bool(chosen and not chosen["paid"])}


@router.put("/settings/overflow")
async def put_overflow(body: OverflowIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    if body.enabled:
        if body.monthly_usd is None:
            raise HTTPException(400, "Set a monthly budget to turn paid overflow on")
        if not body.model or body.model not in {m["model"] for m in paid_models()}:
            raise HTTPException(400, "Choose one of the paid models (connect a paid provider first)")
    await user_settings.save(
        session,
        {
            "overflow_enabled": body.enabled,
            "overflow_monthly_usd": body.monthly_usd,
            "overflow_model": body.model,
        },
    )
    return await get_overflow(session)
