#!/usr/bin/env bash
# A throwaway "Demo" stack for recording the README demo (docs/recording-the-demo.md). Your real stack is
# never stopped, written to, or read for chats: this only
#   - creates a separate Postgres database `switchboard_demo` next to yours (dropped and recreated on `up`),
#   - copies into it ONLY the connection rows, "key saved" markers (dummy ciphertext, suffix masked as ••••),
#     the model catalog and a few system_meta rows (never threads, messages, requests, costs or stats,
#     and never an API key),
#   - starts one extra router container `switchboard-demo-router` on 127.0.0.1:8110 that does NOT sync to
#     LiteLLM (ROUTER_SYNC_ENABLED=false) and tags its traffic `switchboard-demo` (ROUTER_REQUEST_TAG),
#     so Metrics (M6) can exclude it. LiteLLM already holds the provider credentials, written by your
#     main router; the demo router only calls it.
#
#   scripts/demo-stack.sh up       create/reset the demo database and (re)start the demo router
#   scripts/demo-stack.sh reset    same as up (a clean slate for another take)
#   scripts/demo-stack.sh down     remove the demo router and drop the demo database
#   scripts/demo-stack.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.yml")
DEMO_DB=switchboard_demo
MAIN_DB=switchboard
CONTAINER=switchboard-demo-router
PORT=${DEMO_ROUTER_PORT:-8110}
PORTAL_PORT=${DEMO_PORTAL_PORT:-3220}
NETWORK=switchboard_default
IMAGE=switchboard-router:local

[ -f "$ENV_FILE" ] || { echo "deploy/.env not found: run scripts/setup-wsl.sh first." >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
PGUSER_=${POSTGRES_USER:-switchboard}

psql_main() { "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PGUSER_" -d "$1" "${@:2}"; }

# copy_rows "<select on the main DB>" <table in the demo DB>: rows only, through a host pipe.
copy_rows() {
  psql_main "$MAIN_DB" -q -c "\\copy ($1) to stdout" | psql_main "$DEMO_DB" -q -c "\\copy $2 from stdin"
}

# Guard rails: this script may only ever touch the demo database and the demo container.
[ "$DEMO_DB" != "$MAIN_DB" ] || { echo "refusing: demo database equals the main one" >&2; exit 1; }

cmd=${1:-}
case "$cmd" in
  up|reset)
    "${COMPOSE[@]}" ps --status running --services | grep -qx postgres || { echo "Start your stack first (docker compose up -d); the demo needs Postgres and LiteLLM." >&2; exit 1; }
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "creating the empty demo database…"
    psql_main postgres -c "DROP DATABASE IF EXISTS \"$DEMO_DB\" WITH (FORCE)" >/dev/null
    psql_main postgres -c "CREATE DATABASE \"$DEMO_DB\"" >/dev/null
    echo "migrating it to the current schema…"
    docker run --rm --network "$NETWORK" \
      -e "DATABASE_URL=postgresql://$PGUSER_:$POSTGRES_PASSWORD@postgres:5432/$DEMO_DB" \
      -e "LITELLM_MASTER_KEY=$LITELLM_MASTER_KEY" -e "SWITCHBOARD_SECRET_KEY=$SWITCHBOARD_SECRET_KEY" \
      -e "ROUTER_ADMIN_TOKEN=$ROUTER_ADMIN_TOKEN" \
      "$IMAGE" alembic upgrade head >/dev/null
    echo "copying connection rows (suffixes masked) and a few settings rows…"
    # connections: which providers are connected, nothing secret.
    copy_rows "select * from connections" connections
    # provider_secrets: the row (so cards read "key saved") but NO key: the ciphertext is a dummy byte and
    # the suffix is masked at the source, so no real key material or suffix is ever in the demo database.
    copy_rows "select provider, '\\x00'::bytea, '••••', source, created_at, updated_at from provider_secrets" provider_secrets
    copy_rows "select * from model_catalog" model_catalog
    copy_rows "select * from system_meta where key like 'fingerprint:%' or key = 'local_profile'" system_meta
    # The demo profile: name "Demo", onboarding done, balanced preset.
    psql_main "$DEMO_DB" -q -c "INSERT INTO system_meta (key, value, updated_at) VALUES ('onboarding', json_build_object('step','finish','name','Demo','goals', json_build_array('chat','code','private'),'preset','balanced','skipped',false,'completed_at', now())::text, now())" >/dev/null
    echo "starting $CONTAINER on 127.0.0.1:$PORT…"
    docker run -d --name "$CONTAINER" --network "$NETWORK" --restart no \
      --add-host host.docker.internal:host-gateway -p "127.0.0.1:$PORT:8100" \
      -e "DATABASE_URL=postgresql://$PGUSER_:$POSTGRES_PASSWORD@postgres:5432/$DEMO_DB" \
      -e "LITELLM_URL=http://litellm:4000" -e "LITELLM_MASTER_KEY=$LITELLM_MASTER_KEY" \
      -e "LITELLM_SALT_KEY=${LITELLM_SALT_KEY:-}" -e "SWITCHBOARD_SECRET_KEY=$SWITCHBOARD_SECRET_KEY" \
      -e "ROUTER_ADMIN_TOKEN=$ROUTER_ADMIN_TOKEN" \
      -e "HOSTPROBE_URL=http://host.docker.internal:${HOSTPROBE_PORT:-8101}" -e "HOSTPROBE_TOKEN=${HOSTPROBE_TOKEN:-}" \
      -e "OLLAMA_API_BASE=${OLLAMA_API_BASE:-http://host.docker.internal:11434}" \
      -e "PAPERCLIP_URL=http://host.docker.internal:${PAPERCLIP_PORT:-3100}" \
      -e 'CORS_ORIGINS=["http://127.0.0.1:'"$PORTAL_PORT"'","http://localhost:'"$PORTAL_PORT"'"]' \
      -e "CONFIG_DIR=/srv/config" -v "$ROOT/config:/srv/config:ro" \
      -e ROUTER_SYNC_ENABLED=false -e ROUTER_REQUEST_TAG=switchboard-demo \
      "$IMAGE" >/dev/null
    for _ in $(seq 1 40); do
      curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { echo "demo router is up: http://127.0.0.1:$PORT (portal: PORT $PORTAL_PORT)"; exit 0; }
      sleep 1
    done
    echo "the demo router did not become healthy: docker logs $CONTAINER" >&2
    exit 1
    ;;
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    psql_main postgres -c "DROP DATABASE IF EXISTS \"$DEMO_DB\" WITH (FORCE)" >/dev/null
    echo "demo router removed and demo database dropped. Your real stack was not touched."
    ;;
  status)
    docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}  {{.Status}}'
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || echo "(demo router not running)"
    ;;
  *)
    sed -n '2,17p' "$0"
    exit 2
    ;;
esac
