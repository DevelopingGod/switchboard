"""Agent registry and run configs (M4a, config/agents.yaml, docs/m4a.md)."""

import copy
import json
from pathlib import Path

import pytest
import yaml

from app import agents
from app.agents import CLEAN_ENV, AgentsConfigError, build_run, load_agents, parse
from app.job_output import TurnCounter, outcome

FIX = Path(__file__).parent / "fixtures" / "paperclip"
WT = "/home/user/.switchboard/worktrees/demo/job-7"


def raw() -> dict:
    return yaml.safe_load((Path(agents.get_settings().config_dir) / "agents.yaml").read_text())


def run_args(agent: str, kind: str, task: str = "Add multiply") -> tuple[str, dict, str]:
    reg = load_agents()
    spec = build_run(reg, reg.agent(agent), kind, worktree=WT, task=task, budget_left_usd=1.5)
    return spec.adapter_type, spec.adapter_config, spec.instructions


def test_registry_loads_with_the_verified_agents():
    reg = load_agents()
    assert sorted(reg.levels) == [0, 1, 2, 3]
    assert reg.levels[1].approve_plan and reg.levels[1].runs == ("read_only", "edit")
    assert reg.levels[3].needs_sandbox and reg.levels[3].needs_budget
    runnable = sorted(a.id for a in reg.agents.values() if a.runnable)
    assert runnable == ["claude-code", "codex", "opencode", "opencode-paid"]
    # M6.5: the paid-overflow agent is runnable but never a subscription agent or a hire template.
    assert reg.agents["opencode-paid"].paid and reg.subscription(reg.agents["opencode-paid"]) is None
    assert [a.id for a in reg.agents.values() if a.paid] == ["opencode-paid"]
    assert {a.id for a in reg.agents.values() if not a.runnable} == {"gemini-cli", "grok-build", "hermes"}
    # level 3: no agent has a sandbox that works here yet (Paperclip's bwrap fails on merged /usr)
    assert reg.agent("codex").level_unavailable(reg.levels[3]).startswith("Level 3 is off")
    assert "never runs without a sandbox" in reg.agent("claude-code").level_unavailable(reg.levels[3])
    assert "not verified" in reg.agent("hermes").level_unavailable(reg.levels[0]).lower()


def test_claude_flags_per_kind():
    t, cfg, instructions = run_args("claude-code", "read_only")
    assert t == "claude_local" and cfg["engine"] == "cli" and cfg["command"] == "claude"
    assert cfg["dangerouslySkipPermissions"] is False  # Paperclip's default is true
    assert cfg["extraArgs"][:4] == ["--permission-mode", "plan", "--setting-sources", "user"]
    assert cfg["cwd"] == WT and cfg["maxTurnsPerRun"] == load_agents().defaults.max_turns
    assert cfg["extraArgs"][-2:] == ["--max-budget-usd", "1.50"]
    assert "Add multiply" in instructions and "must not call the Paperclip API" in instructions
    _, edit, _ = run_args("claude-code", "edit")
    a = edit["extraArgs"]
    assert a[:2] == ["--permission-mode", "acceptEdits"]
    allowed = a[a.index("--allowedTools") + 1 : a.index("--disallowedTools")]
    assert allowed and all(x.startswith("Bash(") and x.endswith(":*)") for x in allowed)
    assert "Bash(python3 -m unittest:*)" in allowed
    assert "Bash(git push:*)" in a and "WebFetch" in a


def test_a_full_profile_carries_the_sandbox_settings():
    """The shape to restore once a sandbox works (see config/agents.yaml): adapter settings pass through."""
    d = copy.deepcopy(raw())
    d["agents"]["claude-code"]["profiles"]["full"] = {
        "args": ["--permission-mode", "bypassPermissions"],
        "adapter": {"filesystemScope": "workspace", "networkScope": "allowlist"},
    }
    reg = parse(d)
    spec = build_run(reg, reg.agent("claude-code"), "full", worktree=WT, task="t", budget_left_usd=1)
    cfg = spec.adapter_config
    assert cfg["filesystemScope"] == "workspace" and cfg["extraArgs"][:2] == [
        "--permission-mode",
        "bypassPermissions",
    ]


def test_codex_and_opencode_run_as_plain_processes_with_the_task_as_last_arg():
    t, cfg, _ = run_args("codex", "read_only", task="Plan multiply")
    assert t == "process" and cfg["command"] == "codex"
    assert cfg["args"] == ["exec", "--json", "-s", "read-only", "-C", WT, "Plan multiply"]
    _, edit, _ = run_args("codex", "edit")
    assert edit["args"][2:6] == [
        "-s",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=false",
    ]
    t, oc, _ = run_args("opencode", "read_only")
    assert t == "process" and oc["args"][:6] == [
        "run",
        "--format",
        "json",
        "-m",
        "opencode/big-pickle",
        "--dir",
    ]
    perm = json.loads(oc["env"]["OPENCODE_CONFIG_CONTENT"])["permission"]
    assert perm["edit"] == "deny" and perm["bash"] == "deny" and perm["webfetch"] == "deny"
    _, oce, _ = run_args("opencode", "edit")
    perm = json.loads(oce["env"]["OPENCODE_CONFIG_CONTENT"])["permission"]
    assert (
        perm["edit"] == "allow"
        and perm["bash"]["*"] == "deny"
        and perm["bash"]["python3 -m unittest*"] == "allow"
    )
    assert oce["env"]["OPENCODE_DISABLE_PROJECT_CONFIG"] == "true"


@pytest.mark.parametrize("agent", ["claude-code", "codex", "opencode"])
@pytest.mark.parametrize("kind", ["read_only", "edit"])
def test_every_run_gets_a_clean_environment_and_never_touches_login_files(agent, kind):
    _, cfg, _ = run_args(agent, kind)
    env = cfg["env"]
    for k, v in CLEAN_ENV.items():
        assert env[k] == v
    assert env["SSH_AUTH_SOCK"] == "" and env["DBUS_SESSION_BUS_ADDRESS"] == "" and env["GH_TOKEN"] == ""
    assert {env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))} >= {
        "https://",
        "ssh://",
        "git@",
    }
    # Rule: Switchboard and Paperclip never copy, read, move or write a CLI's login files.
    text = json.dumps(cfg).lower()
    for marker in (
        "auth.json",
        "credentials",
        "codex_home",
        "claude_config_dir",
        "oauth",
        "api_key",
        'token":"',
    ):
        assert marker not in text, marker


def test_user_braces_stay_literal_in_claudes_instructions():
    _, _, instructions = run_args("claude-code", "read_only", task="Render {{name}} in the template")
    assert "{{name}}" not in instructions and "name" in instructions


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: d["levels"].pop(3), "0, 1, 2 and 3"),
        (lambda d: d["levels"][0].update(runs=["edit"]), "levels.0"),
        (lambda d: d["agents"]["codex"]["profiles"].pop("edit"), "edit profile"),
        (lambda d: d["agents"]["codex"]["profiles"].update(read_only=["exec", "--json"]), "{prompt}"),
        (lambda d: d["agents"]["claude-code"]["profiles"]["read_only"].append("{prompt}"), "AGENTS.md"),
        (
            lambda d: d["agents"]["claude-code"]["profiles"].update(
                full={"args": ["--permission-mode", "x"]}
            ),
            "bwrap",
        ),
        (lambda d: d["agents"]["codex"].update(runner="codex_local"), "runner"),
        (lambda d: d["defaults"].update(allowed_commands=["npm test; curl x"]), "allowed_commands"),
        (lambda d: d["agents"]["codex"]["profiles"]["edit"].append("{secret}"), "placeholder"),
    ],
)
def test_validation(mutate, message):
    d = copy.deepcopy(raw())
    mutate(d)
    with pytest.raises(AgentsConfigError, match=message.replace("{", r"\{").replace("}", r"\}")):
        parse(d)


# --- run output (recorded runs, docs/m4a.md) ---------------------------------------------------------
def fx(name: str) -> dict:
    return json.loads((FIX / f"{name}.json").read_text())["response"]


def test_claude_outcome_list_price_but_no_money_on_a_subscription():
    out = outcome(load_agents().agent("claude-code"), fx("run_get_claude_plan"))
    assert out.list_price_usd == pytest.approx(0.0626815) and out.cost_usd == 0
    assert out.text.startswith("Plan") and out.provider == "anthropic" and out.model == "claude-sonnet-5-5"
    edit = outcome(load_agents().agent("claude-code"), fx("run_get_claude_edit"))
    assert edit.denied and any("git push" in d for d in edit.denied) and any("curl" in d for d in edit.denied)


def test_codex_outcome_tokens_but_cost_not_reported():
    out = outcome(load_agents().agent("codex"), fx("run_get_codex-proc"))
    assert out.list_price_usd is None and out.cost_usd == 0
    # M4.5a: Codex counts cached input inside input_tokens (100015); it is kept apart, so in + cached + out is
    # the run's total for every CLI.
    assert out.tokens_in == 100015 - 91520 and out.tokens_cached == 91520
    assert out.tokens_out == 645 and out.turns >= 5
    assert "multiply" in out.text


def test_opencode_outcome_sums_steps():
    out = outcome(load_agents().agent("opencode"), fx("run_get_opencode-proc"))
    assert out.list_price_usd == 0 and out.cost_usd == 0 and out.turns == 10
    assert out.tokens_in and out.tokens_out and "Done" in out.text


def test_turn_counter_keeps_only_the_unfinished_line():
    c = TurnCounter("opencode")
    line = json.dumps({"type": "step_finish", "part": {"cost": 0.25, "tokens": {}}})
    c.feed(line[:20])
    assert c.turns == 0
    c.feed(line[20:] + "\n" + line)
    assert c.turns == 1 and c.list_price_usd == pytest.approx(0.25)
    c.finish()
    assert c.turns == 2 and c.list_price_usd == pytest.approx(0.5)
