from datetime import datetime
from typing import Any

from pydantic import BaseModel


class Task(BaseModel):
    id: int
    external_key: str
    source_type: str
    source_url: str | None = None
    artifacts: list[dict[str, Any]] = []
    status: str
    repo: str | None = None
    branch: str | None = None
    title: str | None = None
    summary: str | None = None
    created_at: datetime
    last_addressed: datetime
    paused_reason: str | None = None
    instance_id: str | None = None
    metadata: dict[str, Any] = {}


class Memory(BaseModel):
    id: int
    category: str
    repo: str | None = None
    external_key: str | None = None
    source_type: str | None = None
    title: str
    content: str
    tags: list[str] = []
    created_at: datetime
    metadata: dict[str, Any] = {}


class MemorySearchResult(Memory):
    similarity: float


class CycleRun(BaseModel):
    id: int
    task_id: int | None = None
    cycle_type: str
    instance_id: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    tool_calls: int | None = None
    tokens_used: int | None = None
    progress: dict[str, Any] | None = None
    created_at: datetime
