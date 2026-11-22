"""Token estimates for attachments (M2.5): images per provider where documented, text at ~4 chars/token.

Shown before sending and counted by the quota guard. Anything not documented is labelled an estimate.
"""

from __future__ import annotations

import math

from app.attachments.config import AttachmentsCfg, ImageTokens


def text_tokens(chars: int) -> int:
    return max(1, chars // 4) if chars else 0


def image_tokens(width: int | None, height: int | None, spec: ImageTokens) -> int:
    w, h = max(1, width or 1024), max(1, height or 1024)
    if spec.method == "fixed":
        return spec.tokens
    if spec.method == "area":
        return max(1, math.ceil(w * h / max(1, spec.divisor)))
    # tiles
    if spec.small_edge and w <= spec.small_edge and h <= spec.small_edge:
        return spec.small_tokens or spec.per_tile
    if spec.fit and max(w, h) > spec.fit:
        scale = spec.fit / max(w, h)
        w, h = max(1, int(w * scale)), max(1, int(h * scale))
    tiles = math.ceil(w / spec.tile) * math.ceil(h / spec.tile)
    return spec.base + spec.per_tile * tiles


def for_provider(
    cfg: AttachmentsCfg, provider: str | None, images: list[tuple[int | None, int | None]], text_chars: int
) -> tuple[int, bool]:
    """(tokens, documented) for these attachments on this provider. Text is always an estimate."""
    spec, documented = cfg.tokens_for(provider)
    n = sum(image_tokens(w, h, spec) for w, h in images) + text_tokens(text_chars)
    return n, documented and not text_chars
