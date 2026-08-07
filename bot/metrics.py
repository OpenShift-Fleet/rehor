"""Operational Prometheus metrics for the bot process (served on :9091)."""

from prometheus_client import Counter, Gauge

PREFLIGHT_OUTCOME_TOTAL = Counter(
    "devbot_preflight_outcome_total",
    "Preflight cycle outcomes.",
    ["label", "action"],
)
PREFLIGHT_CONSECUTIVE_ERRORS = Gauge(
    "devbot_preflight_consecutive_errors",
    "Current consecutive preflight error streak.",
    ["label"],
)
CYCLE_TIMEOUT_TOTAL = Counter(
    "devbot_cycle_timeout_total",
    "Agent cycles that hit the cycle timeout.",
    ["label"],
)
CONFIG_SYNC_TOTAL = Counter(
    "devbot_config_sync_total",
    "Remote config repo sync outcomes.",
    ["label", "outcome"],
)
WORK_TYPE_TOTAL = Counter(
    "devbot_work_type_total",
    "Cycles by work type.",
    ["label", "work_type"],
)
TURN_BUDGET_EVENT_TOTAL = Counter(
    "devbot_turn_budget_event_total",
    "Turn budget warning/critical events.",
    ["label", "level"],
)
TRANSCRIPT_UPLOAD_TOTAL = Counter(
    "devbot_transcript_upload_total",
    "Transcript upload outcomes.",
    ["label", "outcome"],
)
MCP_SERVER_STATUS_TOTAL = Counter(
    "devbot_mcp_server_status_total",
    "MCP server connection status observed at cycle start.",
    ["server", "status"],
)
WAKE_SIGNAL_TOTAL = Counter(
    "devbot_wake_signal_total",
    "Dashboard wake signals that interrupted a sleep.",
    ["label"],
)
DISK_FREE_MB = Gauge(
    "devbot_disk_free_mb",
    "Free disk space in MB at last check.",
)
