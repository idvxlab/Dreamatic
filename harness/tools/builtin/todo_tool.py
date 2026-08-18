from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from harness.types.tools import ToolSchema, ToolParam
from harness.storage.plan_store import PlanItem, PlanState, PlanStore

if TYPE_CHECKING:
    from harness.storage.session import SessionStore

TODO_WRITE_SCHEMA = ToolSchema(
    name="todo_write",
    description=(
        "Create, replace, read, and update the single visible session plan. "
        "Use this before non-trivial multi-step work, update it as steps "
        "progress, and replace it with action=set when the user asks for a "
        "new, revised, or more detailed plan. Submit at most one todo_write "
        "call in a tool-call batch; when advancing, complete the current item "
        "before starting the next item."
    ),
    params=[
        ToolParam(name="session_id", type="string", description="Current session identifier"),
        ToolParam(
            name="action",
            type="string",
            description=(
                "Action: set (replace the current visible plan), update "
                "(change one step status), or get (retrieve plan)"
            ),
        ),
        ToolParam(
            name="todos",
            type="array",
            description="List of todo items with 'content' and 'status' fields (use with action=set)",
            required=False,
            items={
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "Todo item text",
                    },
                    "status": {
                        "type": "string",
                        "description": "Todo status",
                        "enum": ["pending", "in_progress", "completed"],
                    },
                },
                "required": ["content", "status"],
                "additionalProperties": False,
            },
        ),
        ToolParam(
            name="index",
            type="integer",
            description="Zero-based index of the todo item to update (use with action=update)",
            required=False,
        ),
        ToolParam(
            name="status",
            type="string",
            description="New status: pending, in_progress, or completed (use with action=update)",
            required=False,
        ),
    ],
)

# In-memory session-level todo store: session_id -> list of dicts
_TODO_STORE: dict[str, list[dict]] = {}
PLAN_META_KEY = "plan_state"


def get_session_todos(session_id: str) -> list[dict]:
    """Return a copy of the session todo list for snapshot/UI rendering."""
    return [dict(item) for item in _TODO_STORE.get(session_id, [])]


def _normalise_todos(todos: list[dict]) -> list[dict]:
    items: list[dict] = []
    for index, item in enumerate(todos):
        content = str(item.get("content", "")).strip()
        status = str(item.get("status", "pending")).strip()
        if status not in ("pending", "in_progress", "completed"):
            status = "pending"
        item_id = str(item.get("item_id", "")).strip() or f"item_{index + 1}"
        items.append({
            "item_id": item_id,
            "content": content,
            "status": status,
            "assigned_session_id": str(item.get("assigned_session_id", "")),
            "result_message_id": str(item.get("result_message_id", "")),
        })
    return items


def _validate_single_in_progress(items: list[dict]) -> str:
    count = sum(1 for item in items if item.get("status") == "in_progress")
    if count > 1:
        return (
            "Error: only one todo item may be in_progress at a time. "
            "Mark the current step completed or pending before starting another."
        )
    return ""


def _plan_status(items: list[dict]) -> str:
    if not items:
        return "pending"
    if all(item.get("status") == "completed" for item in items):
        return "completed"
    if any(item.get("status") == "in_progress" for item in items):
        return "in_progress"
    return "pending"


def build_plan_state(session_id: str, todos: list[dict]) -> dict:
    items = _normalise_todos(todos)
    return {
        "plan_id": f"plan_{session_id}",
        "session_id": session_id,
        "status": _plan_status(items),
        "items": items,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _build_plan_model(session_id: str, todos: list[dict]) -> PlanState:
    now = datetime.now(timezone.utc).isoformat()
    items = _normalise_todos(todos)
    return PlanState(
        plan_id=f"plan_{session_id}",
        session_id=session_id,
        status=_plan_status(items),
        created_at=now,
        updated_at=now,
        items=[
            PlanItem(
                item_id=str(item.get("item_id") or f"item_{index + 1}"),
                content=item.get("content", ""),
                status=item.get("status", "pending"),
                assigned_session_id=item.get("assigned_session_id", ""),
                result_message_id=item.get("result_message_id", ""),
            )
            for index, item in enumerate(items)
        ],
    )


async def load_session_todos(
    session_id: str,
    session_store: "SessionStore | None" = None,
    plan_store: PlanStore | None = None,
) -> list[dict]:
    """Return persisted todos when available, falling back to in-memory state."""
    if plan_store is not None:
        try:
            plan = await plan_store.load_by_session(session_id)
            if plan is not None:
                items = _normalise_todos(plan.to_todos())
                _TODO_STORE[session_id] = items
                return [dict(item) for item in items]
        except Exception:
            pass
    if session_store is not None:
        try:
            record = await session_store.load(session_id)
            plan = (record.metadata or {}).get(PLAN_META_KEY) if record else None
            if isinstance(plan, dict) and isinstance(plan.get("items"), list):
                items = _normalise_todos(plan["items"])
                _TODO_STORE[session_id] = items
                return [dict(item) for item in items]
        except Exception:
            pass
    return get_session_todos(session_id)


async def persist_session_todos(
    session_id: str,
    todos: list[dict],
    session_store: "SessionStore | None" = None,
    plan_store: PlanStore | None = None,
) -> None:
    items = _normalise_todos(todos)
    _TODO_STORE[session_id] = items
    if plan_store is not None:
        try:
            await plan_store.save_plan(_build_plan_model(session_id, items))
        except Exception:
            pass
    if session_store is None:
        return
    try:
        record = await session_store.load(session_id)
        metadata = dict(record.metadata) if record and isinstance(record.metadata, dict) else {}
        messages = record.messages if record else []
        metadata[PLAN_META_KEY] = build_plan_state(session_id, items)
        await session_store.save(session_id, messages, metadata=metadata)
    except Exception:
        pass


async def todo_write_tool(
    session_id: str,
    action: str,
    todos: list[dict] | None = None,
    index: int | None = None,
    status: str | None = None,
    session_store: "SessionStore | None" = None,
    plan_store: PlanStore | None = None,
) -> str:
    global _TODO_STORE

    if action == "set":
        if todos is None:
            return "Error: todos is required when action=set"
        items = _normalise_todos(todos)
        validation_error = _validate_single_in_progress(items)
        if validation_error:
            return validation_error
        await persist_session_todos(
            session_id,
            items,
            session_store=session_store,
            plan_store=plan_store,
        )
        return f"Todo list set with {len(todos)} item(s)."

    if action == "get":
        items = await load_session_todos(
            session_id,
            session_store=session_store,
            plan_store=plan_store,
        )
        if not items:
            return "No todo items."
        lines = []
        for i, item in enumerate(items):
            lines.append(f"[{i}] [{item.get('status', 'pending')}] {item.get('content', '')}")
        return "\n".join(lines)

    if action == "update":
        if index is None:
            return "Error: index is required when action=update"
        items = await load_session_todos(
            session_id,
            session_store=session_store,
            plan_store=plan_store,
        )
        if not items:
            return f"Error: no todo items found for session {session_id}"
        if index < 0 or index >= len(items):
            return f"Error: index {index} out of range (0-{len(items) - 1})"
        if status not in ("pending", "in_progress", "completed"):
            return f"Error: status must be one of pending, in_progress, completed; got '{status}'"
        if status == "in_progress":
            for i, item in enumerate(items):
                if i != index and item.get("status") == "in_progress":
                    return (
                        "Error: only one todo item may be in_progress at a time. "
                        f"Item [{i}] is already in_progress."
                    )
        items[index]["status"] = status
        await persist_session_todos(
            session_id,
            items,
            session_store=session_store,
            plan_store=plan_store,
        )
        return f"Updated item [{index}] → {status}."

    return f"Error: unknown action '{action}'. Use set, update, or get."


def make_todo_write_tool(
    session_store: "SessionStore",
    plan_store: PlanStore | None = None,
    bound_session_id: str | None = None,
):
    async def persistent_todo_write_tool(
        action: str,
        todos: list[dict] | None = None,
        index: int | None = None,
        status: str | None = None,
        session_id: str = "",
    ) -> str:
        target_session_id = bound_session_id or session_id
        return await todo_write_tool(
            session_id=target_session_id,
            action=action,
            todos=todos,
            index=index,
            status=status,
            session_store=session_store,
            plan_store=plan_store,
        )

    return persistent_todo_write_tool
