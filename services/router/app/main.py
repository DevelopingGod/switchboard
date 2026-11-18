"""Switchboard Router API (SPEC §5). Connections, model catalog, CLI detection and install, onboarding,
rules-based routing and chat (M2)."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db, secrets, sync
from app.api import catalog, chat, connections, health, onboarding, settings, system
from app.catalog.job import run_forever
from app.config import get_settings
from app.litellm_admin import LiteLLMAdmin
from app.registry import load_registry
from app.startup import ensure_connections, import_env_keys, record_fingerprints

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # per-request lines (health polls) are noise
log = logging.getLogger("app")


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
        # Self-healing LiteLLM sync: startup, every 5 min, and at once on drift or a LiteLLM restart.
        tasks.append(asyncio.create_task(sync.run_forever(db.sessionmaker(), app.state.litellm)))
        tasks.append(asyncio.create_task(run_forever(db.sessionmaker(), s.catalog_interval_s)))
    yield
    for t in tasks:
        t.cancel()
        with suppress(asyncio.CancelledError):
            await t
    await app.state.litellm.aclose()
    await db.dispose()


app = FastAPI(title="Switchboard Router", version="0.1.5", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(health.router)
app.include_router(connections.router)
app.include_router(catalog.router)
app.include_router(onboarding.router)
app.include_router(chat.router)
app.include_router(system.router)
app.include_router(settings.router)
