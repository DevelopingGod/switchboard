"""Provider key storage (Fernet, SWITCHBOARD_SECRET_KEY) and log/error redaction (SPEC §13.2)."""

import hashlib
import logging
import re

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import ProviderSecret

# Common provider key shapes, redacted even if we never stored them (e.g. echoed in an error body).
_KEY_PATTERNS = re.compile(
    r"(sk-[A-Za-z0-9_\-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_\-]{20,}|csk-[A-Za-z0-9]{8,}"
    r"|xai-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._\-]{8,})"
)
_known: set[str] = set()


def remember(secret: str) -> None:
    """Register a plaintext secret so redact() removes it from logs and stored errors."""
    if len(secret) >= 8:
        _known.add(secret)


def forget(secret: str) -> None:
    _known.discard(secret)


def redact(text: str) -> str:
    for s in _known:
        text = text.replace(s, "[REDACTED]")
    return _KEY_PATTERNS.sub("[REDACTED]", text)


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        clean = redact(msg)
        if clean != msg:
            record.msg, record.args = clean, None
        return True


def install_log_redaction() -> None:
    f = RedactingFilter()
    for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access", "httpx", "app"):
        logger = logging.getLogger(name)
        logger.addFilter(f)
        for h in logger.handlers:
            h.addFilter(f)


def fingerprint(secret: str) -> str:
    """SHA-256 of a secret, for change detection only (doctor.sh)."""
    return hashlib.sha256(secret.encode()).hexdigest()


def _fernet() -> Fernet:
    return Fernet(get_settings().switchboard_secret_key.get_secret_value().encode())


async def store_key(session: AsyncSession, provider: str, api_key: str, source: str = "api") -> None:
    token = _fernet().encrypt(api_key.encode())
    row = await session.get(ProviderSecret, provider)
    if row is None:
        session.add(ProviderSecret(provider=provider, ciphertext=token, last4=api_key[-4:], source=source))
    else:
        row.ciphertext, row.last4, row.source = token, api_key[-4:], source
    remember(api_key)


async def load_key(session: AsyncSession, provider: str) -> str | None:
    row = await session.get(ProviderSecret, provider)
    if row is None:
        return None
    try:
        key = _fernet().decrypt(row.ciphertext).decode()
    except InvalidToken as e:
        raise RuntimeError(
            "cannot decrypt provider key: SWITCHBOARD_SECRET_KEY changed (see docs/m1a.md, Backups)"
        ) from e
    remember(key)
    return key


async def delete_key(session: AsyncSession, provider: str) -> bool:
    row = await session.get(ProviderSecret, provider)
    if row is None:
        return False
    try:
        forget(_fernet().decrypt(row.ciphertext).decode())
    except InvalidToken:
        pass
    await session.delete(row)
    return True


async def key_last4(session: AsyncSession) -> dict[str, str]:
    rows = (await session.execute(select(ProviderSecret.provider, ProviderSecret.last4))).all()
    return {p: l4 for p, l4 in rows}
