# 0015. Paid overflow through per-run LiteLLM virtual keys, handed over as a key file

Status: accepted (2026-11-21, M6.5)

## Context
When every subscription window in a job's chain is used up, the owner may prefer to finish the job on a
paid API model rather than wait. This must be opt-in (off by default), capped by a budget you set, and
clearly labelled "Paid" before anything runs. Provider API keys live in LiteLLM (M1a) and must not spread.
Jobs run through Paperclip, which keeps every agent-config change in its `agent_config_revisions` table.

Verified before building (2026-11-21):
- **Paperclip 2026.1106.0 has no per-run env or config override.** The process adapter builds the child
  environment only from the agent's stored `config.env`; the wake request's `payload` never reaches it.
  Run logs redact env names containing "key"/"token", but the stored config and its revisions keep values.
- **OpenCode 1.19.6 reads `apiKey: "{file:<path>}"`** in a custom OpenAI-compatible provider: a real run
  through LiteLLM was attributed to the key in that file.
- **LiteLLM v1.108.8 virtual keys:** `/key/generate` takes `models`, `max_budget`, `duration`, `key_alias`
  and `metadata.tags`; the tags appear in the spend logs' `request_tags`; the budget is checked before each
  call against an estimate (a key was refused at $0.00008 spent of a $0.01 budget); `/key/delete` answers
  404 "No keys found" when the key is already gone.

## Options
1. **OpenCode → LiteLLM with a per-run virtual key** (budget-capped, model-limited, short-lived); the
   provider key stays in LiteLLM.
2. **Claude Code with an Anthropic API key** in its agent env, capped by `--max-budget-usd`. Puts a
   long-lived provider key into Paperclip's stored config.
3. How option 1's key reaches the run: (a) the agent's env: kept in Paperclip's config revisions after any
   removal; (b) **a key file** written by hostprobe and read by OpenCode with `{file:...}`: never in
   Paperclip; (c) defer overflow.

## Decision
Option 1 with 3b (your choice):
- Settings → Paid overflow: off by default; turning it on needs a monthly budget and a paid model (LiteLLM
  aliases served only by `paid: true` providers).
- The `opencode-paid` agent (agents.yaml) is never in an automatic chain and can't be hired as a template.
  It runs only for a job you confirmed with "Paid — up to $X", either from the New job preview (when every
  window is used up) or from a waiting job's "Use paid overflow".
- **Per run**: a key with `models = [the paid model]`, `max_budget = min(the job's paid budget left, this
  month's overflow budget left)`, `duration = job time limit + 30 min`, alias `sb-overflow-job-<id>-r<run>-a<attempt>`,
  tags `switchboard-overflow` and `sb-job-<id>`. hostprobe writes it to `~/.switchboard/overflow/<agent>.key`
  (folder 700, file 600, no symlinks) right before the run; the agent's stored OpenCode config holds only
  the `{file:...}` path.
- When the run ends, whatever the outcome (done, failed, stopped, a cap, a limit), the key is revoked and the
  file removed; the job's `_finish` does it again; a sweep on start and every 5 minutes deletes any
  `sb-overflow-*` key and key file no running paid job owns (crash recovery). Tested for every outcome,
  including that no key ever appears in Paperclip's agent config.
- One active job per agent, so one file per agent is enough. If `max_active_per_agent` is ever raised, the
  file name must become per job.
- **Costs**: LiteLLM's spend log is the truth. The ingester files a log tagged `switchboard-overflow` +
  `sb-job-<id>` under that job (`kind = job`); the run's own cost row is not written, so nothing counts
  twice. The job's real spend is also read from the key when it is revoked. Overflow spend has its own
  monthly budget and doesn't count toward the chat daily cap.
- `ROUTER_OVERFLOW_ALLOW_FREE` (dev only, doctor warns) lets a free model stand in, to show the key
  lifecycle without spending money; such a job is labelled a test.

## Consequences
- **The running agent can read its own key**, as with any way of giving it one. That is why the key is per
  run, capped to the job's budget, limited to one model and short-lived, and revoked when the run ends.
- A budget below about $0.05 can be refused by LiteLLM's pre-call estimate; the minimum is $0.05.
- The key file briefly exists on disk (mode 600) while a paid run is active.
- Option 2 (Claude Code on an API key) stays possible later as another `paid: true` agent, if Paperclip gains
  a per-run secret mechanism.
