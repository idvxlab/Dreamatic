"""
SQLite-backed persistent storage using aiosqlite.

Schema
------
sessions
  session_id  TEXT PRIMARY KEY
  messages    TEXT  -- JSON blob: list[MessageDict]
  created_at  TEXT
  updated_at  TEXT
  metadata    TEXT  -- JSON blob: dict

checkpoints
  checkpoint_id  TEXT PRIMARY KEY
  session_id     TEXT NOT NULL
  round_index    INTEGER NOT NULL
  state          TEXT NOT NULL  -- EngineState.name
  messages       TEXT NOT NULL  -- JSON blob: list[MessageDict]
  created_at     TEXT NOT NULL

MessageDict wire format
-----------------------
{
  "role": str,
  "round_index": int,
  "is_compressed": bool,
  "content": [
    {"type": "text",         "text": str}
    {"type": "thinking",     "thinking": str, "signature": str}
    {"type": "tool_call",    "tool_call_id": str, "tool_name": str, "tool_input": dict}
    {"type": "tool_result",  "tool_call_id": str, "content": str,
                             "is_error": bool, "is_overflow_ref": bool}
  ]
}
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from harness.types.messages import (
    Message,
    TextBlock,
    ImageBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from harness.engine.state_machine import EngineState
from harness.storage.session import SessionStore, SessionRecord
from harness.storage.checkpoint import CheckpointStore, Checkpoint
from harness.storage.memory_store import MemoryEntry, MemoryStore
from harness.storage.plan_store import PlanItem, PlanState, PlanStore


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _block_to_dict(block: Any) -> dict:
    """Convert a single content block to a plain dict for JSON storage."""
    t = block.type
    if t == "text":
        return {"type": "text", "text": block.text}
    if t == "image":
        return {
            "type": "image",
            "path": block.path,
            "media_type": block.media_type,
            "name": block.name,
            "attachment_id": block.attachment_id,
            "url": block.url,
        }
    if t == "thinking":
        return {"type": "thinking", "thinking": block.thinking, "signature": block.signature}
    if t == "tool_call":
        return {
            "type": "tool_call",
            "tool_call_id": block.tool_call_id,
            "tool_name": block.tool_name,
            "tool_input": block.tool_input,
        }
    if t == "tool_result":
        return {
            "type": "tool_result",
            "tool_call_id": block.tool_call_id,
            "content": block.content,
            "is_error": block.is_error,
            "is_overflow_ref": block.is_overflow_ref,
        }
    raise ValueError(f"Unknown block type: {t!r}")


def _block_from_dict(d: dict) -> Any:
    """Reconstruct the correct block dataclass from a plain dict."""
    t = d["type"]
    if t == "text":
        return TextBlock(text=d["text"])
    if t == "image":
        return ImageBlock(
            path=d["path"],
            media_type=d["media_type"],
            name=d.get("name", ""),
            attachment_id=d.get("attachment_id", ""),
            url=d.get("url", ""),
        )
    if t == "thinking":
        return ThinkingBlock(thinking=d["thinking"], signature=d.get("signature", ""))
    if t == "tool_call":
        return ToolCallBlock(
            tool_call_id=d["tool_call_id"],
            tool_name=d["tool_name"],
            tool_input=d.get("tool_input", {}),
        )
    if t == "tool_result":
        return ToolResultBlock(
            tool_call_id=d["tool_call_id"],
            content=d["content"],
            is_error=d.get("is_error", False),
            is_overflow_ref=d.get("is_overflow_ref", False),
        )
    raise ValueError(f"Unknown block type in stored data: {t!r}")


def _messages_to_json(messages: list[Message]) -> str:
    """Serialise a list of Message objects to a JSON string."""
    data = [
        {
            "role": msg.role,
            "message_id": msg.message_id,
            "round_index": msg.round_index,
            "is_compressed": msg.is_compressed,
            "content": [_block_to_dict(b) for b in msg.content],
        }
        for msg in messages
    ]
    return json.dumps(data, ensure_ascii=False)


def _messages_from_json(raw: str) -> list[Message]:
    """Deserialise a JSON string produced by _messages_to_json back to Message objects."""
    data = json.loads(raw)
    messages: list[Message] = []
    for item in data:
        blocks = [_block_from_dict(b) for b in item["content"]]
        messages.append(
            Message(
                role=item["role"],
                message_id=item.get("message_id", ""),
                content=blocks,
                round_index=item.get("round_index", 0),
                is_compressed=item.get("is_compressed", False),
            )
        )
    return messages


# ---------------------------------------------------------------------------
# SQLiteSessionStore
# ---------------------------------------------------------------------------

class SQLiteSessionStore(SessionStore):
    """Persistent session store backed by a SQLite database file."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._initialised = False

    async def _ensure_tables(self, conn: aiosqlite.Connection) -> None:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id  TEXT PRIMARY KEY,
                messages    TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                metadata    TEXT NOT NULL DEFAULT '{}'
            )
        """)
        # Schema migrations — add columns that may not exist in older DBs
        for col, col_def in [
            ("display_name", "TEXT DEFAULT ''"),
            ("pinned", "INTEGER DEFAULT 0"),
            ("archived", "INTEGER DEFAULT 0"),
        ]:
            try:
                await conn.execute(
                    f"ALTER TABLE sessions ADD COLUMN {col} {col_def}"
                )
            except aiosqlite.OperationalError:
                pass  # column already exists
        await conn.commit()

    async def _get_conn(self) -> aiosqlite.Connection:
        conn = await aiosqlite.connect(self._db_path)
        conn.row_factory = aiosqlite.Row
        await self._ensure_tables(conn)
        return conn

    async def save(self, session_id: str, messages: list[Message], title: str = "", metadata: dict | None = None) -> None:
        now = datetime.now(timezone.utc).isoformat()
        messages_json = _messages_to_json(messages)
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            meta_json = json.dumps(metadata, ensure_ascii=False) if metadata is not None else None
            if title:
                existing_meta = {}
                try:
                    async with conn.execute(
                        "SELECT metadata FROM sessions WHERE session_id = ?",
                        (session_id,),
                    ) as cursor:
                        row = await cursor.fetchone()
                    if row and row["metadata"]:
                        existing_meta = json.loads(row["metadata"])
                except Exception:
                    existing_meta = {}
                existing_meta["title"] = title
                meta_json = json.dumps(existing_meta, ensure_ascii=False)

            if meta_json is not None:
                await conn.execute("""
                    INSERT INTO sessions (session_id, messages, created_at, updated_at, metadata)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        messages   = excluded.messages,
                        updated_at = excluded.updated_at,
                        metadata   = excluded.metadata
                """, (session_id, messages_json, now, now, meta_json))
            else:
                await conn.execute("""
                    INSERT INTO sessions (session_id, messages, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        messages   = excluded.messages,
                        updated_at = excluded.updated_at
                """, (session_id, messages_json, now, now))
            await conn.commit()

    async def load(self, session_id: str) -> SessionRecord | None:
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                return None
            return SessionRecord(
                session_id=row["session_id"],
                messages=_messages_from_json(row["messages"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                metadata=json.loads(row["metadata"]),
                display_name=row["display_name"] if "display_name" in row.keys() else "",
                pinned=bool(row["pinned"]) if "pinned" in row.keys() else False,
                archived=bool(row["archived"]) if "archived" in row.keys() else False,
            )

    async def list_sessions(self) -> list[SessionRecord]:
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT * FROM sessions ORDER BY pinned DESC, created_at DESC"
            ) as cur:
                rows = await cur.fetchall()
            results: list[SessionRecord] = []
            for row in rows:
                results.append(SessionRecord(
                    session_id=row["session_id"],
                    messages=[],  # lazy — messages not needed for listing
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    metadata=json.loads(row["metadata"]),
                    display_name=row["display_name"] if "display_name" in row.keys() else "",
                    pinned=bool(row["pinned"]) if "pinned" in row.keys() else False,
                    archived=bool(row["archived"]) if "archived" in row.keys() else False,
                ))
            return results

    async def update_metadata(self, session_id: str, **kwargs) -> None:
        """Partially update session metadata fields (display_name, pinned, archived)."""
        allowed = {"display_name", "pinned", "archived"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        set_clauses: list[str] = []
        params: list[Any] = []
        for k, v in updates.items():
            if k == "pinned":
                set_clauses.append("pinned = ?")
                params.append(1 if v else 0)
            elif k == "archived":
                set_clauses.append("archived = ?")
                params.append(1 if v else 0)
            else:
                set_clauses.append(f"{k} = ?")
                params.append(v)
        params.append(session_id)
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            await conn.execute(
                f"UPDATE sessions SET {', '.join(set_clauses)} WHERE session_id = ?",
                params,
            )
            await conn.commit()

    async def delete(self, session_id: str) -> None:
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            await conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
            await conn.commit()


# ---------------------------------------------------------------------------
# SQLiteCheckpointStore
# ---------------------------------------------------------------------------

class SQLiteCheckpointStore(CheckpointStore):
    """Persistent checkpoint store backed by a SQLite database file."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    async def _ensure_tables(self, conn: aiosqlite.Connection) -> None:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS checkpoints (
                checkpoint_id  TEXT PRIMARY KEY,
                session_id     TEXT NOT NULL,
                round_index    INTEGER NOT NULL,
                state          TEXT NOT NULL,
                messages       TEXT NOT NULL DEFAULT '[]',
                created_at     TEXT NOT NULL
            )
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_checkpoints_session
            ON checkpoints (session_id)
        """)
        await conn.commit()

    async def save(self, checkpoint: Checkpoint) -> str:
        cid = checkpoint.checkpoint_id or str(uuid.uuid4())
        checkpoint.checkpoint_id = cid
        messages_json = _messages_to_json(checkpoint.messages)
        state_name = checkpoint.state.name  # store enum by name, e.g. "RUNNING"
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            await conn.execute("""
                INSERT INTO checkpoints
                    (checkpoint_id, session_id, round_index, state, messages, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(checkpoint_id) DO UPDATE SET
                    session_id  = excluded.session_id,
                    round_index = excluded.round_index,
                    state       = excluded.state,
                    messages    = excluded.messages,
                    created_at  = excluded.created_at
            """, (cid, checkpoint.session_id, checkpoint.round_index,
                  state_name, messages_json, checkpoint.created_at))
            await conn.commit()
        return cid

    async def load(self, checkpoint_id: str) -> Checkpoint | None:
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT * FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                return None
            return Checkpoint(
                session_id=row["session_id"],
                checkpoint_id=row["checkpoint_id"],
                round_index=row["round_index"],
                state=EngineState[row["state"]],
                messages=_messages_from_json(row["messages"]),
                created_at=row["created_at"],
            )

    async def list_for_session(self, session_id: str) -> list[str]:
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT checkpoint_id FROM checkpoints WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            ) as cursor:
                rows = await cursor.fetchall()
            return [row["checkpoint_id"] for row in rows]

    async def delete(self, checkpoint_id: str) -> None:
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            await conn.execute(
                "DELETE FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,)
            )
            await conn.commit()


class SQLiteMemoryStore(MemoryStore):
    """Persistent long-term memory store backed by the same SQLite database."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    async def _ensure_tables(self, conn: aiosqlite.Connection) -> None:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                entry_id            TEXT PRIMARY KEY,
                scope               TEXT NOT NULL DEFAULT 'global',
                content             TEXT NOT NULL,
                tags                TEXT NOT NULL DEFAULT '[]',
                created_by_session  TEXT NOT NULL DEFAULT '',
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL,
                metadata            TEXT NOT NULL DEFAULT '{}'
            )
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_memories_scope_updated
            ON memories (scope, updated_at)
        """)
        await conn.commit()

    def _row_to_entry(self, row: aiosqlite.Row) -> MemoryEntry:
        return MemoryEntry(
            entry_id=row["entry_id"],
            scope=row["scope"],
            content=row["content"],
            tags=json.loads(row["tags"]),
            created_by_session=row["created_by_session"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            metadata=json.loads(row["metadata"]),
        )

    async def add(
        self,
        content: str,
        scope: str = "global",
        tags: list[str] | None = None,
        created_by_session: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> MemoryEntry:
        now = datetime.now(timezone.utc).isoformat()
        entry = MemoryEntry(
            entry_id=f"mem_{uuid.uuid4().hex[:12]}",
            content=content,
            scope=scope or "global",
            tags=list(tags or []),
            created_by_session=created_by_session,
            created_at=now,
            updated_at=now,
            metadata=dict(metadata or {}),
        )
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            await conn.execute("""
                INSERT INTO memories
                    (entry_id, scope, content, tags, created_by_session, created_at, updated_at, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                entry.entry_id,
                entry.scope,
                entry.content,
                json.dumps(entry.tags, ensure_ascii=False),
                entry.created_by_session,
                entry.created_at,
                entry.updated_at,
                json.dumps(entry.metadata, ensure_ascii=False),
            ))
            await conn.commit()
        return entry

    async def get(self, entry_id: str) -> MemoryEntry | None:
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT * FROM memories WHERE entry_id = ?", (entry_id,)
            ) as cursor:
                row = await cursor.fetchone()
            return self._row_to_entry(row) if row else None

    async def search(
        self,
        query: str = "",
        scope: str = "",
        tags: list[str] | None = None,
        limit: int = 20,
    ) -> list[MemoryEntry]:
        limit = max(1, min(int(limit or 20), 100))
        clauses: list[str] = []
        params: list[Any] = []
        if scope:
            clauses.append("scope = ?")
            params.append(scope)
        if query:
            clauses.append("(content LIKE ? OR tags LIKE ? OR scope LIKE ?)")
            like = f"%{query}%"
            params.extend([like, like, like])
        sql = "SELECT * FROM memories"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(limit)
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(sql, params) as cursor:
                rows = await cursor.fetchall()
        entries = [self._row_to_entry(row) for row in rows]
        wanted_tags = {t.casefold() for t in (tags or []) if t}
        if wanted_tags:
            entries = [
                entry for entry in entries
                if wanted_tags.issubset({t.casefold() for t in entry.tags})
            ]
        return entries

    async def delete(self, entry_id: str) -> bool:
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            cursor = await conn.execute(
                "DELETE FROM memories WHERE entry_id = ?", (entry_id,)
            )
            await conn.commit()
            return cursor.rowcount > 0


class SQLitePlanStore(PlanStore):
    """Persistent plan/task state backed by SQLite."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    async def _ensure_tables(self, conn: aiosqlite.Connection) -> None:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS plans (
                plan_id     TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL UNIQUE,
                title       TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'pending',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                metadata    TEXT NOT NULL DEFAULT '{}'
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS plan_items (
                item_id              TEXT PRIMARY KEY,
                plan_id              TEXT NOT NULL,
                position             INTEGER NOT NULL,
                content              TEXT NOT NULL,
                status               TEXT NOT NULL DEFAULT 'pending',
                assigned_session_id  TEXT NOT NULL DEFAULT '',
                result_message_id    TEXT NOT NULL DEFAULT '',
                metadata             TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
            )
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_plan_items_plan_position
            ON plan_items (plan_id, position)
        """)
        await conn.commit()

    async def save_plan(self, plan: PlanState) -> None:
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            await conn.execute("""
                INSERT INTO plans
                    (plan_id, session_id, title, status, created_at, updated_at, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(plan_id) DO UPDATE SET
                    session_id = excluded.session_id,
                    title      = excluded.title,
                    status     = excluded.status,
                    updated_at = excluded.updated_at,
                    metadata   = excluded.metadata
            """, (
                plan.plan_id,
                plan.session_id,
                plan.title,
                plan.status,
                plan.created_at,
                plan.updated_at,
                json.dumps(plan.metadata, ensure_ascii=False),
            ))
            await conn.execute(
                "DELETE FROM plan_items WHERE plan_id = ?",
                (plan.plan_id,),
            )
            for position, item in enumerate(plan.items):
                await conn.execute("""
                    INSERT INTO plan_items
                        (item_id, plan_id, position, content, status,
                         assigned_session_id, result_message_id, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    item.item_id,
                    plan.plan_id,
                    position,
                    item.content,
                    item.status,
                    item.assigned_session_id,
                    item.result_message_id,
                    json.dumps(item.metadata, ensure_ascii=False),
                ))
            await conn.commit()

    async def load_by_session(self, session_id: str) -> PlanState | None:
        async with aiosqlite.connect(self._db_path) as conn:
            conn.row_factory = aiosqlite.Row
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT * FROM plans WHERE session_id = ?",
                (session_id,),
            ) as cursor:
                plan_row = await cursor.fetchone()
            if plan_row is None:
                return None
            async with conn.execute(
                "SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position",
                (plan_row["plan_id"],),
            ) as cursor:
                item_rows = await cursor.fetchall()
        return PlanState(
            plan_id=plan_row["plan_id"],
            session_id=plan_row["session_id"],
            title=plan_row["title"],
            status=plan_row["status"],
            created_at=plan_row["created_at"],
            updated_at=plan_row["updated_at"],
            metadata=json.loads(plan_row["metadata"]),
            items=[
                PlanItem(
                    item_id=row["item_id"],
                    content=row["content"],
                    status=row["status"],
                    assigned_session_id=row["assigned_session_id"],
                    result_message_id=row["result_message_id"],
                    metadata=json.loads(row["metadata"]),
                )
                for row in item_rows
            ],
        )

    async def bind_item(
        self,
        plan_id: str,
        item_id: str,
        assigned_session_id: str = "",
        result_message_id: str = "",
    ) -> bool:
        updates: list[str] = []
        params: list[Any] = []
        if assigned_session_id:
            updates.append("assigned_session_id = ?")
            params.append(assigned_session_id)
        if result_message_id:
            updates.append("result_message_id = ?")
            params.append(result_message_id)
        if not updates:
            return False
        params.extend([plan_id, item_id])
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            cursor = await conn.execute(
                f"UPDATE plan_items SET {', '.join(updates)} WHERE plan_id = ? AND item_id = ?",
                params,
            )
            await conn.execute(
                "UPDATE plans SET updated_at = ? WHERE plan_id = ?",
                (datetime.now(timezone.utc).isoformat(), plan_id),
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def delete_by_session(self, session_id: str) -> None:
        async with aiosqlite.connect(self._db_path) as conn:
            await self._ensure_tables(conn)
            async with conn.execute(
                "SELECT plan_id FROM plans WHERE session_id = ?",
                (session_id,),
            ) as cursor:
                row = await cursor.fetchone()
            if row:
                await conn.execute(
                    "DELETE FROM plan_items WHERE plan_id = ?",
                    (row[0],),
                )
            await conn.execute("DELETE FROM plans WHERE session_id = ?", (session_id,))
            await conn.commit()
