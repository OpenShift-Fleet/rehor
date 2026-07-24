import re
import time

from prometheus_client import Counter, Histogram
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

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
