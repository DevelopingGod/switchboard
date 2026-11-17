#!/usr/bin/env bash
# Switchboard health check. GREEN/RED = components of shipped milestones (M0, M1a, M1b); YELLOW = later
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
ROUTER="http://127.0.0.1:${ROUTER_PORT:-8100}"
HOSTPROBE="http://127.0.0.1:${HOSTPROBE_PORT:-8101}"

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
owns_router()    { curl -fsS -m 3 "$ROUTER/health" | grep -q '"db"'; }
owns_hostprobe() { curl -sS -m 3 "$HOSTPROBE/health" | grep -q 'unauthorized\|"ok"'; }
port_check "${POSTGRES_PORT:-5432}" postgres owns_postgres
port_check "${LITELLM_PORT:-4000}" litellm owns_litellm
port_check "${PAPERCLIP_URL##*:}" paperclip owns_paperclip
port_check "${ROUTER_PORT:-8100}" router owns_router
port_check "${HOSTPROBE_PORT:-8101}" hostprobe owns_hostprobe

section "Services"
for svc in postgres litellm router; do
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
for alias in fast smart-free local private local-code; do
  [[ " $models " == *" $alias "* ]] || red "LiteLLM alias $alias" "not registered"
done
[[ -n "${CEREBRAS_API_KEY:-}$(curl -fsS -m 5 "$ROUTER/connections" 2>/dev/null | json '"x" if any(p["provider"]=="cerebras" and p["status"]=="connected" for p in d["providers"]) else ""')" \
   && " $models " != *" cerebras "* ]] && red "LiteLLM alias cerebras" "Cerebras keyed but alias not registered"
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

section "Router API (M1a)"
if h=$(curl -fsS -m 10 "$ROUTER/health" 2>/dev/null); then
  [[ $(echo "$h" | json 'd["db"]') == ok ]] && green "Router API" "$ROUTER" || red "Router API" "db: $(echo "$h" | json 'd["db"]')"
  [[ $(echo "$h" | json 'd["litellm"]') == ok ]] && green "Router -> LiteLLM" ok || red "Router -> LiteLLM" down
  rules=$(echo "$h" | json 'd.get("rules","missing")')
  [[ "$rules" == ok* ]] && green "Routing rules (M2)" "config/rules.yaml $rules" || red "Routing rules (M2)" "config/rules.yaml: $rules"
  [[ $(echo "$h" | json 'd.get("fault_injection")') == True ]] \
    && yellow "Fault injection" "ON (dev only): unset ROUTER_FAULT_INJECTION and restart the router" \
    || green "Fault injection" "off"
else red "Router API" "no answer on $ROUTER — docker compose -f deploy/docker-compose.yml up -d router"; fi

status=$(curl -fsS -m 10 "$ROUTER/system/status" 2>/dev/null)
head_rev=$("${COMPOSE[@]}" exec -T router alembic heads 2>/dev/null | awk '{print $1}')
cur_rev=$(echo "$status" | json 'd["alembic_revision"]')
if [[ -n "$head_rev" && "$cur_rev" == "$head_rev" ]]; then green "Router DB migrations" "at head ($cur_rev)"
else red "Router DB migrations" "current '${cur_rev}', head '${head_rev}' — restart the router (it runs alembic upgrade head)"; fi

# Secret keys: the router stores a SHA-256 fingerprint on first start. A changed key makes stored
# provider keys (SWITCHBOARD_SECRET_KEY) or LiteLLM credentials (LITELLM_SALT_KEY) undecryptable.
for k in switchboard_secret_key litellm_salt_key; do
  K=${k^^}; v=$(echo "$status" | json "d['secret_keys']['$k']")
  case "$v" in
    ok)         green "$K" "set, matches stored fingerprint" ;;
    unrecorded) yellow "$K" "set, fingerprint not recorded yet (router not started?)" ;;
    changed)    red "$K" "CHANGED since first start — restore it from your backup (docs/m1a.md, Backups)" ;;
    *)          red "$K" "${v:-unknown} — run scripts/setup-wsl.sh" ;;
  esac
done

section "Providers (via Router)"
conns=$(curl -fsS -m 30 "$ROUTER/connections" 2>/dev/null)
if [[ -z "$conns" ]]; then red "Providers" "router /connections did not answer"
else
  while IFS='|' read -r pid kind st n err; do
    case "$kind:$st" in
      api_key:connected|local:connected)
        if (( n > 0 )); then green "$pid" "connected, $n models in catalog"
        else red "$pid" "connected but 0 available models — POST /catalog/refresh"; fi ;;
      api_key:no_key)
        if [[ "$pid" == groq || "$pid" == gemini ]]; then red "$pid" "no key (needed for fast/smart-free) — docs/m1a.md"
        else yellow "$pid" "no key (optional)"; fi ;;
      *) red "$pid" "$st: ${err:0:100}" ;;
    esac
  done < <(echo "$conns" | python3 -c '
import json, sys
for p in json.load(sys.stdin)["providers"]:
    if p["kind"] != "cli":
        print("|".join(str(x) for x in (p["provider"], p["kind"], p["status"], p.get("models_available") or 0, (p.get("last_error") or "").replace("|", "/"))))')
fi
left=$(echo "$status" | json '" ".join(d["env_keys_still_present"])')
[[ -n "$left" ]] && yellow "deploy/.env provider keys" "provider keys still in deploy/.env — optional to remove ($left)"

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
call local-code qwen2.5-coder

section "Paperclip"
if h=$(curl -fsS -m 5 "$PAPERCLIP_URL/api/health" 2>/dev/null); then
  green "Paperclip API" "$PAPERCLIP_URL $(echo "$h" | json 'd.get("status","")')"
else red "Paperclip API" "no answer — paperclipai service start (see docs/TROUBLESHOOTING.md)"; fi

section "hostprobe (CLI detection, M1a)"
if systemctl --user is-active --quiet switchboard-hostprobe.service; then green "hostprobe service" active
else red "hostprobe service" "not active — systemctl --user restart switchboard-hostprobe (scripts/setup-wsl.sh installs it)"; fi
if curl -fsS -m 5 -H "X-Probe-Token: ${HOSTPROBE_TOKEN:-}" "$HOSTPROBE/health" 2>/dev/null | grep -q ok; then
  green "hostprobe health" "$HOSTPROBE (token ok)"
else red "hostprobe health" "no authorized answer on $HOSTPROBE — check HOSTPROBE_TOKEN in deploy/.env"; fi
[[ $(curl -fsS -m 10 "$ROUTER/health" 2>/dev/null | json 'd["hostprobe"]') == ok ]] \
  && green "Router -> hostprobe" ok || red "Router -> hostprobe" "router cannot reach host.docker.internal:${HOSTPROBE_PORT:-8101}"

section "Agent CLIs in WSL (detected by hostprobe)"
clis=$(curl -fsS -m 30 "$ROUTER/connections/cli" 2>/dev/null)
while IFS='|' read -r pid st ver; do
  case "$st" in
    logged_in)     green "$pid" "v$ver, logged in" ;;
    logged_out)    yellow "$pid" "v$ver, installed, not logged in" ;;
    installed)     yellow "$pid" "v$ver, installed, login status unknown" ;;
    windows_only)  yellow "$pid" "Windows binary only — install the Linux CLI in WSL" ;;
    not_installed) yellow "$pid" "not installed in WSL" ;;
    *)             yellow "$pid" "$st" ;;
  esac
done < <(echo "$clis" | python3 -c '
import json, sys
for k, c in json.load(sys.stdin)["clis"].items():
    print("|".join([k, c["status"], c.get("version") or "?"]))' 2>/dev/null)

section "Portal (M1b)"
PORTAL_ENV="$ROOT/apps/portal/.env.local"
if [[ ! -f "$PORTAL_ENV" ]]; then
  red "portal env" "apps/portal/.env.local missing — run scripts/setup-wsl.sh"
elif grep -qx "ROUTER_ADMIN_TOKEN=${ROUTER_ADMIN_TOKEN:-}" "$PORTAL_ENV" && [[ -n "${ROUTER_ADMIN_TOKEN:-}" ]]; then
  green "portal env" "ROUTER_ADMIN_TOKEN matches deploy/.env (server-side only)"
else
  red "portal env" "ROUTER_ADMIN_TOKEN in apps/portal/.env.local differs from deploy/.env"
fi
# The portal holds the admin token and has no login yet (carry-over to M7): it must stay on loopback.
bound=$(ss -ltnH 'sport = :3000' 2>/dev/null | awk '{print $4}')
if [[ -z "$bound" ]]; then
  yellow "portal :3000" "not running — cd apps/portal && npm run dev (binds 127.0.0.1)"
elif grep -qE '^(0\.0\.0\.0|\*|\[::\]|::):3000$' <<<"$bound"; then
  red "portal :3000" "listening on all interfaces ($(echo $bound)) — start it with next dev/start -H 127.0.0.1 (npm run dev does)"
else
  green "portal :3000" "bound to $(echo $bound) only"
fi

echo
if (( RED == 0 )); then printf '\033[32mAll checks green.\033[0m\n'
else printf '\033[31m%d check(s) red.\033[0m\n' "$RED"; exit 1; fi
