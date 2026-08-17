"""Operational Prometheus metrics for the bot process (served on :9091)."""

from prometheus_client import Counter, Gauge, Histogram

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
    "Transcript upload outcomes for agent sessions (not preflight orphans).",
    ["label", "outcome"],
)
MCP_SERVER_STATUS_TOTAL = Counter(
    "devbot_mcp_server_status_total",
    "MCP server connection status observed at cycle start.",
    ["server", "status"],
)
CYCLE_DURATION_SECONDS = Histogram(
    "devbot_cycle_duration_seconds",
    "Wall-clock duration of a single agent cycle.",
    ["label", "work_type"],
    buckets=[30, 60, 120, 300, 600, 900, 1200, 1800],
)
DISK_FREE_MB = Gauge(
    "devbot_disk_free_mb",
    "Free disk space in MB at last check.",
)

# --- Real-time cost/token counters (source of truth; DB gauges live in memory-server) ---

CYCLE_COST_USD_TOTAL = Counter(
    "devbot_cycle_cost_usd_total",
    "Cumulative USD spend from agent cycles.",
    ["model", "label", "workflow"],
)
CYCLE_INPUT_TOKENS_TOTAL = Counter(
    "devbot_cycle_input_tokens_total",
    "Input tokens consumed.",
    ["model", "label", "workflow"],
)
CYCLE_OUTPUT_TOKENS_TOTAL = Counter(
    "devbot_cycle_output_tokens_total",
    "Output tokens consumed.",
    ["model", "label", "workflow"],
)
CYCLE_CACHE_READ_TOKENS_TOTAL = Counter(
    "devbot_cycle_cache_read_tokens_total",
    "Cache read tokens.",
    ["model", "label", "workflow"],
)
CYCLE_CACHE_WRITE_TOKENS_TOTAL = Counter(
    "devbot_cycle_cache_write_tokens_total",
    "Cache write tokens.",
    ["model", "label", "workflow"],
)
CYCLES_TOTAL = Counter(
    "devbot_cycles_total",
    "Agent cycle count by status.",
    ["model", "label", "workflow", "status"],
)
IDLE_WITH_TOKENS_TOTAL = Counter(
    "devbot_idle_with_tokens_total",
    "Cycles reported idle (no_work) that still consumed tokens — likely preflight bug.",
    ["label", "workflow"],
)


def record_cycle_metrics(
    *,
    model: str,
    label: str,
    workflow: str,
    status: str,
    cost_usd: float,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
) -> None:
    """Increment real-time cost/token counters after an agent cycle."""
    model = model or "unknown"
    label = label or "unknown"
    workflow = workflow or "unknown"

    CYCLE_COST_USD_TOTAL.labels(model=model, label=label, workflow=workflow).inc(cost_usd or 0)
    CYCLE_INPUT_TOKENS_TOTAL.labels(model=model, label=label, workflow=workflow).inc(input_tokens or 0)
    CYCLE_OUTPUT_TOKENS_TOTAL.labels(model=model, label=label, workflow=workflow).inc(output_tokens or 0)
    CYCLE_CACHE_READ_TOKENS_TOTAL.labels(model=model, label=label, workflow=workflow).inc(cache_read_tokens or 0)
    CYCLE_CACHE_WRITE_TOKENS_TOTAL.labels(model=model, label=label, workflow=workflow).inc(cache_write_tokens or 0)
    CYCLES_TOTAL.labels(model=model, label=label, workflow=workflow, status=status).inc()

    tokens = (input_tokens or 0) + (output_tokens or 0) + (cache_read_tokens or 0) + (cache_write_tokens or 0)
    if status == "idle" and tokens > 0:
        IDLE_WITH_TOKENS_TOTAL.labels(label=label, workflow=workflow).inc()
