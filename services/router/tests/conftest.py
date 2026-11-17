"""Test setup: a throwaway `switchboard_test` DB on the same Postgres, fake LiteLLM and providers.

Run inside the router image: docker compose ... run --rm router pytest
"""

import json
import os
import re
from pathlib import Path

import psycopg
import pytest
from cryptography.fernet import Fernet

_base = os.environ.get("DATABASE_URL", "postgresql://switchboard:switchboard@localhost:5432/switchboard")
TEST_DB = "switchboard_test"
os.environ["DATABASE_URL"] = _base.rsplit("/", 1)[0] + f"/{TEST_DB}"
os.environ["LITELLM_URL"] = "http://litellm.test"
os.environ["LITELLM_MASTER_KEY"] = "sk-master-test"
os.environ["LITELLM_SALT_KEY"] = "sk-salt-test"
os.environ["SWITCHBOARD_SECRET_KEY"] = Fernet.generate_key().decode()
os.environ["ROUTER_ADMIN_TOKEN"] = "admin-token-test-0123456789"
os.environ["HOSTPROBE_URL"] = "http://hostprobe.test"
os.environ["HOSTPROBE_TOKEN"] = "probe-token-test-0123456789"
os.environ["OLLAMA_API_BASE"] = "http://ollama.test"
os.environ["BACKGROUND_JOBS"] = "false"
os.environ.setdefault("CONFIG_DIR", str(Path(__file__).resolve().parents[3] / "config"))
if not Path(os.environ["CONFIG_DIR"], "providers.yaml").exists():
    os.environ["CONFIG_DIR"] = "/srv/config"
for k in (
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "CEREBRAS_API_KEY",
    "MISTRAL_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENCODE_ZEN_API_KEY",
):
    os.environ.pop(k, None)

import httpx  # noqa: E402
import respx  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import db  # noqa: E402
from app.db import async_url  # noqa: E402

ROUTER_DIR = Path(__file__).resolve().parents[1]
ADMIN = {"Authorization": "Bearer admin-token-test-0123456789"}


def _admin_url() -> str:
    return re.sub(r"\+psycopg", "", os.environ["DATABASE_URL"]).rsplit("/", 1)[0] + "/postgres"


def alembic_cfg() -> Config:
    cfg = Config(str(ROUTER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROUTER_DIR / "alembic"))
    cfg.attributes["url"] = async_url(os.environ["DATABASE_URL"])
    return cfg


@pytest.fixture(scope="session", autouse=True)
def database():
    with psycopg.connect(_admin_url(), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{TEST_DB}"')
    command.upgrade(alembic_cfg(), "head")
    yield
    with psycopg.connect(_admin_url(), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')


TABLES = "model_stats, model_catalog, connections, provider_secrets, system_meta, costs, requests"


@pytest.fixture(autouse=True)
async def clean_db():
    async with db.engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture
async def session():
    async with db.sessionmaker()() as s:
        yield s


class FakeLiteLLM:
    """In-memory LiteLLM admin API (the subset the router uses)."""

    def __init__(self):
        self.credentials: dict[str, dict] = {}
        self.models: dict[str, dict] = {}
        self.chat_calls: list[str] = []
        self.broken = False  # simulate LiteLLM errors on writes
        self._n = 0

    def install(self, mock: respx.MockRouter) -> None:
        base = "http://litellm.test"
        mock.get(f"{base}/health/liveliness").respond(200, json="I'm alive!")
        mock.get(f"{base}/credentials").mock(side_effect=self.list_credentials)
        mock.post(f"{base}/credentials").mock(side_effect=self.create_credential)
        mock.patch(url__regex=rf"{base}/credentials/.+").mock(side_effect=self.patch_credential)
        mock.delete(url__regex=rf"{base}/credentials/.+").mock(side_effect=self.delete_credential)
        mock.get(f"{base}/model/info").mock(side_effect=self.model_info)
        mock.post(f"{base}/model/new").mock(side_effect=self.model_new)
        mock.post(f"{base}/model/delete").mock(side_effect=self.model_delete)
        mock.post(f"{base}/v1/chat/completions").mock(side_effect=self.chat)

    def _auth(self, request: httpx.Request) -> bool:
        return request.headers.get("authorization") == "Bearer sk-master-test"

    def list_credentials(self, request):
        return httpx.Response(200, json={"credentials": [{"credential_name": n} for n in self.credentials]})

    def create_credential(self, request):
        assert self._auth(request)
        if self.broken:
            return httpx.Response(500, text="boom")
        body = json.loads(request.content)
        if body["credential_name"] in self.credentials:
            return httpx.Response(409, json={"error": {"message": "already exists"}})
        self.credentials[body["credential_name"]] = body["credential_values"]
        return httpx.Response(200, json={"success": True})

    def patch_credential(self, request):
        name = request.url.path.rsplit("/", 1)[1]
        self.credentials[name] = json.loads(request.content)["credential_values"]
        return httpx.Response(200, json={"success": True})

    def delete_credential(self, request):
        name = request.url.path.rsplit("/", 1)[1]
        if self.credentials.pop(name, None) is None:
            return httpx.Response(404, json={"detail": "Credential not found"})
        return httpx.Response(200, json={"success": True})

    def model_info(self, request):
        return httpx.Response(200, json={"data": list(self.models.values())})

    def model_new(self, request):
        body = json.loads(request.content)
        self._n += 1
        mid = f"m{self._n}"
        body["model_info"] = {**body.get("model_info", {}), "id": mid, "db_model": True}
        self.models[mid] = body
        return httpx.Response(200, json={"model_id": mid})

    def model_delete(self, request):
        self.models.pop(json.loads(request.content)["id"])
        return httpx.Response(200, json={"message": "deleted"})

    def chat(self, request):
        alias = json.loads(request.content)["model"]
        self.chat_calls.append(alias)
        if not any(m["model_name"] == alias for m in self.models.values()):
            return httpx.Response(400, json={"error": {"message": f"Invalid model name {alias}"}})
        served = next(m for m in self.models.values() if m["model_name"] == alias)["litellm_params"]["model"]
        return httpx.Response(
            200,
            json={"model": alias, "choices": [{"message": {"content": "pong"}}]},
            headers={"x-litellm-model-name": served},
        )

    def deployments(self, alias: str | None = None) -> list[dict]:
        return [m for m in self.models.values() if alias is None or m["model_name"] == alias]


@pytest.fixture
def mock_http():
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as mock:
        yield mock


@pytest.fixture
def litellm(mock_http):
    fake = FakeLiteLLM()
    fake.install(mock_http)
    return fake


@pytest.fixture
def hostprobe_down(mock_http):
    mock_http.route(host="hostprobe.test").mock(side_effect=httpx.ConnectError("refused"))


@pytest.fixture
def hostprobe_up(mock_http):
    mock_http.get("http://hostprobe.test/health").respond(200, json={"status": "ok"})
    mock_http.get("http://hostprobe.test/cli").respond(
        200,
        json={
            "clis": {
                "claude": {"installed": False, "version": None, "logged_in": None, "windows_only": True},
                "codex": {
                    "installed": True,
                    "version": "0.98.1",
                    "logged_in": True,
                    "windows_only": False,
                    "login_method": "codex login status",
                },
                "gemini": {"installed": True, "version": "0.40.0", "logged_in": False, "windows_only": False},
                "grok": {"installed": False, "version": None, "logged_in": None, "windows_only": False},
                "opencode": {"installed": False, "version": None, "logged_in": None, "windows_only": False},
            }
        },
    )


@pytest.fixture
async def client(litellm):
    from app.litellm_admin import LiteLLMAdmin
    from app.main import app

    app.state.litellm = LiteLLMAdmin()
    app.state.background = {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://router.test") as c:
        yield c
    await app.state.litellm.aclose()
