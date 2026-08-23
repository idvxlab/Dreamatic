"""
WebSocket endpoint for real-time message streaming.

Clients connect to /ws/{session_id} and receive JSON-encoded messages
as they arrive from the engine. This is the PRIMARY sync path — the
frontend subscribes to event frames (state, question.*) instead of
polling GET /state.

Event channels (server → client):
  "token"          — streamed LLM text token
  "thinking"       — thinking phase started
  "thinking_token" — streamed thinking chunk
  "message"        — full Message (assistant reply or tool result)
  "state"          — engine state change snapshot
  "question.asked"  — a new QuestionRequest was registered (ask_user fired)
  "question.updated"— a QuestionRequest transitioned (status change)
  "question.resolved"— a QuestionRequest reached a terminal status
  "error"          — error frame

The legacy /state polling endpoint remains for:
  - snapshot restore on initial page load
  - dev / debug mode where WS may not be available
  - background sync when the WS connection is down
"""
from __future__ import annotations

import json

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.routing import APIRouter

from api.rest import (
    _engines,
    _get_engine,
    _is_tool_inventory_query,
    _render_tool_inventory,
    _respond_with_local_text,
)
from harness.engine.engine import serialize_message
from harness.types.messages import Message

router = APIRouter()

_THINKING_START = "\x00THINKING\x00"
_THINKING_TOKEN_PREFIX = "\x00THINKING_TOKEN\x00"

# Event types that originate from the engine's event channel and are
# forwarded verbatim to the WS client. QuestionMode events live here.
_FORWARDED_EVENT_TYPES = {
    "question.asked",
    "question.updated",
    "question.resolved",
    "title_generated",
    "subagent.created",
    "subagent.waiting_approval",
    "runtime.event",
    "canvas.run_bound",
    # Rewrite history ("edit and regenerate"): the engine emits these on
    # success (message_rewritten) and on refusal (message_rewrite_refused).
    # Forwarding them lets the frontend react without polling.
    "message_rewritten",
    "message_rewrite_refused",
}


@router.websocket("/ws/{session_id}")
async def session_websocket(websocket: WebSocket, session_id: str) -> None:
    """
    Stream messages and engine events for a session over WebSocket.

    Protocol (server → client):
      {"type": "token",           "data": "<text chunk>"}
      {"type": "thinking"}
      {"type": "thinking_token",  "data": "<thinking chunk>"}
      {"type": "message",         "data": <serialized Message>}
      {"type": "state",           "data": <snapshot>}
      {"type": "question.asked",  "data": <QuestionRequest dict>}
      {"type": "question.updated","data": {"request_id", "status"}}
      {"type": "question.resolved","data": {"request_id", "status", "tool_call_id"}}
      {"type": "error",           "data": {"detail": "..."}}

    Protocol (client → server):
      {"type": "message", "text": "..."}   → send user message
      {"type": "cancel"}                   → cancel running loop
    """
    await websocket.accept()

    if session_id not in _engines:
        await websocket.send_text(
            json.dumps({"type": "error", "data": {"detail": f"Session {session_id!r} not found"}})
        )
        await websocket.close(code=4004)
        return

    engine = _engines[session_id]

    async def push_message(msg: Message) -> None:
        """Fires for every completed message (assistant reply or tool result)."""
        await websocket.send_text(
            json.dumps({"type": "message", "data": serialize_message(msg)})
        )

    async def push_token(text: str) -> None:
        """Fires for each streamed token or sentinel."""
        if text == _THINKING_START:
            await websocket.send_text(json.dumps({"type": "thinking"}))
        elif text.startswith(_THINKING_TOKEN_PREFIX):
            chunk = text[len(_THINKING_TOKEN_PREFIX):]
            await websocket.send_text(
                json.dumps({"type": "thinking_token", "data": chunk})
            )
        else:
            await websocket.send_text(
                json.dumps({"type": "token", "data": text})
            )

    async def push_state() -> None:
        """Fires when engine state changes (RUNNING → COMPLETED/ERROR/WAITING_INPUT/...)."""
        snapshot = await engine.get_snapshot()
        await websocket.send_text(
            json.dumps({"type": "state", "data": snapshot})
        )

    async def push_event(event: dict) -> None:
        """
        Engine-level semantic event channel.

        Forwards question.asked / question.updated / question.resolved
        verbatim. The frontend uses these as the PRIMARY sync signal —
        no polling required. Polling is only a fallback for restore / dev.
        """
        etype = event.get("type")
        if etype not in _FORWARDED_EVENT_TYPES:
            return
        await websocket.send_text(json.dumps(event))

    engine.add_message_listener(push_message)
    engine.add_token_listener(push_token)
    engine.add_state_listener(push_state)
    engine.add_event_listener(push_event)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(
                    json.dumps({"type": "error", "data": {"detail": "Invalid JSON"}})
                )
                continue

            msg_type = msg.get("type")

            if msg_type == "message":
                text = msg.get("text", "")
                if text:
                    snapshot = await engine.get_snapshot()
                    if _is_tool_inventory_query(text) and not snapshot.get("is_running"):
                        await _respond_with_local_text(
                            session_id=session_id,
                            engine=engine,
                            user_text=text,
                            assistant_text=_render_tool_inventory(engine),
                        )
                    else:
                        send_result = await engine.send_message(text)
                snapshot = await engine.get_snapshot()
                # If the message was queued (engine was RUNNING), surface a
                # dedicated event so the frontend can update the queued panel
                # immediately, without waiting for the next snapshot tick.
                ws_payload: dict[str, Any] = {"type": "state", "data": snapshot}
                if 'send_result' in locals() and send_result.get("queued"):
                    ws_payload = {
                        "type": "message_queued",
                        "data": send_result,
                    }
                await websocket.send_text(json.dumps(ws_payload))

            elif msg_type == "confirm":
                await engine.confirm()
                snapshot = await engine.get_snapshot()
                await websocket.send_text(json.dumps({"type": "state", "data": snapshot}))

            elif msg_type == "deny":
                await engine.deny()
                snapshot = await engine.get_snapshot()
                await websocket.send_text(json.dumps({"type": "state", "data": snapshot}))

            elif msg_type == "cancel":
                await engine.cancel()
                await websocket.send_text(
                    json.dumps({"type": "state", "data": {"status": "cancel_requested"}})
                )

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

            else:
                await websocket.send_text(
                    json.dumps({"type": "error", "data": {"detail": f"Unknown message type: {msg_type!r}"}})
                )

    except WebSocketDisconnect:
        pass
    finally:
        engine.remove_message_listener(push_message)
        engine.remove_token_listener(push_token)
        engine.remove_state_listener(push_state)
        engine.remove_event_listener(push_event)
