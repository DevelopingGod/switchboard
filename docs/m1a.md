# M1a — Router backend

The Router API (`services/router`) holds provider connections and a live model catalog, registers API keys in LiteLLM, and reports which agent CLIs are installed in WSL. M1b builds the Connections screen and wizard on top of it.

| Component | Where | URL |
|---|---|---|
| Router API (FastAPI, SQLAlchemy, Alembic) | Docker (`router` service) | `http://127.0.0.1:8100` |
| hostprobe (CLI detection) | WSL, systemd user unit `switchboard-hostprobe` | `http://127.0.0.1:8101` |
| Router DB | Postgres `switchboard` database | — |

```
 portal (M1b) ──REST──▶ Router API ──admin API──▶ LiteLLM (DB: routable models + credentials)
                          │   │
                          │   └──HTTPS──▶ provider /models (catalog, key tests, direct model tests)
                          └──host.docker.internal:8101──▶ hostprobe (WSL) ──fixed argv──▶ claude/codex/gemini/grok/opencode
```

## Setup

```bash
scripts/setup-wsl.sh
```

It generates `SWITCHBOARD_SECRET_KEY`, `ROUTER_ADMIN_TOKEN` and `HOSTPROBE_TOKEN` in `deploy/.env`. Existing values are never overwritten; missing ones are appended. It also installs and starts the hostprobe user service, then starts the stack. On every start the router runs `alembic upgrade head`.

Check everything with:

```bash
scripts/doctor.sh
```

## Single source of truth for models: LiteLLM's DB

**Decision:** LiteLLM's database (`STORE_MODEL_IN_DB=True`) is the only place routable models live, and the Router API is its only writer. `config/litellm.yaml` keeps settings (fallbacks, retries, timeouts) and has no `model_list`. Aliases are declared in `config/providers.yaml` under `aliases:`. On startup and after every key change, the router reconciles them into LiteLLM.

Why the DB and not YAML:

- **Runtime key changes.** Adding or removing a key from the UI must not require editing YAML or `.env` and restarting LiteLLM. Through the admin API the change takes effect immediately.
- **Secrets stay out of files.** Keys are stored as LiteLLM *credentials* (encrypted with `LITELLM_SALT_KEY`), one per provider, named `sb-<provider>`. Deployments reference them with `litellm_credential_name`, so a key never sits in a deployment, a YAML file or git.
- **No drift.** A YAML `model_list` combined with DB models means two writers that drift apart. With one writer that reconciles from a declarative file, the result is reviewable (`providers.yaml` is in git) and idempotent.
- **Safe coexistence.** The router only touches deployments tagged `model_info.managed_by: switchboard`. Models added by hand in the LiteLLM UI are left alone.

The `model_catalog` table is a different thing: it lists what each provider **offers** (live `/models`). LiteLLM holds what is **routable**.

Each managed deployment carries a hash of its spec. If `providers.yaml` changes (for example a timeout), the next reconcile replaces the deployment rather than duplicating it. To apply YAML edits, restart the router.

### Aliases (from `config/providers.yaml`)

| Alias | Deployments (in `order`) | Timeout | LiteLLM fallback |
|---|---|---|---|
| `fast` | Groq `openai/gpt-oss-120b` (1) → Cerebras `gpt-oss-120b` (2, only if keyed) | 25 s | `smart-free` |
| `cerebras` | Cerebras `gpt-oss-120b` (only if keyed) | 25 s | — |
| `smart-free` | Gemini `gemini-3.5-flash` | 30 s | `local` |
| `general` | Mistral `mistral-small-latest` (if keyed) | 60 s | — |
| `explore` | OpenRouter `openai/gpt-oss-120b:free` (if keyed) | 60 s | — |
| `code-free` | OpenCode Zen `big-pickle` (if keyed) | 90 s | — |
| `local`, `private` | Ollama `qwen3:4b` | — | none |
| `local-code` | Ollama `qwen2.5-coder:3b` | — | none |

LiteLLM uses the lowest `order` first and retries the next order when it fails (verified in v1.108.8's router source). With `num_retries: 1`, a hung Gemini call reaches `local` in about 2 × 30 s.

## Keys

- `PUT /connections/{provider}/key` first validates the key by listing the provider's models. Only if that works does it store the key, Fernet-encrypted with `SWITCHBOARD_SECRET_KEY`, in `provider_secrets`. It then registers or updates the LiteLLM credential, reconciles aliases and refreshes that provider's catalog. A rejected key changes nothing.
- The router keeps its own encrypted copy because it needs the plaintext to refresh the catalog every 24 h and to test models directly. The API only ever returns the last 4 characters.
- Keys are only ever sent in headers (`Authorization`, or `x-goog-api-key` for Gemini), never in URLs. Logs pass through a redacting filter, and provider error text is scrubbed before it is stored in `last_error`. A test checks that a key never appears in responses, logs or the `connections` table.
- **One-time `.env` import:** any `*_API_KEY` set in `deploy/.env` is imported on the router's first start. After that it is optional, and `doctor.sh` shows a yellow reminder. A key you later remove through the API is not imported again.

### Backups (important)

| Secret | Protects | If lost or changed |
|---|---|---|
| `SWITCHBOARD_SECRET_KEY` | provider keys in the Router DB | the router can't decrypt stored keys; re-enter every key |
| `LITELLM_SALT_KEY` | credentials and models in the LiteLLM DB | LiteLLM can't decrypt them; delete the `sb-*` credentials and re-enter keys |

Copy both values from `deploy/.env` into a password manager. On first start the router records a SHA-256 fingerprint of each in `system_meta`. `doctor.sh` turns red if either one later differs, so an accidental rotation is caught before it does damage.

## API

Write and refresh endpoints need `Authorization: Bearer $ROUTER_ADMIN_TOKEN`. Read endpoints are open on loopback. CORS allows only `http://localhost:3000` and `http://127.0.0.1:3000`, the portal.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | `{status, db, litellm, hostprobe}`. Only the DB affects `status`. |
| GET | `/system/status` | — | Alembic revision, secret-key fingerprint checks, imported keys still in `.env`, last reconcile |
| GET | `/connections` | — | Every provider: kind, status, privacy, free limits, `key_last4`, model count. CLI rows come from hostprobe. |
| PUT | `/connections/{provider}/key` | admin | Validate, store and register a key |
| POST | `/connections/{provider}/test` | admin | Re-list the provider's models with the stored key |
| DELETE | `/connections/{provider}/key` | admin | Remove the key, the LiteLLM credential and the managed deployments |
| POST | `/models/test` | admin | `{"alias": "fast"}` goes through LiteLLM. `{"provider", "model_id"}` calls the provider directly with the stored key. Updates `model_stats` (`task_type="test"`). |
| GET | `/catalog?provider=&tag=&status=&free=` | — | Catalog. `status` defaults to `available`; `all` includes `missing` and `deprecated`. |
| POST | `/catalog/refresh` | admin | Refresh every provider now (it also runs at startup and every 24 h) |
| GET | `/connections/cli` | — | CLI detection via hostprobe |
| POST | `/connections/cli/refresh` | admin | Same, re-probing once hostprobe's 30 s cache has expired |

### curl

```bash
set -a; . deploy/.env; set +a
R=127.0.0.1:8100; A="Authorization: Bearer $ROUTER_ADMIN_TOKEN"

# Status
curl -s $R/health
curl -s $R/connections | python3 -m json.tool
curl -s "$R/catalog?provider=groq&tag=code"
curl -s $R/connections/cli

# Add a key. read -s keeps it out of shell history and the terminal.
read -rs -p "Cerebras key: " KEY; echo
python3 -c 'import json,sys; print(json.dumps({"api_key": sys.argv[1]}))' "$KEY" \
  | curl -s -X PUT -H "$A" -H 'Content-Type: application/json' --data-binary @- $R/connections/cerebras/key
unset KEY

# Test the connection, an alias (through LiteLLM) and a single model (direct)
curl -s -X POST -H "$A" $R/connections/cerebras/test
curl -s -X POST -H "$A" -H 'Content-Type: application/json' -d '{"alias":"fast"}' $R/models/test
curl -s -X POST -H "$A" -H 'Content-Type: application/json' \
  -d '{"provider":"groq","model_id":"openai/gpt-oss-20b"}' $R/models/test

# Remove the key
curl -s -X DELETE -H "$A" $R/connections/cerebras/key

# Refresh the catalog now
curl -s -X POST -H "$A" $R/catalog/refresh
```

## Model catalog

- **Sources:** each provider's own `/models` API, called directly: Groq, Cerebras and Mistral (OpenAI-style), Gemini (`v1beta/models`, `x-goog-api-key`, paginated), OpenRouter, OpenCode Zen (`/zen/v1/models`) and Ollama (`/api/tags`). These responses include context window, output limit, modalities, prices and deprecation, which LiteLLM's model listing drops.
- **Schedule:** on startup, every 24 h, and on `POST /catalog/refresh`. API-key providers without a key are skipped (`no_key`).
- **Status:** `available` | `deprecated` (provider metadata says so, e.g. Groq `active:false`, OpenRouter `expiration_date`, or the model is listed under `deprecated:` in `config/model-tags.yaml`) | `missing` (absent from the latest *successful* fetch). A failed fetch never marks anything missing; it only sets the connection's `last_error`.
- **Tags:** curated rules in `config/model-tags.yaml` (globs, optionally per provider) come first. Otherwise tags are derived from metadata (modalities, context ≥ 200k → `long-context`, reasoning flag). If neither produces tags, the model is `untagged`. Each model's `tag_source` says which applied.
- **`free`:** OpenRouter `:free` or zero price, and Zen zero cost, are per model. For Groq, Gemini, Cerebras, Mistral and Ollama it means "the provider has a free tier"; the limits are in `providers.yaml`.

## hostprobe (CLI detection)

The router runs in Docker and can't execute WSL binaries, so a small stdlib-only service in WSL does it. Rules (M1a review):

- **Allowlist only.** The argv for each CLI (`--version` plus one auth-status command) is hard-coded in `services/hostprobe/hostprobe.py`. No request data reaches a command, and nothing runs through a shell. The only endpoints are `GET /cli` and `GET /health`.
- **Minimal output.** It returns `installed`, `version`, `logged_in`, `windows_only` and `login_method`. Command output is reduced to a version string or a boolean, then discarded. Credential files are checked with `stat` only; they are never opened.
- **Auth and limits.** Every request needs `X-Probe-Token`, compared in constant time. The token is in `deploy/.env`; hostprobe reads only that one variable from the file. It listens on `127.0.0.1` only. Each command has a 5 s timeout. Results are cached for 30 s. Rate limits: 6 probes/min, 60 requests/min.
- **Resolution.** Binaries are looked up on a clean Linux PATH (nvm bin, `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.opencode/bin`, `~/.grok/bin`, `/usr/local/bin`, `/usr/bin`), never under `/mnt/*`. A CLI found only as a Windows install is reported as `windows_only`.
- **Router side.** If hostprobe is down, the router stays healthy and CLI rows show `unknown`.
- Login and install actions come later (M1b/M4.5) as separate allowlisted, user-confirmed endpoints.

| CLI | Version | Logged-in check | Verified |
|---|---|---|---|
| claude | `claude --version` | `claude auth status` (exit 0 = logged in); otherwise `~/.claude/.credentials.json` exists | Not yet (no Linux install; the Windows binary is broken). Falls back to the file check. |
| codex | `codex --version` | `codex login status` ("Logged in") | Yes, `codex login --help` lists `status` |
| gemini | `gemini --version` | `~/.gemini/oauth_creds.json` exists (no status command) | Not yet (no Linux install); known default credential path |
| grok | `grok --version` | `~/.grok/auth.json` or `~/.config/grok/auth.json` exists | No; re-check after installing Grok Build |
| opencode | `opencode --version` | `opencode auth list` ("N credentials", N > 0); otherwise `~/.local/share/opencode/auth.json` | Not yet (no Linux install); output format checked by unit test only |

Debug one probe locally (prints JSON and starts no server):

```bash
python3 services/hostprobe/hostprobe.py --env-file deploy/.env --once
```

## Tests

```bash
# Router: uses a throwaway switchboard_test DB on the same Postgres; providers and LiteLLM are mocked
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm --no-deps router pytest -q
# Live fetchers (opt-in): pass real keys as LIVE_<ENV_KEY>
docker compose ... run --rm --no-deps -e LIVE_GROQ_API_KEY=... router pytest -m live
# hostprobe (stdlib unittest, host python)
python3 -m unittest discover -s services/hostprobe/tests
# Lint
docker compose ... run --rm --no-deps -v "$PWD/services:/srv/services" -w /srv/services router \
  sh -c 'ruff check --no-cache router hostprobe && ruff format --no-cache --check router hostprobe'
```

## Troubleshooting

- **`hostprobe: down` in `/health`:** run `systemctl --user status switchboard-hostprobe`, and check that `HOSTPROBE_TOKEN` in `deploy/.env` matches what the router got. Recreate the router after editing `.env`: `docker compose ... up -d router`.
- **`smart-free` answers via `ollama_chat/qwen3:4b`:** Gemini is timing out and the `local` fallback worked. On 2026-11-17 `gemini-3.5-flash` hung on direct `generateContent` calls too (the same provider-side behaviour M0 saw with 3.8).
- **Reconcile errors at startup:** LiteLLM wasn't up yet. The router retries with backoff, and `/system/status` → `background.reconcile` shows the last result.
- **Changed `SWITCHBOARD_SECRET_KEY`:** restore it from your backup. Otherwise delete the `provider_secrets` rows and re-enter the keys.
