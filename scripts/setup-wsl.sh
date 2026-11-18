#!/usr/bin/env bash
# Switchboard setup for WSL2 (Ubuntu). Safe to re-run.
#   scripts/setup-wsl.sh          interactive (asks before onboarding Paperclip)
#   scripts/setup-wsl.sh --yes    non-interactive
#   scripts/setup-wsl.sh --pull-models   only: detect the GPU, pick the local-model profile and pull its
#                                        missing Ollama models (the stack must be running)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.yml")
NVM_VERSION=v0.41.0
NODE_MAJOR=24
GITLEAKS_VERSION=v8.30.1
YES=false
PULL_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --yes) YES=true ;;
    --pull-models) PULL_ONLY=true ;;
    *) printf 'unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done
export PATH="$HOME/.local/bin:$PATH"   # gitleaks, paperclipai shim

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }
confirm() { $YES && return 0; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }

# --- Local-model profile + Ollama models (M3a, config/local-models.yaml) -----------------
# The router detects the GPU through hostprobe (nvidia-smi), picks a profile (a profile you chose in
# Settings is kept) and pulls the profile's missing models through Ollama's API. WSL can't reach the
# Windows Ollama on localhost, which is why this goes through the router (inside Docker).
local_models() {
  local R="http://127.0.0.1:${ROUTER_PORT:-8100}" auth=(-H "Authorization: Bearer ${ROUTER_ADMIN_TOKEN:-}")
  local v
  if ! v=$(curl -fsS -m 30 -X POST "${auth[@]}" "$R/system/local-profile/detect"); then
    warn "Router not answering on $R; start the stack, then run scripts/setup-wsl.sh --pull-models"
    return 0
  fi
  say "$(printf '%s' "$v" | python3 -c '
import json, sys
d = json.load(sys.stdin); x = d["detected"]
seen = ("Detected %g GB VRAM" % x["vram_gb"]) if x.get("vram_gb") is not None else "GPU not detected"
print("%s -> local-model profile %s%s; models: %s" % (seen, d["active"], " (your pick)" if d["overridden"] else "",
      ", ".join(next(p for p in d["profiles"] if p["name"] == d["active"])["models"])))')"
  local missing
  missing=$(printf '%s' "$v" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["missing"]))')
  if [[ -z "$missing" ]]; then say "All local models are pulled"; return 0; fi
  if [[ $(printf '%s' "$v" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ollama"])') != ok ]]; then
    warn "Ollama not reachable; start Ollama on Windows, then run scripts/setup-wsl.sh --pull-models"
    return 0
  fi
  confirm "Pull $missing with Ollama now (about 1-10 GB)?" || { warn "Skipped; run scripts/setup-wsl.sh --pull-models later"; return 0; }
  curl -fsS -m 30 -X POST "${auth[@]}" "$R/system/models/pull" >/dev/null || { warn "Pull request failed"; return 0; }
  local status=running line
  while [[ "$status" == running ]]; do
    sleep 3
    line=$(curl -fsS -m 10 "$R/system/local-profile" | python3 -c '
import json, sys
p = json.load(sys.stdin)["pull"]
print(p["status"], p.get("model") or "", p.get("percent") if p.get("percent") is not None else "", p.get("error") or "")')
    read -r status model pct err <<<"$line"
    [[ "$status" == running ]] && printf '\r  pulling %s %s%%   ' "$model" "${pct:-0}"
  done
  printf '\n'
  [[ "$status" == done ]] && say "Local models pulled" || warn "Model pull ended: $status ${err:-}"
}

if $PULL_ONLY; then
  set -a; . "$ENV_FILE"; set +a
  local_models
  exit 0
fi

# --- 1. Prerequisites -------------------------------------------------------
grep -qi microsoft /proc/version || warn "Not running under WSL; continuing anyway."
command -v docker >/dev/null || die "Docker not found. Install Docker Desktop with the WSL2 backend."
docker info >/dev/null 2>&1 || die "Docker daemon not reachable. Start Docker Desktop."
command -v openssl >/dev/null || die "openssl not found (sudo apt install openssl)."

# --- 2. Node (Linux, via nvm) — Paperclip needs >= 24.11 ----------------------
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  say "Installing nvm $NVM_VERSION"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE="$HOME/.bashrc" bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if ! nvm ls "$NODE_MAJOR" >/dev/null 2>&1; then
  say "Installing Node $NODE_MAJOR"
  nvm install "$NODE_MAJOR"
fi
nvm alias default "$NODE_MAJOR" >/dev/null
nvm use default >/dev/null
say "Node $(node --version) at $(command -v node)"

# --- 3. gitleaks + pre-commit hook ------------------------------------------
if ! gitleaks version 2>/dev/null | grep -q "${GITLEAKS_VERSION#v}"; then
  say "Installing gitleaks $GITLEAKS_VERSION to ~/.local/bin"
  tmp=$(mktemp -d)
  v=${GITLEAKS_VERSION#v}
  base="https://github.com/gitleaks/gitleaks/releases/download/$GITLEAKS_VERSION"
  curl -fsSL -o "$tmp/gitleaks_${v}_linux_x64.tar.gz" "$base/gitleaks_${v}_linux_x64.tar.gz"
  curl -fsSL -o "$tmp/checksums.txt" "$base/gitleaks_${v}_checksums.txt"
  (cd "$tmp" && grep " gitleaks_${v}_linux_x64.tar.gz\$" checksums.txt | sha256sum -c -) || die "gitleaks checksum mismatch"
  mkdir -p "$HOME/.local/bin"
  tar -xzf "$tmp/gitleaks_${v}_linux_x64.tar.gz" -C "$HOME/.local/bin" gitleaks
  rm -rf "$tmp"
fi
git -C "$ROOT" config core.hooksPath .githooks
say "gitleaks $(gitleaks version) pre-commit hook enabled"

# --- 4. deploy/.env ---------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  say "Creating deploy/.env from .env.example"
  cp "$ROOT/deploy/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
fill_secret() {  # fill_secret VAR VALUE — only if empty or missing; never overwrites
  if grep -qE "^$1=$" "$ENV_FILE"; then
    sed -i "s|^$1=$|$1=$2|" "$ENV_FILE"
    say "Generated $1"
  elif ! grep -qE "^$1=" "$ENV_FILE"; then
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
    say "Generated $1 (appended)"
  fi
}
fill_secret POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill_secret LITELLM_MASTER_KEY "sk-$(openssl rand -hex 24)"
fill_secret LITELLM_SALT_KEY "sk-$(openssl rand -hex 24)"
# M1a: Router API secrets. SWITCHBOARD_SECRET_KEY is a Fernet key (urlsafe base64 of 32 bytes).
fill_secret SWITCHBOARD_SECRET_KEY "$(openssl rand -base64 32 | tr '+/' '-_')"
fill_secret ROUTER_ADMIN_TOKEN "$(openssl rand -hex 32)"
fill_secret HOSTPROBE_TOKEN "$(openssl rand -hex 32)"
set -a; . "$ENV_FILE"; set +a
say "Back up SWITCHBOARD_SECRET_KEY and LITELLM_SALT_KEY (docs/m1a.md, Backups): stored keys can't be decrypted without them."

# --- 4b. Portal env (M1b). The portal runs outside Docker, so it gets its own server-side file with
# just the two values it needs. Never overwritten; never read by the browser (docs/m1b.md).
PORTAL_ENV="$ROOT/apps/portal/.env.local"
if [[ ! -f "$PORTAL_ENV" ]]; then
  printf 'ROUTER_URL=http://127.0.0.1:%s\nROUTER_ADMIN_TOKEN=%s\n' "${ROUTER_PORT:-8100}" "$ROUTER_ADMIN_TOKEN" >"$PORTAL_ENV"
  chmod 600 "$PORTAL_ENV"
  say "Created apps/portal/.env.local (ROUTER_URL, ROUTER_ADMIN_TOKEN)"
elif ! grep -qx "ROUTER_ADMIN_TOKEN=$ROUTER_ADMIN_TOKEN" "$PORTAL_ENV"; then
  warn "apps/portal/.env.local has a different ROUTER_ADMIN_TOKEN than deploy/.env; fix it by hand (not overwritten)."
fi

# --- 5. hostprobe (native systemd user service; CLI detection for the router) --
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|@REPO@|$ROOT|g" "$ROOT/services/hostprobe/switchboard-hostprobe.service" >"$UNIT_DIR/switchboard-hostprobe.service"
systemctl --user daemon-reload
systemctl --user enable --now switchboard-hostprobe.service
systemctl --user restart switchboard-hostprobe.service
say "hostprobe running on 127.0.0.1:${HOSTPROBE_PORT:-8101}"

# --- 6. Postgres + LiteLLM + Router -------------------------------------------
say "Starting Postgres, LiteLLM and the Router API"
"${COMPOSE[@]}" up -d --build --wait

# --- 7. Ollama reachability (from Docker, the path LiteLLM uses) ------------
say "Checking Ollama at $OLLAMA_API_BASE (from inside the litellm container)"
if "${COMPOSE[@]}" exec -T litellm python -c \
    "import urllib.request,os; urllib.request.urlopen(os.environ['OLLAMA_API_BASE']+'/api/version', timeout=5)" 2>/dev/null; then
  say "Ollama reachable"
  local_models
else
  warn "Ollama not reachable. Start Ollama on Windows, then re-run scripts/doctor.sh."
fi

# --- 8. Paperclip (native, loopback, background service) --------------------
PC=(npx -y --registry https://registry.npmjs.org "paperclipai@$PAPERCLIP_VERSION")
if curl -fsS -m 3 "$PAPERCLIP_URL/api/health" >/dev/null 2>&1; then
  say "Paperclip already running at $PAPERCLIP_URL"
else
  echo "Paperclip onboarding will run:"
  echo "  ${PC[*]} onboard --yes --bind loopback --install-service"
  if confirm "Run it now?"; then
    (cd "$HOME" && "${PC[@]}" onboard --yes --bind loopback --install-service)
  else
    warn "Skipped Paperclip onboarding."
  fi
fi

say "Done. Run scripts/doctor.sh to check every component."
