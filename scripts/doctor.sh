#!/usr/bin/env bash
# Switchboard health check. GREEN/RED = components of shipped milestones; YELLOW = later milestones or
# advisory; GREY = skipped on purpose (optional provider without a key). Exits non-zero if anything is RED.
#
# Never hangs: stdin is /dev/null, no interactive shell is spawned, and every external command runs under
# a hard timeout (SIGKILL one second after SIGTERM): 5 s for commands, 3 s for network calls. Two
# deliberate exceptions, because they are slow by nature and would show false reds:
#   - router /connections and /connections/cli: 10 s (they may run hostprobe CLI detection);
#   - live model calls through LiteLLM: 45 s each (cold local model load; smart-free may wait out a
#     30 s Gemini timeout before falling back to local).
# A check that hits its limit is reported as "timed out", never waited on.
#
# Usage: scripts/doctor.sh [-v|--verbose] [-h|--help]
#   --verbose  print every command (secrets redacted), its exit code and duration, on stderr
set -uo pipefail

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Nothing below may wait on the terminal. fd 3 = the real stderr, for progress and --verbose output that
# must survive callers' `2>/dev/null`.
exec </dev/null 3>&2

T_CMD=5      # local commands (docker, compose exec, systemctl, ss, python)
T_NET=3      # HTTP calls
T_PROBE=10   # router endpoints that may run hostprobe CLI detection
T_LIVE=45    # one live model call

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.yml")
RED=0
TTY=0; [[ -t 3 ]] && TTY=1

# --- output ------------------------------------------------------------------------------------------
CHECK=""; CHECK_T0=0
now_ms() { date +%s%3N; }
clear_progress() { (( TTY && !VERBOSE )) && printf '\r\033[K' >&3; return 0; }
# begin NAME — announce a check before running it, so a slow step is visible while it runs.
begin() {
  CHECK=$1; CHECK_T0=$(now_ms)
  if (( VERBOSE )); then printf '  … %s\n' "$1" >&3
  elif (( TTY )); then printf '\r\033[K  … %s' "$1" >&3
  fi
}
took() { (( VERBOSE )) && printf ' \033[2m(%d ms)\033[0m' $(( $(now_ms) - CHECK_T0 )); return 0; }
line() { clear_progress; printf "  $1 %-28s %s" "$2" "${3:-}"; took; printf '\n'; }
green()  { line '\033[32m●\033[0m' "$1" "${2:-}"; }
yellow() { line '\033[33m●\033[0m' "$1" "${2:-}"; }
red()    { line '\033[31m●\033[0m' "$1" "${2:-}"; RED=$((RED + 1)); }
skip()   { line '\033[2m○\033[0m' "$1" "${2:-}"; }   # grey: skipped on purpose, not counted
section() { clear_progress; printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- running things -----------------------------------------------------------------------------------
redact() {
  local s="$*" v
  for v in "${LITELLM_MASTER_KEY:-}" "${ROUTER_ADMIN_TOKEN:-}" "${HOSTPROBE_TOKEN:-}" "${POSTGRES_PASSWORD:-}"; do
    [[ -n "$v" ]] && s=${s//"$v"/***}
  done
  printf '%s' "$s"
}
# run SECS CMD... — run with a hard timeout. Exit 124/137 means it timed out.
LAST_TIMEOUT=0
run() {
  local secs=$1; shift
  local t0 rc; t0=$(now_ms)
  (( VERBOSE )) && printf '    $ %s\n' "$(redact "$@")" >&3
  timeout -k 1 "$secs" "$@"; rc=$?
  LAST_TIMEOUT=0; [[ $rc == 124 || $rc == 137 ]] && LAST_TIMEOUT=$secs
  (( VERBOSE )) && printf '    → exit %d, %d ms%s\n' "$rc" $(( $(now_ms) - t0 )) \
    "$( (( LAST_TIMEOUT )) && echo ", TIMED OUT after ${secs}s")" >&3
  return $rc
}
# http [SECS] CURL_ARGS... — curl with connect + total limits (default T_NET).
http() {
  local secs=$T_NET
  [[ "$1" =~ ^[0-9]+$ ]] && { secs=$1; shift; }
  run $(( secs + 1 )) curl -sS --connect-timeout 2 -m "$secs" "$@"
}
# why_failed — suffix for a red line when the last command timed out.
why_failed() { (( LAST_TIMEOUT )) && printf ' (timed out after %ss)' "$LAST_TIMEOUT"; return 0; }

# json EXPR — evaluate a Python expression against stdin JSON as `d`.
json() { run "$T_CMD" python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

[[ -f "$ENV_FILE" ]] || { red "deploy/.env" "missing — run scripts/setup-wsl.sh"; exit 1; }
set -a; . "$ENV_FILE"; set +a
LITELLM="http://127.0.0.1:${LITELLM_PORT:-4000}"
ROUTER="http://127.0.0.1:${ROUTER_PORT:-8100}"
HOSTPROBE="http://127.0.0.1:${HOSTPROBE_PORT:-8101}"

section "Host"
# Node source: what the user's terminal resolves. No interactive shell (it ignores SIGTERM and can grab
# the TTY, which made this check hang). Instead: the login-shell PATH, plus whether the shell rc files
# load nvm (Ubuntu's ~/.bashrc returns early for non-interactive shells, so nvm only appears there).
begin "Node source"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
resolved=$(run "$T_CMD" bash -lc 'echo "@@node=$(command -v node)"; echo "@@npm=$(command -v npm)"' 2>/dev/null)
login_node=$(sed -n 's/^@@node=//p' <<<"$resolved")
login_npm=$(sed -n 's/^@@npm=//p' <<<"$resolved")
rc_nvm=""
for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  grep -qsE '^[^#]*nvm\.sh' "$f" && { rc_nvm=${f/#$HOME/\~}; break; }
done
nvm_node=""
[[ -s "$NVM_DIR/nvm.sh" ]] && nvm_node=$(run "$T_CMD" bash -c '. "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm which default 2>/dev/null' 2>/dev/null)
[[ "$nvm_node" == "$NVM_DIR"/* && -x "$nvm_node" ]] || nvm_node=""
if [[ -n "$rc_nvm" && -n "$nvm_node" ]]; then green "Node source" "nvm via $rc_nvm ($nvm_node)"; node_bin=$nvm_node
else
  node_bin=""
  case "$login_node" in
    "$NVM_DIR"/*) green "Node source" "nvm ($login_node)"; node_bin=$login_node ;;
    /mnt/*)       red "Node source" "Windows node first on PATH ($login_node) — load ~/.nvm/nvm.sh in ~/.bashrc" ;;
    "")           red "Node source" "no Linux node — ~/.bashrc does not load nvm (run scripts/setup-wsl.sh)" ;;
    *)            yellow "Node source" "non-nvm node ($login_node)"; node_bin=$login_node ;;
  esac
  [[ "$login_npm" == /mnt/* ]] && red "npm source" "Windows npm first on PATH ($login_npm)"
fi

begin "Node version"
if [[ -n "$node_bin" ]] && node_v=$(run "$T_CMD" "$node_bin" --version 2>/dev/null); then
  if run "$T_CMD" python3 -c "import sys; v=tuple(map(int,'${node_v#v}'.split('.'))); sys.exit(v < (24,11,0))"; then
    green "Node version" "$node_v"
  else red "Node version" "$node_v < 24.11"; fi
else red "Node version" "no Linux node$(why_failed) — run scripts/setup-wsl.sh"; fi

# Clock drift: WSL's clock can fall behind after the laptop sleeps, which breaks TLS,
# OAuth logins and JWTs. Compare against an HTTPS Date header.
begin "Clock drift"
if remote=$(http -I https://www.google.com 2>/dev/null | grep -i '^date:' | cut -d' ' -f2- | tr -d '\r') && [[ -n "$remote" ]]; then
  drift=$(( $(date +%s) - $(date -d "$remote" +%s) )); drift=${drift#-}
  if (( drift <= 5 )); then green "Clock drift" "${drift}s"
  elif (( drift <= 30 )); then yellow "Clock drift" "${drift}s — wsl.exe --shutdown resyncs"
  else red "Clock drift" "${drift}s — run: sudo hwclock -s  (or wsl.exe --shutdown)"; fi
else yellow "Clock drift" "could not reach a time reference within ${T_NET}s"; fi

begin "Docker"
DOCKER_OK=0
if run "$T_CMD" docker info >/dev/null 2>&1; then DOCKER_OK=1; green "Docker" "$(run "$T_CMD" docker version -f '{{.Server.Version}}' 2>/dev/null)"
else red "Docker" "daemon not reachable$(why_failed) — start Docker Desktop"; fi
# dc ARGS... — docker compose under the command timeout; fails at once when Docker is down, so the
# checks below don't each wait out their own timeout. dc_why explains such a failure.
dc() { (( DOCKER_OK )) || return 125; run "$T_CMD" "${COMPOSE[@]}" "$@"; }
dc_why() { (( DOCKER_OK )) || printf ' (Docker not reachable)'; return 0; }

section "Ports"
# port_check PORT NAME OWNER_FN — green if our service owns it, red if something else does.
listening() { run 2 bash -c "</dev/tcp/127.0.0.1/$1" 2>/dev/null; }
port_check() {
  begin "$1 ($2)"
  if "$3" >/dev/null 2>&1; then green "$1 ($2)" "owned by $2"
  elif listening "$1"; then red "$1 ($2)" "in use by another process — ss -ltnp 'sport = :$1'"
  else red "$1 ($2)" "nothing listening"; fi
}
PAPERCLIP_URL=${PAPERCLIP_URL:-http://127.0.0.1:3100}
owns_postgres()  { dc port postgres 5432 | grep -q ":${POSTGRES_PORT:-5432}\$"; }
owns_litellm()   { http -f "$LITELLM/health/liveliness"; }
owns_paperclip() { http -f "$PAPERCLIP_URL/api/health"; }
owns_router()    { http -f "$ROUTER/health" | grep -q '"db"'; }
owns_hostprobe() { http "$HOSTPROBE/health" | grep -q 'unauthorized\|"ok"'; }
port_check "${POSTGRES_PORT:-5432}" postgres owns_postgres
port_check "${LITELLM_PORT:-4000}" litellm owns_litellm
port_check "${PAPERCLIP_URL##*:}" paperclip owns_paperclip
port_check "${ROUTER_PORT:-8100}" router owns_router
port_check "${HOSTPROBE_PORT:-8101}" hostprobe owns_hostprobe

section "Services"
for svc in postgres litellm router; do
  begin "$svc container"
  state=$(dc ps --format '{{.Health}}' "$svc" 2>/dev/null)
  if [[ "$state" == healthy ]]; then green "$svc container" healthy
  else red "$svc container" "${state:-not running}$(dc_why) — docker compose -f deploy/docker-compose.yml up -d"; fi
done

begin "Postgres databases"
dbs=$(dc exec -T postgres psql -U "${POSTGRES_USER:-switchboard}" -d switchboard -Atc \
  "select datname from pg_database where datname in ('switchboard','litellm') order by 1" 2>/dev/null | tr '\n' ' ')
if [[ "$dbs" == "litellm switchboard " ]]; then green "Postgres databases" "litellm, switchboard"
else red "Postgres databases" "found: '${dbs}'$(dc_why)"; fi

begin "LiteLLM proxy"
if http -f "$LITELLM/health/liveliness" >/dev/null 2>&1; then green "LiteLLM proxy" "$LITELLM"
else red "LiteLLM proxy" "not answering on $LITELLM$(why_failed)"; fi

begin "LiteLLM aliases"
models=$(http -f -H "Authorization: Bearer $LITELLM_MASTER_KEY" "$LITELLM/v1/models" | json '" ".join(sorted(m["id"] for m in d["data"]))')
for alias in fast smart-free local private local-code; do
  [[ " $models " == *" $alias "* ]] || red "LiteLLM alias $alias" "not registered"
done
conns=$(http "$T_PROBE" -f "$ROUTER/connections" 2>/dev/null)
cerebras_live=$(echo "$conns" | json '"x" if any(p["provider"]=="cerebras" and p["status"]=="connected" and not (p.get("credits") or {}).get("exhausted") for p in d["providers"]) else ""')
[[ -n "${CEREBRAS_API_KEY:-}$cerebras_live" && " $models " != *" cerebras "* ]] \
  && red "LiteLLM alias cerebras" "Cerebras keyed but alias not registered (an exhausted credit balance removes it on purpose)"
# Only named aliases; `<provider>/<model>` entries come from per-provider wildcard deployments (M2).
[[ -n "$models" ]] && green "LiteLLM aliases" "$(tr ' ' '\n' <<<"$models" | grep -v / | sort -u | tr '\n' ' ')"

section "Ollama (Windows, via Docker)"
begin "Ollama reachable"
tags=$(dc exec -T litellm python -c \
  "import urllib.request,os; print(urllib.request.urlopen(os.environ['OLLAMA_API_BASE']+'/api/tags', timeout=3).read().decode())" 2>/dev/null)
if [[ -n "$tags" ]]; then
  green "Ollama reachable" "$OLLAMA_API_BASE"
  have() { echo "$tags" | json "any(m['name']=='$1' for m in d['models'])" | grep -q True; }
  if have qwen3:4b; then green "Model qwen3:4b" "pulled"; else red "Model qwen3:4b" "missing — ollama pull qwen3:4b"; fi
  if have hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M; then green "Arch-Router (M3)" "pulled"
  else yellow "Arch-Router (M3)" "not pulled yet"; fi
else red "Ollama reachable" "no answer from $OLLAMA_API_BASE$(dc_why) — start Ollama on Windows"; fi

section "Router API (M1a)"
begin "Router API"
if h=$(http -f "$ROUTER/health" 2>/dev/null); then
  [[ $(echo "$h" | json 'd["db"]') == ok ]] && green "Router API" "$ROUTER" || red "Router API" "db: $(echo "$h" | json 'd["db"]')"
  [[ $(echo "$h" | json 'd["litellm"]') == ok ]] && green "Router -> LiteLLM" ok || red "Router -> LiteLLM" down
  rules=$(echo "$h" | json 'd.get("rules","missing")')
  [[ "$rules" == ok* ]] && green "Routing rules (M2)" "config/rules.yaml $rules" || red "Routing rules (M2)" "config/rules.yaml: $rules"
  [[ $(echo "$h" | json 'd.get("fault_injection")') == True ]] \
    && yellow "Fault injection" "ON (dev only): unset ROUTER_FAULT_INJECTION and restart the router" \
    || green "Fault injection" "off"
else red "Router API" "no answer on $ROUTER$(why_failed) — docker compose -f deploy/docker-compose.yml up -d router"; fi

begin "Router DB migrations"
status=$(http -f "$ROUTER/system/status" 2>/dev/null)
head_rev=$(dc exec -T router alembic heads 2>/dev/null | awk '{print $1}')
cur_rev=$(echo "$status" | json 'd["alembic_revision"]')
if [[ -n "$head_rev" && "$cur_rev" == "$head_rev" ]]; then green "Router DB migrations" "at head ($cur_rev)"
else red "Router DB migrations" "current '${cur_rev}', head '${head_rev}'$(dc_why) — restart the router (it runs alembic upgrade head)"; fi

# Secret keys: the router stores a SHA-256 fingerprint on first start. A changed key makes stored
# provider keys (SWITCHBOARD_SECRET_KEY) or LiteLLM credentials (LITELLM_SALT_KEY) undecryptable.
for k in switchboard_secret_key litellm_salt_key; do
  K=${k^^}; begin "$K"; v=$(echo "$status" | json "d['secret_keys']['$k']")
  case "$v" in
    ok)         green "$K" "set, matches stored fingerprint" ;;
    unrecorded) yellow "$K" "set, fingerprint not recorded yet (router not started?)" ;;
    changed)    red "$K" "CHANGED since first start — restore it from your backup (docs/m1a.md, Backups)" ;;
    *)          red "$K" "${v:-unknown} — run scripts/setup-wsl.sh" ;;
  esac
done

section "Providers (via Router)"
begin "Providers"
# Providers marked `optional: true` in config/providers.yaml (e.g. Cerebras, skipped by the owner) are
# shown grey without a key: neither a warning nor a failure.
optional=$(run "$T_CMD" python3 -c '
import sys, yaml
for k, v in (yaml.safe_load(open(sys.argv[1])) or {}).get("providers", {}).items():
    if (v or {}).get("optional"):
        print(k + "|" + str(v.get("skip_note") or "optional"))' "$ROOT/config/providers.yaml" 2>/dev/null)
if [[ -z "$conns" ]]; then red "Providers" "router /connections did not answer within ${T_PROBE}s"
else
  while IFS='|' read -r pid kind st n err; do
    case "$kind:$st" in
      api_key:connected|local:connected)
        if (( n > 0 )); then green "$pid" "connected, $n models in catalog"
        else red "$pid" "connected but 0 available models — POST /catalog/refresh"; fi ;;
      api_key:no_key)
        note=$(sed -n "s/^$pid|//p" <<<"$optional")
        if [[ -n "$note" ]]; then skip "$pid" "skipped ($note)"
        elif [[ "$pid" == groq || "$pid" == gemini ]]; then red "$pid" "no key (needed for fast/smart-free) — docs/m1a.md"
        else yellow "$pid" "no key (optional)"; fi ;;
      *) red "$pid" "$st: ${err:0:100}" ;;
    esac
  done < <(echo "$conns" | run "$T_CMD" python3 -c '
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
  begin "$1"
  hdrs=$(mktemp)
  out=$(http "$T_LIVE" -D "$hdrs" -w '\n%{http_code}' "$LITELLM/v1/chat/completions" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$1\",\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]}" 2>&1)
  code=${out##*$'\n'}; body=${out%$'\n'*}
  # The body echoes the alias; the header names the deployment that actually served it.
  served=$(grep -i '^x-litellm-model-name:' "$hdrs" | cut -d' ' -f2 | tr -d '\r')
  rm -f "$hdrs"
  if [[ "$code" != 200 ]]; then
    red "$1" "HTTP $code$(why_failed): $(echo "$body" | json 'd["error"]["message"][:120]' || echo "${body:0:120}")"
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
begin "Paperclip API"
if h=$(http -f "$PAPERCLIP_URL/api/health" 2>/dev/null); then
  green "Paperclip API" "$PAPERCLIP_URL $(echo "$h" | json 'd.get("status","")')"
else red "Paperclip API" "no answer$(why_failed) — paperclipai service start (see docs/TROUBLESHOOTING.md)"; fi

section "hostprobe (CLI detection, M1a)"
begin "hostprobe service"
if run "$T_CMD" systemctl --user is-active --quiet switchboard-hostprobe.service; then green "hostprobe service" active
else red "hostprobe service" "not active$(why_failed) — systemctl --user restart switchboard-hostprobe (scripts/setup-wsl.sh installs it)"; fi
begin "hostprobe health"
if http -f -H "X-Probe-Token: ${HOSTPROBE_TOKEN:-}" "$HOSTPROBE/health" 2>/dev/null | grep -q ok; then
  green "hostprobe health" "$HOSTPROBE (token ok)"
else red "hostprobe health" "no authorized answer on $HOSTPROBE$(why_failed) — check HOSTPROBE_TOKEN in deploy/.env"; fi
begin "Router -> hostprobe"
[[ $(http -f "$ROUTER/health" 2>/dev/null | json 'd["hostprobe"]') == ok ]] \
  && green "Router -> hostprobe" ok || red "Router -> hostprobe" "router cannot reach host.docker.internal:${HOSTPROBE_PORT:-8101}"

section "Agent CLIs in WSL (detected by hostprobe)"
begin "Agent CLIs"
clis=$(http "$T_PROBE" -f "$ROUTER/connections/cli" 2>/dev/null)
[[ -z "$clis" ]] && yellow "Agent CLIs" "router /connections/cli did not answer within ${T_PROBE}s"
while IFS='|' read -r pid st ver; do
  case "$st" in
    logged_in)     green "$pid" "v$ver, logged in" ;;
    logged_out)    yellow "$pid" "v$ver, installed, not logged in" ;;
    installed)     yellow "$pid" "v$ver, installed, login status unknown" ;;
    windows_only)  yellow "$pid" "Windows binary only — install the Linux CLI in WSL" ;;
    not_installed) yellow "$pid" "not installed in WSL" ;;
    *)             yellow "$pid" "$st" ;;
  esac
done < <(echo "$clis" | run "$T_CMD" python3 -c '
import json, sys
for k, c in json.load(sys.stdin)["clis"].items():
    print("|".join([k, c["status"], c.get("version") or "?"]))' 2>/dev/null)

section "Portal (M1b)"
begin "portal env"
PORTAL_ENV="$ROOT/apps/portal/.env.local"
if [[ ! -f "$PORTAL_ENV" ]]; then
  red "portal env" "apps/portal/.env.local missing — run scripts/setup-wsl.sh"
elif grep -qx "ROUTER_ADMIN_TOKEN=${ROUTER_ADMIN_TOKEN:-}" "$PORTAL_ENV" && [[ -n "${ROUTER_ADMIN_TOKEN:-}" ]]; then
  green "portal env" "ROUTER_ADMIN_TOKEN matches deploy/.env (server-side only)"
else
  red "portal env" "ROUTER_ADMIN_TOKEN in apps/portal/.env.local differs from deploy/.env"
fi
# The portal holds the admin token and has no login yet (carry-over to M7): it must stay on loopback.
begin "portal :3000"
bound=$(run "$T_CMD" ss -ltnH 'sport = :3000' 2>/dev/null | awk '{print $4}')
if [[ -z "$bound" ]]; then
  yellow "portal :3000" "not running — cd apps/portal && npm run dev (binds 127.0.0.1)"
elif grep -qE '^(0\.0\.0\.0|\*|\[::\]|::):3000$' <<<"$bound"; then
  red "portal :3000" "listening on all interfaces ($(echo $bound)) — start it with next dev/start -H 127.0.0.1 (npm run dev does)"
else
  green "portal :3000" "bound to $(echo $bound) only"
fi

clear_progress
echo
if (( RED == 0 )); then printf '\033[32mAll checks green.\033[0m\n'
else printf '\033[31m%d check(s) red.\033[0m\n' "$RED"; exit 1; fi
