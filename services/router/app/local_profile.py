"""Local-model profiles (M3a, config/local-models.yaml).

Switchboard is open source and runs on many machines, so the local models are not hard-coded: the GPU
memory is detected (nvidia-smi through hostprobe `/hw`), a profile is recommended, and the owner can
pick another in Settings → Local models. The active profile decides the classifier model, the
`local` / `private` / `local-code` aliases and the model for titles and summaries.

State lives in `system_meta` key `local_profile`: {active, detected: {vram_gb, ram_gb, gpu, source},
recommended, overridden}. The active name is cached in this module (set at startup and on change) so
the registry can read it without a DB session.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client
from app.config import get_settings
from app.models import SystemMeta

if TYPE_CHECKING:
    from app.registry import AliasDeployment

log = logging.getLogger("app.local_profile")

KEY = "local_profile"
LOCAL_ALIASES = ("local", "private", "local-code")


@dataclass(frozen=True)
class Profile:
    name: str
    label: str
    min_vram_gb: float
    classifier: str | None
    general: str
    tasks: str | None
    coder: str | None
    cpu: bool
    max_loaded: int
    classifier_options: dict[str, Any] = field(default_factory=dict, compare=False)

    @property
    def models(self) -> list[str]:
        """Every model this profile uses, classifier first (what setup/doctor pull)."""
        out: list[str] = []
        for m in (self.classifier, self.general, self.tasks, self.coder):
            if m and m not in out:
                out.append(m)
        return out

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "min_vram_gb": self.min_vram_gb,
            "classifier": self.classifier,
            "general": self.general,
            "tasks": self.tasks,
            "coder": self.coder or self.general,
            "cpu": self.cpu,
            "max_loaded": self.max_loaded,
            "models": self.models,
        }


def _path(config_dir: Path | None = None) -> Path:
    return (config_dir or get_settings().config_dir) / "local-models.yaml"


def load_profiles(config_dir: Path | None = None) -> tuple[dict[str, Profile], str]:
    data = yaml.safe_load(_path(config_dir).read_text()) or {}
    out: dict[str, Profile] = {}
    for name, p in (data.get("profiles") or {}).items():
        if not p.get("general"):
            raise ValueError(f"local-models.yaml profile {name}: `general` is required")
        out[str(name)] = Profile(
            name=str(name),
            label=str(p.get("label") or name),
            min_vram_gb=float(p.get("min_vram_gb", 0)),
            classifier=p.get("classifier"),
            general=str(p["general"]),
            tasks=p.get("tasks"),
            coder=p.get("coder"),
            cpu=bool(p.get("cpu", False)),
            max_loaded=int(p.get("max_loaded", 2)),
            classifier_options=dict(p.get("classifier_options") or {}),
        )
    fallback = str(data.get("fallback") or "small")
    if fallback not in out:
        raise ValueError(f"local-models.yaml: fallback {fallback!r} is not a profile")
    return out, fallback


_active: str | None = None


def set_active(name: str | None) -> None:
    global _active
    _active = name


def active() -> Profile:
    profiles, fallback = load_profiles()
    return profiles.get(_active or "", profiles[fallback])


def recommend(vram_gb: float | None) -> str:
    """Largest profile whose `min_vram_gb` fits; unknown VRAM -> the configured fallback."""
    profiles, fallback = load_profiles()
    if vram_gb is None:
        return fallback
    fitting = [p for p in profiles.values() if p.min_vram_gb <= vram_gb + 0.25]  # 3.9 GB cards are "4"
    return max(fitting, key=lambda p: p.min_vram_gb).name if fitting else fallback


def apply(aliases: list[AliasDeployment]) -> list[AliasDeployment]:
    """Point local / private / local-code at the active profile's models."""
    try:
        prof = active()
    except (OSError, ValueError):  # no local-models.yaml (old config dir): keep providers.yaml
        return aliases
    want = {"local": prof.general, "private": prof.general, "local-code": prof.coder or prof.general}
    return [
        replace(a, model=want[a.alias]) if a.alias in want and a.provider == "ollama" else a for a in aliases
    ]


# --- state ----------------------------------------------------------------------------------------
async def load_state(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(SystemMeta, KEY)
    if not row:
        return {}
    try:
        return json.loads(row.value)
    except ValueError:
        return {}


async def save_state(session: AsyncSession, state: dict[str, Any]) -> None:
    row = await session.get(SystemMeta, KEY)
    if row is None:
        session.add(SystemMeta(key=KEY, value=json.dumps(state)))
    else:
        row.value = json.dumps(state)
    await session.commit()
    set_active(state.get("active"))


async def detect() -> dict[str, Any]:
    """GPU memory and RAM from hostprobe `/hw` (nvidia-smi + /proc/meminfo). Never raises."""
    ok, data, err = await hostprobe_client.probe("/hw", timeout=10)
    if not ok or not data:
        return {"vram_gb": None, "ram_gb": None, "gpu": None, "source": "unavailable", "error": err}
    vram_mb = data.get("vram_mb")
    ram_mb = data.get("ram_mb")
    return {
        "vram_gb": round(vram_mb / 1024, 1) if isinstance(vram_mb, int | float) else None,
        "ram_gb": round(ram_mb / 1024, 1) if isinstance(ram_mb, int | float) else None,
        "gpu": data.get("gpu"),
        "source": data.get("source") or "hostprobe",
        "error": data.get("error"),
    }


async def init(session: AsyncSession, redetect: bool = False) -> dict[str, Any]:
    """Startup: load the saved profile; on first start (or `redetect`) detect and recommend. A profile
    the owner picked is never replaced by detection."""
    state = await load_state(session)
    profiles, _ = load_profiles()
    if redetect or "detected" not in state:
        det = await detect()
        state["detected"] = det
        state["recommended"] = recommend(det["vram_gb"])
        if not state.get("overridden") or state.get("active") not in profiles:
            state["active"], state["overridden"] = state["recommended"], False
        await save_state(session, state)
    elif state.get("active") not in profiles:
        state["active"], state["overridden"] = state.get("recommended") or recommend(None), False
        await save_state(session, state)
    set_active(state["active"])
    return state


async def choose(session: AsyncSession, name: str | None) -> dict[str, Any]:
    """Settings → Local models. `None` goes back to the detected recommendation."""
    profiles, _ = load_profiles()
    state = await load_state(session)
    if name is None:
        state["active"], state["overridden"] = state.get("recommended") or recommend(None), False
    else:
        if name not in profiles:
            raise ValueError(f"unknown profile {name!r}")
        state["active"], state["overridden"] = name, name != state.get("recommended")
    await save_state(session, state)
    return state


def view(state: dict[str, Any], installed: list[str] | None = None) -> dict[str, Any]:
    profiles, fallback = load_profiles()
    act = profiles.get(state.get("active") or "", profiles[fallback])
    missing = [m for m in act.models if installed is not None and not _installed(m, installed)]
    return {
        "active": act.name,
        "recommended": state.get("recommended") or fallback,
        "overridden": bool(state.get("overridden")),
        "detected": state.get("detected") or {"vram_gb": None, "ram_gb": None, "source": "unavailable"},
        "profiles": [p.as_dict() for p in profiles.values()],
        "installed": installed,
        "missing": missing,
    }


def _installed(model: str, installed: list[str]) -> bool:
    """Ollama lists `qwen3:4b`; a name without a tag means `:latest`."""
    names = set(installed)
    return model in names or (":" not in model and f"{model}:latest" in names)
