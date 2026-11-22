"""Attachments, end to end (M2.5, ADR 0016): ingest an upload, bind it to a chat message or job, and turn a
message's attachments into what the model receives.

What the model gets:
- documents (PDF text, text and code files): the extracted text, secrets masked, in a fenced block after the
  person's text, so it counts toward the context window like any other text;
- images: an OpenAI-style `image_url` part (a data URI; LiteLLM converts it per provider). Only the most
  recent `history_images` image-bearing turns carry their images; older ones become a short note.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.attachments import config as att_config
from app.attachments import store, tokens
from app.attachments.extract import Processed, process
from app.attachments.sniff import Refused, safe_name, sniff
from app.models import Attachment

KIND_LABEL = {"image": "image", "pdf": "PDF", "text": "file"}


def folder(a: Attachment):
    if a.thread_id is not None and a.status == "bound":
        return store.thread_dir(a.thread_id)
    if a.job_id is not None:
        return store.job_dir(a.job_id)
    return store.staging_dir(a.id)


def blob_path(a: Attachment):
    return store.path(folder(a), a.sha256)


def thumb_path(a: Attachment):
    return store.path(folder(a), a.sha256, store.THUMB)


def read_text(a: Attachment) -> str:
    p = store.path(folder(a), a.sha256, store.TEXT)
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def as_json(a: Attachment) -> dict[str, Any]:
    return {
        "id": str(a.id),
        "name": a.name,
        "kind": a.kind,
        "mime": a.mime,
        "bytes": a.bytes,
        "code": a.code,
        "pages": a.pages,
        "pages_read": a.pages_read,
        "width": a.width,
        "height": a.height,
        "text_chars": a.text_chars,
        "tokens": est_tokens(a),
        "truncated": a.truncated,
        "secret": list(a.secret_kinds or []) or None,
        "note": a.note,
        "status": a.status,
    }


def est_tokens(a: Attachment, provider: str | None = None) -> int:
    cfg = att_config.load()
    if a.kind == "image":
        spec, _ = cfg.tokens_for(provider)
        return tokens.image_tokens(a.width, a.height, spec)
    return tokens.text_tokens(a.text_chars)


async def ingest(session: AsyncSession, raw: bytes, filename: str) -> Attachment:
    """Check, process and stage one upload (CPU work off the event loop). Raises HTTP 413/415."""
    att = await asyncio.to_thread(build, raw, filename)
    session.add(att)
    await session.commit()
    return att


def build(raw: bytes, filename: str) -> Attachment:
    """Sniff, process and write one upload to its staging folder; returns the (unsaved) row."""
    cfg = att_config.load()
    if len(raw) > cfg.max_file_bytes:
        raise HTTPException(413, f"This file is over the {cfg.max_file_bytes // (1024 * 1024)} MB limit.")
    name = safe_name(filename or "file")
    try:
        sn = sniff(raw[:8192], name, cfg, complete=len(raw) <= 8192)
        p: Processed = process(raw, sn, cfg)
    except Refused as e:
        raise HTTPException(415, str(e)) from None
    sha = hashlib.sha256(p.data).hexdigest()
    att = Attachment(
        id=uuid.uuid4(),
        status="staged",
        sha256=sha,
        name=name,
        kind=p.kind,
        mime=p.mime,
        bytes=len(p.data),
        code=p.code,
        pages=p.pages,
        pages_read=p.pages_read,
        width=p.width,
        height=p.height,
        text_chars=len(p.text or ""),
        truncated=p.truncated,
        secret_kinds=p.secret_kinds,
        note=p.note,
    )
    d = store.staging_dir(att.id)
    store.write(store.path(d, sha), p.data)
    if p.thumb:
        store.write(store.path(d, sha, store.THUMB), p.thumb)
    if p.text:
        store.write(store.path(d, sha, store.TEXT), p.text.encode("utf-8"))
    return att


async def staged(session: AsyncSession, ids: Sequence[uuid.UUID]) -> list[Attachment]:
    """The uploads named by `ids`, in that order; 409 when one is gone or already sent."""
    cfg = att_config.load()
    if len(ids) > cfg.max_files_per_message:
        raise HTTPException(422, f"At most {cfg.max_files_per_message} files per message.")
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "The same file is attached twice.")
    if not ids:
        return []
    rows = {
        a.id: a for a in (await session.execute(select(Attachment).where(Attachment.id.in_(ids)))).scalars()
    }
    out = []
    for i in ids:
        a = rows.get(i)
        if a is None or a.status != "staged":
            raise HTTPException(409, "An attached file is no longer available. Attach it again.")
        out.append(a)
    return out


def bind(atts: Iterable[Attachment], thread_id: uuid.UUID, message_id: int) -> None:
    """Move staged files into the thread's folder (dedupe by content) and link them to the message.
    The caller commits."""
    for a in atts:
        src = store.staging_dir(a.id)
        store.move_all(src, store.thread_dir(thread_id), a.sha256)
        a.thread_id, a.message_id, a.status = thread_id, message_id, "bound"


async def for_messages(session: AsyncSession, message_ids: Iterable[int]) -> dict[int, list[Attachment]]:
    ids = list(set(message_ids))
    if not ids:
        return {}
    out: dict[int, list[Attachment]] = {}
    q = (
        select(Attachment)
        .where(Attachment.message_id.in_(ids))
        .order_by(Attachment.created_at, Attachment.id)
    )
    for a in (await session.execute(q)).scalars():
        out.setdefault(a.message_id, []).append(a)  # type: ignore[arg-type]
    return out


# --- what a turn needs ---------------------------------------------------------------------------------
@dataclass
class TurnFiles:
    """The current message's attachments, summarised for routing and the composer's estimate."""

    items: list[Attachment] = field(default_factory=list)

    @property
    def images(self) -> list[Attachment]:
        return [a for a in self.items if a.kind == "image"]

    @property
    def docs(self) -> list[Attachment]:
        return [a for a in self.items if a.kind != "image" and a.text_chars]

    @property
    def needs_vision(self) -> bool:
        return bool(self.images)

    @property
    def code(self) -> bool:
        return any(a.code for a in self.items)

    @property
    def secret_kinds(self) -> list[str]:
        out: list[str] = []
        for a in self.items:
            for k in a.secret_kinds or []:
                if k not in out:
                    out.append(k)
        return out

    def tokens(self, provider: str | None = None) -> tuple[int, bool]:
        cfg = att_config.load()
        return tokens.for_provider(
            cfg, provider, [(a.width, a.height) for a in self.images], sum(a.text_chars for a in self.docs)
        )

    def long_document(self) -> bool:
        cfg = att_config.load()
        return tokens.text_tokens(sum(a.text_chars for a in self.docs)) >= cfg.long_document_tokens

    def sample(self, chars: int = 2000) -> str:
        """The start of the documents, for the sensitive-topic check."""
        out, left = [], chars
        for a in self.docs:
            if left <= 0:
                break
            t = read_text(a)[:left]
            out.append(t)
            left -= len(t)
        return "\n".join(out)


def doc_block(a: Attachment) -> str:
    text = read_text(a)
    what = f"{KIND_LABEL.get(a.kind, 'file')} “{a.name}”"
    extra = []
    if a.pages:
        extra.append(
            f"{a.pages_read or a.pages} of {a.pages} pages read" if a.truncated else f"{a.pages} pages"
        )
    elif a.truncated:
        extra.append("cut to the size limit")
    head = f"[Attached {what}" + (f", {', '.join(extra)}" if extra else "") + "]"
    fence = "````" if "```" in text else "```"
    lang = a.name.rsplit(".", 1)[-1].lower() if a.code and "." in a.name else ""
    return f"{head}\n{fence}{lang}\n{text}\n{fence}"


def note_for(a: Attachment) -> str:
    if a.kind == "image":
        return f"[Image “{a.name}” attached earlier]"
    if a.note:  # a scanned PDF: nothing was read
        return f"[Attached PDF “{a.name}”: {a.note}]"
    return ""


def text_with_docs(text: str, atts: list[Attachment]) -> str:
    """The message text plus its documents (and notes for files that gave no text)."""
    parts = [text] if text else []
    for a in atts:
        if a.kind == "image":
            continue
        parts.append(doc_block(a) if a.text_chars else note_for(a))
    return "\n\n".join(p for p in parts if p)


def image_part(a: Attachment) -> dict[str, Any]:
    data = blob_path(a).read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{a.mime};base64,{b64}"}}


def to_wire(
    messages: list[dict[str, Any]], by_msg: dict[int, list[Attachment]], keep_images: int
) -> list[dict[str, Any]]:
    """Expand `_mid` (a user message id) into documents and images, then drop the private keys. Images are
    kept on the newest `keep_images` image-bearing user messages; older images become a note."""
    image_turns = [
        m["_mid"]
        for m in messages
        if m.get("_mid") and any(a.kind == "image" for a in by_msg.get(m["_mid"], []))
    ]
    keep = set(image_turns[-keep_images:]) if keep_images else set()
    out: list[dict[str, Any]] = []
    for m in messages:
        mid = m.get("_mid")
        atts = by_msg.get(mid, []) if mid else []
        clean = {k: v for k, v in m.items() if not k.startswith("_")}
        if not atts:
            out.append(clean)
            continue
        text = text_with_docs(m["content"], atts)
        imgs = [a for a in atts if a.kind == "image"]
        if imgs and mid in keep:
            parts: list[dict[str, Any]] = [{"type": "text", "text": text or "(see the attached image)"}]
            parts += [image_part(a) for a in imgs]
            clean["content"] = parts
        else:
            notes = [note_for(a) for a in imgs]
            clean["content"] = "\n\n".join(p for p in [text, *notes] if p)
        out.append(clean)
    return out


def extra_tokens(atts: list[Attachment], with_images: bool) -> int:
    """Tokens the attachments add to a history message (for trimming)."""
    n = sum(tokens.text_tokens(a.text_chars) for a in atts if a.kind != "image")
    if with_images:
        n += sum(est_tokens(a) for a in atts if a.kind == "image")
    return n
