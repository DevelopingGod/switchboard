# Troubleshooting

Start with `scripts/doctor.sh`. Each red line below maps to a fix.

## Node

**`Node source: Windows node first on PATH`**
WSL appends Windows `PATH` entries, so `/mnt/c/.../npm` or `/mnt/d/NodeJS/npm` can win. Make sure `~/.bashrc` loads nvm (setup-wsl.sh adds this) and open a new shell:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm use default
type -a node npm    # the ~/.nvm path must be first
```

To drop Windows paths entirely, set `appendWindowsPath = false` under `[interop]` in `/etc/wsl.conf`, then run `wsl.exe --shutdown`. This also hides Windows CLIs such as `code` and `explorer.exe`.

**`Node version < 24.11`**: run `nvm install 24 && nvm alias default 24`.

## Clock drift

WSL's clock can fall behind after the laptop sleeps. This breaks TLS, OAuth logins (`claude`, `codex login`) and Paperclip agent JWTs.

```bash
sudo hwclock -s          # quick resync
wsl.exe --shutdown       # from PowerShell or WSL: full restart, always resyncs
```

## Port conflicts

`doctor.sh` checks 5432 (Postgres), 4000 (LiteLLM) and 3100 (Paperclip). If one of them shows `in use by another process`:

```bash
ss -ltnp 'sport = :5432'                                   # inside WSL
powershell.exe "Get-NetTCPConnection -LocalPort 5432 -State Listen | Select OwningProcess"   # on Windows
```

Docker Desktop publishes ports on the Windows host, so a native Windows Postgres or another container can hold the port. Either stop that service, or change `POSTGRES_PORT` / `LITELLM_PORT` in `deploy/.env` and run `docker compose ... up -d` again. For Paperclip, use `paperclipai configure` and update `PAPERCLIP_URL` to match.

## Ollama

**`Ollama reachable: no answer`**
- Start Ollama on Windows (tray icon or `ollama serve`).
- Check it from Docker, the path LiteLLM uses: `docker run --rm curlimages/curl:8.10.1 -s http://host.docker.internal:11434/api/version`.
- WSL `localhost:11434` won't work with NAT networking. This is expected, and only Docker needs to reach Ollama.

**`Model qwen3:4b missing`**: on Windows, run `ollama pull qwen3:4b`.

## LiteLLM

**Keys changed but calls still fail**: LiteLLM reads env vars only at start.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d litellm
```

**LiteLLM won't start: `error mounting ... to rootfs at "/app/config.yaml"`**: this comes from an old compose file that mounted the single file. Docker Desktop loses a single-file bind mount when an editor replaces the file. The current compose file mounts the `config/` directory instead, so pull the latest and run `up -d litellm`.

**`HTTP 401 Invalid API Key` (Groq)**: the key is wrong or revoked. Create a new one at console.groq.com.

**`smart-free` times out**: some Gemini models hang on `generateContent` for some accounts even though they're in the model list. That's why `config/litellm.yaml` pins a specific version instead of `gemini-flash-latest`. Test candidate models directly:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"ping"}]}]}'
```

**`fast` shows yellow `fallback`**: Groq failed (rate limit, outage) and Gemini answered. To see why, run `docker compose ... logs litellm`.

**Never change `LITELLM_SALT_KEY`** after first start, or LiteLLM can no longer decrypt the provider keys stored in its DB.

## Paperclip

```bash
paperclipai service status
paperclipai service logs
paperclipai service restart
paperclipai doctor
```

Data and config live in `~/.paperclip/instances/default/`. If `paperclipai` isn't found, add `~/.local/bin` to `PATH`.

## gitleaks pre-commit hook

**`pre-commit: gitleaks not installed`**: run `scripts/setup-wsl.sh`, which installs the pinned gitleaks into `~/.local/bin` and sets `core.hooksPath=.githooks`.

**False positive**: add `# gitleaks:allow` to the end of the line, or add a rule allowlist in `.gitleaks.toml`. Use `git commit --no-verify` only after confirming the match isn't a real secret.

## Line endings

`.gitattributes` forces LF. If a script fails with `/usr/bin/env: 'bash\r'`, it was edited on Windows with CRLF:

```bash
git add --renormalize . && git checkout -- .
```
