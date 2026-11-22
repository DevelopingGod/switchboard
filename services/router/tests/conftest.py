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
os.environ["PAPERCLIP_URL"] = "http://paperclip.test"
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
    "XAI_API_KEY",
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


TABLES = (
    "messages, threads, model_stats, model_catalog, connections, provider_secrets, system_meta, "
    "costs, requests, quota_usage, cooldowns, quota_headers, rules_versions, job_events, jobs, projects, "
    "agent_profiles, metrics_15m, metrics_dirty, cli_accounts, usage_windows, attachments"
)


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    """Each test gets its own attachments folder (M2.5)."""
    from app.config import get_settings

    d = tmp_path / "data"
    monkeypatch.setattr(get_settings(), "data_dir", d)
    return d


@pytest.fixture(autouse=True)
async def clean_db():
    async with db.engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    from app import agents

    agents.set_overlay([])  # the fleet overlay is process memory (refreshed from agent_profiles)
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
        self.down = False  # liveliness fails and every admin call is refused (LiteLLM stopped)
        self.model_writes = 0
        self.wildcard_models = ["model-a", "model-b", "model-c"]  # /model/info expansion of `<p>/*`
        self._n = 0
        # M2 streaming: every streamed request body, and per-model scripted behaviour:
        #   "ok" (default) | "429" | "402" | "402-wrapped" | "500" | "timeout" | "midstream" | "stop"
        #   | "think-tags"
        self.stream_calls: list[dict] = []
        self.script: dict[str, str] = {}
        self.usage_cost: float = 0.0012
        self.answer = "Hello there!"
        self.title = "Centering a div in CSS"
        self.title_status = 200
        self.on_stream_chunk = None  # hook called between chunks (stop test)
        # M6: x-litellm-call-id of every chat call, and the spend-log rows GET /spend/logs/v2 pages through
        self.call_ids: list[str | None] = []
        self.spend_logs: list[dict] = []
        self.spend_down = False

    def install(self, mock: respx.MockRouter) -> None:
        base = "http://litellm.test"
        mock.get(f"{base}/health/liveliness").mock(side_effect=self.liveliness)
        mock.get(f"{base}/credentials").mock(side_effect=self.list_credentials)
        mock.post(f"{base}/credentials").mock(side_effect=self.create_credential)
        mock.patch(url__regex=rf"{base}/credentials/.+").mock(side_effect=self.patch_credential)
        mock.delete(url__regex=rf"{base}/credentials/.+").mock(side_effect=self.delete_credential)
        mock.get(f"{base}/model/info").mock(side_effect=self.model_info)
        mock.post(f"{base}/model/new").mock(side_effect=self.model_new)
        mock.post(f"{base}/model/delete").mock(side_effect=self.model_delete)
        mock.patch(url__regex=rf"{base}/model/.+/update").mock(side_effect=self.model_update)
        mock.post(f"{base}/v1/chat/completions").mock(side_effect=self.chat)
        mock.get(f"{base}/spend/logs/v2").mock(side_effect=self.spend_page)

    def _auth(self, request: httpx.Request) -> bool:
        return request.headers.get("authorization") == "Bearer sk-master-test"

    def liveliness(self, request):
        if self.down:
            raise httpx.ConnectError("connection refused")
        return httpx.Response(200, json="I'm alive!")

    def restart(self, wipe: bool = True) -> None:
        """LiteLLM restarted; with `wipe`, its DB lost our deployments and credentials."""
        self.down = False
        if wipe:
            self.models.clear()
            self.credentials.clear()

    def list_credentials(self, request):
        if self.down:
            raise httpx.ConnectError("connection refused")
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
        if self.down:
            raise httpx.ConnectError("connection refused")
        # Like v1.108.8: a `<provider>/*` wildcard is listed once per provider model, all with one id.
        rows = []
        for m in self.models.values():
            if m["model_name"].endswith("/*"):
                prefix = m["model_name"][:-1]
                rows += [{**m, "model_name": prefix + name} for name in self.wildcard_models]
            else:
                rows.append(m)
        return httpx.Response(200, json={"data": rows})

    def model_new(self, request):
        # Recorded from v1.108.8: a caller-chosen model_info.id is kept; reusing an existing id is a
        # 500 "Failed to add model to db".
        if self.broken:
            return httpx.Response(500, text="boom")
        body = json.loads(request.content)
        self._n += 1
        mid = body.get("model_info", {}).get("id") or f"m{self._n}"
        if mid in self.models:
            return httpx.Response(
                500,
                json={
                    "error": {
                        "message": "{'error': 'Failed to add model to db. "
                        "Check your server logs for more details.'}",
                        "code": "500",
                    }
                },
            )
        body["model_info"] = {**body.get("model_info", {}), "id": mid, "db_model": True}
        self.models[mid] = body
        self.model_writes += 1
        return httpx.Response(200, json={"model_id": mid})

    def model_update(self, request):
        mid = request.url.path.split("/")[-2]
        if mid not in self.models:
            return httpx.Response(
                400, json={"error": {"message": f"{{'error': 'Model with id={mid} not found in db'}}"}}
            )
        body = json.loads(request.content)
        body["model_info"] = {**body.get("model_info", {}), "id": mid, "db_model": True}
        self.models[mid] = body
        self.model_writes += 1
        return httpx.Response(200, json={"model_id": mid})

    def model_delete(self, request):
        # Recorded from v1.108.8: deleting an id that is gone is a 400 with "not found in db".
        mid = json.loads(request.content)["id"]
        if self.models.pop(mid, None) is None:
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": f"{{'error': 'Model with id={mid} not found in db'}}",
                        "type": "auth_error",
                        "code": "400",
                    }
                },
            )
        return httpx.Response(200, json={"message": f"Model: {mid} deleted successfully"})

    def resolve(self, name: str) -> str | None:
        """Served deployment for an alias or a `<provider>/<model>` wildcard name, like LiteLLM."""
        for m in self.models.values():
            if m["model_name"] == name:
                return m["litellm_params"]["model"]
        for m in self.models.values():
            pattern = m["model_name"]
            if pattern.endswith("/*") and name.startswith(pattern[:-1]):
                return m["litellm_params"]["model"][:-1] + name[len(pattern) - 1 :]
        return None

    def chat(self, request):
        body = json.loads(request.content)
        self.call_ids.append(request.headers.get("x-litellm-call-id"))
        if body.get("stream"):
            return self.stream(body)
        alias = body["model"]
        self.chat_calls.append(alias)
        if alias.startswith("ollama/llama3.2"):  # local title model
            if self.title_status != 200:
                return httpx.Response(self.title_status, json={"error": {"message": "down"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": self.title}}]})
        if not any(m["model_name"] == alias for m in self.models.values()):
            return httpx.Response(400, json={"error": {"message": f"Invalid model name {alias}"}})
        served = next(m for m in self.models.values() if m["model_name"] == alias)["litellm_params"]["model"]
        return httpx.Response(
            200,
            json={"model": alias, "choices": [{"message": {"content": "pong"}}]},
            headers={"x-litellm-model-name": served},
        )

    def spend_page(self, request):
        """Like v1.108.8: start/end filter on startTime, sorted ascending, `page` from 1."""
        if self.spend_down:
            raise httpx.ConnectError("connection refused")
        q = request.url.params
        lo, hi = q["start_date"], q["end_date"]
        size, page = int(q.get("page_size", 50)), int(q.get("page", 1))

        def key(r):
            return r["startTime"][:19].replace("T", " ")

        rows = sorted((r for r in self.spend_logs if lo <= key(r) <= hi), key=key)
        pages = max(1, -(-len(rows) // size))
        chunk = rows[(page - 1) * size : page * size]
        return httpx.Response(
            200,
            json={"data": chunk, "total": len(rows), "page": page, "page_size": size, "total_pages": pages},
        )

    def stream(self, body: dict):
        name = body["model"]
        self.stream_calls.append(body)
        served = self.resolve(name)
        if served is None:
            return httpx.Response(
                400, json={"error": {"message": f"Invalid model name passed in model={name}"}}
            )
        mode = self.script.get(name, "ok")
        if mode == "429":
            return httpx.Response(
                429, json={"error": {"message": "rate limited"}}, headers={"retry-after": "30"}
            )
        if mode == "500":
            return httpx.Response(500, json={"error": {"message": "boom"}})
        if mode == "402":  # OpenRouter-style: out of credit
            return httpx.Response(
                402,
                json={
                    "error": {
                        "message": "This request requires more credits, or fewer max_tokens.",
                        "code": 402,
                    }
                },
            )
        if mode == "402-wrapped":  # LiteLLM surfacing a provider 402 under another status
            return httpx.Response(
                500,
                json={"error": {"message": "OpenrouterException - Error code: 402 - Insufficient credits"}},
            )
        if mode == "timeout":
            raise httpx.ReadTimeout("timed out")

        def chunk(delta=None, usage=None):
            obj = {"model": name, "choices": [{"index": 0, "delta": delta}] if delta is not None else []}
            if usage:
                obj["usage"] = usage
            return f"data: {json.dumps(obj)}\n\n".encode()

        fake = self
        words = [w + " " for w in self.answer.split(" ")]
        words[-1] = words[-1].rstrip()

        async def gen():
            yield chunk({"reasoning_content": "Let me think about it."})
            if mode == "think-tags":
                yield chunk({"content": "<thi"})
                yield chunk({"content": "nk>secret plan</think>"})
            for i, w in enumerate(words):
                if fake.on_stream_chunk:
                    await fake.on_stream_chunk(i)
                yield chunk({"content": w})
                if mode == "midstream" and i == 0:
                    yield f"data: {json.dumps({'error': {'message': 'connection reset'}})}\n\n".encode()
                    return
            usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": fake.usage_cost}
            yield chunk(None, usage)
            yield b"data: [DONE]\n\n"

        return httpx.Response(
            200,
            content=gen(),
            headers={"content-type": "text/event-stream", "x-litellm-model-name": served},
        )

    def streamed_models(self) -> list[str]:
        return [b["model"] for b in self.stream_calls]

    def deployments(self, alias: str | None = None) -> list[dict]:
        return [m for m in self.models.values() if alias is None or m["model_name"] == alias]


class FakeOllama:
    """Ollama's native API (M3a): the classifier, titles/summaries (tasks model), tags, ps, pull."""

    def __init__(self):
        self.calls: list[dict] = []
        self.route: str | None = None  # classifier answer; None -> 404 (not pulled): heuristics
        self.routes: dict[str, str] = {}  # substring of the user message -> route
        self.classifier_delay = 0.0
        self.title = "Centering a div in CSS"
        self.title_status = 200
        self.summary = "- The user is planning a trip to Japan in April.\n- Budget: 2000 USD."
        self.summary_status = 200
        self.down = False
        self.installed = ["qwen3:4b", "llama3.2:3b", "hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M"]
        self.loaded: list[str] = []
        self.unloaded: list[str] = []
        self.cpu: set[str] = set()  # models pinned to the CPU (num_gpu 0): `ollama ps` shows size_vram 0

    def install(self, mock: respx.MockRouter) -> None:
        base = "http://ollama.test"
        mock.post(f"{base}/api/chat").mock(side_effect=self.chat)
        mock.get(f"{base}/api/tags").mock(side_effect=self.tags)
        mock.get(f"{base}/api/ps").mock(side_effect=self.ps)
        mock.post(f"{base}/api/generate").mock(side_effect=self.generate)

    def _down(self):
        if self.down:
            raise httpx.ConnectError("connection refused")

    async def chat(self, request):
        self._down()
        body = json.loads(request.content)
        self.calls.append(body)
        if (body.get("options") or {}).get("num_gpu") == 0:
            self.cpu.add(body["model"])
        model, text = body["model"], body["messages"][-1]["content"]
        r = await self._answer(model, text)
        if r.status_code == 200 and model not in self.loaded:
            self.loaded.append(model)
        return r

    async def _answer(self, model, text):
        if "Arch-Router" in model:
            if self.classifier_delay:
                import asyncio

                await asyncio.sleep(self.classifier_delay)
            conv = text.split("<conversation>", 1)[-1]
            route = next((r for k, r in self.routes.items() if k in conv), self.route)
            if route is None:
                return httpx.Response(404, json={"error": f"model '{model}' not found"})
            return httpx.Response(200, json={"message": {"content": json.dumps({"route": route})}})
        if text.startswith("Write a title"):
            if self.title_status != 200:
                return httpx.Response(self.title_status, json={"error": "down"})
            return httpx.Response(200, json={"message": {"content": self.title}})
        if text.startswith("You keep a running summary"):
            if self.summary_status != 200:
                return httpx.Response(self.summary_status, json={"error": "down"})
            return httpx.Response(200, json={"message": {"content": self.summary}})
        return httpx.Response(200, json={"message": {"content": "hi"}})

    def tags(self, request):
        self._down()
        return httpx.Response(200, json={"models": [{"name": n} for n in self.installed]})

    def ps(self, request):
        self._down()
        models = [{"name": n, "size": 2**30, "size_vram": 0 if n in self.cpu else 2**30} for n in self.loaded]
        return httpx.Response(200, json={"models": models})

    def generate(self, request):
        body = json.loads(request.content)
        if body.get("keep_alive") == 0 and body["model"] in self.loaded:
            self.loaded.remove(body["model"])
            self.unloaded.append(body["model"])
        return httpx.Response(200, json={"done": True})

    def classifier_calls(self) -> list[dict]:
        return [c for c in self.calls if "Arch-Router" in c["model"]]


@pytest.fixture(autouse=True)
def _reset_m3a_state():
    """Module-level state that must not leak between tests."""
    from app import local_profile, local_queue
    from app.routing import classifier
    from app.routing.health import cooldowns

    classifier.reset()
    local_queue.reset()
    local_profile.set_active("small")
    cooldowns.clear()
    yield
    classifier.reset()
    local_queue.reset()
    local_profile.set_active("small")


@pytest.fixture
def ollama_fake(mock_http):
    fake = FakeOllama()
    fake.install(mock_http)
    return fake


@pytest.fixture
def mock_http():
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as mock:
        yield mock


@pytest.fixture
def litellm(mock_http, ollama_fake):
    fake = FakeLiteLLM()
    fake.install(mock_http)
    fake.ollama = ollama_fake
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
                    "bin_path": "~/.local/bin/codex",
                    "bin_dir": "~/.local/bin",
                    "on_user_path": False,
                },
                "gemini": {"installed": True, "version": "0.40.0", "logged_in": False, "windows_only": False},
                "grok": {"installed": False, "version": None, "logged_in": None, "windows_only": False},
                "opencode": {"installed": False, "version": None, "logged_in": None, "windows_only": False},
            }
        },
    )


@pytest.fixture
async def client(litellm):
    from app import sync
    from app.litellm_admin import LiteLLMAdmin
    from app.main import app

    sync.reset()
    app.state.litellm = LiteLLMAdmin()
    app.state.background = {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://router.test") as c:
        yield c
    await app.state.litellm.aclose()
