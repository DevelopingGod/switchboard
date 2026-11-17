"""Model catalog API (SPEC §6.4)."""

from typing import Any

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.catalog.job import refresh_all
from app.db import get_session
from app.deps import require_admin
from app.models import ModelCatalog, ModelStats

router = APIRouter(tags=["catalog"])


@router.get("/catalog")
async def list_catalog(
    provider: str | None = None,
    tag: str | None = None,
    status: str | None = "available",
    free: bool | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """`status=all` includes missing and deprecated models."""
    q = select(ModelCatalog, ModelStats).outerjoin(
        ModelStats, (ModelStats.model_id == ModelCatalog.id) & (ModelStats.task_type == "test")
    )
    if provider:
        q = q.where(ModelCatalog.provider == provider)
    if status and status != "all":
        q = q.where(ModelCatalog.status == status)
    if tag:
        q = q.where(ModelCatalog.tags_json.contains([tag]))
    if free is not None:
        q = q.where(ModelCatalog.free.is_(free))
    rows = (await session.execute(q.order_by(ModelCatalog.provider, ModelCatalog.model_id))).all()
    models = [
        {
            "provider": m.provider,
            "model_id": m.model_id,
            "display_name": m.display_name,
            "tags": m.tags_json,
            "tag_source": m.tag_source,
            "context": m.context,
            "max_output": m.max_output,
            "prices": m.prices_json,
            "free": m.free,
            "privacy": m.privacy,
            "status": m.status,
            "first_seen": m.first_seen,
            "last_seen": m.last_seen,
            "test": None
            if s is None
            else {
                "samples": s.samples,
                "error_rate": s.error_rate,
                "p50_ms": s.p50_ms,
                "p95_ms": s.p95_ms,
                "last_ok": s.last_ok,
                "updated_at": s.updated_at,
            },
        }
        for m, s in rows
    ]
    return {"count": len(models), "models": models}


@router.post("/catalog/refresh", dependencies=[Depends(require_admin)])
async def refresh(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    async with httpx.AsyncClient() as client:
        return {"results": await refresh_all(session, client)}
