"""Subscriptions you pay for (Settings → Subscriptions, M6): name, monthly fee, start date.

Stored as one JSON document in `system_meta` (key `subscriptions`). Used only for honest savings:
"Net saved = value at API prices − subscription fees for the range − real spend". A fee is spread evenly over
each calendar month (fee × days in range ÷ days in that month), from its start date (and until its end
date, if one is set), so a range never charges a whole month for a few days.
"""

from __future__ import annotations

import json
from calendar import monthrange
from datetime import UTC, date, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SystemMeta

KEY = "subscriptions"
MAX = 20


class Subscription(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    monthly_usd: float = Field(ge=0, le=10_000)
    start: date
    end: date | None = None

    @field_validator("name")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("a name is needed")
        return v

    @field_validator("end")
    @classmethod
    def _after(cls, v: date | None, info: Any) -> date | None:
        start = info.data.get("start")
        if v is not None and start is not None and v < start:
            raise ValueError("the end date must be on or after the start date")
        return v


class Subscriptions(BaseModel):
    items: list[Subscription] = Field(default_factory=list, max_length=MAX)


async def load(session: AsyncSession) -> list[Subscription]:
    raw = await session.scalar(select(SystemMeta.value).where(SystemMeta.key == KEY))
    if not raw:
        return []
    try:
        return Subscriptions.model_validate({"items": json.loads(raw)}).items
    except ValueError:
        return []  # a hand-edited row that no longer validates: treat as none rather than fail the page


async def save(session: AsyncSession, items: list[Subscription]) -> list[Subscription]:
    doc = json.dumps([s.model_dump(mode="json") for s in items])
    stmt = insert(SystemMeta).values(key=KEY, value=doc, updated_at=datetime.now(UTC))
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["key"],
            set_={"value": stmt.excluded.value, "updated_at": stmt.excluded.updated_at},
        )
    )
    await session.commit()
    return items


def fees(items: list[Subscription], first: date, last: date) -> float:
    """Pro-rated fees for the days first..last (inclusive, the viewer's local dates)."""
    total = 0.0
    for s in items:
        if s.monthly_usd <= 0:
            continue
        a = max(first, s.start)
        b = min(last, s.end) if s.end else last
        d = a
        while d <= b:
            dim = monthrange(d.year, d.month)[1]
            month_end = date(d.year, d.month, dim)
            upto = min(b, month_end)
            total += s.monthly_usd * ((upto - d).days + 1) / dim
            d = upto + timedelta(days=1)
    return round(total, 6)
