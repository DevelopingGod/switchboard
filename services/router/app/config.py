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
    hostprobe_token: SecretStr | None = None
    config_dir: Path = Path("/srv/config")
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    catalog_interval_s: int = 24 * 3600
    # Skip the startup catalog/reconcile/import tasks (tests drive them directly).
    background_jobs: bool = True
    # Dev only (never in compose): lets a chat request carry `fault` to fail a target with a 429 or a
    # timeout, to check fallbacks live (docs/m2.md).
    router_fault_injection: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
