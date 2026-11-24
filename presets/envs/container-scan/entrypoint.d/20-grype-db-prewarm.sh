#!/bin/bash
# Grype DB pre-warm — runs as botuser at container startup.
# Downloads the vulnerability DB in the background so the first CVE scan
# does not pay the ~190MB download inside a bounded agent cycle.
# The database lives in ~/.cache/grype and is ephemeral per pod, so this
# runs on every pod start. Disable with GRYPE_DB_PREWARM=0.
command -v grype &>/dev/null || exit 0
[ "${GRYPE_DB_PREWARM:-1}" = "1" ] || exit 0

LOG_DIR="$HOME/.cache/grype"
LOG="$LOG_DIR/prewarm.log"
mkdir -p "$LOG_DIR"

# Skip if a valid database is already present
if timeout 30 grype db status &>/dev/null; then
    echo "$(date -u +%FT%TZ) grype db already present, skipping prewarm" >> "$LOG"
    exit 0
fi

# Detached: pod startup must not block on the download
(
    echo "$(date -u +%FT%TZ) prewarm start" >> "$LOG"
    if timeout "${GRYPE_DB_PREWARM_TIMEOUT:-900}" grype db update >> "$LOG" 2>&1; then
        echo "$(date -u +%FT%TZ) prewarm done" >> "$LOG"
    else
        echo "$(date -u +%FT%TZ) prewarm failed rc=$? (agents fall back to bounded in-cycle update)" >> "$LOG"
    fi
) &

exit 0
