"""Rules UI API (M3b, ADR 0004): view, validate, save, diff and roll back the overrides over rules.yaml.

Reads are open (like /settings); every write needs the admin token. The dry-run tester is
`POST /route/dry-run` (app/api/chat.py), which accepts an unsaved `draft` of the same document.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import rules_versions
from app.db import get_session
from app.deps import require_admin
from app.errors import problem, rules_invalid
from app.models import RulesVersion
from app.registry import load_registry
from app.routing import overrides as ov
from app.routing import rules as rules_mod
from app.routing.context import active_preset
from app.routing.rules import INTENTS, SENSITIVE, WHEN_KEYS

router = APIRouter(tags=["rules"])


class OverridesIn(BaseModel):
    overrides: dict[str, Any]
    note: str | None = Field(default=None, max_length=200)
    # The version id the editor started from (null = no saved version yet). A different current
    # version means someone else saved first: 409, nothing is overwritten.
    base_version: int | None = None


class ValidateIn(BaseModel):
    overrides: dict[str, Any]


def _version(v: RulesVersion | None, with_overrides: bool = False) -> dict[str, Any] | None:
    if v is None:
        return None
    out: dict[str, Any] = {
        "id": v.id,
        "created_at": v.created_at.isoformat(),
        "source": v.source,
        "note": v.note,
        "rolled_back_to": v.rolled_back_to,
        "changes": len(ov.flatten(v.overrides or {}).keys() - {""}),
    }
    if with_overrides:
        out["overrides"] = v.overrides
    return out


def _vocab() -> dict[str, Any]:
    reg = load_registry()
    return {
        "aliases": sorted({a.alias for a in reg.aliases}),
        "providers": sorted(reg.providers),
        "capabilities": list(ov.CAPABILITIES),
        "intents": sorted(INTENTS),
        "sensitive": sorted(SENSITIVE),
        "when_keys": sorted(WHEN_KEYS),
        "paid_policies": list(ov.PAID_POLICIES),
        "presets": list(rules_mod.PRESETS),
        "protected_rules": list(ov.PROTECTED_RULES),
        "limits": {"max_rules": ov.MAX_RULES, "max_fallbacks": ov.MAX_FALLBACKS, "max_text": ov.MAX_TEXT},
    }


@router.get("/rules")
async def get_rules(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """The base file, the current overrides, the merged result and what the editor needs to validate."""
    base = rules_mod.load_raw()
    cur = await rules_versions.current(session)
    await rules_versions.effective_rules(session)  # refreshes last_error
    overrides = cur.overrides if cur else {}
    try:
        effective = ov.merge(base, overrides)
    except (TypeError, KeyError, AttributeError):  # a stored document that no longer fits the base
        effective = base
    return {
        "version": _version(cur),
        "overrides": overrides,
        "base": base,
        "effective": effective,
        "active_preset": await active_preset(session) or rules_mod.DEFAULT_PRESET,
        # set when the saved overrides stopped validating (rules.yaml changed): routing uses the base
        # until they are fixed or reset
        "problems": rules_versions.last_error["problems"] if rules_versions.last_error["version"] else [],
        "vocab": _vocab(),
    }


@router.post("/rules/validate")
async def validate(body: ValidateIn) -> dict[str, Any]:
    """Check a draft without saving it (inline validation in the editor)."""
    try:
        _, rs = ov.build(body.overrides, rules_mod.load_raw(), load_registry())
    except ov.RulesInvalid as e:
        return {"ok": False, "problems": [p.as_dict() for p in e.problems]}
    return {"ok": True, "problems": [], "rules": len(rs.rules)}


@router.put("/rules/overrides", dependencies=[Depends(require_admin)])
async def put_overrides(body: OverridesIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        row, created = await rules_versions.save(
            session, body.overrides, note=body.note, expected=body.base_version
        )
    except ov.RulesInvalid as e:
        raise rules_invalid(e) from e
    except rules_versions.Stale as e:
        raise problem(
            409,
            "rules_stale",
            "The rules were changed somewhere else. Reload them and apply your edit again.",
            f"current version {e.current_id}",
        ) from e
    return {"version": _version(row), "created": created}


@router.get("/rules/versions")
async def versions(
    limit: int = Query(20, ge=1, le=100),
    before: int | None = Query(None, ge=1),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    rows, nxt = await rules_versions.history(session, limit, before)
    return {"versions": [_version(r) for r in rows], "next_before": nxt}


@router.get("/rules/versions/{version_id}")
async def version(version_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await rules_versions.get(session, version_id)
    if row is None:
        raise problem(404, "not_found", "That version doesn't exist.")
    return _version(row, with_overrides=True) or {}


@router.get("/rules/versions/{version_id}/diff")
async def version_diff(
    version_id: int,
    against: str = Query("previous", pattern=r"^(previous|current|base|\d{1,12})$"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Changes from `against` to this version: the previous one (default), the current one, the plain
    rules.yaml (`base`), or any version id."""
    row = await rules_versions.get(session, version_id)
    if row is None:
        raise problem(404, "not_found", "That version doesn't exist.")
    if against == "base":
        other: dict[str, Any] = {}
    elif against == "current":
        cur = await rules_versions.current(session)
        other = cur.overrides if cur else {}
    elif against == "previous":
        prev = await rules_versions.previous(session, version_id)
        other = prev.overrides if prev else {}
    else:
        o = await rules_versions.get(session, int(against))
        if o is None:
            raise problem(404, "not_found", "The version to compare with doesn't exist.")
        other = o.overrides
    return {"version": version_id, "against": against, "changes": ov.diff(other, row.overrides or {})}


@router.post("/rules/versions/{version_id}/rollback", dependencies=[Depends(require_admin)])
async def rollback(version_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Make an older version current again by saving a copy of it as a new version."""
    old = await rules_versions.get(session, version_id)
    if old is None:
        raise problem(404, "not_found", "That version doesn't exist.")
    cur = await rules_versions.current(session)
    try:
        row, created = await rules_versions.save(
            session,
            old.overrides or {},
            note=f"Rolled back to version {old.id}",
            expected=cur.id if cur else None,
            source="rollback",
            rolled_back_to=old.id,
        )
    except ov.RulesInvalid as e:  # rules.yaml changed since: that version no longer fits
        raise rules_invalid(e) from e
    except rules_versions.Stale as e:  # raced with another save
        raise HTTPException(409, {"code": "rules_stale", "message": str(e), "detail": None}) from e
    return {"version": _version(row), "created": created}
