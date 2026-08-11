#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [container-e2e] $*"
}

die() {
  log "ERROR: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

wait_for_http() {
  local url="$1"
  local timeout_s="${2:-60}"
  local interval_s="${3:-2}"
  local start_ts deadline now remaining max_time sleep_s

  start_ts=$(date +%s)
  deadline=$((start_ts + timeout_s))

  while true; do
    now=$(date +%s)
    remaining=$((deadline - now))
    if [ "$remaining" -le 0 ]; then
      return 1
    fi

    max_time="$remaining"
    if [ "$max_time" -gt "$interval_s" ]; then
      max_time="$interval_s"
    fi

    if curl -sf --max-time "$max_time" "$url" >/dev/null 2>&1; then
      return 0
    fi

    now=$(date +%s)
    remaining=$((deadline - now))
    if [ "$remaining" -le 0 ]; then
      return 1
    fi

    sleep_s="$interval_s"
    if [ "$sleep_s" -gt "$remaining" ]; then
      sleep_s="$remaining"
    fi
    sleep "$sleep_s"
  done
}

wait_for_container_log() {
  local runtime="$1"
  local container="$2"
  local needle="$3"
  local timeout_s="${4:-120}"
  local interval_s="${5:-2}"
  local elapsed=0

  while true; do
    if "$runtime" logs "$container" 2>&1 | grep -qE "$needle"; then
      return 0
    fi
    if ! "$runtime" ps --format '{{.Names}}' | grep -qE "^${container}$"; then
      return 1
    fi
    elapsed=$((elapsed + interval_s))
    if [ "$elapsed" -ge "$timeout_s" ]; then
      return 1
    fi
    sleep "$interval_s"
  done
}
