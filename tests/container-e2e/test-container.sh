#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

RUNTIME="${CONTAINER_RT:-docker}"
FIXTURE="minimal"
IMAGE_TAG="bot:e2e"
SUITE_ID="rehor62"
KEEP_ARTIFACTS=0
ARTIFACTS_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixture)
      [ "$#" -ge 2 ] || die "missing value for --fixture"
      FIXTURE="$2"
      shift 2
      ;;
    --runtime)
      [ "$#" -ge 2 ] || die "missing value for --runtime"
      RUNTIME="$2"
      shift 2
      ;;
    --image-tag)
      [ "$#" -ge 2 ] || die "missing value for --image-tag"
      IMAGE_TAG="$2"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --artifacts-dir)
      [ "$#" -ge 2 ] || die "missing value for --artifacts-dir"
      ARTIFACTS_DIR="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_cmd "$RUNTIME"
require_cmd mktemp

FIXTURE_ROOT="$SCRIPT_DIR/fixtures/$FIXTURE"
[ -d "$FIXTURE_ROOT" ] || die "fixture not found: $FIXTURE_ROOT"
[ -f "$FIXTURE_ROOT/fixture.env" ] || die "fixture.env missing for fixture $FIXTURE"
[ -d "$FIXTURE_ROOT/instance" ] || die "instance directory missing for fixture $FIXTURE"

# shellcheck disable=SC1090
source "$FIXTURE_ROOT/fixture.env"

if [ "$FIXTURE" != "minimal" ]; then
  log "Checking Docker engine free space for heavy fixture: $FIXTURE"
  AVAILABLE_MB="$("$RUNTIME" run --rm alpine:3.21 sh -c "df -Pm / | awk 'NR==2 {print \$4}'")"
  MIN_REQUIRED_MB=4096
  if [ "${AVAILABLE_MB:-0}" -lt "$MIN_REQUIRED_MB" ]; then
    die "insufficient Docker engine free space (${AVAILABLE_MB}MB). Need >= ${MIN_REQUIRED_MB}MB for fixture '${FIXTURE}'."
  fi
  log "Docker engine free space looks sufficient: ${AVAILABLE_MB}MB"
fi

BUILD_ROOT="$(mktemp -d)"
RUN_SUFFIX="$(date +%s)-$$-$RANDOM"
NETWORK_NAME="${SUITE_ID}-${FIXTURE}-net-${RUN_SUFFIX}"
SOCK_VOLUME="${SUITE_ID}-${FIXTURE}-sock-${RUN_SUFFIX}"
POSTGRES_CONTAINER="${SUITE_ID}-${FIXTURE}-pg-${RUN_SUFFIX}"
MEMORY_CONTAINER="${SUITE_ID}-${FIXTURE}-memory-${RUN_SUFFIX}"
PROXY_CONTAINER="${SUITE_ID}-${FIXTURE}-proxy-${RUN_SUFFIX}"
BOT_CONTAINER="${SUITE_ID}-${FIXTURE}-bot-${RUN_SUFFIX}"
BOT_CHECK_CONTAINER="${SUITE_ID}-${FIXTURE}-bot-check-${RUN_SUFFIX}"

cleanup() {
  set +e
  mkdir -p "$BUILD_ROOT/logs"
  log "Collecting logs (best-effort)"
  "$RUNTIME" logs "$BOT_CONTAINER" >"$BUILD_ROOT/logs/bot.log" 2>&1 || true
  "$RUNTIME" logs "$BOT_CHECK_CONTAINER" >"$BUILD_ROOT/logs/bot-check.log" 2>&1 || true
  "$RUNTIME" logs "$PROXY_CONTAINER" >"$BUILD_ROOT/logs/proxy.log" 2>&1 || true
  "$RUNTIME" logs "$MEMORY_CONTAINER" >"$BUILD_ROOT/logs/memory.log" 2>&1 || true
  "$RUNTIME" logs "$POSTGRES_CONTAINER" >"$BUILD_ROOT/logs/postgres.log" 2>&1 || true

  "$RUNTIME" rm -f "$BOT_CONTAINER" "$BOT_CHECK_CONTAINER" "$PROXY_CONTAINER" "$MEMORY_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  "$RUNTIME" network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  "$RUNTIME" volume rm "$SOCK_VOLUME" >/dev/null 2>&1 || true

  if [ -n "$ARTIFACTS_DIR" ]; then
    mkdir -p "$ARTIFACTS_DIR"
    cp -R "$BUILD_ROOT/logs/." "$ARTIFACTS_DIR/" >/dev/null 2>&1 || true
    log "Copied artifacts to: $ARTIFACTS_DIR"
  fi

  if [ "$KEEP_ARTIFACTS" -eq 1 ]; then
    log "Artifacts kept at: $BUILD_ROOT"
  else
    rm -rf "$BUILD_ROOT"
  fi
}
trap cleanup EXIT

log "Preparing temporary build context"
bash "$SCRIPT_DIR/sync-devbot.sh" "$REPO_ROOT" "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT/instance"
cp -R "$FIXTURE_ROOT/instance/." "$BUILD_ROOT/instance/"
cat >"$BUILD_ROOT/setup.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF
chmod +x "$BUILD_ROOT/setup.sh"

log "Building proxy and memory-server images"
"$RUNTIME" build -t "${SUITE_ID}/proxy:${FIXTURE}" "$REPO_ROOT/proxy"
"$RUNTIME" build -f "$REPO_ROOT/memory-server/Dockerfile" -t "${SUITE_ID}/memory:${FIXTURE}" "$REPO_ROOT"

log "Building runner image from Dockerfile.runner"
"$RUNTIME" build -t "$IMAGE_TAG" -f "$BUILD_ROOT/dev-bot/Dockerfile.runner" "$BUILD_ROOT"

log "Creating network and shared socket volume"
"$RUNTIME" network create "$NETWORK_NAME" >/dev/null
"$RUNTIME" volume create "$SOCK_VOLUME" >/dev/null

log "Starting postgres"
"$RUNTIME" run -d \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK_NAME" \
  --tmpfs /tmp/pgdata:rw,size=512m \
  -e PGDATA=/tmp/pgdata \
  -e POSTGRES_USER=devbot_test \
  -e POSTGRES_PASSWORD=devbot_test \
  -e POSTGRES_DB=devbot_migration_test \
  pgvector/pgvector:pg17 >/dev/null

if ! wait_for_container_log "$RUNTIME" "$POSTGRES_CONTAINER" "database system is ready to accept connections" 120 2; then
  "$RUNTIME" logs "$POSTGRES_CONTAINER" || true
  die "postgres never became ready"
fi

log "Starting memory-server"
"$RUNTIME" run -d \
  --name "$MEMORY_CONTAINER" \
  --network "$NETWORK_NAME" \
  --tmpfs /tmp:rw,size=256m \
  -e DATABASE_URL=postgresql://devbot_test:devbot_test@"$POSTGRES_CONTAINER":5432/devbot_migration_test \
  "${SUITE_ID}/memory:${FIXTURE}" >/dev/null

if ! wait_for_container_log "$RUNTIME" "$MEMORY_CONTAINER" "Uvicorn running on http://0.0.0.0:8080" 120 2; then
  "$RUNTIME" logs "$MEMORY_CONTAINER" || true
  die "memory-server never reported startup"
fi

log "Starting proxy sidecar"
"$RUNTIME" run -d \
  --name "$PROXY_CONTAINER" \
  --network "$NETWORK_NAME" \
  --tmpfs /tmp:rw,size=256m \
  -v "${SOCK_VOLUME}:/var/run/devbot" \
  -e GH_TOKEN=dummy-smoke-token \
  "${SUITE_ID}/proxy:${FIXTURE}" >/dev/null

if ! wait_for_container_log "$RUNTIME" "$PROXY_CONTAINER" "executor-server listening on" 120 2; then
  "$RUNTIME" logs "$PROXY_CONTAINER" || true
  die "proxy never reported executor-server readiness"
fi

log "Starting bot container with real entrypoint"
"$RUNTIME" run -d \
  --name "$BOT_CONTAINER" \
  --network "$NETWORK_NAME" \
  --tmpfs /tmp:rw,size=256m \
  -v "${SOCK_VOLUME}:/var/run/devbot" \
  -e EXECUTOR_ADDR=unix:///var/run/devbot/executor.sock \
  -e PROXY_HOST="$PROXY_CONTAINER" \
  -e PROXY_PORT=3128 \
  -e BOT_MEMORY_URL=http://"$MEMORY_CONTAINER":8080/mcp \
  -e BOT_MEMORY_HEALTH_URL=http://"$MEMORY_CONTAINER":8080/health \
  -e BOT_MEMORY_HEALTH_TIMEOUT=90 \
  -e BOT_LABEL=rehor62-e2e \
  -e BOT_INSTANCE_ID=rehor62-e2e \
  -e GH_USER_NAME="Dev Bot" \
  -e GH_USER_EMAIL="dev-bot@example.com" \
  -e GL_USER_NAME="Dev Bot" \
  -e GL_USER_EMAIL="dev-bot@example.com" \
  "$IMAGE_TAG" >/dev/null

if ! wait_for_container_log "$RUNTIME" "$BOT_CONTAINER" "Credentials configured\\. Starting bot with label:" 120 2; then
  "$RUNTIME" logs "$BOT_CONTAINER" || true
  die "bot entrypoint did not reach startup handoff"
fi

log "Starting detached check container"
"$RUNTIME" run -d \
  --name "$BOT_CHECK_CONTAINER" \
  --network "$NETWORK_NAME" \
  --tmpfs /tmp:rw,size=256m \
  --entrypoint bash \
  "$IMAGE_TAG" \
  -lc "sleep infinity" >/dev/null

log "Running baseline checks"
for check in \
  "$SCRIPT_DIR/checks/10-tools.sh" \
  "$SCRIPT_DIR/checks/20-imports.sh" \
  "$SCRIPT_DIR/checks/30-profile.sh" \
  "$SCRIPT_DIR/checks/40-entrypoint.sh" \
  "$SCRIPT_DIR/checks/50-skills.sh"; do
  log "Running check: $(basename "$check")"
  target_container="$BOT_CHECK_CONTAINER"
  if [ "$(basename "$check")" = "40-entrypoint.sh" ]; then
    target_container="$BOT_CONTAINER"
  fi
  bash "$check" "$target_container" "$RUNTIME"
done

if [ "${CHECK_NODE:-0}" = "1" ]; then
  log "Running env check: node"
  bash "$SCRIPT_DIR/checks/60-env-node.sh" "$BOT_CHECK_CONTAINER" "$RUNTIME"
fi
if [ "${CHECK_GO:-0}" = "1" ]; then
  log "Running env check: go"
  bash "$SCRIPT_DIR/checks/61-env-go.sh" "$BOT_CHECK_CONTAINER" "$RUNTIME"
fi
if [ "${CHECK_CONTAINER_SCAN:-0}" = "1" ]; then
  log "Running env check: container-scan"
  bash "$SCRIPT_DIR/checks/62-env-container-scan.sh" "$BOT_CHECK_CONTAINER" "$RUNTIME"
fi
if [ "${CHECK_BROWSER:-0}" = "1" ]; then
  log "Running env check: browser"
  bash "$SCRIPT_DIR/checks/63-env-browser.sh" "$BOT_CHECK_CONTAINER" "$RUNTIME"
fi

log "Container E2E checks passed for fixture: $FIXTURE"
