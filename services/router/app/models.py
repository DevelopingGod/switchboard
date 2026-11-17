"""Router DB tables (SPEC §9, §6.4). Schema changes go through Alembic (alembic/versions)."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONB, list[Any]: JSONB}


class Connection(Base):
    """One row per provider in config/providers.yaml. Never holds secrets (SPEC §9)."""

    __tablename__ = "connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), unique=True)
    kind: Mapped[str] = mapped_column(String(16))  # cli | api_key | local
    # api_key: no_key | connected | error ; local: connected | error ; cli: unknown | ...
    status: Mapped[str] = mapped_column(String(32), default="no_key")
    last_checked: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    meta_json: Mapped[dict[str, Any]] = mapped_column(default=dict)


class ProviderSecret(Base):
    """Fernet-encrypted provider API key (SWITCHBOARD_SECRET_KEY). Never returned by the API."""

    __tablename__ = "provider_secrets"

    provider: Mapped[str] = mapped_column(String(64), primary_key=True)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    last4: Mapped[str] = mapped_column(String(4))
    source: Mapped[str] = mapped_column(String(16), default="api")  # api | env-import
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SystemMeta(Base):
    """Key/value facts about this install (e.g. secret-key fingerprints checked by doctor.sh)."""

    __tablename__ = "system_meta"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ModelCatalog(Base):
    __tablename__ = "model_catalog"
    __table_args__ = (UniqueConstraint("provider", "model_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), index=True)
    model_id: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(255))
    tags_json: Mapped[list[Any]] = mapped_column(default=list)
    tag_source: Mapped[str] = mapped_column(String(16), default="untagged")  # curated | metadata | untagged
    context: Mapped[int | None] = mapped_column(Integer)
    max_output: Mapped[int | None] = mapped_column(Integer)
    prices_json: Mapped[dict[str, Any]] = mapped_column(default=dict)
    free: Mapped[bool] = mapped_column(Boolean, default=False)
    privacy: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="available")  # available | deprecated | missing
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    meta_json: Mapped[dict[str, Any]] = mapped_column(default=dict)


class ModelStats(Base):
    """Per model + task type (SPEC §6.4). M1a fills task_type="test" from POST /models/test."""

    __tablename__ = "model_stats"
    __table_args__ = (UniqueConstraint("model_id", "task_type"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_id: Mapped[int] = mapped_column(ForeignKey("model_catalog.id", ondelete="CASCADE"))
    task_type: Mapped[str] = mapped_column(String(32))
    samples: Mapped[int] = mapped_column(Integer, default=0)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    p50_ms: Mapped[int | None] = mapped_column(Integer)
    p95_ms: Mapped[int | None] = mapped_column(Integer)
    error_rate: Mapped[float] = mapped_column(Float, default=0.0)
    thumbs_up: Mapped[int] = mapped_column(Integer, default=0)
    thumbs_down: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[float | None] = mapped_column(Float)
    recent_ms: Mapped[list[Any]] = mapped_column(default=list)  # last 50 latencies for p50/p95
    last_ok: Mapped[bool | None] = mapped_column(Boolean)
    last_error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Thread(Base):
    """A chat thread (M2). `private` is sticky: once set, every request in it stays local."""

    __tablename__ = "threads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(120), default="")
    title_source: Mapped[str] = mapped_column(String(16), default="none")  # none | words | local | user
    private: Mapped[bool] = mapped_column(Boolean, default=False)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Message(Base):
    """One chat message. Reasoning/thinking text is never stored (only the answer)."""

    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    thread_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("threads.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="")
    # user: done ; assistant: streaming | done | stopped | error | notice | blocked
    status: Mapped[str] = mapped_column(String(16), default="done")
    request_id: Mapped[int | None] = mapped_column(ForeignKey("requests.id", ondelete="SET NULL"))
    private: Mapped[bool] = mapped_column(Boolean, default=False)
    feedback: Mapped[int | None] = mapped_column(SmallInteger)  # 1 | -1 | null
    meta_json: Mapped[dict[str, Any]] = mapped_column(default=dict)  # route summary for the chip
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Request(Base):
    """Every routed request (SPEC §9, §13.5): rule, target, fallbacks tried and why, latency."""

    __tablename__ = "requests"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16))  # chat | media | job
    prompt_hash: Mapped[str | None] = mapped_column(String(64))
    rule_id: Mapped[str | None] = mapped_column(String(64))
    target: Mapped[str | None] = mapped_column(String(255))
    fallbacks_tried_json: Mapped[list[Any]] = mapped_column(default=list)
    temperature: Mapped[float | None] = mapped_column(Float)
    autonomy: Mapped[int | None] = mapped_column(Integer)
    private: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str | None] = mapped_column(String(32))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # M2
    thread_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("threads.id", ondelete="SET NULL")
    )
    intent: Mapped[str | None] = mapped_column(String(32))
    model: Mapped[str | None] = mapped_column(String(255))  # deployment that served it
    model_catalog_id: Mapped[int | None] = mapped_column(ForeignKey("model_catalog.id", ondelete="SET NULL"))
    ttft_ms: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    decision_json: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Cost(Base):
    """One row per billable event (SPEC §9). `cost_usd` is what counts toward caps: free-tier calls
    are $0 there and keep the provider's list price in `list_price_usd`."""

    __tablename__ = "costs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[int | None] = mapped_column(ForeignKey("requests.id", ondelete="SET NULL"))
    source: Mapped[str] = mapped_column(String(16))  # litellm | paperclip | router
    provider: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(255))
    tokens_in: Mapped[int | None] = mapped_column(Integer)
    tokens_out: Mapped[int | None] = mapped_column(Integer)
    units: Mapped[float | None] = mapped_column(Float)
    cost_usd: Mapped[float | None] = mapped_column(Numeric(12, 6))
    list_price_usd: Mapped[float | None] = mapped_column(Numeric(12, 6))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
