"""The workflow pack registry (M4.5a, SPEC §8a, ADR 0018): `packs/<id>/pack.yaml` + its committed lock.

Validated like rules and agents: hand-written checks that name the field, frozen dataclasses, cached by file
modification time. A manifest error makes that one pack unavailable (listed with the reason); the others still load.
The lock must match its manifest (`spec`), or the pack can't be installed until a maintainer re-runs
`python3 scripts/pack-lock.py <id>`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from app.config import get_settings

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
NPM_SOURCE = re.compile(r"npm:((?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)")
PYPI_SOURCE = re.compile(r"pypi:([A-Za-z0-9][A-Za-z0-9._-]*)==(\d+(?:\.\d+){1,3}(?:[-+.]?[0-9A-Za-z.]+)?)")
GIT_SOURCE = re.compile(r"git:https://[^\s]+")
REQUIRES = re.compile(r"(node|python)\s*((?:>=|<=|==|>|<)\s*[\d.]+(?:\s*,\s*(?:>=|<=|==|>|<)\s*[\d.]+)*)")
PLACEHOLDERS = {"{tool_id}", "{tool_ids}"}
ENV_KEY = re.compile(r"[A-Z][A-Z0-9_]{0,60}")
# Host ids are agent CLIs as packs name them; an agent's host is its CLI (claude -> claude-code).
HOSTS = {"claude-code", "codex", "opencode", "gemini-cli", "grok-build", "hermes"}
# Fields copied into the lock (scripts/pack-lock.py SPEC_FIELDS); the lock must match them exactly.
SPEC_FIELDS = (
    "id", "name", "trust", "source", "requires", "scope", "hosts", "bins", "env", "detect", "project", "owned",
    "artifacts", "allow", "cache", "auto",
)


def host_of(cli: str) -> str:
    return {"claude": "claude-code", "gemini": "gemini-cli", "grok": "grok-build"}.get(cli, cli)


class PackError(ValueError):
    pass


@dataclass(frozen=True)
class Step:
    id: str
    label: str
    skill: str
    task: str


@dataclass(frozen=True)
class Flow:
    id: str
    label: str
    summary: str
    steps: tuple[Step, ...]


@dataclass(frozen=True)
class Pack:
    id: str
    name: str
    summary: str
    trust: str  # verified | community
    source: str
    kind: str  # npm | pypi | git
    package: str | None
    version: str | None
    homepage: str | None = None
    repository: str | None = None
    license: str | None = None
    lookalikes: tuple[str, ...] = ()
    requires: tuple[str, ...] = ()
    scope: tuple[str, ...] = ("project",)
    hosts: dict[str, str] = field(default_factory=dict, compare=False)
    refused: str | None = None  # why it can't be installed (global-only)
    owned: tuple[str, ...] = ()
    artifacts: tuple[str, ...] = ()
    allow: tuple[str, ...] = ()
    invoke: dict[str, str] = field(default_factory=dict, compare=False)
    flows: tuple[Flow, ...] = ()
    auto: str | None = None  # "graph": an automatic pack (ADR 0019)
    note: str | None = None  # told to the agent when the pack is set up
    skill_file: str | None = None  # where a skill's instructions are in the worktree ("{skill}" placeholder)
    lock_problem: str | None = None  # the lock is missing or doesn't match the manifest

    @property
    def installable(self) -> bool:
        return self.refused is None and self.lock_problem is None

    def flow(self, flow_id: str) -> Flow | None:
        return next((f for f in self.flows if f.id == flow_id), None)

    def invoke_for(self, host: str, skill: str) -> str:
        form = self.invoke.get(host) or "/{skill}"
        return form.replace("{skill}", skill)


def _str(raw: dict, key: str, where: str, required: bool = True, max_len: int = 400) -> str | None:
    v = raw.get(key)
    if v is None and not required:
        return None
    if not isinstance(v, str) or not v.strip() or len(v) > max_len:
        raise PackError(f"{where}.{key}: a non-empty string of at most {max_len} characters is required")
    return v.strip()


def _strs(raw: dict, key: str, where: str) -> tuple[str, ...]:
    v = raw.get(key) or []
    if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v):
        raise PackError(f"{where}.{key}: a list of strings is required")
    return tuple(v)


def _argvs(raw: Any, where: str, bins: dict[str, str]) -> None:
    if raw is None:
        return
    if not isinstance(raw, list):
        raise PackError(f"{where}: a list of commands (each a list of words) is required")
    for i, argv in enumerate(raw):
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            raise PackError(f"{where}[{i}]: a command is a list of words")
        if argv[0] not in bins:
            raise PackError(f"{where}[{i}]: {argv[0]!r} is not one of the pack's programs ({', '.join(bins)})")
        for a in argv:
            if "{" in a and a not in PLACEHOLDERS:
                raise PackError(f"{where}[{i}]: {a!r}: the only placeholders are {{tool_id}} and {{tool_ids}}")


def parse(raw: Any, folder: str) -> Pack:
    where = f"packs/{folder}/pack.yaml"
    if not isinstance(raw, dict):
        raise PackError(f"{where}: a mapping is required")
    pid = _str(raw, "id", where)
    if pid != folder or not ID_RE.fullmatch(pid or ""):
        raise PackError(f"{where}.id: must be the folder name ({folder}), lower-case letters, digits and dashes")
    trust = raw.get("trust", "community")
    if trust not in ("verified", "community"):
        raise PackError(f"{where}.trust: verified or community")
    source = _str(raw, "source", where) or ""
    scope = _strs(raw, "scope", where) or ("project",)
    if not set(scope) <= {"project", "global"}:
        raise PackError(f"{where}.scope: project and/or global")
    refused = _str(raw, "refused", where, required=False, max_len=600)
    if "project" not in scope and not refused:
        raise PackError(f"{where}.refused: a global-only pack must say, in plain words, why it is refused")
    if "project" not in scope:
        kind, package, version = "git", None, None
        if not (GIT_SOURCE.fullmatch(source) or NPM_SOURCE.fullmatch(source) or PYPI_SOURCE.fullmatch(source)):
            raise PackError(f"{where}.source: npm:<name>@<version>, pypi:<name>==<version> or git:https://…")
    elif m := NPM_SOURCE.fullmatch(source):
        kind, package, version = "npm", m.group(1), m.group(2)
    elif m := PYPI_SOURCE.fullmatch(source):
        kind, package, version = "pypi", m.group(1), m.group(2)
    else:
        raise PackError(
            f"{where}.source: an exact package and version: npm:<name>@<x.y.z> or pypi:<name>==<x.y.z> "
            "(never latest, never a range)"
        )
    lookalikes = _strs(raw, "lookalikes", where)
    if package and package in lookalikes:
        raise PackError(f"{where}.lookalikes: lists the pack's own package {package}")
    requires = _strs(raw, "requires", where)
    for r in requires:
        if not REQUIRES.fullmatch(r):
            raise PackError(f"{where}.requires: {r!r}: like node>=22.20 or python>=3.11.5,<3.15")
    hosts = raw.get("hosts") or {}
    if not isinstance(hosts, dict) or not hosts or not all(isinstance(v, str) and v for v in hosts.values()):
        raise PackError(f"{where}.hosts: a mapping of agent host -> the pack's own tool id is required")
    unknown = set(hosts) - HOSTS
    if unknown:
        raise PackError(f"{where}.hosts: unknown host {sorted(unknown)[0]!r} (one of {', '.join(sorted(HOSTS))})")
    bins = raw.get("bins") or {}
    project = raw.get("project") or {}
    if "project" in scope:
        if not isinstance(bins, dict) or not bins:
            raise PackError(f"{where}.bins: the pack's programs (name -> path inside its install) are required")
        for name, rel in bins.items():
            if not ID_RE.fullmatch(str(name)) or not isinstance(rel, str) or rel.startswith("/") or ".." in rel:
                raise PackError(f"{where}.bins.{name}: a relative path inside the install")
        if not isinstance(project, dict) or not set(project) <= {"setup", "prepare"}:
            raise PackError(f"{where}.project: setup and/or prepare (lists of commands)")
        _argvs(project.get("setup"), f"{where}.project.setup", bins)
        _argvs(project.get("prepare"), f"{where}.project.prepare", bins)
        detect = raw.get("detect")
        if detect is not None:
            _argvs([detect], f"{where}.detect", bins)
    env = raw.get("env") or {}
    if not isinstance(env, dict) or not all(ENV_KEY.fullmatch(str(k)) for k in env):
        raise PackError(f"{where}.env: UPPER_CASE names only")
    owned = _strs(raw, "owned", where)
    artifacts = _strs(raw, "artifacts", where)
    for g in (*owned, *artifacts):
        if g.startswith("/") or ".." in g.split("/") or g.startswith(".git/") or g.startswith(".switchboard"):
            raise PackError(f"{where}: {g!r} must be a path pattern inside the project")
    invoke = raw.get("invoke") or {}
    if not isinstance(invoke, dict) or not all(isinstance(v, str) and "{skill}" in v for v in invoke.values()):
        raise PackError(f"{where}.invoke: host -> a form containing {{skill}}")
    flows = []
    for i, f in enumerate(raw.get("flows") or []):
        fw = f"{where}.flows[{i}]"
        if not isinstance(f, dict):
            raise PackError(f"{fw}: a mapping is required")
        steps = []
        for j, s in enumerate(f.get("steps") or []):
            sw = f"{fw}.steps[{j}]"
            if not isinstance(s, dict):
                raise PackError(f"{sw}: a mapping is required")
            steps.append(Step(_str(s, "id", sw) or "", _str(s, "label", sw) or "", _str(s, "skill", sw) or "",
                              _str(s, "task", sw, max_len=1000) or ""))
        if len(steps) < 1 or len(steps) > 6:
            raise PackError(f"{fw}.steps: 1 to 6 steps")
        flows.append(Flow(_str(f, "id", fw) or "", _str(f, "label", fw) or "", _str(f, "summary", fw) or "",
                          tuple(steps)))
    auto = raw.get("auto")
    if auto not in (None, "graph"):
        raise PackError(f"{where}.auto: graph (or leave it out)")
    if auto == "graph" and not raw.get("cache"):
        raise PackError(f"{where}.cache: an automatic graph pack names the folder it builds (its cache)")
    return Pack(
        id=pid,
        name=_str(raw, "name", where, max_len=80) or pid,
        summary=_str(raw, "summary", where, max_len=200) or "",
        trust=trust,
        source=source,
        kind=kind,
        package=package,
        version=version,
        homepage=_str(raw, "homepage", where, required=False),
        repository=_str(raw, "repository", where, required=False),
        license=_str(raw, "license", where, required=False, max_len=40),
        lookalikes=lookalikes,
        requires=requires,
        scope=scope,
        hosts=dict(hosts),
        refused=refused,
        owned=owned,
        artifacts=artifacts,
        allow=_strs(raw, "allow", where),
        invoke=dict(invoke),
        flows=tuple(flows),
        auto=auto,
        note=_str(raw, "note", where, required=False, max_len=1000),
        skill_file=_skill_file(raw, where),
    )


def _skill_file(raw: dict, where: str) -> str | None:
    v = _str(raw, "skill_file", where, required=False)
    if v is not None and ("{skill}" not in v or v.startswith("/") or ".." in v.split("/")):
        raise PackError(f"{where}.skill_file: a path inside the project containing {{skill}}")
    return v


def spec_of(raw: dict) -> dict:
    return {k: raw[k] for k in SPEC_FIELDS if k in raw}


def lock_problem(raw: dict, lock_path: Path) -> str | None:
    try:
        lock = json.loads(lock_path.read_text())
    except FileNotFoundError:
        return "the pack has no lock yet (python3 scripts/pack-lock.py <id>)"
    except ValueError:
        return "the pack's lock is not valid JSON"
    if lock.get("spec") != spec_of(raw):
        return "the pack's lock doesn't match its manifest (python3 scripts/pack-lock.py <id>)"
    return None


@dataclass(frozen=True)
class Registry:
    packs: dict[str, Pack]
    errors: dict[str, str]  # folder -> why it didn't load

    def get(self, pid: str) -> Pack | None:
        return self.packs.get(pid)


_cache: tuple[tuple, Registry] | None = None


def _root() -> Path:
    return get_settings().packs_dir


def load() -> Registry:
    """Every pack under packs/, re-read when a manifest or lock changes."""
    global _cache
    root = _root()
    folders = sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    key = tuple(
        (f.name, *(int(x.stat().st_mtime_ns) if x.exists() else 0 for x in (f / "pack.yaml", f / "pack.lock.json")))
        for f in folders
    )
    if _cache and _cache[0] == key:
        return _cache[1]
    packs: dict[str, Pack] = {}
    errors: dict[str, str] = {}
    for f in folders:
        if not (f / "pack.yaml").is_file():
            continue
        try:
            raw = yaml.safe_load((f / "pack.yaml").read_text())
            pack = parse(raw, f.name)
            if "project" in pack.scope:
                problem = lock_problem(raw, f / "pack.lock.json")
                if problem:
                    pack = replace(pack, lock_problem=problem)
            packs[pack.id] = pack
        except (PackError, yaml.YAMLError) as e:
            errors[f.name] = str(e)
    reg = Registry(packs, errors)
    _cache = (key, reg)
    return reg
