"""config/attachments.yaml: limits, allowed kinds, routing thresholds, image token accounting (M2.5).

Validated like rules.yaml (frozen dataclasses, a plain ValueError on a bad file) and re-read when the
file's mtime changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from app.config import get_settings

IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
METHODS = {"tiles", "fixed", "area"}


@dataclass(frozen=True)
class ImageTokens:
    method: str = "area"
    tile: int = 512
    per_tile: int = 170
    base: int = 0
    small_edge: int = 0
    small_tokens: int = 0
    tokens: int = 258
    divisor: int = 750
    fit: int = 0


@dataclass(frozen=True)
class AttachmentsCfg:
    max_file_bytes: int = 10 * 1024 * 1024
    max_files_per_message: int = 5
    max_pdf_pages: int = 50
    max_text_chars: int = 200_000
    max_image_px: int = 2048
    max_image_pixels: int = 40_000_000
    image_extensions: frozenset[str] = frozenset({"png", "jpg", "jpeg", "webp", "gif"})
    image_mimes: frozenset[str] = frozenset(IMAGE_MIMES)
    pdf_extensions: frozenset[str] = frozenset({"pdf"})
    text_extensions: frozenset[str] = frozenset({"txt", "md", "csv", "json"})
    code_extensions: frozenset[str] = frozenset({"py", "js", "ts"})
    long_document_tokens: int = 12_000
    history_images: int = 1
    staging_ttl_h: int = 24
    image_tokens: dict[str, ImageTokens] = field(default_factory=dict, compare=False)

    def tokens_for(self, provider: str | None) -> tuple[ImageTokens, bool]:
        """(accounting, documented) for a provider; the default is an estimate."""
        if provider and provider in self.image_tokens:
            return self.image_tokens[provider], True
        return self.image_tokens.get("default", ImageTokens()), False


def _exts(v: Any, key: str) -> frozenset[str]:
    if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
        raise ValueError(f"attachments.yaml: {key} must be a list of names")
    return frozenset(x.lower().lstrip(".") for x in v)


def _pos(v: Any, key: str, lo: int = 1, hi: int = 10**9) -> int:
    n = int(v)
    if not lo <= n <= hi:
        raise ValueError(f"attachments.yaml: {key} must be between {lo} and {hi}")
    return n


def parse(data: dict[str, Any]) -> AttachmentsCfg:
    lim = data.get("limits") or {}
    kinds = data.get("kinds") or {}
    route = data.get("routing") or {}
    store = data.get("storage") or {}
    img = kinds.get("image") or {}
    mimes = frozenset(img.get("mimes") or IMAGE_MIMES)
    if bad := mimes - IMAGE_MIMES:  # SVG and friends can carry script: never allowed, whatever the file says
        raise ValueError(f"attachments.yaml: image mimes not supported: {sorted(bad)}")
    text = kinds.get("text") or {}
    tokens: dict[str, ImageTokens] = {}
    for pid, spec in (data.get("image_tokens") or {}).items():
        spec = dict(spec or {})
        if spec.get("method") not in METHODS:
            raise ValueError(f"attachments.yaml: image_tokens.{pid}.method must be one of {sorted(METHODS)}")
        known = ImageTokens.__dataclass_fields__
        if bad_keys := set(spec) - set(known):
            raise ValueError(f"attachments.yaml: image_tokens.{pid}: unknown keys {sorted(bad_keys)}")
        tokens[str(pid)] = ImageTokens(**{k: (v if k == "method" else int(v)) for k, v in spec.items()})
    return AttachmentsCfg(
        max_file_bytes=_pos(lim.get("max_file_mb", 10), "limits.max_file_mb", 1, 100) * 1024 * 1024,
        max_files_per_message=_pos(
            lim.get("max_files_per_message", 5), "limits.max_files_per_message", 1, 20
        ),
        max_pdf_pages=_pos(lim.get("max_pdf_pages", 50), "limits.max_pdf_pages", 1, 2000),
        max_text_chars=_pos(lim.get("max_text_chars", 200_000), "limits.max_text_chars", 1000),
        max_image_px=_pos(lim.get("max_image_px", 2048), "limits.max_image_px", 256, 8192),
        max_image_pixels=_pos(lim.get("max_image_pixels", 40_000_000), "limits.max_image_pixels", 10**6),
        image_extensions=_exts(img.get("extensions") or ["png", "jpg", "jpeg", "webp", "gif"], "image"),
        image_mimes=mimes,
        pdf_extensions=_exts((kinds.get("pdf") or {}).get("extensions") or ["pdf"], "pdf"),
        text_extensions=_exts(text.get("extensions") or ["txt"], "text.extensions"),
        code_extensions=_exts(text.get("code") or ["py"], "text.code"),
        long_document_tokens=_pos(route.get("long_document_tokens", 12000), "routing.long_document_tokens"),
        history_images=_pos(route.get("history_images", 1), "routing.history_images", 0, 10),
        staging_ttl_h=_pos(store.get("staging_ttl_h", 24), "storage.staging_ttl_h", 1, 24 * 30),
        image_tokens=tokens,
    )


_cache: dict[Path, tuple[float, AttachmentsCfg]] = {}


def load(config_dir: Path | None = None) -> AttachmentsCfg:
    path = (config_dir or get_settings().config_dir) / "attachments.yaml"
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return AttachmentsCfg()  # an older config folder: safe defaults
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    cfg = parse(yaml.safe_load(path.read_text()) or {})
    _cache[path] = (mtime, cfg)
    return cfg
