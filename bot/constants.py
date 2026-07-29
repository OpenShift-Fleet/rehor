import os

_DEFAULT_COOLDOWN_SECONDS = 172800  # 48 hours

MEMORY_API_BASE = os.environ.get("MEMORY_API_URL", "http://localhost:8080/api")
