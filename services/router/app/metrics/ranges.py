"""Time ranges in the viewer's own time zone (M6). Rollup buckets are 15 minutes in UTC, which line up with
every real UTC offset, so local days and hours are exact."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_DAYS = 366
RANGES = {"today": 1, "7d": 7, "30d": 30}


class RangeError(ValueError):
    pass


def zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise RangeError(f"unknown time zone {tz!r}") from e


@dataclass(frozen=True)
class Range:
    key: str
    tz: ZoneInfo
    start: datetime  # UTC instant of the first local midnight
    end: datetime  # UTC instant (now, or the day after the last date)
    first: date
    last: date
    slot: str  # hour | day

    @property
    def days(self) -> int:
        return (self.last - self.first).days + 1

    def as_dict(self) -> dict[str, str]:
        return {
            "key": self.key,
            "tz": self.tz.key,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "first": self.first.isoformat(),
            "last": self.last.isoformat(),
            "slot": self.slot,
        }


def local_midnight(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time(0), tzinfo=tz).astimezone(UTC)


def resolve(
    key: str, tz: str | None, now: datetime | None = None, first: str | None = None, last: str | None = None
) -> Range:
    z = zone(tz)
    now = now or datetime.now(UTC)
    today = now.astimezone(z).date()
    if key == "custom":
        try:
            a, b = date.fromisoformat(first or ""), date.fromisoformat(last or "")
        except ValueError as e:
            raise RangeError("custom ranges need first and last dates (YYYY-MM-DD)") from e
        if b < a or (b - a).days + 1 > MAX_DAYS:
            raise RangeError(f"a custom range is 1 to {MAX_DAYS} days")
        b = min(b, today)
        end = min(now, local_midnight(b + timedelta(days=1), z))
        return Range("custom", z, local_midnight(a, z), end, a, b, "day")
    if key not in RANGES:
        raise RangeError("range is today, 7d, 30d or custom")
    n = RANGES[key]
    a = today - timedelta(days=n - 1)
    return Range(key, z, local_midnight(a, z), now, a, today, "hour" if n == 1 else "day")
