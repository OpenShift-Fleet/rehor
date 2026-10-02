from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class OutcomeEvidence(BaseModel):
    """One provider/workflow fact with LLM-assigned, bounded evidence resolution."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    source: str
    reference: str
    resolution: Literal["accepted", "rejected", "unknown"]
    disposition: str
    reason: str
    kind: Literal["state", "comment"] = Field(
        default="state",
        description=(
            "Evidence category: state for provider/workflow facts, comment for authored commentary. "
            "Omitted kind defaults to state for compatibility; callers must set comment for comments."
        ),
    )
    author_type: Literal["human", "workflow", "agent", "automation"] | None = Field(
        default=None,
        alias="authorType",
        description=(
            "Author category, used only for comment evidence: agent/automation comments are ignored; "
            "human/workflow comments are authoritative. Missing authorType remains authoritative for compatibility. "
            "State evidence is valid regardless of authorType."
        ),
    )


class OutcomeArtifact(BaseModel):
    """Shared artifact identity with provider-specific facts retained as extras."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    type: str
    url: str | None = None
    id: str | None = None
    supersedes: list[str] = Field(default_factory=list)


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
