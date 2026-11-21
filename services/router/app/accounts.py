"""Named accounts of subscription CLIs (M6.5, ADR 0013): separate accounts for separate purposes.

A personal Claude Pro and a company Team seat stay apart: each extra account is a folder on the host
(`~/.switchboard/accounts/<cli>/<name>`, created empty by hostprobe, mode 700) that the vendor CLI logs into
itself (`CLAUDE_CONFIG_DIR=<folder> claude auth login`). Switchboard never copies, reads or moves anything in
it; a job run only sets the CLI's own config-folder variable. "default" is the CLI's normal login.

You choose the account per project (wins) or per agent. **A job is bound to one account when it is created
and never moves to another account of the same CLI**, not on a limit, not as a fallback: providers' terms
forbid rotating accounts to get around usage limits, and doing it risks a ban. When an account's window is
used up, the job falls back to another CLI, waits for the reset, or uses paid overflow if you opt in.
"""

from __future__ import annotations

import re
import time
import urllib.parse
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client
from app.agents import AgentDef, AgentRegistry
from app.models import AgentProfile, CliAccount, Job, Project

DEFAULT = "default"
NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,30}")
STATUS_TTL_S = 60.0
_status_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}  # bounded by the accounts table


class AccountError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def key(name: str | None) -> str:
    """The stored form: None and "" are the default account."""
    return name or DEFAULT


def _check_cli(reg: AgentRegistry, cli: str) -> None:
    if cli not in reg.clis:
        raise AccountError(400, "Accounts are for subscription CLIs: " + ", ".join(reg.clis))


async def names(session: AsyncSession, cli: str) -> list[str]:
    rows = await session.scalars(
        select(CliAccount.name)
        .where(CliAccount.cli == cli, CliAccount.deleted_at.is_(None))
        .order_by(CliAccount.name)
    )
    return [DEFAULT, *rows.all()]


async def exists(session: AsyncSession, cli: str, name: str | None) -> bool:
    if key(name) == DEFAULT:
        return True
    return (
        await session.scalar(
            select(CliAccount.id).where(
                CliAccount.cli == cli, CliAccount.name == name, CliAccount.deleted_at.is_(None)
            )
        )
    ) is not None


async def status(cli: str, name: str | None, *, fresh: bool = False) -> dict[str, Any]:
    """hostprobe's view of one account: installed, logged in, plan label, login command, and the env a run
    sets. Cached for a minute (each check runs the CLI's status command); never raises."""
    k = (cli, key(name))
    hit = _status_cache.get(k)
    if hit and not fresh and time.monotonic() - hit[0] < STATUS_TTL_S:
        return hit[1]
    q = urllib.parse.urlencode({"cli": cli, "name": key(name)})
    code, data = await hostprobe_client.call("GET", f"/accounts/status?{q}", timeout=15)
    out = data if code == 200 else {"error": data.get("error") or f"hostprobe HTTP {code}", "logged_in": None}
    if code == 200:
        _status_cache[k] = (time.monotonic(), out)
    return out


def forget(cli: str, name: str | None) -> None:
    _status_cache.pop((cli, key(name)), None)


async def listing(session: AsyncSession, reg: AgentRegistry, *, fresh: bool = False) -> list[dict[str, Any]]:
    """Every subscription CLI with its accounts, login state and plan label (for Settings → Accounts)."""
    rows = (
        await session.scalars(
            select(CliAccount).where(CliAccount.deleted_at.is_(None)).order_by(CliAccount.id)
        )
    ).all()
    out = []
    for cli in reg.clis.values():
        accounts = []
        for name, label in [(DEFAULT, None), *((r.name, r.label) for r in rows if r.cli == cli.id)]:
            st = await status(cli.id, name, fresh=fresh)
            accounts.append(
                {
                    "name": name,
                    "label": label,
                    "logged_in": st.get("logged_in"),
                    "installed": st.get("installed"),
                    "plan": st.get("plan"),
                    "plan_label": cli.plan_label(st.get("plan")) if st.get("plan") else None,
                    "home": st.get("home"),
                    "login_command": st.get("login_command"),
                    "error": st.get("error"),
                }
            )
        out.append({"cli": cli.id, "label": cli.label, "home_env": cli.home_env, "accounts": accounts})
    return out


async def create(session: AsyncSession, reg: AgentRegistry, cli: str, name: str, label: str | None) -> dict:
    _check_cli(reg, cli)
    if name == DEFAULT or not NAME_RE.fullmatch(name or ""):
        raise AccountError(
            400, 'Use a short name: lowercase letters, digits and dashes (for example "work" or "personal").'
        )
    code, res = await hostprobe_client.call("POST", "/accounts", {"cli": cli, "name": name})
    if code != 200:
        raise AccountError(
            code if code < 500 else 502, res.get("error") or "hostprobe couldn't make the folder"
        )
    row = await session.scalar(select(CliAccount).where(CliAccount.cli == cli, CliAccount.name == name))
    if row is None:
        session.add(CliAccount(cli=cli, name=name, label=(label or "").strip()[:80] or None))
    else:  # re-adding a removed account: same folder, same login
        row.deleted_at = None
        row.label = (label or "").strip()[:80] or row.label
    await session.commit()
    forget(cli, name)
    return {"cli": cli, "name": name, "home": res.get("home"), "login_command": res.get("login_command")}


def _agents_of(cli: str) -> list[AgentDef]:
    from app.agents import load_agents

    reg = load_agents()
    return [a for a in [*reg.agents.values(), *reg.retired.values()] if a.cli == cli]


def reg_cli_of(agent_id: str) -> str | None:
    from app.agents import load_agents

    a = load_agents().agents.get(agent_id)
    return a.cli if a else None


async def users(session: AsyncSession, cli: str, name: str) -> list[str]:
    """What still uses an account (plain words), so removing it can't strand a job, agent or project."""
    found: list[str] = []
    jobs = (
        await session.scalars(
            select(Job.id).where(
                Job.account == name,
                Job.agent.in_([a.id for a in _agents_of(cli)]),
                Job.status.in_(("queued", "running", "needs_approval", "waiting_reset")),
            )
        )
    ).all()
    found += [f"job {j}" for j in jobs]
    agents = (
        await session.execute(
            select(AgentProfile.id, AgentProfile.label, AgentProfile.template).where(
                AgentProfile.account == name, AgentProfile.deleted_at.is_(None)
            )
        )
    ).all()
    found += [f"agent {label or aid}" for aid, label, tpl in agents if reg_cli_of(tpl or aid) in (None, cli)]
    projects = (
        await session.scalars(
            select(Project.name).where(Project.removed_at.is_(None), Project.accounts[cli].astext == name)
        )
    ).all()
    found += [f"project {p}" for p in projects]
    return found


async def remove(session: AsyncSession, reg: AgentRegistry, cli: str, name: str) -> None:
    """Soft delete. The folder and its login stay on disk (Switchboard never touches what's inside): log out
    with the CLI, or delete the folder yourself."""
    _check_cli(reg, cli)
    if name == DEFAULT:
        raise AccountError(400, "The default account is the CLI's own login; it can't be removed here.")
    row = await session.scalar(
        select(CliAccount).where(
            CliAccount.cli == cli, CliAccount.name == name, CliAccount.deleted_at.is_(None)
        )
    )
    if row is None:
        return  # already gone = done
    used = await users(session, cli, name)
    if used:
        raise AccountError(409, f"“{name}” is still used by {', '.join(used[:5])}. Change those first.")
    row.deleted_at = datetime.now(UTC)
    await session.commit()
    forget(cli, name)


def resolve(reg: AgentRegistry, agent: AgentDef, project: Project | None) -> str | None:
    """The account a new job for `agent` in `project` uses: the project's choice for that CLI, else the
    agent's, else the default (None). Non-subscription agents have none."""
    cli = reg.subscription(agent)
    if cli is None:
        return None
    chosen = ((project.accounts or {}) if project else {}).get(cli.id) or agent.account
    return None if key(chosen) == DEFAULT else chosen


def switch_reason(
    reg: AgentRegistry, agent: AgentDef, account: str | None, bound: dict[str, str | None]
) -> str | None:
    """The one rule (ADR 0013): a job that already chose an account for a CLI never uses another account of
    that CLI. `bound` maps cli -> account for the agents tried before this one in the same job."""
    cli = reg.subscription(agent)
    if cli is None or cli.id not in bound or key(bound[cli.id]) == key(account):
        return None
    return (
        f"{agent.label} uses another {cli.label} account (“{key(account)}”); Switchboard never switches "
        "accounts of one provider to get around a limit"
    )


async def validate_choice(session: AsyncSession, reg: AgentRegistry, cli: str, name: str | None) -> None:
    _check_cli(reg, cli)
    if not await exists(session, cli, name):
        raise AccountError(
            400, f"There is no {reg.clis[cli].label} account called “{name}” (Settings → Accounts)"
        )


__all__ = [
    "DEFAULT",
    "AccountError",
    "create",
    "exists",
    "key",
    "listing",
    "names",
    "remove",
    "resolve",
    "status",
    "switch_reason",
    "users",
    "validate_choice",
]
