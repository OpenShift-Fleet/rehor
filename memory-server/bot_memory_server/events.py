"""Simple in-process event bus with SSE broadcasting."""

import asyncio
import json
import time
from dataclasses import dataclass, field


@dataclass
class Event:
    type: str  # task_added, task_updated, memory_stored, memory_deleted, bot_status
    data: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps({"type": self.type, "data": self.data, "timestamp": self.timestamp})

    def to_sse_json(self) -> str:
        return self.to_json()


class EventBus:
    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subscribers.remove(q)

    async def publish(self, event: Event):
        for q in self._subscribers:
            await q.put(event)


bus = EventBus()
