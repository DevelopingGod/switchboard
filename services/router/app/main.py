"""Switchboard Router API (SPEC §5). Connections, model catalog, CLI detection and install, onboarding,
rules-based routing and chat (M2), agent jobs through Paperclip (M4a)."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db, fleet, jobs, local_profile, secrets, sync
from app.api import agents, catalog, chat, connections, health, onboarding, projects, rules, settings, system
from app.api import jobs as jobs_api
from app.catalog.job import run_forever
from app.config import get_settings
from app.litellm_admin import LiteLLMAdmin
from app.registry import load_registry
from app.routing import classifier
from app.routing.health import cooldowns
from app.startup import ensure_connections, import_env_keys, record_fingerprints
from app.version import VERSION

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
            # M3a: local-model profile (detects the GPU on first start), cooldowns from before a restart
            await local_profile.init(session)
            await system.refresh_profile_state(session)
            restored = await cooldowns.load(session)
            await fleet.refresh(session)  # M4b: hired agents and edits on top of agents.yaml (ADR 0009)
            if restored:
                log.info("restored %d cooldown(s) from before the restart", restored)
        classifier.warm_up_in_background()  # load Arch-Router now, not on the first message
        # Self-healing LiteLLM sync: startup, every 5 min, and at once on drift or a LiteLLM restart.
        if s.router_sync_enabled:
            tasks.append(asyncio.create_task(sync.run_forever(db.sessionmaker(), app.state.litellm)))
            tasks.append(asyncio.create_task(run_forever(db.sessionmaker(), s.catalog_interval_s)))
            # M4a: agent jobs (ADR 0007). Only the main router runs them (never the demo router).
            tasks.append(asyncio.create_task(jobs.loop()))
        else:
            log.info("ROUTER_SYNC_ENABLED=false: no LiteLLM sync and no catalog refresh from this router")
    yield
    for t in tasks:
        t.cancel()
        with suppress(asyncio.CancelledError):
            await t
    await app.state.litellm.aclose()
    await db.dispose()


app = FastAPI(title="Switchboard Router", version=VERSION, lifespan=lifespan)
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
app.include_router(rules.router)
app.include_router(projects.router)
app.include_router(agents.router)
app.include_router(jobs_api.router)
