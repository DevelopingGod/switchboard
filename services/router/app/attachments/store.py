"""Attachment files on disk (M2.5, ADR 0016).

    <data_dir>/attachments/staging/<attachment id>/{blob, thumb.webp, text.txt}   uploaded, not sent yet
    <data_dir>/attachments/threads/<thread id>/<sha256>{, .thumb.webp, .txt}      one copy per thread (dedupe)
    <data_dir>/attachments/jobs/<job id>/<sha256>{, .thumb.webp, .txt}            one copy per job

Folders are 0700 and files 0600; writes go to a temp file and are renamed into place. Deleting a thread or a
job removes its folder; a missing folder or file counts as deleted (idempotent).
"""

from __future__ import annotations

import os
import shutil
import time
import uuid
from pathlib import Path

from app.config import get_settings

BLOB, THUMB, TEXT = "", ".thumb.webp", ".txt"


def root() -> Path:
    return get_settings().data_dir / "attachments"


def _mkdir(p: Path) -> Path:
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    return p


def staging_dir(att_id: uuid.UUID) -> Path:
    return root() / "staging" / str(att_id)


def thread_dir(thread_id: uuid.UUID) -> Path:
    return root() / "threads" / str(thread_id)


def job_dir(job_id: int) -> Path:
    return root() / "jobs" / str(int(job_id))


def owner_dir(
    *, staging: uuid.UUID | None = None, thread: uuid.UUID | None = None, job: int | None = None
) -> Path:
    if thread is not None:
        return thread_dir(thread)
    if job is not None:
        return job_dir(job)
    assert staging is not None
    return staging_dir(staging)


def path(folder: Path, sha256: str, part: str = BLOB) -> Path:
    if len(sha256) != 64 or not all(c in "0123456789abcdef" for c in sha256):
        raise ValueError("bad content hash")
    return folder / f"{sha256}{part}"


def write(dest: Path, data: bytes) -> None:
    """Atomic write, 0600."""
    _mkdir(dest.parent)
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def move_all(src: Path, dst: Path, sha256: str) -> None:
    """Move one attachment's files (blob, thumb, text) from `src` to `dst`. If `dst` already has the same
    content (same hash), the staged copy is dropped instead (dedupe)."""
    _mkdir(dst)
    for part in (BLOB, THUMB, TEXT):
        a, b = path(src, sha256, part), path(dst, sha256, part)
        if not a.exists():
            continue
        if b.exists():
            a.unlink(missing_ok=True)
        else:
            os.replace(a, b)
    if src.parent.name == "staging":
        remove_dir(src)


def copy_all(src: Path, dst: Path, sha256: str) -> None:
    """Copy (not move) one attachment's files: a chat attachment carried into a job keeps its chat copy."""
    _mkdir(dst)
    for part in (BLOB, THUMB, TEXT):
        a, b = path(src, sha256, part), path(dst, sha256, part)
        if a.exists() and not b.exists():
            tmp = b.with_name(f".{b.name}.{uuid.uuid4().hex}.tmp")
            shutil.copyfile(a, tmp, follow_symlinks=False)
            os.chmod(tmp, 0o600)
            os.replace(tmp, b)


def remove_files(folder: Path, sha256: str) -> None:
    for part in (BLOB, THUMB, TEXT):
        path(folder, sha256, part).unlink(missing_ok=True)


def remove_dir(folder: Path) -> None:
    """Delete a thread's, job's or upload's folder. Gone already = done."""
    r = root().resolve()
    target = folder.resolve() if folder.exists() else folder
    if r not in target.parents:  # never anything outside the attachments root
        raise ValueError("refusing to delete outside the attachments folder")
    shutil.rmtree(target, ignore_errors=True)


def remove_all() -> None:
    """Settings → Clear chats: every thread's and upload's files (job copies stay with their jobs)."""
    for sub in ("threads", "staging"):
        shutil.rmtree(root() / sub, ignore_errors=True)


def sweep_staging(ttl_h: int, now: float | None = None) -> int:
    """Remove uploads that were never sent (older than ttl_h). Returns how many folders went."""
    base = root() / "staging"
    if not base.exists():
        return 0
    cutoff = (now or time.time()) - ttl_h * 3600
    n = 0
    for d in base.iterdir():
        try:
            if d.is_dir() and not d.is_symlink() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                n += 1
        except FileNotFoundError:
            continue
    return n


def usage_bytes() -> int:
    total = 0
    for dirpath, _, files in os.walk(root()):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except FileNotFoundError:
                continue
    return total
