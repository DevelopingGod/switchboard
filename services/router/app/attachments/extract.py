"""Turn an accepted upload into what is stored and sent (M2.5).

- Images: decoded with Pillow under a pixel cap (decompression bombs), orientation applied, metadata (EXIF,
  GPS) dropped by re-encoding, scaled down to `max_image_px`, a small WebP thumbnail made. GIFs keep their
  first frame, as PNG (what every vision API accepts).
- PDFs: text from the first `max_pdf_pages` pages (pypdf); no text at all = a scanned PDF (OCR comes later).
- Text: UTF-8 as-is, capped at `max_text_chars`.
Extracted text is scanned for secrets and stored masked. Nothing is ever executed or rendered here.
"""

from __future__ import annotations

import io
import logging
import warnings
from dataclasses import dataclass, field

from PIL import Image, ImageOps
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.attachments.config import AttachmentsCfg
from app.attachments.sniff import Refused, Sniffed
from app.routing import secrets_detect

log = logging.getLogger("app.attachments")

THUMB_PX = 320
SCANNED_NOTE = "No text found: this looks like a scanned PDF. Text recognition (OCR) comes later."


@dataclass
class Processed:
    kind: str
    mime: str
    data: bytes  # what is stored and sent (images re-encoded)
    thumb: bytes | None = None
    text: str | None = None  # extracted text, secrets masked
    pages: int | None = None
    pages_read: int | None = None
    width: int | None = None
    height: int | None = None
    truncated: bool = False
    secret_kinds: list[str] = field(default_factory=list)
    note: str | None = None
    code: bool = False


def process(raw: bytes, s: Sniffed, cfg: AttachmentsCfg) -> Processed:
    if s.kind == "image":
        return _image(raw, s, cfg)
    if s.kind == "pdf":
        return _pdf(raw, cfg)
    return _text(raw, s, cfg)


def _image(raw: bytes, s: Sniffed, cfg: AttachmentsCfg) -> Processed:
    Image.MAX_IMAGE_PIXELS = cfg.max_image_pixels  # Pillow warns above this and raises at 2x
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as probe:
                probe.verify()  # structure check without decoding the pixels
            img = Image.open(io.BytesIO(raw))
            if img.width * img.height > cfg.max_image_pixels:
                raise Refused("This image is too large (too many pixels).")
            img.load()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
        raise Refused("This image is too large (too many pixels).") from e
    except Refused:
        raise
    except Exception as e:  # noqa: BLE001 - any decoder error means "not a valid image"
        raise Refused("This image couldn't be read; it may be damaged.") from e
    img = ImageOps.exif_transpose(img)  # keep the visible orientation; metadata goes with the re-encode
    if img.mode not in ("RGB", "RGBA", "L", "LA"):
        img = img.convert("RGBA" if "A" in img.getbands() or img.mode == "P" else "RGB")
    if max(img.size) > cfg.max_image_px:
        img.thumbnail((cfg.max_image_px, cfg.max_image_px), Image.Resampling.LANCZOS)
    mime = "image/png" if s.mime == "image/gif" else s.mime
    out = io.BytesIO()
    if mime == "image/jpeg":
        img.convert("RGB").save(out, "JPEG", quality=90, optimize=True)
    elif mime == "image/webp":
        img.save(out, "WEBP", quality=90)
    else:
        img.save(out, "PNG", optimize=True)
    thumb = img.copy()
    thumb.thumbnail((THUMB_PX, THUMB_PX), Image.Resampling.LANCZOS)
    tb = io.BytesIO()
    thumb.save(tb, "WEBP", quality=80)
    return Processed("image", mime, out.getvalue(), thumb=tb.getvalue(), width=img.width, height=img.height)


def _cap(text: str, cfg: AttachmentsCfg) -> tuple[str, bool]:
    if len(text) > cfg.max_text_chars:
        return text[: cfg.max_text_chars], True
    return text, False


def _masked(p: Processed) -> Processed:
    if p.text:
        p.text, p.secret_kinds = secrets_detect.mask(p.text)
    return p


def _pdf(raw: bytes, cfg: AttachmentsCfg) -> Processed:
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted and not reader.decrypt(""):
            raise Refused("This PDF is password-protected. Remove the password and attach it again.")
        total = len(reader.pages)
        parts: list[str] = []
        used, truncated = 0, False
        read = 0
        for page in reader.pages[: cfg.max_pdf_pages]:
            t = (page.extract_text() or "").strip()
            read += 1
            if t:
                parts.append(t)
                used += len(t)
            if used >= cfg.max_text_chars:
                truncated = True
                break
    except Refused:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, IndexError, RecursionError) as e:
        raise Refused("This PDF couldn't be read; it may be damaged.") from e
    text, cut = _cap("\n\n".join(parts), cfg)
    p = Processed("pdf", "application/pdf", raw, pages=total, pages_read=read)
    p.truncated = truncated or cut or total > read
    if not text.strip():
        p.note = SCANNED_NOTE
        return p
    p.text = text
    return _masked(p)


def _text(raw: bytes, s: Sniffed, cfg: AttachmentsCfg) -> Processed:
    text = raw.decode("utf-8", errors="replace").removeprefix("﻿")
    text, cut = _cap(text, cfg)
    p = Processed("text", "text/plain", raw, text=text, truncated=cut, code=s.code)
    return _masked(p)
