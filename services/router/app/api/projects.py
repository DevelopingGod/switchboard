"""Projects: the folders agents may work in (M4a allowlist; SPEC §13.4, ADR 0008).

Adding one asks hostprobe to inspect the folder on the host: it must be the top of a git repository with at
least one commit, and never the Switchboard repository itself. Removing one takes it off the allowlist (its
jobs' history stays). Worktrees and their disk use come from hostprobe; `POST /projects/{id}/cleanup` applies
the retention rule.
"""

from __future__ import annotations

import urllib.parse
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client, jobs
from app.db import get_session
from app.deps import require_admin
from app.models import Job, Project

router = APIRouter(tags=["projects"], dependencies=[Depends(require_admin)])


class ProjectIn(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    name: str | None = Field(default=None, max_length=120)


def project_json(p: Project, active: int = 0, total: int = 0) -> dict[str, Any]:
    return {
        "id": p.id,
        "name": p.name,
        "path": p.path,
        "slug": p.slug,
        "head_branch": p.head_branch,
        "created_at": p.created_at.isoformat(),
        "active_jobs": active,
        "jobs": total,
    }


async def _counts(session: AsyncSession) -> dict[int, tuple[int, int]]:
    rows = (
        await session.execute(
            select(
                Job.project_id,
                func.count().filter(Job.status.in_(jobs.ACTIVE)),
                func.count(),
            ).group_by(Job.project_id)
        )
    ).all()
    return {r[0]: (int(r[1]), int(r[2])) for r in rows}


@router.get("/projects")
async def list_projects(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (
        await session.scalars(select(Project).where(Project.removed_at.is_(None)).order_by(Project.name))
    ).all()
    counts = await _counts(session)
    return {"projects": [project_json(p, *counts.get(p.id, (0, 0))) for p in rows]}


@router.post("/projects", status_code=201)
async def add_project(body: ProjectIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    status, info = await hostprobe_client.call("POST", "/git/inspect", {"path": body.path})
    if status == 503:
        raise HTTPException(
            503, "hostprobe isn't answering, so the folder can't be checked: start it and retry"
        )
    if status != 200:
        raise HTTPException(400 if status < 500 else 502, info.get("error") or "couldn't check that folder")
    if not info.get("is_repo"):
        raise HTTPException(
            400, "That folder isn't a git repository: agents work on a new branch, so it needs git"
        )
    if not info.get("is_top"):
        raise HTTPException(400, f"Add the repository's top folder instead: {info.get('top')}")
    if info.get("is_self"):
        raise HTTPException(
            403,
            "That is the Switchboard repository itself. Agents can't work on the app that runs them; "
            "use another folder.",
        )
    if not info.get("has_commits"):
        raise HTTPException(400, "The repository has no commits yet: commit once, then add it")
    path = str(info["path"])
    existing = await session.scalar(select(Project).where(Project.path == path))
    if existing:
        existing.removed_at = None  # adding it again restores it
        existing.head_branch = info.get("head_branch")
        await session.commit()
        return project_json(existing)
    name = (body.name or path.rstrip("/").rsplit("/", 1)[-1])[:120]
    base = jobs.slugify(name)
    slug, n = base, 2
    while await session.scalar(select(Project.id).where(Project.slug == slug)):
        slug, n = f"{base}-{n}", n + 1
    p = Project(name=name, path=path, slug=slug, head_branch=info.get("head_branch"))
    session.add(p)
    await session.commit()
    return project_json(p)


@router.delete("/projects/{project_id}")
async def remove_project(project_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    p = await session.get(Project, project_id)
    if p is None or p.removed_at is not None:
        return {"removed": True}  # already gone = success
    active = await session.scalar(
        select(func.count()).select_from(Job).where(Job.project_id == p.id, Job.status.in_(jobs.ACTIVE))
    )
    if active:
        raise HTTPException(409, f"{active} job(s) are still active in this project: stop them first")
    p.removed_at = jobs.now()
    await session.commit()
    return {"removed": True}


@router.get("/projects/{project_id}/worktrees")
async def worktrees(project_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """The project's job worktrees and their disk use, read only (Settings → Projects)."""
    p = await session.get(Project, project_id)
    if p is None or p.removed_at is not None:
        raise HTTPException(404, "no such project")
    status, data = await hostprobe_client.call(
        "GET", "/git/worktrees?" + urllib.parse.urlencode({"project": p.path, "slug": p.slug})
    )
    if status != 200:
        raise HTTPException(
            503 if status in (0, 503) else 502,
            data.get("error") or "hostprobe couldn't list the worktrees: is it running?",
        )
    return {**data, "keep": await jobs.keep_per_project(session)}


@router.post("/projects/{project_id}/cleanup")
async def cleanup(project_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Apply worktree retention now and report what's left and its disk use."""
    p = await session.get(Project, project_id)
    if p is None or p.removed_at is not None:
        raise HTTPException(404, "no such project")
    return await jobs.retention(session, p)
