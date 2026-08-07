import asyncio
import logging
import re
import time

from prometheus_client import Counter, Gauge, Histogram
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

logger = logging.getLogger(__name__)

DB_GAUGE_REFRESH_INTERVAL_SECONDS = 60

REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "path", "code"],
)
REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "path"],
    buckets=[0.05, 0.1, 0.25, 0.5, 0.8, 1.0, 2.5, 5.0],
)

# --- Real-time cycle counters (incremented on every POST /api/costs) ---

CYCLE_COST_USD_TOTAL = Counter(
    "devbot_cycle_cost_usd_total",
    "Cumulative USD spend",
    ["model", "label"],
)
CYCLE_INPUT_TOKENS_TOTAL = Counter(
    "devbot_cycle_input_tokens_total",
    "Input tokens consumed",
    ["model", "label"],
)
CYCLE_OUTPUT_TOKENS_TOTAL = Counter(
    "devbot_cycle_output_tokens_total",
    "Output tokens consumed",
    ["model", "label"],
)
CYCLE_CACHE_READ_TOKENS_TOTAL = Counter(
    "devbot_cycle_cache_read_tokens_total",
    "Cache read tokens",
    ["model", "label"],
)
CYCLE_CACHE_WRITE_TOKENS_TOTAL = Counter(
    "devbot_cycle_cache_write_tokens_total",
    "Cache write tokens",
    ["model", "label"],
)
CYCLES_TOTAL = Counter(
    "devbot_cycles_total",
    "Cycle count",
    ["model", "label", "status"],
)
CYCLE_DURATION_SECONDS_TOTAL = Counter(
    "devbot_cycle_duration_seconds_total",
    "Cumulative wall-clock time",
    ["model", "label"],
)


def record_cycle(
    *,
    model: str,
    label: str,
    status: str,
    cost_usd: float,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    duration_seconds: float,
) -> None:
    """Increment real-time cycle counters. Call on every POST /api/costs."""
    model = model or "unknown"
    label = label or "unknown"

    CYCLE_COST_USD_TOTAL.labels(model=model, label=label).inc(cost_usd or 0)
    CYCLE_INPUT_TOKENS_TOTAL.labels(model=model, label=label).inc(input_tokens or 0)
    CYCLE_OUTPUT_TOKENS_TOTAL.labels(model=model, label=label).inc(output_tokens or 0)
    CYCLE_CACHE_READ_TOKENS_TOTAL.labels(model=model, label=label).inc(cache_read_tokens or 0)
    CYCLE_CACHE_WRITE_TOKENS_TOTAL.labels(model=model, label=label).inc(cache_write_tokens or 0)
    CYCLES_TOTAL.labels(model=model, label=label, status=status).inc()
    CYCLE_DURATION_SECONDS_TOTAL.labels(model=model, label=label).inc(duration_seconds or 0)


# --- DB-backed gauges (period totals, refreshed periodically from Postgres) ---

DB_COST_USD = Gauge(
    "devbot_db_cost_usd",
    "Lifetime USD spend from DB",
    ["model", "label"],
)
DB_INPUT_TOKENS = Gauge(
    "devbot_db_input_tokens",
    "Lifetime input tokens from DB",
    ["model", "label"],
)
DB_OUTPUT_TOKENS = Gauge(
    "devbot_db_output_tokens",
    "Lifetime output tokens from DB",
    ["model", "label"],
)
DB_CACHE_READ_TOKENS = Gauge(
    "devbot_db_cache_read_tokens",
    "Lifetime cache read tokens from DB",
    ["model", "label"],
)
DB_CACHE_WRITE_TOKENS = Gauge(
    "devbot_db_cache_write_tokens",
    "Lifetime cache write tokens from DB",
    ["model", "label"],
)
DB_CYCLES = Gauge(
    "devbot_db_cycles",
    "Lifetime cycle count from DB",
    ["model", "label"],
)


async def refresh_db_gauges() -> None:
    """Query Postgres cycle aggregates and update the DB-backed gauges."""
    from .db import get_pool

    rows = await get_pool().fetch(
        """
        SELECT COALESCE(model, 'unknown') AS model,
               COALESCE(label, 'unknown') AS label,
               SUM(cost_usd) AS cost_usd,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               COUNT(*) AS cycles
        FROM cycles
        GROUP BY model, label
        """
    )
    for r in rows:
        labels = {"model": r["model"], "label": r["label"]}
        DB_COST_USD.labels(**labels).set(float(r["cost_usd"] or 0))
        DB_INPUT_TOKENS.labels(**labels).set(r["input_tokens"] or 0)
        DB_OUTPUT_TOKENS.labels(**labels).set(r["output_tokens"] or 0)
        DB_CACHE_READ_TOKENS.labels(**labels).set(r["cache_read_tokens"] or 0)
        DB_CACHE_WRITE_TOKENS.labels(**labels).set(r["cache_write_tokens"] or 0)
        DB_CYCLES.labels(**labels).set(r["cycles"] or 0)


async def db_gauge_refresh_loop() -> None:
    """Background task: refresh DB-backed gauges every 60s until cancelled."""
    while True:
        try:
            await refresh_db_gauges()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Failed to refresh DB-backed Prometheus gauges")
        await asyncio.sleep(DB_GAUGE_REFRESH_INTERVAL_SECONDS)


_ID_RE = re.compile(r"/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|\d+)")


def normalize_path(path: str) -> str:
    return _ID_RE.sub("/:id", path)


class PrometheusMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/metrics":
            return await call_next(request)

        start = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception:
            raise
        finally:
            duration = time.perf_counter() - start
            path = normalize_path(request.url.path)
            REQUEST_COUNT.labels(
                method=request.method,
                path=path,
                code=str(status_code),
            ).inc()
            REQUEST_LATENCY.labels(method=request.method, path=path).observe(duration)
