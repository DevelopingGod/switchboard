#!/usr/bin/env bash
# Switchboard health check. GREEN/RED = current milestone (M0) components; YELLOW = later
# milestones or advisory. Exits non-zero if anything is RED.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.yml")
RED=0

green()  { printf '  \033[32m●\033[0m %-28s %s\n' "$1" "${2:-}"; }
yellow() { printf '  \033[33m●\033[0m %-28s %s\n' "$1" "${2:-}"; }
red()    { printf '  \033[31m●\033[0m %-28s %s\n' "$1" "${2:-}"; RED=$((RED + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -f "$ENV_FILE" ]] || { red "deploy/.env" "missing — run scripts/setup-wsl.sh"; exit 1; }
set -a; . "$ENV_FILE"; set +a
LITELLM="http://127.0.0.1:${LITELLM_PORT:-4000}"

# json EXPR — evaluate a Python expression against stdin JSON as `d`.
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

section "Host"
# Node source: what a fresh interactive shell (i.e. the user's terminal, ~/.bashrc loaded)
# resolves. Windows Node via /mnt/* interop breaks Paperclip and native modules.
resolved=$(timeout 10 bash -ic 'echo "@@node=$(command -v node)"; echo "@@npm=$(command -v npm)"' 2>/dev/null </dev/null)
caller_node=$(sed -n 's/^@@node=//p' <<<"$resolved")
caller_npm=$(sed -n 's/^@@npm=//p' <<<"$resolved")
case "$caller_node" in
  "$HOME"/.nvm/*) green "Node source" "nvm ($caller_node)" ;;
  /mnt/*)         red "Node source" "Windows node first on PATH ($caller_node) — source ~/.nvm/nvm.sh in ~/.bashrc" ;;
  "")             red "Node source" "no node in an interactive shell — check ~/.bashrc loads nvm" ;;
  *)              yellow "Node source" "non-nvm node ($caller_node)" ;;
esac
[[ "$caller_npm" == /mnt/* ]] && red "npm source" "Windows npm first on PATH ($caller_npm)"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use default >/dev/null 2>&1
if node_v=$(node --version 2>/dev/null) && [[ "$(command -v node)" != /mnt/* ]]; then
  if python3 -c "import sys; v=tuple(map(int,'${node_v#v}'.split('.'))); sys.exit(v < (24,11,0))"; then
    green "Node version" "$node_v"
  else red "Node version" "$node_v < 24.11"; fi
else red "Node version" "no Linux node — run scripts/setup-wsl.sh"; fi

# Clock drift: WSL's clock can fall behind after the laptop sleeps, which breaks TLS,
# OAuth logins and JWTs. Compare against an HTTPS Date header.
if remote=$(curl -sSI -m 5 https://www.google.com 2>/dev/null | grep -i '^date:' | cut -d' ' -f2- | tr -d '\r') && [[ -n "$remote" ]]; then
  drift=$(( $(date +%s) - $(date -d "$remote" +%s) )); drift=${drift#-}
  if (( drift <= 5 )); then green "Clock drift" "${drift}s"
  elif (( drift <= 30 )); then yellow "Clock drift" "${drift}s — wsl.exe --shutdown resyncs"
  else red "Clock drift" "${drift}s — run: sudo hwclock -s  (or wsl.exe --shutdown)"; fi
else yellow "Clock drift" "could not reach a time reference"; fi

if docker info >/dev/null 2>&1; then green "Docker" "$(docker version -f '{{.Server.Version}}')"
else red "Docker" "daemon not reachable — start Docker Desktop"; fi

section "Ports"
# port_check PORT NAME OWNER_FN — green if our service owns it, red if something else does.
listening() { timeout 2 bash -c "</dev/tcp/127.0.0.1/$1" 2>/dev/null; }
port_check() {
  if "$3" >/dev/null 2>&1; then green "$1 ($2)" "owned by $2"
  elif listening "$1"; then red "$1 ($2)" "in use by another process — ss -ltnp 'sport = :$1'"
  else red "$1 ($2)" "nothing listening"; fi
}
PAPERCLIP_URL=${PAPERCLIP_URL:-http://127.0.0.1:3100}
owns_postgres()  { "${COMPOSE[@]}" port postgres 5432 | grep -q ":${POSTGRES_PORT:-5432}\$"; }
owns_litellm()   { curl -fsS -m 3 "$LITELLM/health/liveliness"; }
owns_paperclip() { curl -fsS -m 3 "$PAPERCLIP_URL/api/health"; }
port_check "${POSTGRES_PORT:-5432}" postgres owns_postgres
port_check "${LITELLM_PORT:-4000}" litellm owns_litellm
port_check "${PAPERCLIP_URL##*:}" paperclip owns_paperclip

section "Services"
for svc in postgres litellm; do
  state=$("${COMPOSE[@]}" ps --format '{{.Health}}' "$svc" 2>/dev/null)
  if [[ "$state" == healthy ]]; then green "$svc container" healthy
  else red "$svc container" "${state:-not running} — docker compose -f deploy/docker-compose.yml up -d"; fi
done

dbs=$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-switchboard}" -d switchboard -Atc \
  "select datname from pg_database where datname in ('switchboard','litellm') order by 1" 2>/dev/null | tr '\n' ' ')
if [[ "$dbs" == "litellm switchboard " ]]; then green "Postgres databases" "litellm, switchboard"
else red "Postgres databases" "found: '${dbs}'"; fi

if curl -fsS -m 5 "$LITELLM/health/liveliness" >/dev/null 2>&1; then green "LiteLLM proxy" "$LITELLM"
else red "LiteLLM proxy" "not answering on $LITELLM"; fi

models=$(curl -fsS -m 5 -H "Authorization: Bearer $LITELLM_MASTER_KEY" "$LITELLM/v1/models" | json '" ".join(sorted(m["id"] for m in d["data"]))')
for alias in fast smart-free local private; do
  [[ " $models " == *" $alias "* ]] || red "LiteLLM alias $alias" "not registered"
done
[[ -n "$models" ]] && green "LiteLLM aliases" "$models"

section "Ollama (Windows, via Docker)"
tags=$("${COMPOSE[@]}" exec -T litellm python -c \
  "import urllib.request,os; print(urllib.request.urlopen(os.environ['OLLAMA_API_BASE']+'/api/tags', timeout=5).read().decode())" 2>/dev/null)
if [[ -n "$tags" ]]; then
  green "Ollama reachable" "$OLLAMA_API_BASE"
  have() { echo "$tags" | json "any(m['name']=='$1' for m in d['models'])" | grep -q True; }
  if have qwen3:4b; then green "Model qwen3:4b" "pulled"; else red "Model qwen3:4b" "missing — ollama pull qwen3:4b"; fi
  if have hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M; then green "Arch-Router (M3)" "pulled"
  else yellow "Arch-Router (M3)" "not pulled yet"; fi
else red "Ollama reachable" "no answer from $OLLAMA_API_BASE — start Ollama on Windows"; fi

section "Provider keys"
[[ -n "${GROQ_API_KEY:-}" ]] && green "GROQ_API_KEY" set || red "GROQ_API_KEY" "empty in deploy/.env"
[[ -n "${GEMINI_API_KEY:-}" ]] && green "GEMINI_API_KEY" set || red "GEMINI_API_KEY" "empty in deploy/.env"
[[ -n "${CEREBRAS_API_KEY:-}" ]] && green "CEREBRAS_API_KEY (M1)" set || yellow "CEREBRAS_API_KEY (M1)" "not set"

section "Live calls through LiteLLM"
# call ALIAS EXPECTED_PROVIDER_SUBSTRING
call() {
  local hdrs out code body served
  hdrs=$(mktemp)
  out=$(curl -sS -m 90 -D "$hdrs" -w '\n%{http_code}' "$LITELLM/v1/chat/completions" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$1\",\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]}" 2>&1)
  code=${out##*$'\n'}; body=${out%$'\n'*}
  # The body echoes the alias; the header names the deployment that actually served it.
  served=$(grep -i '^x-litellm-model-name:' "$hdrs" | cut -d' ' -f2 | tr -d '\r')
  rm -f "$hdrs"
  if [[ "$code" != 200 ]]; then
    red "$1" "HTTP $code: $(echo "$body" | json 'd["error"]["message"][:120]' || echo "${body:0:120}")"
    return
  fi
  if [[ "$served" == *"$2"* ]]; then green "$1" "200 via $served"
  else yellow "$1" "200 via $served (fallback, expected $2)"; fi
}
call fast gpt-oss
call smart-free gemini
call local qwen3

section "Paperclip"
if h=$(curl -fsS -m 5 "$PAPERCLIP_URL/api/health" 2>/dev/null); then
  green "Paperclip API" "$PAPERCLIP_URL $(echo "$h" | json 'd.get("status","")')"
else red "Paperclip API" "no answer — paperclipai service start (see docs/TROUBLESHOOTING.md)"; fi

section "Agent CLIs in WSL (M1)"
for cli in claude codex gemini grok opencode; do
  p=$(command -v "$cli" 2>/dev/null || true)
  if [[ -z "$p" ]]; then yellow "$cli" "not installed"
  elif [[ "$p" == /mnt/* ]]; then yellow "$cli" "Windows binary only ($p)"
  else green "$cli" "$($cli --version 2>/dev/null | head -1)"; fi
done

echo
if (( RED == 0 )); then printf '\033[32mAll M0 checks green.\033[0m\n'
else printf '\033[31m%d M0 check(s) red.\033[0m\n' "$RED"; exit 1; fi
