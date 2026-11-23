"""Agent registry (config/agents.yaml, M4a; SPEC §6.1, §7.3; ADR 0007).

Loads and validates the registry, and turns one job run (agent + kind of run + worktree + task) into the
Paperclip agent config that runs it. The CLI flags live in the YAML (verified per CLI version, docs/m4a.md);
this module only fills in placeholders and adds what every run gets:

- a clean environment: no SSH agent, no desktop keyring, no GitHub CLI login, no git credential prompts, and
  a git config (environment only, never the repo's) that makes any `git push` fail before it reaches the
  network;
- `PYTHONDONTWRITEBYTECODE` so test runs don't leave `__pycache__` in the diff;
- for OpenCode, `OPENCODE_DISABLE_PROJECT_CONFIG` so the repo can't widen its own permissions (Claude gets
  `--setting-sources user` in its profiles for the same reason).

Rule for every agent: Switchboard and Paperclip never copy, read, move or write a CLI's login files. Codex
and OpenCode therefore run through Paperclip's plain `process` adapter (their own adapters touch login files
or ~/.claude/skills), Claude through `claude_local` (uses ~/.claude in place).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from app.config import get_settings

RUNNERS = {"claude_local", "process"}
PERMISSION_STYLES = {"claude", "codex", "opencode"}
RUN_KINDS = ("read_only", "edit", "full")
REVIEWS = {"result", "diff"}
PLACEHOLDER = re.compile(r"\{(model|worktree|prompt|allowed)\}")

# Every run's environment (overrides the Paperclip service's own). Empty = unset for the CLI.
PUSH_GUARD_PREFIXES = ("https://", "http://", "ssh://", "git@", "git://")
CLEAN_ENV: dict[str, str] = {
    "SSH_AUTH_SOCK": "",  # the user's SSH agent (push over SSH)
    "DBUS_SESSION_BUS_ADDRESS": "",  # the desktop keyring
    "GH_TOKEN": "",
    "GITHUB_TOKEN": "",
    "GH_CONFIG_DIR": "/nonexistent/switchboard-no-gh",  # the GitHub CLI's login
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "",
    "SSH_ASKPASS": "",
    "PYTHONDONTWRITEBYTECODE": "1",
    # Any push URL is rewritten to a scheme git can't speak, so `git push` fails locally (verified). The
    # repo's own config is untouched; fetch URLs are unchanged.
    "GIT_CONFIG_COUNT": str(len(PUSH_GUARD_PREFIXES)),
    **{
        f"GIT_CONFIG_KEY_{i}": "url.switchboard-no-push:///.pushInsteadOf"
        for i in range(len(PUSH_GUARD_PREFIXES))
    },
    **{f"GIT_CONFIG_VALUE_{i}": p for i, p in enumerate(PUSH_GUARD_PREFIXES)},
}


class AgentsConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Profile:
    args: tuple[str, ...]
    adapter: dict[str, Any] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class AgentDef:
    id: str
    label: str
    cli: str
    capabilities: tuple[str, ...]
    runner: str | None = None
    command: str | None = None
    model: str | None = None
    cost: str = "none"  # reported | none
    permissions: str | None = None
    profiles: dict[str, Profile] = field(default_factory=dict, compare=False)
    full_unavailable: str | None = None
    note: str | None = None
    # Fleet (M4b, ADR 0009): `models` are the choices offered when hiring (agents.yaml); the rest comes from
    # the `agent_profiles` overlay. `template` is the agents.yaml entry a hired agent is built on (None for
    # the built-in agents themselves).
    models: tuple[str, ...] = ()
    template: str | None = None
    role: str | None = None
    default_autonomy: int | None = None
    monthly_list_usd: float | None = None
    allowed_projects: tuple[int, ...] | None = None  # None = every project
    paused: bool = False
    # M6.5: the named account this agent uses (None = the CLI's default login; a project can override it),
    # and whether it is the paid-overflow agent (runs only for a job you confirmed as paid).
    account: str | None = None
    paid: bool = False
    edited: bool = False  # a built-in agent with saved changes ("Reset to default" removes them)

    @property
    def hired(self) -> bool:
        return self.template is not None

    @property
    def runnable(self) -> bool:
        """Has a verified runner (the optional agents are listed but not run yet)."""
        return self.runner is not None

    def level_unavailable(self, level: Level) -> str | None:
        """Why this agent can't run a job at this level, or None."""
        if not self.runnable:
            return self.note or f"{self.label} isn't set up to run jobs yet"
        missing = [k for k in level.runs if k not in self.profiles]
        if missing:
            if "full" in missing and self.full_unavailable:
                return self.full_unavailable
            return f"{self.label} has no {', '.join(missing)} profile"
        return None


@dataclass(frozen=True)
class Level:
    number: int
    runs: tuple[str, ...]
    review: str
    approve_plan: bool = False
    needs_sandbox: bool = False
    needs_budget: bool = False


@dataclass(frozen=True)
class WindowDef:
    id: str
    label: str
    hours: float


@dataclass(frozen=True)
class CliDef:
    """A subscription CLI (M6.5): where its login lives, where it reports its usage window."""

    id: str
    label: str
    home_env: str
    login: str
    usage: str | None  # stream_event | session_file | None
    plans: dict[str, str]
    windows: tuple[WindowDef, ...]
    estimate_by: str  # list_price | tokens
    limit_patterns: tuple[str, ...]

    def window(self, wid: str) -> WindowDef | None:
        return next((w for w in self.windows if w.id == wid), None)

    def plan_label(self, plan: str | None) -> str:
        return self.plans.get(plan or "", self.label)


@dataclass(frozen=True)
class Guard:
    save_at: float = 0.8
    block_at: float = 1.0
    light_levels: tuple[int, ...] = (0,)
    heavy_rules: tuple[str, ...] = ("code-heavy",)


@dataclass(frozen=True)
class Defaults:
    max_active_per_agent: int
    run_timeout_s: int
    run_grace_s: int
    job_timeout_s: int
    max_turns: int
    per_job_list_usd: float
    per_agent_daily_list_usd: float
    per_agent_monthly_list_usd: float | None
    keep_per_project: int
    allowed_commands: tuple[str, ...]
    max_auto_wait_h: float = 12.0
    max_waits: int = 3
    guard: Guard = field(default_factory=Guard)
    litellm_base_url: str = "http://127.0.0.1:4000/v1"
    key_margin_minutes: int = 30


@dataclass(frozen=True)
class AgentRegistry:
    defaults: Defaults
    levels: dict[int, Level]
    agents: dict[str, AgentDef]
    # Hired agents you deleted: never offered or run again, kept so old jobs still show a name.
    retired: dict[str, AgentDef] = field(default_factory=dict)
    clis: dict[str, CliDef] = field(default_factory=dict)  # subscription CLIs (M6.5)

    def subscription(self, agent: AgentDef) -> CliDef | None:
        """The subscription CLI an agent runs on (its usage window and accounts), or None."""
        return None if agent.paid else self.clis.get(agent.cli)

    def label(self, agent_id: str) -> str:
        a = self.agents.get(agent_id) or self.retired.get(agent_id)
        return a.label if a else agent_id

    def agent(self, agent_id: str) -> AgentDef:
        if agent_id not in self.agents:
            raise KeyError(f"no agent called “{agent_id}” in config/agents.yaml")
        return self.agents[agent_id]


def _path(config_dir: Path | None = None) -> Path:
    return (config_dir or get_settings().config_dir) / "agents.yaml"


def _profile(agent_id: str, kind: str, raw: Any) -> Profile:
    if isinstance(raw, list):
        args, adapter = raw, {}
    elif isinstance(raw, dict) and isinstance(raw.get("args"), list):
        args, adapter = raw["args"], dict(raw.get("adapter") or {})
    else:
        raise AgentsConfigError(
            f"agents.yaml {agent_id}.profiles.{kind}: a list of args or {{args, adapter}}"
        )
    if not all(isinstance(a, str) for a in args):
        raise AgentsConfigError(f"agents.yaml {agent_id}.profiles.{kind}: every arg must be a string")
    for a in args:
        for bad in re.findall(r"\{([a-z_]+)\}", a):
            if not PLACEHOLDER.fullmatch("{" + bad + "}"):
                raise AgentsConfigError(
                    f"agents.yaml {agent_id}.profiles.{kind}: unknown placeholder {{{bad}}}"
                )
    return Profile(tuple(args), adapter)


def parse(data: dict[str, Any]) -> AgentRegistry:
    d = data.get("defaults") or {}
    b = d.get("budget") or {}
    cmds = d.get("allowed_commands") or []
    if not all(isinstance(c, str) and c.strip() and not re.search(r"[;&|`$<>]", c) for c in cmds):
        raise AgentsConfigError("agents.yaml defaults.allowed_commands: plain command prefixes only")
    defaults = Defaults(
        max_active_per_agent=int(d.get("max_active_per_agent", 1)),
        run_timeout_s=int(d.get("run_timeout_s", 1800)),
        run_grace_s=int(d.get("run_grace_s", 15)),
        job_timeout_s=int(d.get("job_timeout_s", 7200)),
        max_turns=int(d.get("max_turns", 40)),
        per_job_list_usd=float(b.get("per_job_list_usd", 2.0)),
        per_agent_daily_list_usd=float(b.get("per_agent_daily_list_usd", 10.0)),
        per_agent_monthly_list_usd=(
            float(b["per_agent_monthly_list_usd"])
            if b.get("per_agent_monthly_list_usd") is not None
            else None
        ),
        keep_per_project=int((d.get("worktrees") or {}).get("keep_per_project", 10)),
        allowed_commands=tuple(c.strip() for c in cmds),
    )
    g = d.get("subscription_guard") or {}
    ov = d.get("overflow") or {}
    defaults = replace(
        defaults,
        max_auto_wait_h=float(d.get("max_auto_wait_h", 12)),
        max_waits=int(d.get("max_waits", 3)),
        guard=Guard(
            save_at=float(g.get("save_at", 0.8)),
            block_at=float(g.get("block_at", 1.0)),
            light_levels=tuple(int(x) for x in g.get("light_levels", [0])),
            heavy_rules=tuple(str(x) for x in g.get("heavy_rules", ["code-heavy"])),
        ),
        litellm_base_url=str(ov.get("litellm_base_url") or "http://127.0.0.1:4000/v1"),
        key_margin_minutes=int(ov.get("key_margin_minutes", 30)),
    )
    if not 0 < defaults.guard.save_at <= defaults.guard.block_at <= 1:
        raise AgentsConfigError("agents.yaml defaults.subscription_guard: 0 < save_at ≤ block_at ≤ 1")
    if defaults.max_auto_wait_h < 0 or defaults.max_waits < 1:
        raise AgentsConfigError("agents.yaml defaults: max_auto_wait_h ≥ 0 and max_waits ≥ 1")
    if not re.fullmatch(r"https?://[^\s]+", defaults.litellm_base_url):
        raise AgentsConfigError("agents.yaml defaults.overflow.litellm_base_url: an http(s) URL")
    clis = _clis(data.get("clis") or {})
    if defaults.max_active_per_agent < 1 or defaults.run_timeout_s < 30 or defaults.max_turns < 1:
        raise AgentsConfigError("agents.yaml defaults: limits must be positive (run_timeout_s ≥ 30)")

    levels: dict[int, Level] = {}
    for n, lv in (data.get("levels") or {}).items():
        runs = tuple(lv.get("runs") or ())
        if not runs or any(r not in RUN_KINDS for r in runs):
            raise AgentsConfigError(f"agents.yaml levels.{n}.runs: one or more of {', '.join(RUN_KINDS)}")
        if lv.get("review") not in REVIEWS:
            raise AgentsConfigError(f"agents.yaml levels.{n}.review: result or diff")
        if lv.get("approve_plan") and (len(runs) < 2 or runs[0] != "read_only"):
            raise AgentsConfigError(f"agents.yaml levels.{n}: approve_plan needs a read_only run first")
        levels[int(n)] = Level(
            number=int(n),
            runs=runs,
            review=lv["review"],
            approve_plan=bool(lv.get("approve_plan")),
            needs_sandbox=bool(lv.get("needs_sandbox")),
            needs_budget=bool(lv.get("needs_budget")),
        )
    if sorted(levels) != [0, 1, 2, 3]:
        raise AgentsConfigError("agents.yaml levels: 0, 1, 2 and 3 are all needed (SPEC §7.3)")
    if any(k != "read_only" for k in levels[0].runs):
        raise AgentsConfigError("agents.yaml levels.0 may only make read_only runs")

    agents: dict[str, AgentDef] = {}
    for aid, a in (data.get("agents") or {}).items():
        aid = str(aid)
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,40}", aid):
            raise AgentsConfigError(f"agents.yaml: agent id “{aid}” must be lower-case letters, digits and -")
        runner = a.get("runner")
        if runner is not None and runner not in RUNNERS:
            raise AgentsConfigError(f"agents.yaml {aid}.runner: one of {', '.join(sorted(RUNNERS))}")
        profiles = {k: _profile(aid, k, v) for k, v in (a.get("profiles") or {}).items()}
        if any(k not in RUN_KINDS for k in profiles):
            raise AgentsConfigError(f"agents.yaml {aid}.profiles: only {', '.join(RUN_KINDS)}")
        if runner:
            if not a.get("command"):
                raise AgentsConfigError(f"agents.yaml {aid}: a runnable agent needs `command`")
            if a.get("permissions") not in PERMISSION_STYLES:
                raise AgentsConfigError(
                    f"agents.yaml {aid}.permissions: one of {', '.join(sorted(PERMISSION_STYLES))}"
                )
            for k in ("read_only", "edit"):
                if k not in profiles:
                    raise AgentsConfigError(f"agents.yaml {aid}: a runnable agent needs a {k} profile")
            for k, p in profiles.items():
                has_prompt = any("{prompt}" in x for x in p.args)
                if runner == "process" and not has_prompt:
                    raise AgentsConfigError(
                        f"agents.yaml {aid}.profiles.{k}: a process runner passes {{prompt}}"
                    )
                if runner == "claude_local" and has_prompt:
                    raise AgentsConfigError(
                        f"agents.yaml {aid}.profiles.{k}: Claude reads the task from AGENTS.md"
                    )
                if p.adapter and runner != "claude_local":
                    raise AgentsConfigError(f"agents.yaml {aid}.profiles.{k}.adapter: only for claude_local")
            if "full" in profiles and profiles["full"].adapter.get("filesystemScope") != "workspace":
                raise AgentsConfigError(
                    f"agents.yaml {aid}.profiles.full: needs the bwrap sandbox (filesystemScope)"
                )
        agents[aid] = AgentDef(
            id=aid,
            label=str(a.get("label") or aid),
            cli=str(a.get("cli") or aid),
            capabilities=tuple(a.get("capabilities") or ()),
            runner=runner,
            command=a.get("command"),
            model=a.get("model"),
            cost=str(a.get("cost") or "none"),
            permissions=a.get("permissions"),
            profiles=profiles,
            full_unavailable=a.get("full_unavailable"),
            note=a.get("note"),
            models=tuple(str(m) for m in (a.get("models") or ([a["model"]] if a.get("model") else []))),
            paid=bool(a.get("paid")),
        )
        if agents[aid].paid and (runner != "process" or a.get("permissions") != "opencode"):
            raise AgentsConfigError(
                f"agents.yaml {aid}: a paid agent runs OpenCode through LiteLLM (process)"
            )
    if not agents:
        raise AgentsConfigError("agents.yaml: no agents")
    return AgentRegistry(defaults, levels, agents, clis=clis)


USAGE_SOURCES = {"stream_event", "session_file"}
HOME_ENV = re.compile(r"[A-Z][A-Z0-9_]{2,40}")


def _clis(raw: dict[str, Any]) -> dict[str, CliDef]:
    out: dict[str, CliDef] = {}
    for cid, c in raw.items():
        cid = str(cid)
        if not isinstance(c, dict):
            raise AgentsConfigError(f"agents.yaml clis.{cid}: a mapping")
        if not HOME_ENV.fullmatch(str(c.get("home_env") or "")):
            raise AgentsConfigError(f"agents.yaml clis.{cid}.home_env: the CLI's config-folder variable")
        usage = c.get("usage")
        if usage is not None and usage not in USAGE_SOURCES:
            raise AgentsConfigError(
                f"agents.yaml clis.{cid}.usage: one of {', '.join(sorted(USAGE_SOURCES))}"
            )
        wins = []
        for wid, w in (c.get("windows") or {}).items():
            hours = float((w or {}).get("hours") or 0)
            if hours <= 0:
                raise AgentsConfigError(f"agents.yaml clis.{cid}.windows.{wid}.hours: more than 0")
            wins.append(WindowDef(str(wid), str((w or {}).get("label") or wid), hours))
        if not wins:
            raise AgentsConfigError(f"agents.yaml clis.{cid}.windows: at least one window")
        by = str(c.get("estimate_by") or "list_price")
        if by not in ("list_price", "tokens"):
            raise AgentsConfigError(f"agents.yaml clis.{cid}.estimate_by: list_price or tokens")
        out[cid] = CliDef(
            id=cid,
            label=str(c.get("label") or cid),
            home_env=str(c["home_env"]),
            login=str(c.get("login") or f"{cid} login"),
            usage=usage,
            plans={str(k): str(v) for k, v in (c.get("plans") or {}).items()},
            windows=tuple(wins),
            estimate_by=by,
            limit_patterns=tuple(str(p).lower() for p in (c.get("limit_patterns") or ())),
        )
    return out


_cache: tuple[float, Path, AgentRegistry] | None = None
_merged: tuple[int, int, AgentRegistry] | None = None  # (id of the base, overlay version, merged)
_overlay: tuple[dict[str, Any], ...] = ()
_overlay_version = 0


def load_base(config_dir: Path | None = None) -> AgentRegistry:
    """config/agents.yaml alone, re-read when the file changes (like rules.yaml)."""
    global _cache
    path = _path(config_dir)
    mtime = path.stat().st_mtime
    if _cache and _cache[0] == mtime and _cache[1] == path:
        return _cache[2]
    reg = parse(yaml.safe_load(path.read_text()) or {})
    _cache = (mtime, path, reg)
    return reg


def load_agents(config_dir: Path | None = None) -> AgentRegistry:
    """The effective registry: agents.yaml with the fleet overlay (ADR 0009) merged on top. The overlay is
    the `agent_profiles` rows, kept here by `app.fleet.refresh` (on start, after every write, and on every
    job-loop step), so callers stay synchronous."""
    global _merged
    base = load_base(config_dir)
    if _merged and _merged[0] == id(base) and _merged[1] == _overlay_version:
        return _merged[2]
    reg = merge(base, _overlay)
    _merged = (id(base), _overlay_version, reg)
    return reg


def set_overlay(rows: list[dict[str, Any]] | tuple[dict[str, Any], ...]) -> None:
    """Replace the overlay (plain dicts with the `agent_profiles` columns)."""
    global _overlay, _overlay_version
    rows = tuple(sorted((dict(r) for r in rows), key=lambda r: str(r["id"])))
    if rows != _overlay:
        _overlay = rows
        _overlay_version += 1


AGENT_ID = re.compile(r"[a-z][a-z0-9-]{1,40}")


def _apply(a: AgentDef, row: dict[str, Any]) -> AgentDef:
    def num(v: Any) -> float | None:
        return float(v) if v is not None else None

    projects = row.get("allowed_project_ids")
    return replace(
        a,
        label=row.get("label") or a.label,
        role=row.get("role") or None,
        model=row.get("model") or a.model,
        default_autonomy=row.get("default_autonomy"),
        monthly_list_usd=num(row.get("monthly_list_usd")),
        allowed_projects=tuple(int(p) for p in projects) if projects is not None else None,
        paused=bool(row.get("paused")),
        account=row.get("account") or None,
    )


def merge(base: AgentRegistry, rows: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> AgentRegistry:
    """Overlay rows onto the base. A row whose template is gone or isn't runnable any more is skipped
    (agents.yaml changed under it); it stays in the table and the Agents page shows it as such."""
    agents = dict(base.agents)
    retired: dict[str, AgentDef] = {}
    for row in rows:
        aid = str(row["id"])
        tpl = base.agents.get(str(row.get("template") or ""))
        if row.get("builtin"):
            if aid in base.agents and not row.get("deleted_at"):
                agents[aid] = replace(_apply(base.agents[aid], row), edited=True)
            continue
        if tpl is None or not tpl.runnable or tpl.paid or aid in base.agents or not AGENT_ID.fullmatch(aid):
            continue
        hired = replace(_apply(tpl, row), id=aid, template=tpl.id, note=None)
        if row.get("deleted_at"):
            retired[aid] = hired
        else:
            agents[aid] = hired
    return AgentRegistry(base.defaults, base.levels, agents, retired, clis=base.clis)


OVERFLOW_PROVIDER = "switchboard"


# --- one run -> Paperclip agent config -------------------------------------------------------------------
@dataclass(frozen=True)
class RunSpec:
    adapter_type: str  # claude_local | process
    adapter_config: dict[str, Any]
    instructions: str  # the agent's AGENTS.md (Claude reads the task there; process runners get it as an arg)


def _neutralise_braces(text: str) -> str:
    """Paperclip renders `{{name}}` in some prompt fields; keep a user's literal braces literal."""
    return text.replace("{{", "{​{").replace("}}", "}​}")


def build_run(
    reg: AgentRegistry,
    agent: AgentDef,
    kind: str,
    *,
    worktree: str,
    task: str,
    budget_left_usd: float | None,
    account_home: str | None = None,
    overflow: dict[str, str] | None = None,
    extra_env: dict[str, str] | None = None,
    extra_allowed: list[str] | None = None,
) -> RunSpec:
    """The complete Paperclip adapter config for one run. Always complete: Paperclip's reads are redacted,
    so the router never edits what it read back (docs/m4a.md).

    `account_home` (M6.5) is a named account's folder on the host: the CLI's `home_env` points at it, so the
    vendor CLI uses that login (nothing in it is read or copied). `overflow` = {key_file, model} for the paid
    agent: OpenCode reads the LiteLLM key from that file (`{file:...}`), so the key never enters Paperclip's
    config (ADR 0015). `extra_env` / `extra_allowed` (M4.5a, ADR 0018): the run's PATH with the job's pack
    wrappers first, and the pack commands the agent may run (prefixes, like `allowed_commands`)."""
    if kind not in agent.profiles:
        raise KeyError(f"{agent.label} has no {kind} profile")
    if agent.paid and not overflow:
        raise KeyError(f"{agent.label} runs only as paid overflow")
    profile = agent.profiles[kind]
    d = reg.defaults
    if agent.role:  # a hired agent's role (ADR 0009) comes before the task, for every runner
        task = f"Your role: {agent.role.strip()}\n\n{task}"
    instructions = (
        "# Switchboard job\n\nThis is a direct Switchboard job, not a Paperclip heartbeat: there is no issue "
        "to check out, and you must not call the Paperclip API. Switchboard records the result.\n\n"
        "Never push, never change git remotes or credentials, and stay inside this folder.\n\n"
        f"## Task\n\n{_neutralise_braces(task)}\n"
    )
    env = dict(CLEAN_ENV)
    env.update({k: v for k, v in (extra_env or {}).items() if k == "PATH"})
    commands = [*d.allowed_commands, *(c for c in extra_allowed or [] if c not in d.allowed_commands)]
    allowed: list[str] = []
    if agent.permissions == "claude":
        allowed = [f"Bash({c}:*)" for c in commands]
    elif agent.permissions == "opencode":
        env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
        if kind == "read_only":
            perm: dict[str, Any] = {"edit": "deny", "bash": "deny", "webfetch": "deny", "websearch": "deny"}
        else:
            bash: dict[str, str] = {"*": "deny"}
            bash.update({f"{c}*": "allow" for c in commands})
            perm = {"edit": "allow", "bash": bash, "webfetch": "deny", "websearch": "deny"}
        content: dict[str, Any] = {"permission": perm}
        if agent.paid and overflow:
            content["provider"] = {
                OVERFLOW_PROVIDER: {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Switchboard LiteLLM (paid overflow)",
                    "options": {
                        "baseURL": d.litellm_base_url,
                        "apiKey": "{file:" + overflow["key_file"] + "}",
                    },
                    "models": {overflow["model"]: {"name": overflow["model"]}},
                }
            }
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(content)
    cli = reg.subscription(agent)
    if account_home and cli is not None:
        env[cli.home_env] = account_home
    model = f"{OVERFLOW_PROVIDER}/{overflow['model']}" if agent.paid and overflow else agent.model

    def render(arg: str) -> list[str]:
        if arg == "{allowed}":
            return allowed
        return [
            PLACEHOLDER.sub(
                lambda m: {"model": model or "", "worktree": worktree, "prompt": task}[m.group(1)], arg
            )
        ]

    args = [x for a in profile.args for x in render(a)]
    common = {
        "cwd": worktree,
        "timeoutSec": d.run_timeout_s,
        "graceSec": d.run_grace_s,
        "env": env,
    }
    if agent.runner == "claude_local":
        if budget_left_usd is not None and agent.cost == "reported":
            args += ["--max-budget-usd", f"{max(budget_left_usd, 0.01):.2f}"]
        cfg: dict[str, Any] = {
            **common,
            "engine": "cli",
            "command": agent.command,
            "dangerouslySkipPermissions": False,  # Paperclip's default is true; the profile decides
            "maxTurnsPerRun": d.max_turns,
            "extraArgs": args,
            # Paperclip merges a PATCHed adapterConfig into the stored one key by key (values such as
            # `env` are replaced whole; verified in 2026.1106.0's routes/agents.js), so every key a profile
            # may set is stated on every run and a sandbox setting from an earlier run never sticks (found
            # live in M6.5: M4a's level-3 attempt had left `filesystemScope: workspace` on the Claude agent).
            "filesystemScope": None,
            "networkScope": None,
            "networkAllowlist": [],
            **profile.adapter,
        }
        if agent.model:
            cfg["model"] = agent.model
        return RunSpec("claude_local", cfg, instructions)
    return RunSpec("process", {**common, "command": agent.command, "args": args}, instructions)
