"""What a file is, from its bytes (magic numbers), never from its name (M2.5).

Only the small allowlist in config/attachments.yaml passes: PNG, JPEG, WebP, GIF, PDF, and UTF-8 text
without NUL bytes. The extension must agree with the bytes. Archives, executables, HTML and SVG are refused
with a plain reason, even when renamed.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from app.attachments.config import AttachmentsCfg

SNIFF_BYTES = 8192

# Signatures of things we never accept, for a clear message (the allowlist refuses them anyway).
_REFUSED: tuple[tuple[bytes, str], ...] = (
    (b"PK\x03\x04", "an archive (zip, docx, xlsx, jar…)"),
    (b"PK\x05\x06", "an archive"),
    (b"\x1f\x8b", "a compressed archive (gzip)"),
    (b"7z\xbc\xaf\x27\x1c", "an archive (7z)"),
    (b"Rar!", "an archive (rar)"),
    (b"BZh", "a compressed archive (bzip2)"),
    (b"\xfd7zXZ\x00", "a compressed archive (xz)"),
    (b"MZ", "a Windows program"),
    (b"\x7fELF", "a program (ELF)"),
    (b"\xcf\xfa\xed\xfe", "a program (Mach-O)"),
    (b"\xca\xfe\xba\xbe", "a program (Mach-O or Java class)"),
)
_MARKUP = re.compile(rb"^\s*(<\?xml|<!doctype\s+html|<html|<svg|<script|<head|<body|<iframe)", re.I)


class Refused(ValueError):
    """A file we won't take, with a one-sentence reason for the person."""


@dataclass(frozen=True)
class Sniffed:
    kind: str  # image | pdf | text
    mime: str
    code: bool = False  # a code file (sets the request's intent to code)


def extension(name: str) -> str:
    base = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
    if "." not in base:
        return base  # Dockerfile, Makefile
    return base.rsplit(".", 1)[1]


def image_mime(head: bytes) -> str | None:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def _is_text(head: bytes, complete: bool) -> bool:
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError as e:
        # The sample may end in the middle of a multi-byte character; only then is it still text.
        return not complete and e.start >= len(head) - 3


def sniff(head: bytes, name: str, cfg: AttachmentsCfg, complete: bool = False) -> Sniffed:
    """Decide from the first bytes (`complete` = this is the whole file). Raises Refused."""
    ext = extension(name)
    if not head:
        raise Refused("The file is empty.")
    for sig, what in _REFUSED:
        if head.startswith(sig):
            raise Refused(f"This looks like {what}. Attach images, PDFs or text files only.")
    if mime := image_mime(head):
        if mime not in cfg.image_mimes:
            raise Refused("This image type isn't accepted.")
        if ext not in cfg.image_extensions:
            raise Refused(
                "The file name doesn't match its content (it is an image). Rename it and try again."
            )
        return Sniffed("image", mime)
    if head.startswith(b"%PDF-"):
        if ext not in cfg.pdf_extensions:
            raise Refused("The file name doesn't match its content (it is a PDF). Rename it and try again.")
        return Sniffed("pdf", "application/pdf")
    if _MARKUP.match(head.lstrip(b"\xef\xbb\xbf")) or ext in ("html", "htm", "svg", "xhtml"):
        raise Refused("HTML and SVG files aren't accepted (they can run code). Paste the text instead.")
    if not _is_text(head, complete):
        raise Refused("This file type isn't supported. Attach images (PNG, JPEG, WebP, GIF), PDFs or text.")
    if ext in cfg.code_extensions:
        return Sniffed("text", "text/plain", code=True)
    if ext in cfg.text_extensions:
        return Sniffed("text", "text/plain")
    if ext in cfg.image_extensions or ext in cfg.pdf_extensions:
        raise Refused("The file name doesn't match its content. Rename it and try again.")
    raise Refused(f"“.{ext}” files aren't on the list of accepted text files.")


_UNSAFE = re.compile(r"[^\w.\- ()]+", re.UNICODE)


def safe_name(name: str, max_len: int = 120) -> str:
    """A display/storage name: the last path part, NFC, no control or shell-special characters, no leading
    dots, bounded length (the extension kept)."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = unicodedata.normalize("NFC", base)
    base = "".join(ch for ch in base if unicodedata.category(ch)[0] != "C")
    base = _UNSAFE.sub("_", base).strip(" ._") or "file"
    if len(base) > max_len:
        stem, dot, ext = base.rpartition(".")
        if dot and 0 < len(ext) <= 12:
            base = stem[: max_len - len(ext) - 1] + "." + ext
        else:
            base = base[:max_len]
    return base
