# 0019. graphify as an automatic pack, kept only where a holdout shows it saves tokens

Status: accepted (2026-11-23, M4.5a)

## Context
graphify builds a knowledge graph of a repository so an agent can query it instead of reading files. Whether that
saves tokens depends on the project and the agent; a pack that costs build time and context without a gain should
switch itself off. The comparison must be fair: the kind of tasks drifts over time, so "before vs after enabling"
mixes the graph's effect with the work's.

Facts: Switchboard records tokens per job in `costs` (one row per run). Cached input tokens were not recorded at
all: `job_output.py` read only `input_tokens` from Claude's result (Claude reports cache reads and cache writes
separately, and they are most of an agent's input).

## Options
1. **Holdout control** inside the same group (your choice).
2. Before vs after enabling.
3. Ask the agent to estimate savings: not a measurement.

## Decision
- **When:** agent jobs (never chat) on a project whose graphify mode is **Auto** and whose tracked files or bytes are
  at least `config/packs.yaml` `graphify.auto.min_files` / `min_bytes` (counted by hostprobe with `git ls-files`), or
  **Always** (the owner's explicit choice), or never (**Off**). The pack must be installed and support the job's agent.
- **Build:** before the first run, in the worktree, through the wrapper and without network: `graphify extract .
  --code-only` then `graphify cluster-only . --no-label --no-viz`, then `graphify install --project --platform
  <host>`. A per-project copy of `graphify-out/` in `~/.switchboard/data/packs/graphify/<project>/` is copied in
  first and back after, so later jobs only re-parse changed files. `graphify-out/` is pack-owned (never committed);
  the AGENTS.md section graphify adds is a setup edit (unticked).
- **AST pass only** in M4.5a. The AI semantic pass (routed through Switchboard, local only for private projects)
  moves to M4.5a-2 with private projects.
- **Groups:** project + agent + flow (`openspec.change` or plain). Flow jobs are never compared with plain jobs.
- **Tokens** (one definition for Metrics and this comparison): input + cached input + output, summed from `costs`
  by `job_id`. Migration 0012 adds `costs.tokens_cached` (Claude: `cache_read_input_tokens` +
  `cache_creation_input_tokens`; Codex: `cached_input_tokens`; OpenCode: its cache read/write). Older rows have no
  cached figure and the panel says so.
- **Measuring:** every `holdout_every` (5)th eligible job in a group runs without the graph (a control) until both
  arms have `min_samples` (5) finished jobs. Status: "Measuring (n of 5)", n = the smaller arm.
- **Decision:** median tokens with the graph at least `min_gain` (10%) below the controls → **on** (holdouts stop);
  otherwise **off** (graphify stops for that group, with the numbers, an event and a toast).
- **Re-check:** after `recheck_every` (20) eligible jobs since the decision, a new round: when on, 5 control jobs;
  when off, 5 jobs with the graph; compared with the latest 5 of the other arm. "Turn back on" starts a fresh round.
- Shown in Metrics Pro (one row per group: status, medians with and without, cached input as its own column,
  samples, CSV) and in Settings → Projects. All numbers in `config/packs.yaml`.

## Consequences
- During measuring, one job in five runs without the graph on purpose; after a decision, none, until a re-check.
- Five jobs per arm is a small sample: the result is a median, labelled with its sample counts, never a claim of
  significance.
- Recording cached input makes token totals larger and more honest for jobs from now on; costs in dollars were
  already right (Paperclip and LiteLLM price them).
