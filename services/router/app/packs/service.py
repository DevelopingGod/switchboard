"""Per-project pack settings, what a job sets up, and graphify's holdout (M4.5a, ADRs 0018-0019).

`projects.packs` (JSONB):
    {"openspec": {"enabled": true, "hosts": ["claude-code"]},
     "graphify": {"mode": "auto" | "always" | "off", "hosts": [...],
                  "measure": {"<agent>|<flow or plain>": {state, round, seen, since, arm, decided, numbers}}}}

`jobs.packs` (JSONB), written when the job's packs are set up:
    {"requested": [...], "setup": {...hostprobe's record, trimmed...}, "refused": [...],
     "graphify": {"group", "round", "used", "control", "reason", "build_ms", "nodes"}}

Packs are lazy (SPEC §8a.6): a job sets up only the pack its workflow uses, plus graphify when the graph decision
says so. Nothing here runs a command: hostprobe does, from the pack's lock.
"""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client
from app.agents import AgentDef
from app.config import get_settings
from app.models import Cost, Job, Project
from app.packs.registry import Pack, Registry, host_of, load

GRAPH_MODES = ("auto", "always", "off")


# --- config/packs.yaml ----------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Measure:
    holdout_every: int = 5
    min_samples: int = 5
    min_gain: float = 0.10
    recheck_every: int = 20


@dataclass(frozen=True)
class PackConfig:
    min_files: int = 1500
    min_bytes: int = 20_000_000
    measure: Measure = Measure()
    setup_timeout_s: int = 1800


_cfg: tuple[float, PackConfig] | None = None


def config() -> PackConfig:
    global _cfg
    path = Path(get_settings().config_dir) / "packs.yaml"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return PackConfig()
    if _cfg and _cfg[0] == mtime:
        return _cfg[1]
    raw = yaml.safe_load(path.read_text()) or {}
    g = raw.get("graphify") or {}
    auto, m = g.get("auto") or {}, g.get("measure") or {}

    def num(d: dict, k: str, default: float, lo: float, hi: float) -> float:
        v = d.get(k, default)
        if not isinstance(v, int | float) or isinstance(v, bool) or not lo <= v <= hi:
            raise ValueError(f"config/packs.yaml graphify {k}: a number from {lo:g} to {hi:g}")
        return v

    cfg = PackConfig(
        min_files=int(num(auto, "min_files", 1500, 1, 10_000_000)),
        min_bytes=int(num(auto, "min_bytes", 20_000_000, 1, 10**12)),
        measure=Measure(
            holdout_every=int(num(m, "holdout_every", 5, 2, 100)),
            min_samples=int(num(m, "min_samples", 5, 1, 100)),
            min_gain=float(num(m, "min_gain", 0.10, 0, 0.9)),
            recheck_every=int(num(m, "recheck_every", 20, 1, 1000)),
        ),
        setup_timeout_s=int(num(raw, "setup_timeout_s", 1800, 60, 7200)),
    )
    _cfg = (mtime, cfg)
    return cfg


# --- what is installed (hostprobe) ------------------------------------------------------------------------
_installed: tuple[float, dict[str, Any]] | None = None


async def installed(fresh: bool = False) -> dict[str, Any]:
    """hostprobe's view of the store: {"packs": {id: {current, previous, versions}}, "service_path", ...}.
    Cached for 10 s. Never raises: `reachable` False when hostprobe is down."""
    global _installed
    if not fresh and _installed and time.monotonic() - _installed[0] < 10:
        return _installed[1]
    status, data = await hostprobe_client.call("GET", "/packs", timeout=20)
    if status != 200:
        out = {"reachable": False, "error": data.get("error"), "packs": {}}
    else:
        out = {
            "reachable": True,
            "packs": {p["id"]: p for p in data.get("packs") or [] if isinstance(p, dict) and "id" in p},
            "store": data.get("store"),
            "network_isolated": data.get("network_isolated"),
            "service_path": data.get("service_path"),
        }
    _installed = (time.monotonic(), out)
    return out


def forget_installed() -> None:
    global _installed
    _installed = None


# --- per-project settings ---------------------------------------------------------------------------------
def settings_of(project: Project, reg: Registry | None = None) -> dict[str, dict[str, Any]]:
    """A project's pack settings with defaults filled in (every installable pack listed)."""
    reg = reg or load()
    raw = project.packs or {}
    out: dict[str, dict[str, Any]] = {}
    for pack in reg.packs.values():
        if not pack.installable:
            continue
        cur = raw.get(pack.id) or {}
        hosts = [h for h in cur.get("hosts") or list(pack.hosts) if h in pack.hosts]
        if pack.auto == "graph":
            mode = cur.get("mode") if cur.get("mode") in GRAPH_MODES else "auto"
            out[pack.id] = {"mode": mode, "hosts": hosts, "measure": cur.get("measure") or {}}
        else:
            out[pack.id] = {"enabled": bool(cur.get("enabled")), "hosts": hosts}
    return out


class SettingsError(ValueError):
    pass


def update(project: Project, body: dict[str, Any], reg: Registry | None = None) -> dict[str, Any]:
    """Apply `{pack: {enabled?, mode?, hosts?, turn_back_on?}}`; measuring state is kept, or reset by
    `turn_back_on` (a fresh round for every group of that pack)."""
    reg = reg or load()
    cur = settings_of(project, reg)
    if not isinstance(body, dict):
        raise SettingsError("a mapping of pack id -> settings is required")
    for pid, change in body.items():
        pack = reg.get(pid)
        if pack is None or not pack.installable:
            raise SettingsError(f"{pid}: not an installable pack")
        if not isinstance(change, dict):
            raise SettingsError(f"{pid}: a mapping of settings is required")
        entry = dict(cur[pid])
        if "hosts" in change:
            hosts = change["hosts"]
            if not isinstance(hosts, list) or not all(isinstance(h, str) and h in pack.hosts for h in hosts):
                raise SettingsError(f"{pid}: hosts must be among {', '.join(pack.hosts)}")
            entry["hosts"] = list(dict.fromkeys(hosts))
        if pack.auto == "graph":
            if "mode" in change:
                if change["mode"] not in GRAPH_MODES:
                    raise SettingsError(f"{pid}: mode is auto, always or off")
                entry["mode"] = change["mode"]
            if change.get("turn_back_on"):
                entry["measure"] = {}
                if entry["mode"] == "off":
                    entry["mode"] = "auto"
        elif "enabled" in change:
            if not isinstance(change["enabled"], bool):
                raise SettingsError(f"{pid}: enabled is true or false")
            entry["enabled"] = change["enabled"]
        cur[pid] = entry
    project.packs = cur
    return cur


# --- flows (OpenSpec) -------------------------------------------------------------------------------------
def flow_ref(value: str | None) -> tuple[Pack, Any] | None:
    """"openspec.change" -> (pack, flow); None when unknown."""
    if not value or "." not in value:
        return None
    pid, fid = value.split(".", 1)
    pack = load().get(pid)
    flow = pack.flow(fid) if pack else None
    return (pack, flow) if pack and flow else None


def check_flow(value: str | None, project: Project, agent: AgentDef, autonomy: int) -> str | None:
    """None if this job may run the flow, else a plain reason."""
    if not value:
        return None
    ref = flow_ref(value)
    if ref is None:
        return f"Unknown workflow {value}"
    pack, flow = ref
    if not pack.installable:
        return f"{pack.name} can't be used: {pack.refused or pack.lock_problem}"
    st = settings_of(project).get(pack.id) or {}
    if not st.get("enabled"):
        return f"{pack.name} isn't turned on for this project (Settings → Projects)"
    host = host_of(agent.cli)
    if host not in st.get("hosts", []):
        return f"{pack.name} isn't set up for {agent.label} in this project (Settings → Projects)"
    if autonomy < 1:
        return f"{flow.label} writes files, so it needs autonomy 1 or more"
    return None


def flow_task(job: Job, agent: AgentDef) -> tuple[str, str] | None:
    """(step label, the task text for the current step) of a flow job."""
    ref = flow_ref(job.flow)
    if ref is None:
        return None
    pack, flow = ref
    step = flow.steps[min(job.run_index, len(flow.steps) - 1)]
    host = host_of(agent.cli)
    invoke = pack.invoke_for(host, step.skill)
    n, total = job.run_index + 1, len(flow.steps)
    return step.label, (
        f"{job.prompt}\n\n"
        f"This job follows the {pack.name} workflow ({flow.label}). Step {n} of {total}: {step.label}.\n"
        f"Use the `{step.skill}` skill (invoke it as `{invoke}`)"
        + (f"; if it isn't offered to you, read `{pack.skill_file.replace('{skill}', step.skill)}` and follow it"
           if pack.skill_file else "")
        + f". {step.task}\n\n"
        "Work only in this folder. Don't commit, don't push. End with a short summary of what you did."
    )


def flow_steps(job: Job) -> int:
    ref = flow_ref(job.flow)
    return len(ref[1].steps) if ref else 0


# --- what a job sets up -----------------------------------------------------------------------------------
def group_key(agent_id: str, flow: str | None) -> str:
    return f"{agent_id}|{flow or 'plain'}"


async def graph_decision(
    session: AsyncSession, project: Project, agent: AgentDef, job: Job, size_fn: Any
) -> dict[str, Any]:
    """Whether this job builds and uses the graph: {eligible, used, control, reason, group, round}.

    Mutates `project.packs` (the group's counters); the caller commits."""
    reg = load()
    pack = next((p for p in reg.packs.values() if p.auto == "graph" and p.installable), None)
    out: dict[str, Any] = {"eligible": False, "used": False, "control": False, "reason": None}
    if pack is None:
        out["reason"] = "no graph pack"
        return out
    st = settings_of(project, reg)[pack.id]
    out["pack"] = pack.id
    host = host_of(agent.cli)
    cfg = config()
    if st["mode"] == "off":
        out["reason"] = "Off for this project"
        return out
    if host not in pack.hosts or host not in st["hosts"]:
        out["reason"] = f"not set up for {agent.label}"
        return out
    inst = (await installed()).get("packs", {}).get(pack.id) or {}
    if not inst.get("current"):
        out["reason"] = f"{pack.name} isn't installed"
        return out
    if st["mode"] == "auto":
        size = await size_fn()
        out["size"] = size
        if size is None:
            out["reason"] = "the project's size is unknown"
            return out
        big = size.get("files", 0) >= cfg.min_files or size.get("bytes", 0) >= cfg.min_bytes
        if not big:
            out["reason"] = (
                f"the project is below the Auto threshold ({size.get('files')} files, "
                f"{round(size.get('bytes', 0) / 1e6, 1)} MB; needs {cfg.min_files} files or "
                f"{round(cfg.min_bytes / 1e6)} MB)"
            )
            return out
    out["eligible"] = True
    key = group_key(job.agent, job.flow)
    out["group"] = key
    measures = dict(st.get("measure") or {})
    m = dict(measures.get(key) or {"state": "measuring", "round": 1, "seen": 0, "since": 0, "arm": "both"})
    m["seen"] = int(m.get("seen", 0)) + 1
    every = cfg.measure.holdout_every
    if m["state"] == "measuring":
        sample = m["seen"] % every == 0
        if m.get("arm", "both") == "both":
            out["used"], out["control"] = not sample, sample
        elif m["arm"] == "control":  # re-check while on: a control every n-th job
            out["used"], out["control"] = not sample, sample
        else:  # re-check while off: the graph every n-th job
            out["used"], out["control"] = sample, not sample
    else:
        m["since"] = int(m.get("since", 0)) + 1
        out["used"] = m["state"] == "on"
        out["control"] = False
        if m["since"] >= cfg.measure.recheck_every:
            m.update(state="measuring", round=int(m.get("round", 1)) + 1, since=0,
                     arm="control" if m["state"] == "on" else "graph", seen=0)
    out["round"] = m["round"]
    out["reason"] = (
        "control job (runs without the graph to measure it)" if out["control"]
        else ("graph used" if out["used"] else "graph off for this group: no token gain")
    )
    measures[key] = m
    project.packs = {**(project.packs or {}), pack.id: {**st, "measure": measures}}
    return out


async def job_requests(
    session: AsyncSession, project: Project, job: Job, agent: AgentDef, worktree_body: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The pack setup requests for this job, and what to record in `jobs.packs`."""
    host = host_of(agent.cli)
    reqs: list[dict[str, Any]] = []
    info: dict[str, Any] = {}
    ref = flow_ref(job.flow)
    if ref is not None:
        reqs.append({"id": ref[0].id, "hosts": [host]})
    async def size_fn() -> dict[str, Any] | None:  # only asked when graphify could apply (Auto mode)
        status, res = await hostprobe_client.call("POST", "/git/worktrees/size", worktree_body)
        return res if status == 200 else None

    g = await graph_decision(session, project, agent, job, size_fn)
    info["graphify"] = g
    if g.get("used"):
        reqs.append({"id": g["pack"], "hosts": [host], "graph": True})
    info["requested"] = [r["id"] for r in reqs]
    return reqs, info


def setup_summary(rec: dict[str, Any]) -> dict[str, Any]:
    """What jobs.packs keeps of hostprobe's setup record (the job page shows it)."""
    out: dict[str, Any] = {"refused": rec.get("refused") or [], "bins": rec.get("bins") or [], "packs": {}}
    for pid, p in (rec.get("packs") or {}).items():
        out["packs"][pid] = {
            "name": p.get("name"),
            "version": p.get("version"),
            "verify_ms": p.get("verify_ms"),
            "verify_files": p.get("verify_files"),
            "owned": sorted([*(p.get("owned_dirs") or []), *(p.get("owned_files") or [])])[:200],
            "artifacts": (p.get("artifacts") or [])[:200],
            "edits": [{"path": e.get("path"), "kind": e.get("kind")} for e in p.get("edits") or []][:200],
            "steps": p.get("steps") or [],
            "graph": p.get("graph"),
            "graph_stats": p.get("graph_stats"),
            "cache_used": p.get("cache_used"),
        }
    return out


def agent_note(job: Job) -> str:
    """Told to the agent after its task: what each set-up pack is for."""
    notes = []
    for pid in ((job.packs or {}).get("setup") or {}).get("packs") or {}:
        pack = load().get(pid)
        if pack and pack.note:
            notes.append(pack.note)
    return ("\n\n" + "\n\n".join(notes)) if notes else ""


def allowed_commands(job: Job) -> list[str]:
    out: list[str] = []
    for pid in ((job.packs or {}).get("setup") or {}).get("packs") or {}:
        pack = load().get(pid)
        if pack:
            out += list(pack.allow)
    return out


# --- measuring (ADR 0019) ---------------------------------------------------------------------------------
def tokens_expr():
    """One definition of a job's tokens, shared with Metrics: input + cached input + output."""
    return (
        func.coalesce(Cost.tokens_in, 0) + func.coalesce(Cost.tokens_cached, 0) + func.coalesce(Cost.tokens_out, 0)
    )


async def samples(session: AsyncSession, project_id: int, group: str) -> list[dict[str, Any]]:
    """Finished jobs of one group with their arm and tokens, newest first (bounded)."""
    agent_id, _, flow = group.partition("|")
    q = (
        select(
            Job.id,
            Job.finished_at,
            Job.packs["graphify"]["used"].astext,
            Job.packs["graphify"]["round"].astext,
            func.coalesce(func.sum(tokens_expr()), 0),
            func.coalesce(func.sum(func.coalesce(Cost.tokens_cached, 0)), 0),
            func.count(Cost.tokens_cached),
        )
        .join(Cost, Cost.job_id == Job.id, isouter=True)
        .where(
            Job.project_id == project_id,
            Job.agent == agent_id,
            Job.status == "done",
            Job.packs["graphify"]["eligible"].astext == "true",
            (Job.flow == flow) if flow != "plain" else Job.flow.is_(None),
        )
        .group_by(Job.id)
        .order_by(Job.finished_at.desc())
        .limit(200)
    )
    rows = (await session.execute(q)).all()
    return [
        {"job": r[0], "used": r[2] == "true", "round": int(r[3] or 0), "tokens": int(r[4]),
         "cached": int(r[5]), "has_cached": bool(r[6])}
        for r in rows
    ]


def _median(xs: list[int]) -> float | None:
    return float(statistics.median(xs)) if xs else None


async def reconsider(session: AsyncSession, project: Project, group: str) -> dict[str, Any] | None:
    """After a job of the group finished: decide when the round has its samples. Returns the event data of a
    decision (or None). Mutates `project.packs`; the caller commits."""
    reg = load()
    pack = next((p for p in reg.packs.values() if p.auto == "graph"), None)
    if pack is None:
        return None
    st = (project.packs or {}).get(pack.id) or {}
    measures = dict(st.get("measure") or {})
    m = measures.get(group)
    if not m or m.get("state") != "measuring":
        return None
    cfg = config().measure
    rows = await samples(session, project.id, group)
    rnd = int(m.get("round", 1))
    this = [r for r in rows if r["round"] == rnd]
    arm = m.get("arm", "both")
    if arm == "both":
        with_g = [r["tokens"] for r in this if r["used"]][: cfg.min_samples]
        without = [r["tokens"] for r in this if not r["used"]][: cfg.min_samples]
    elif arm == "control":
        without = [r["tokens"] for r in this if not r["used"]][: cfg.min_samples]
        with_g = [r["tokens"] for r in rows if r["used"]][: cfg.min_samples]
    else:
        with_g = [r["tokens"] for r in this if r["used"]][: cfg.min_samples]
        without = [r["tokens"] for r in rows if not r["used"]][: cfg.min_samples]
    if len(with_g) < cfg.min_samples or len(without) < cfg.min_samples:
        return None
    mw, mo = _median(with_g), _median(without)
    gain = (1 - mw / mo) if mo else 0.0
    state = "on" if gain >= cfg.min_gain else "off"
    m = {**m, "state": state, "since": 0, "seen": 0, "decided": int(time.time()),
         "numbers": {"with": mw, "without": mo, "gain": round(gain, 4), "samples": cfg.min_samples, "round": rnd}}
    measures[group] = m
    project.packs = {**(project.packs or {}), pack.id: {**st, "measure": measures}}
    return {"group": group, "state": state, "gain": round(gain, 4), "with": mw, "without": mo}


def status_line(m: dict[str, Any] | None, counts: tuple[int, int], cfg: Measure | None = None) -> str:
    """"Measuring (n of 5)", "Saves 23% tokens (rechecks in 12 jobs)" or "Off: no gain (rechecks in 12 jobs)"."""
    cfg = cfg or config().measure
    if not m or m.get("state") == "measuring":
        arm = (m or {}).get("arm", "both")
        with_n, without_n = counts
        n = min(with_n, without_n) if arm == "both" else (without_n if arm == "control" else with_n)
        return f"Measuring ({min(n, cfg.min_samples)} of {cfg.min_samples})"
    left = max(0, cfg.recheck_every - int(m.get("since", 0)))
    gain = round(100 * float((m.get("numbers") or {}).get("gain") or 0))
    if m.get("state") == "on":
        return f"Saves {gain}% tokens (rechecks in {left} jobs)"
    return f"Off: no gain (rechecks in {left} jobs)"


async def metrics_rows(session: AsyncSession) -> list[dict[str, Any]]:
    """One row per project + agent + flow that graphify has measured."""
    reg = load()
    pack = next((p for p in reg.packs.values() if p.auto == "graph"), None)
    if pack is None:
        return []
    cfg = config().measure
    projects = (await session.scalars(select(Project).where(Project.removed_at.is_(None)))).all()
    out = []
    for project in projects:
        st = (project.packs or {}).get(pack.id) or {}
        for group, m in sorted((st.get("measure") or {}).items()):
            rows = await samples(session, project.id, group)
            rnd = int(m.get("round", 1))
            this = [r for r in rows if r["round"] == rnd]
            with_rows = [r for r in rows if r["used"]][: cfg.min_samples]
            without_rows = [r for r in rows if not r["used"]][: cfg.min_samples]
            agent_id, _, flow = group.partition("|")
            out.append({
                "project_id": project.id,
                "project": project.name,
                "agent": agent_id,
                "flow": None if flow == "plain" else flow,
                "state": m.get("state", "measuring"),
                "status": status_line(m, (sum(r["used"] for r in this), sum(not r["used"] for r in this)), cfg),
                "round": rnd,
                "median_with": _median([r["tokens"] for r in with_rows]),
                "median_without": _median([r["tokens"] for r in without_rows]),
                "cached_with": _median([r["cached"] for r in with_rows]),
                "cached_without": _median([r["cached"] for r in without_rows]),
                "samples_with": len([r for r in rows if r["used"]]),
                "samples_without": len([r for r in rows if not r["used"]]),
                "cached_known": all(r["has_cached"] for r in [*with_rows, *without_rows]) if rows else True,
                "gain": (m.get("numbers") or {}).get("gain"),
                "decided": m.get("decided"),
            })
    return out

