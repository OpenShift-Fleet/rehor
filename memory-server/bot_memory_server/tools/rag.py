import json
from typing import Optional

from fastmcp import FastMCP

from ..db import get_pool
from ..embeddings import embed
from ..events import Event, bus
from ..models import Memory, MemorySearchResult


def _row_to_memory(row) -> dict:
    memory = Memory(
        id=row["id"],
        category=row["category"],
        repo=row["repo"],
        external_key=row.get("external_key"),
        source_type=row.get("source_type"),
        title=row["title"],
        content=row["content"],
        tags=list(row["tags"]) if row["tags"] else [],
        created_at=row["created_at"],
        metadata=json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
    )
    return memory.model_dump(mode="json")


def _row_to_search_result(row) -> dict:
    result = MemorySearchResult(
        id=row["id"],
        category=row["category"],
        repo=row["repo"],
        external_key=row.get("external_key"),
        source_type=row.get("source_type"),
        title=row["title"],
        content=row["content"],
        tags=list(row["tags"]) if row["tags"] else [],
        created_at=row["created_at"],
        metadata=json.loads(row["metadata"]) if isinstance(row["metadata"], str) else (row["metadata"] or {}),
        similarity=1 - row["distance"],
    )
    return result.model_dump(mode="json")


def register_rag_tools(mcp: FastMCP):
    @mcp.tool()
    async def memory_store(
        category: str,
        title: str,
        content: str,
        repo: Optional[str] = None,
        external_key: Optional[str] = None,
        source_type: Optional[str] = None,
        tags: Optional[list[str]] = None,
        metadata: Optional[dict] = None,
    ) -> dict:
        """Store a memory with auto-generated embedding.
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345'). Optional.
        source_type: Source system — 'jira', 'github', etc. Inferred as 'jira' if external_key looks like a Jira key.
        Categories: learning, review_feedback, codebase_pattern.
        Tags: free-form labels like bug-fix, cve, css, patternfly, dependency-upgrade, ci, ui-change, testing."""
        pool = get_pool()
        vector = embed(f"{title}\n{content}")
        if external_key and not source_type:
            source_type = "jira"
        row = await pool.fetchrow(
            """
            INSERT INTO memories (category, repo, external_key, source_type, title, content, tags, embedding, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
            """,
            category,
            repo,
            external_key,
            source_type,
            title,
            content,
            tags or [],
            vector,
            json.dumps(metadata or {}),
        )
        result = _row_to_memory(row)
        await bus.publish(
            Event(
                "memory_stored",
                {"id": result["id"], "title": title, "category": category},
            )
        )
        return result

    @mcp.tool()
    async def memory_search(
        query: str,
        category: Optional[str] = None,
        repo: Optional[str] = None,
        tag: Optional[str] = None,
        limit: int = 5,
    ) -> list[dict]:
        """Semantic search over memories. Returns top matches with similarity scores. Filter by tag."""
        pool = get_pool()
        vector = embed(query)

        conditions = []
        params = [vector, limit]
        idx = 2

        if category:
            idx += 1
            conditions.append(f"category = ${idx}")
            params.append(category)
        if repo:
            idx += 1
            conditions.append(f"repo = ${idx}")
            params.append(repo)
        if tag:
            idx += 1
            conditions.append(f"${idx} = ANY(tags)")
            params.append(tag)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = await pool.fetch(
            f"""
            SELECT *, embedding <=> $1 AS distance
            FROM memories
            {where}
            ORDER BY distance
            LIMIT $2
            """,
            *params,
        )
        return [_row_to_search_result(r) for r in rows]

    @mcp.tool()
    async def memory_list(
        category: Optional[str] = None,
        repo: Optional[str] = None,
        tag: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List recent memories, optionally filtered by category, repo, or tag.
        Returns {items, total, limit, offset}."""
        pool = get_pool()

        conditions = []
        params = []
        idx = 0

        if category:
            idx += 1
            conditions.append(f"category = ${idx}")
            params.append(category)
        if repo:
            idx += 1
            conditions.append(f"repo = ${idx}")
            params.append(repo)
        if tag:
            idx += 1
            conditions.append(f"${idx} = ANY(tags)")
            params.append(tag)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        total = await pool.fetchval(f"SELECT COUNT(*) FROM memories {where}", *params)

        idx += 1
        params.append(limit)
        limit_idx = idx
        idx += 1
        params.append(offset)
        offset_idx = idx

        rows = await pool.fetch(
            f"""
            SELECT * FROM memories
            {where}
            ORDER BY created_at DESC
            LIMIT ${limit_idx} OFFSET ${offset_idx}
            """,
            *params,
        )
        return {
            "items": [_row_to_memory(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    @mcp.tool()
    async def memory_delete(id: int) -> dict:
        """Delete a memory by ID."""
        pool = get_pool()
        result = await pool.execute("DELETE FROM memories WHERE id = $1", id)
        if result == "DELETE 0":
            raise ValueError(f"Memory {id} not found")
        await bus.publish(Event("memory_deleted", {"id": id}))
        return {"deleted": True, "id": id}
