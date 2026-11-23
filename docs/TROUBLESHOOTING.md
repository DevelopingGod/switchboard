# Troubleshooting

Start with `scripts/doctor.sh`. Each red line below maps to a fix.

`doctor.sh` never waits on the terminal: every check has a hard timeout (5 s for commands, 3 s for network calls; 10 s for the router's CLI-detection endpoints and 45 s per live model call) and shows `timed out after Ns` instead of hanging. It prints each check's name while it runs. `scripts/doctor.sh --verbose` also prints every command (secrets redacted), its exit code and duration. Use it instead of `bash -x`, which prints every key in `deploy/.env`. Optional providers you skipped (`optional: true` in `config/providers.yaml`, e.g. Cerebras) show as a grey `○ skipped`, not a warning.

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

**`Model … missing` (local-model profile, M3a)**: run `scripts/setup-wsl.sh --pull-models`, or use Settings → Local models → Pull missing models. A missing classifier is only yellow: routing uses the keyword heuristics until it's pulled.

**Routing says "classifier slower than 1.5 s" or "classifier is loading" after a private chat (small GPUs)**: on 4 GB the classifier (1.1 GB) and qwen3:4b or llama3.2:3b don't fit together, so Ollama swaps them, whatever `keep_alive` says. The router reloads the classifier in the background after the other model runs; until then (about 3 s) the keyword heuristics decide. `OLLAMA_MAX_LOADED_MODELS` doesn't help: these evictions are by memory, not by count, so leave it at its default. To keep the classifier always loaded, run it on the CPU: add `classifier_options: { num_gpu: 0 }` to the `small` profile in `config/local-models.yaml` (≈ 0.9 s per message, 95% on the labelled set; docs/m3a.md).

**Titles stay as the first words**: the tasks model (llama3.2:3b in the GPU profiles) isn't pulled, or Ollama is down. qwen3 models can't do titles: they write their reasoning into the answer even with thinking off.

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

## Router after pulling M3b

The router needs a rebuild (new migrations 0005 `rules_versions` and 0006 thread index run on start) and hostprobe a restart (new `claude` login parser):

```bash
docker compose -f deploy/docker-compose.yml up -d --build router
systemctl --user restart switchboard-hostprobe
```

## Classifier slow or falling back on a small GPU

On the `small` local profile (4–6 GB GPU) Arch-Router and the tasks model run on the CPU so nothing swaps (ADR 0002). `ollama ps` should list all three models, with 0 MiB in GPU for the CPU ones. The classifier takes ~0.9 s a call there against a 1.5 s limit; on a slower CPU raise `classifier.timeout_s` (Settings → Routing rules → Commands & classifier). Measure with:

```bash
docker compose -f deploy/docker-compose.yml run --rm --no-deps -v "$PWD/scripts:/scripts:ro" router python /scripts/measure-local.py
```

## A saved rule edit "no longer fits rules.yaml"

After you edit `config/rules.yaml` (removing or renaming a rule your saved changes touch), Routing rules shows a red notice and routing uses the plain file until you fix it. Reset your changes there, or roll back to a version that still fits.

## Router image rebuild is slow or times out on PyPI

The router image installs its Python packages in their own layer, before the code is copied
(`services/router/Dockerfile`). A code-only change reuses that layer and rebuilds in seconds with no downloads; only
a change to `services/router/pyproject.toml` reinstalls packages.

- **Retries reuse downloads.** pip's cache is a BuildKit cache mount (`/root/.cache/pip`), kept between builds but
  never put in the image. If PyPI times out halfway, run the build again: wheels already downloaded come from the
  cache (`Using cached …` in `--progress=plain` output).
- **Slow network:** `PIP_DEFAULT_TIMEOUT=120` and `PIP_RETRIES=10` are set in the Dockerfile.
- **Start clean:** `docker builder prune` removes the build cache, including the pip cache mount; the next build
  downloads everything again.
- **Check:** `docker compose -f deploy/docker-compose.yml build --progress=plain router`; after a code-only change
  the dependency step says `CACHED`.

## Data folder (attachments)

Attachments (files and images in chat and jobs) live in the data folder, `~/.switchboard/data` by default
(`SWITCHBOARD_DATA_DIR` in `deploy/.env`). It is outside the repository, mode 700, and owned by you: the router
container runs as your user (`SWITCHBOARD_UID`/`SWITCHBOARD_GID`, filled by `scripts/setup-wsl.sh`) so the router
and hostprobe can both read and write it.

- **doctor says the folder is missing:** run `scripts/setup-wsl.sh` (it creates the folder before the router
  starts). If the router started first, Docker created the folder itself, owned by root.
- **Owned by root or another user:** Switchboard never uses `sudo`. Stop the router, then fix the owner once
  yourself (for example `sudo chown -R "$(id -u):$(id -g)" ~/.switchboard/data`), `chmod 700` it, and start the
  router again.
- **"not writable" in doctor:** `SWITCHBOARD_UID`/`SWITCHBOARD_GID` in `deploy/.env` must be your `id -u`/`id -g`,
  then `docker compose -f deploy/docker-compose.yml up -d router`.
- **Backups:** back the folder up with `deploy/.env`. Deleting a chat deletes its files; Settings → Data → Export
  includes the files only when you tick "Include attachments".
