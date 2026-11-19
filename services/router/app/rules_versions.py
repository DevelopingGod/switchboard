"""Rules UI storage (M3b, ADR 0004): versioned overrides over rules.yaml, in the Router DB.

- The current version is the newest `rules_versions` row. Saving the same document again is a no-op
  (idempotent); a rollback is a new row copying an older one, so history is never rewritten.
- `effective_rules()` is what a chat turn routes with: base ⊕ current overrides, parsed once per
  (rules.yaml mtime, version id) and cached. If the base changed under the overrides so that they no
  longer validate (a rule they edit was removed), routing falls back to the base rules and the problem
  is reported in `GET /rules` instead of failing requests (self-healing, principle 5).
"""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import RulesVersion
from app.registry import load_registry
from app.routing import overrides as ov_mod
from app.routing import rules as rules_mod
from app.routing.overrides import RulesInvalid
from app.routing.rules import RuleSet

log = logging.getLogger("app.rules_versions")

_built: dict[tuple[float, int], RuleSet] = {}
MAX_BUILT = 4  # bounded: a couple of recent (file, version) pairs
last_error: dict[str, Any] = {"version": None, "problems": []}


def _path():
    return get_settings().config_dir / "rules.yaml"


def base_sha() -> str:
    return hashlib.sha256(_path().read_bytes()).hexdigest()


async def current(session: AsyncSession) -> RulesVersion | None:
    return (
        await session.execute(select(RulesVersion).order_by(RulesVersion.id.desc()).limit(1))
    ).scalar_one_or_none()


async def get(session: AsyncSession, version_id: int) -> RulesVersion | None:
    return await session.get(RulesVersion, version_id)


async def effective_rules(session: AsyncSession, draft: dict[str, Any] | None = None) -> RuleSet:
    """Base + overrides (or an unsaved `draft`, for the dry-run tester; raises RulesInvalid)."""
    base = rules_mod.load_raw()
    if draft is not None:
        return ov_mod.build(draft, base, load_registry())[1]
    row = await current(session)
    if row is None or not row.overrides:
        last_error.update(version=None, problems=[])
        return rules_mod.load_rules()
    key = (_path().stat().st_mtime, row.id)
    if key in _built:
        return _built[key]
    try:
        rs = ov_mod.build(row.overrides, base, load_registry())[1]
    except RulesInvalid as e:
        log.warning("rules override v%s no longer valid, using rules.yaml: %s", row.id, e)
        last_error.update(version=row.id, problems=[p.as_dict() for p in e.problems])
        return rules_mod.load_rules()
    last_error.update(version=None, problems=[])
    if len(_built) >= MAX_BUILT:
        _built.pop(next(iter(_built)))
    _built[key] = rs
    return rs


class Stale(RuntimeError):
    def __init__(self, current_id: int | None):
        self.current_id = current_id
        super().__init__("The rules changed since you opened them.")


async def save(
    session: AsyncSession,
    overrides: dict[str, Any],
    *,
    note: str | None,
    expected: int | None,
    source: str = "edit",
    rolled_back_to: int | None = None,
) -> tuple[RulesVersion | None, bool]:
    """Validate and append a version. `expected` is the version id the editor started from (None =
    no version yet); a different current version raises Stale. Returns (current row, created)."""
    ov_mod.build(overrides, rules_mod.load_raw(), load_registry())  # raises RulesInvalid
    cur = await current(session)
    if (cur.id if cur else None) != expected:
        raise Stale(cur.id if cur else None)
    if (cur.overrides if cur else {}) == overrides:
        return cur, False
    row = RulesVersion(
        created_at=datetime.now(UTC),
        source=source,
        note=(note or "").strip()[:200] or None,
        rolled_back_to=rolled_back_to,
        base_sha=base_sha(),
        overrides=overrides,
    )
    session.add(row)
    await session.commit()
    _built.clear()
    return row, True


async def history(
    session: AsyncSession, limit: int = 20, before: int | None = None
) -> tuple[list[RulesVersion], int | None]:
    """Newest first, keyset-paginated on id."""
    q = select(RulesVersion).order_by(RulesVersion.id.desc()).limit(limit + 1)
    if before is not None:
        q = q.where(RulesVersion.id < before)
    rows = list((await session.execute(q)).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, (rows[-1].id if more and rows else None)


async def previous(session: AsyncSession, version_id: int) -> RulesVersion | None:
    return (
        await session.execute(
            select(RulesVersion).where(RulesVersion.id < version_id).order_by(RulesVersion.id.desc()).limit(1)
        )
    ).scalar_one_or_none()
