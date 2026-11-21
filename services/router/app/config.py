"""Router settings, read from the environment (deploy/.env via docker compose)."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    database_url: SecretStr
    litellm_url: str = "http://litellm:4000"
    litellm_master_key: SecretStr
    # LITELLM_SALT_KEY is only fingerprinted (doctor.sh detects an accidental change); never used.
    litellm_salt_key: SecretStr | None = None
    switchboard_secret_key: SecretStr
    router_admin_token: SecretStr
    ollama_api_base: str = "http://host.docker.internal:11434"
    hostprobe_url: str = "http://host.docker.internal:8101"
    paperclip_url: str = "http://host.docker.internal:3100"
    # Paperclip board API key, only for an `authenticated` Paperclip (ADR 0007: local_trusted needs none).
    paperclip_api_key: SecretStr | None = None
    hostprobe_token: SecretStr | None = None
    config_dir: Path = Path("/srv/config")
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    catalog_interval_s: int = 24 * 3600
    # Skip the startup catalog/reconcile/import tasks (tests drive them directly).
    background_jobs: bool = True
    # False = this router never writes to LiteLLM and runs no catalog refresh: used by the throwaway demo
    # router (scripts/demo-reset.sh), so only the main router reconciles (docs/recording-the-demo.md).
    router_sync_enabled: bool = True
    # Non-empty = every LiteLLM call and `requests` row carries this tag (the demo router sets
    # "switchboard-demo") so Metrics (M6) can exclude it.
    router_request_tag: str = ""
    # Dev only (never in compose): lets a chat request carry `fault` to fail a target with a 429 or a
    # timeout, to check fallbacks live (docs/m2.md).
    router_fault_injection: bool = False
    # Dev only (never in compose defaults): low quota limits to demo the quota guard live, e.g.
    # "groq:openai/gpt-oss-120b=rpd:3" (docs/m3a.md). doctor.sh warns while it is set.
    router_quota_test_limits: str = ""
    # Dev only (M6.5, never in compose defaults; doctor.sh warns while set): "claude:resets_in=120" makes the
    # next run of that CLI end as if it hit its usage limit, resetting in 120 s, once per job (docs/m65.md).
    router_limit_test: str = ""
    # Dev only: lets paid overflow use a free model, to demo the key lifecycle without spending money. The
    # UI labels such a job "test: free model", never just "Paid".
    router_overflow_allow_free: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
