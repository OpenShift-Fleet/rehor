import os
import re

_DEFAULT_COOLDOWN_SECONDS = 172800  # 48 hours


def _derive_memory_api_base() -> str:
    explicit = os.environ.get("MEMORY_API_URL")
    if explicit:
        return explicit.rstrip("/")
    bot_memory = os.environ.get("BOT_MEMORY_URL", "")
    if bot_memory:
        base = re.sub(r"/mcp/?$", "", bot_memory.rstrip("/"))
        return f"{base}/api"
    return "http://localhost:8080/api"


MEMORY_API_BASE = _derive_memory_api_base()
