# 0009. The agent fleet: hired agents and edits are a database overlay on agents.yaml

Status: accepted (2026-11-20)

## Context
M4b adds an Agents view where you hire agents ("Reviewer" on Claude Code with a cheaper model, a role and a monthly
budget), pause them, edit them and limit them to some projects. `config/agents.yaml` holds the verified CLI flags for
each autonomy level (docs/m4a.md); it is mounted read-only into the router, lives in git, and is what a new install
starts from. Principles 2 (config over code) and 4 (persist what must survive restarts) apply. Each job runs on one
Paperclip agent per registry entry (ADR 0007), and Paperclip redacts some values when an agent is read back, so the
router never does read-modify-write on Paperclip's copy.

## Options
1. **Database overlay** (`agent_profiles`) merged onto agents.yaml when the registry loads, like the rules overrides
   (ADR 0004). The YAML stays the only place CLI flags live; a row only carries what you can change.
2. **A user YAML file** the router writes (for example `~/.switchboard/agents.yaml`). Readable, but the config mount is
   read-only, a second writer would have to be added on the host, and there is no history or soft delete.
3. **Paperclip as the source of truth** (agents live in Paperclip, Switchboard reads them back). Couples the registry
   to Paperclip's schema and its redaction behaviour; a Paperclip reset would lose your fleet.

## Decision
Option 1 (your choice, 2026-11-20).
- **Table `agent_profiles`** (migration 0008): `id`, `template`, `builtin`, `label`, `role`, `model`,
  `default_autonomy`, `monthly_list_usd`, `allowed_project_ids` (null = every project), `paused`, timestamps,
  `deleted_at`.
- **A hired agent** has its own id (from its name) and a `template` (claude-code, codex or opencode). It runs exactly
  as its template does (same flags, same runner) with your label, role, model, default autonomy, monthly budget and
  allowed projects. Optional CLIs (Gemini CLI, Grok Build, Hermes) can't be hired until they are verified.
- **An edited built-in agent** is a row with `builtin = true` and the built-in's id. "Reset to default" deletes the
  row.
- **Deleting a hired agent** sets `deleted_at` (soft delete): it is never offered or run again, while its jobs and costs
  keep their agent and name. Built-in agents can't be deleted (pause them). An agent with a job in progress can't be
  deleted.
- **Merging:** `app.agents.load_agents()` returns agents.yaml with the overlay applied. The rows are kept in memory by
  `app.fleet.refresh`, which runs on start, after every write and on each job-loop step, so a second worker would
  catch up within a step. Callers stay synchronous. A row whose template is gone or no longer runnable is skipped
  (agents.yaml changed under it).
- **The rules apply in one place:** `jobs.agent_check` (paused, allowed project, installed and logged in, level
  available, today's and this month's list-price budget). The job preview, job creation and the job loop all use it,
  so the preview can't promise an agent the loop would skip.
- **The role** is put before the task for every runner ("Your role: …").
- **Paperclip sync is idempotent and partial:**
  - A Paperclip agent is still created on the agent's first run (creating one runs Paperclip's setup check, which
    starts the CLI).
  - Renames send only the name.
  - Pause and resume are mirrored, except while the agent has a job in progress. Switchboard's own pause is what stops
    new jobs, and the run step resumes a Paperclip-paused agent it chose to run.
  - Delete terminates the Paperclip agent. "Already gone" counts as done.

## Consequences
- Your fleet survives restarts and router upgrades. agents.yaml remains the reviewed source of every CLI flag.
- A config change to a template (new flags, a new model list) flows to its hired agents automatically.
- The registry is now process memory refreshed from the database. Tests reset it per test (`conftest.py`).
- Monthly list-price budgets are new: `defaults.budget.per_agent_monthly_list_usd` (none by default) or per agent.
- Paperclip's own UI shows hired agents under their names once they have run. Agents that were deleted stay
  terminated in Paperclip, because Paperclip can't delete a terminated agent (docs/m4a.md).
