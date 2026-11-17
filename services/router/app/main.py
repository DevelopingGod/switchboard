"""Switchboard Router API (SPEC §5). Connections, model catalog, CLI detection and install, onboarding."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db, secrets
from app.api import catalog, connections, health, onboarding
from app.catalog.job import run_forever
from app.config import get_settings
from app.litellm_admin import LiteLLMAdmin
from app.reconcile import reconcile
from app.registry import load_registry
from app.startup import ensure_connections, import_env_keys, record_fingerprints

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # per-request lines (health polls) are noise
log = logging.getLogger("app")


async def reconcile_until_done(admin: LiteLLMAdmin, status: dict) -> None:
    """LiteLLM may start after the router; retry with backoff until one reconcile succeeds."""
    delay = 2
    while True:
        try:
            async with db.sessionmaker()() as session:
                result = await reconcile(session, admin)
            status["reconcile"] = {"at": datetime.now(UTC).isoformat(), **result}
            return
        except Exception as e:
            log.warning("reconcile failed (%s); retrying in %ss", secrets.redact(str(e))[:200], delay)
            status["reconcile"] = {"error": secrets.redact(str(e))[:200]}
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    secrets.install_log_redaction()
    s = get_settings()
    app.state.litellm = LiteLLMAdmin()
    app.state.background = {}
    tasks: list[asyncio.Task] = []
    if s.background_jobs:
        registry = load_registry()
        async with db.sessionmaker()() as session:
            await ensure_connections(session, registry)
            await record_fingerprints(session)
            await import_env_keys(session, registry)
        tasks.append(asyncio.create_task(reconcile_until_done(app.state.litellm, app.state.background)))
        tasks.append(asyncio.create_task(run_forever(db.sessionmaker(), s.catalog_interval_s)))
    yield
    for t in tasks:
        t.cancel()
        with suppress(asyncio.CancelledError):
            await t
    await app.state.litellm.aclose()
    await db.dispose()


app = FastAPI(title="Switchboard Router", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(health.router)
app.include_router(connections.router)
app.include_router(catalog.router)
app.include_router(onboarding.router)
