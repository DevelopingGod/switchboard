"""Attachments API (M2.5, ADR 0016): upload, serve, remove, and the composer's token estimate.

Uploads are a raw body (`application/octet-stream`) with the file name in `X-Filename` (percent-encoded), so
no multipart parser is needed; the body is read in chunks and cut off at the size limit.

Serving is defensive (the portal proxies these bytes onto its own origin): only sniffed raster images are
served inline, under a CSP that allows nothing and a sandbox; PDFs and text are always downloads
(`Content-Disposition: attachment`, `application/octet-stream`). `nosniff` everywhere.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Any
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import db
from app.attachments import config as att_config
from app.attachments import service, store
from app.db import get_session
from app.deps import require_admin
from app.models import Attachment
from app.routing import secrets_detect
from app.routing.context import build_context
from app.routing.engine import RouteRequest, decide

log = logging.getLogger("app.attachments")
router = APIRouter(tags=["attachments"], dependencies=[Depends(require_admin)])

INLINE_IMAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
DOWNLOAD_CSP = "default-src 'none'; sandbox"


@router.post("/attachments")
async def upload(
    request: Request,
    x_filename: str = Header(..., max_length=600),
    content_length: int | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    cfg = att_config.load()
    limit = cfg.max_file_bytes
    if content_length is not None and content_length > limit:
        raise HTTPException(413, f"This file is over the {limit // (1024 * 1024)} MB limit.")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, f"This file is over the {limit // (1024 * 1024)} MB limit.")
        chunks.append(chunk)
    raw = b"".join(chunks)
    att = await service.ingest(session, raw, unquote(x_filename))
    return service.as_json(att)


async def _get(session: AsyncSession, att_id: uuid.UUID) -> Attachment:
    a = await session.get(Attachment, att_id)
    if a is None:
        raise HTTPException(404, "attachment not found")
    return a


def _file(path, a: Attachment, inline: bool, mime: str) -> Response:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise HTTPException(404, "the file is gone") from None
    safe = quote(a.name)
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if inline:
        headers["Content-Security-Policy"] = INLINE_IMAGE_CSP
        headers["Content-Disposition"] = f"inline; filename*=UTF-8''{safe}"
        return Response(data, media_type=mime, headers=headers)
    headers["Content-Security-Policy"] = DOWNLOAD_CSP
    headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{safe}"
    return Response(data, media_type="application/octet-stream", headers=headers)


@router.get("/attachments/{att_id}")
async def get_file(att_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Response:
    a = await _get(session, att_id)
    inline = a.kind == "image" and a.mime in att_config.IMAGE_MIMES
    return _file(service.blob_path(a), a, inline, a.mime if inline else "application/octet-stream")


@router.get("/attachments/{att_id}/thumb")
async def get_thumb(att_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Response:
    a = await _get(session, att_id)
    if a.kind != "image":
        raise HTTPException(404, "no preview for this file")
    return _file(service.thumb_path(a), a, True, "image/webp")


@router.get("/attachments/{att_id}/meta")
async def get_meta(att_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return service.as_json(await _get(session, att_id))


@router.delete("/attachments/{att_id}")
async def remove(att_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Remove an upload that wasn't sent (a chip's ×). Gone already = done. A sent file goes with its chat."""
    a = await session.get(Attachment, att_id)
    if a is None:
        return {"deleted": str(att_id)}
    if a.status != "staged":
        raise HTTPException(409, "This file is part of a sent message; it is removed with the chat.")
    store.remove_dir(store.staging_dir(a.id))
    await session.delete(a)
    await session.commit()
    return {"deleted": str(att_id)}


class EstimateIn(BaseModel):
    text: str = Field(default="", max_length=32_000)
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    target: str = Field(default="auto", max_length=220, pattern=r"^(auto|model:[\w.:/@-]{1,200})$")
    private: bool = False


@router.post("/chat/estimate")
async def estimate(body: EstimateIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """What the composer shows before sending: which model would likely answer, and the attachments'
    tokens on it (the provider's own image accounting where documented, else a labelled estimate)."""
    files = service.TurnFiles(
        await service.staged(session, body.attachment_ids) if body.attachment_ids else []
    )
    text_masked, kinds = secrets_detect.mask(body.text or "")
    kinds = [*kinds, *files.secret_kinds]
    ctx = await build_context(session)
    tok0 = files.tokens()[0]
    try:
        dec = decide(
            RouteRequest(
                text=text_masked or "(attachment)",
                target=body.target,
                private=body.private and not kinds,
                secret_kinds=tuple(kinds),
                needs_vision=files.needs_vision,
                long_document=bool(files.docs) and files.long_document(),
                code_files=files.code,
                attachment_tokens=tok0,
            ),
            ctx,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    first = dec.candidates[0] if dec.candidates else None
    provider = first.provider if first else None
    n, documented = files.tokens(provider)
    from app.routing.engine import tokens as text_tokens

    total = n + (text_tokens(len(text_masked)) if text_masked else 0)
    return {
        "tokens": total,
        "attachment_tokens": n,
        "documented": documented,
        "model": first.label if first else None,
        "provider": provider,
        "local": first.local if first else None,
        "private": dec.private,
        "needs_vision": files.needs_vision,
        "long_document": bool((dec.attachments or {}).get("long_document")),
        "blocked": None
        if first
        else ("no_local_vision" if dec.private and files.needs_vision else "no_model"),
    }


async def sweep_forever(interval_s: int = 3600) -> None:
    """Remove uploads that were never sent (attachments.yaml `storage.staging_ttl_h`)."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import delete

    while True:
        with contextlib.suppress(Exception):
            ttl = att_config.load().staging_ttl_h
            cutoff = datetime.now(UTC) - timedelta(hours=ttl)
            async with db.sessionmaker()() as s:
                old = list(
                    (
                        await s.execute(
                            select(Attachment.id).where(
                                Attachment.status == "staged", Attachment.created_at < cutoff
                            )
                        )
                    ).scalars()
                )
                for i in old:
                    store.remove_dir(store.staging_dir(i))
                if old:
                    await s.execute(delete(Attachment).where(Attachment.id.in_(old)))
                    await s.commit()
            n = store.sweep_staging(ttl)
            if old or n:
                log.info("removed %d unsent upload(s)", max(len(old), n))
        await asyncio.sleep(interval_s)
