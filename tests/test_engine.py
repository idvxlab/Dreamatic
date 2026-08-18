"""Tests for the engine state machine and AgentEngine."""
from __future__ import annotations

import asyncio
import pytest

from harness.engine.state_machine import (
    EngineState,
    IllegalTransitionError,
    StateMachine,
)
from harness.engine.engine import AgentEngine, EngineConfig
from harness.engine.loop import ReactLoop
from harness.engine.compression import CompressionConfig, ContextCompressor
from harness.engine.loop_detector import LoopDetector
from harness.types.messages import Message, TextBlock, ToolCallBlock, ToolResultBlock
from harness.observability.events import EventEmitter
from harness.tools.executor import ToolExecutor
from harness.tools.registry import ToolRegistry
from harness.tools.overflow import OverflowStore
from harness.storage.backends.memory import MemorySessionStore
from harness.tools.builtin.todo_tool import (
    TODO_WRITE_SCHEMA,
    make_todo_write_tool,
    todo_write_tool,
)
from harness.storage.backends.memory import InMemoryMemoryStore, InMemoryPlanStore


# ──────────────────────────────────────────────────────────────────────
# StateMachine
# ──────────────────────────────────────────────────────────────────────

class TestStateMachine:
    def test_initial_state(self):
        sm = StateMachine()
        assert sm.state == EngineState.WAITING_INPUT

    def test_legal_transition(self):
        sm = StateMachine()
        sm.transition(EngineState.RUNNING)
        assert sm.state == EngineState.RUNNING

    def test_illegal_transition_raises(self):
        sm = StateMachine()
        with pytest.raises(IllegalTransitionError):
            sm.transition(EngineState.COMPLETED)  # must go through RUNNING first

    def test_full_happy_path(self):
        sm = StateMachine()
        sm.transition(EngineState.RUNNING)
        sm.transition(EngineState.COMPLETED)
        # Session reuse
        sm.transition(EngineState.WAITING_INPUT)
        assert sm.state == EngineState.WAITING_INPUT

    def test_error_recovery(self):
        sm = StateMachine()
        sm.transition(EngineState.RUNNING)
        sm.transition(EngineState.ERROR)
        sm.transition(EngineState.WAITING_INPUT)
        assert sm.state == EngineState.WAITING_INPUT

    def test_cancel_goes_to_waiting_not_error(self):
        sm = StateMachine()
        sm.transition(EngineState.RUNNING)
        sm.transition(EngineState.WAITING_INPUT)  # cancel path
        assert sm.state == EngineState.WAITING_INPUT


# ──────────────────────────────────────────────────────────────────────
# LoopDetector
# ──────────────────────────────────────────────────────────────────────

class TestLoopDetector:
    def _make_calls(self, *names: str) -> list[ToolCallBlock]:
        return [
            ToolCallBlock(tool_call_id=f"id-{n}", tool_name=n, tool_input={})
            for n in names
        ]

    def test_no_repeat_initially(self):
        ld = LoopDetector(window=5, threshold=2)
        assert not ld.is_repeated(self._make_calls("read_file"))

    def test_default_detects_repeat_on_third_occurrence(self):
        ld = LoopDetector()
        assert not ld.is_repeated(self._make_calls("shell"))
        assert not ld.is_repeated(self._make_calls("shell"))
        assert ld.is_repeated(self._make_calls("shell"))

    def test_detects_repeat_on_second_occurrence(self):
        ld = LoopDetector(window=5, threshold=2)
        ld.is_repeated(self._make_calls("shell"))   # first — not repeated
        assert ld.is_repeated(self._make_calls("shell"))  # second — repeated!

    def test_different_tools_not_repeated(self):
        ld = LoopDetector(window=5, threshold=2)
        ld.is_repeated(self._make_calls("read_file"))
        assert not ld.is_repeated(self._make_calls("shell"))

    def test_window_eviction(self):
        ld = LoopDetector(window=3, threshold=2)
        ld.is_repeated(self._make_calls("shell"))
        ld.is_repeated(self._make_calls("a"))
        ld.is_repeated(self._make_calls("b"))
        ld.is_repeated(self._make_calls("c"))
        # "shell" was evicted from the window (size 3), so not repeated
        assert not ld.is_repeated(self._make_calls("shell"))


# ──────────────────────────────────────────────────────────────────────
# AgentEngine integration
# ──────────────────────────────────────────────────────────────────────

class _MockLLM:
    """Returns a fixed text reply with no tool calls."""
    def __init__(self, reply_text: str = "Done.") -> None:
        self._text = reply_text

    async def chat(self, messages, tools=None):
        return Message(role="assistant", content=[TextBlock(text=self._text)])

    async def stream_chat(self, messages, tools=None, on_token=None):
        if on_token:
            for word in self._text.split():
                await on_token(word + " ")
        return await self.chat(messages, tools)

    async def complete(self, prompt: str) -> str:
        return "Summary."


class _FlakyLLM:
    """Raises once, then returns a normal assistant reply."""

    def __init__(self) -> None:
        self.calls = 0

    async def chat(self, messages, tools=None):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("Connection error.")
        return Message(role="assistant", content=[TextBlock(text="Recovered automatically.")])

    async def stream_chat(self, messages, tools=None, on_token=None):
        return await self.chat(messages, tools)

    async def complete(self, prompt: str) -> str:
        return "Summary."


def _build_engine(reply_text: str = "Done.", system_prompt: str = "") -> AgentEngine:
    session_id = "test-engine"
    emitter = EventEmitter(session_id)
    llm = _MockLLM(reply_text)
    store = MemorySessionStore()
    registry = ToolRegistry()
    overflow = OverflowStore()
    executor = ToolExecutor(registry=registry, overflow=overflow, emitter=emitter)
    compressor = ContextCompressor(
        summarizer=llm,
        config=CompressionConfig(),
    )
    loop = ReactLoop(
        llm=llm,
        tool_registry=registry,
        tool_executor=executor,
        compressor=compressor,
        emitter=emitter,
        max_rounds=10,
    )
    return AgentEngine(
        config=EngineConfig(session_id=session_id, system_prompt=system_prompt),
        loop=loop,
        session_store=store,
        emitter=emitter,
        tool_registry=registry,
    )


def _build_engine_with_llm(llm, session_id: str = "test-engine") -> AgentEngine:
    emitter = EventEmitter(session_id)
    store = MemorySessionStore()
    registry = ToolRegistry()
    overflow = OverflowStore()
    executor = ToolExecutor(registry=registry, overflow=overflow, emitter=emitter)
    compressor = ContextCompressor(
        summarizer=llm,
        config=CompressionConfig(),
    )
    loop = ReactLoop(
        llm=llm,
        tool_registry=registry,
        tool_executor=executor,
        compressor=compressor,
        emitter=emitter,
        max_rounds=10,
    )
    return AgentEngine(
        config=EngineConfig(session_id=session_id),
        loop=loop,
        session_store=store,
        emitter=emitter,
        tool_registry=registry,
    )


def _enable_todo_write(engine: AgentEngine) -> None:
    if engine._config.plan_store is None:
        engine._config.plan_store = InMemoryPlanStore()
    engine._tool_registry.register(
        TODO_WRITE_SCHEMA,
        make_todo_write_tool(
            engine._session_store,
            engine._config.plan_store,
            bound_session_id=engine._config.session_id,
        ),
    )


def _seed_messages(engine: AgentEngine, items: list[tuple[str, str]]) -> list[str]:
    """
    Synchronously inject messages into the engine's _messages list while
    the engine is in WAITING_INPUT. Returns the message_ids of the user
    messages in the same order they were inserted.

    Direct mutation is safe for tests because:
    - We only do this before/after the engine enters RUNNING.
    - The engine holds the state lock only during state transitions and
      I/O; once we're past the initial setup, the lock is free.
    """
    ids: list[str] = []
    for role, text in items:
        msg = Message(role=role, content=[TextBlock(text=text)])
        engine._messages.append(msg)
        if role == "user":
            ids.append(msg.message_id)
    return ids


@pytest.mark.asyncio
async def test_plan_reminder_added_for_nontrivial_task_without_existing_plan():
    engine = _build_engine()
    _enable_todo_write(engine)

    reminder = await engine._build_plan_reminder_message_if_needed(
        "请继续实现这个功能并运行测试"
    )

    assert reminder is not None
    assert reminder.role == "system"
    text = reminder.content[0].text
    assert "todo_write" in text
    assert 'action="set"' in text
    assert "load that Skill before writing the detailed plan" in text
    assert "replace it with the Skill-defined stages" in text


@pytest.mark.asyncio
async def test_plan_reminder_not_added_when_plan_exists():
    engine = _build_engine()
    _enable_todo_write(engine)
    await todo_write_tool(
        session_id=engine._config.session_id,
        action="set",
        todos=[{"content": "已有计划", "status": "in_progress"}],
        session_store=engine._session_store,
        plan_store=engine._config.plan_store,
    )

    reminder = await engine._build_plan_reminder_message_if_needed(
        "请继续实现这个功能并运行测试"
    )

    assert reminder is None


@pytest.mark.asyncio
async def test_snapshot_includes_unified_plan_tasks():
    engine = _build_engine()
    _enable_todo_write(engine)
    await todo_write_tool(
        session_id=engine._config.session_id,
        action="set",
        todos=[{"content": "Build visible planning UI", "status": "in_progress"}],
        session_store=engine._session_store,
        plan_store=engine._config.plan_store,
    )

    snapshot = await engine.get_snapshot()

    assert snapshot["todos"][0]["content"] == "Build visible planning UI"
    assert snapshot["tasks"][0]["source"] == "plan_item"
    assert snapshot["tasks"][0]["status"] == "running"
    assert snapshot["tasks"][0]["title"] == "Build visible planning UI"


@pytest.mark.asyncio
async def test_memory_context_is_injected_temporarily():
    memory_store = InMemoryMemoryStore()
    await memory_store.add(
        content="Tongji admissions planning should prioritize undergraduate applicants.",
        tags=["tongji"],
    )
    engine = _build_engine("Done.")
    engine._config.memory_store = memory_store
    engine._messages.append(
        Message(
            role="user",
            content=[TextBlock(text="Tongji admissions planning")],
        )
    )

    context_msg = await engine._build_memory_context_message_if_needed()

    assert context_msg is not None
    assert "Tongji admissions planning" in context_msg.content[0].text


@pytest.mark.asyncio
async def test_memory_context_is_not_persisted_in_session_messages():
    memory_store = InMemoryMemoryStore()
    await memory_store.add(content="Project architecture report should be concise.")
    engine = _build_engine("Done.")
    engine._config.memory_store = memory_store

    await engine.send_message("Project architecture report")
    await asyncio.sleep(0.1)
    snapshot = await engine.get_snapshot()

    system_texts = [
        block.get("text", "")
        for message in snapshot["last_messages"]
        if message["role"] == "system"
        for block in message["content"]
    ]
    assert not any("Relevant long-term memories" in text for text in system_texts)


@pytest.mark.asyncio
async def test_restore_marks_existing_title_as_generated():
    engine = _build_engine("New generated title")
    await engine._session_store.save(
        engine.session_id,
        [Message(role="user", content=[TextBlock(text="first topic")])],
        metadata={"title": "Original topic"},
    )

    restored = await engine.restore_from_store()

    assert restored is True
    assert engine._title_generated is True


@pytest.mark.asyncio
async def test_title_generation_does_not_overwrite_existing_title():
    engine = _build_engine("New generated title")
    await engine._session_store.save(
        engine.session_id,
        [Message(role="user", content=[TextBlock(text="first topic")])],
        metadata={"title": "Original topic"},
    )

    await engine._generate_title_async("later follow-up")

    record = await engine._session_store.load(engine.session_id)
    assert record is not None
    assert record.metadata["title"] == "Original topic"


@pytest.mark.asyncio
async def test_snapshot_returns_full_visible_history_and_hides_internal_reminders():
    engine = _build_engine("Done.")
    for i in range(25):
        engine._messages.append(
            Message(role="user", content=[TextBlock(text=f"visible {i}")])
        )
    engine._messages.append(
        Message(
            role="user",
            content=[
                TextBlock(
                    text=(
                        "<reminder>Update the visible plan with todo_write "
                        "before continuing.</reminder>"
                    )
                )
            ],
        )
    )

    snapshot = await engine.get_snapshot()
    texts = [
        block.get("text", "")
        for message in snapshot["last_messages"]
        for block in message["content"]
        if block.get("type") == "text"
    ]

    assert len(snapshot["last_messages"]) == 25
    assert texts[0] == "visible 0"
    assert texts[-1] == "visible 24"
    assert not any("Update the visible plan" in text for text in texts)


@pytest.mark.asyncio
async def test_snapshot_hides_internal_loop_detector_message():
    engine = _build_engine("Done.")
    engine._messages.append(
        Message(role="user", content=[TextBlock(text="visible request")])
    )
    engine._messages.append(
        Message(
            role="system",
            content=[
                TextBlock(
                    text=(
                        "<internal>Repeated tool call detected. "
                        "Please reconsider your approach.</internal>"
                    )
                )
            ],
        )
    )

    snapshot = await engine.get_snapshot()
    texts = [
        block.get("text", "")
        for message in snapshot["last_messages"]
        for block in message["content"]
        if block.get("type") == "text"
    ]

    assert "visible request" in texts
    assert not any("Repeated tool call detected" in text for text in texts)


@pytest.mark.asyncio
async def test_snapshot_marks_tool_result_without_followup_as_needing_continuation():
    engine = _build_engine("Done.")
    engine._messages.append(
        Message(
            role="assistant",
            content=[
                ToolCallBlock(
                    tool_call_id="call-needs-continue",
                    tool_name="noop",
                    tool_input={},
                )
            ],
        )
    )
    engine._messages.append(
        Message(
            role="tool",
            content=[
                ToolResultBlock(
                    tool_call_id="call-needs-continue",
                    content="ok",
                )
            ],
        )
    )

    snapshot = await engine.get_snapshot()

    assert snapshot["state"] == "WAITING_INPUT"
    assert snapshot["needs_continuation"] is True


@pytest.mark.asyncio
async def test_continue_if_needed_resumes_after_tool_result_tail():
    engine = _build_engine("Recovered from tool result.")
    engine._messages.extend(
        [
            Message(role="user", content=[TextBlock(text="run tool")]),
            Message(
                role="assistant",
                content=[
                    ToolCallBlock(
                        tool_call_id="call-resume",
                        tool_name="noop",
                        tool_input={},
                    )
                ],
            ),
            Message(
                role="tool",
                content=[
                    ToolResultBlock(
                        tool_call_id="call-resume",
                        tool_name="noop",
                        content="ok",
                    )
                ],
            ),
        ]
    )

    result = await engine.continue_if_needed()
    await asyncio.sleep(0.15)

    snapshot = await engine.get_snapshot()
    assert result["status"] == "started"
    assert snapshot["state"] == "COMPLETED"
    texts = [
        b.get("text", "")
        for m in snapshot["last_messages"]
        for b in m["content"]
        if b.get("type") == "text"
    ]
    assert any("Recovered from tool result." in text for text in texts)
    assert snapshot["needs_continuation"] is False


@pytest.mark.asyncio
async def test_engine_completes_on_text_reply():
    engine = _build_engine("The answer is 42.")
    await engine.send_message("What is the answer?")
    await asyncio.sleep(0.1)  # let the task run
    snapshot = await engine.get_snapshot()
    assert snapshot["state"] == "COMPLETED"
    assert not snapshot["is_running"]
    # Last message should be the assistant reply
    last = snapshot["last_messages"][-1]
    assert last["role"] == "assistant"


@pytest.mark.asyncio
async def test_send_message_recovers_from_error_state():
    engine = _build_engine("Recovered.")
    async with engine._state_lock:
        engine._sm.transition(EngineState.ERROR)
        engine._last_error = "previous failure"

    result = await engine.send_message("continue after error")
    await asyncio.sleep(0.1)

    snapshot = await engine.get_snapshot()
    assert result["status"] == "started"
    assert snapshot["state"] == "COMPLETED"
    assert snapshot["last_error"] == ""
    assert snapshot["last_messages"][-1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_recover_if_possible_resumes_recoverable_error():
    engine = _build_engine("Recovered after protocol repair.")
    async with engine._state_lock:
        engine._sm.transition(EngineState.ERROR)
        engine._last_error = (
            "An assistant message with 'tool_calls' must be followed by "
            "tool messages responding to each tool_call_id."
        )

    result = await engine.recover_if_possible()
    await asyncio.sleep(0.1)

    snapshot = await engine.get_snapshot()
    assert result["status"] == "started"
    assert snapshot["state"] == "COMPLETED"
    assert snapshot["last_error"] == ""
    assert snapshot["last_messages"][-1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_connection_error_is_marked_recoverable():
    engine = _build_engine("Recovered after connection retry.")
    async with engine._state_lock:
        engine._sm.transition(EngineState.ERROR)
        engine._last_error = "Connection error."

    snapshot = await engine.get_snapshot()
    assert snapshot["recoverable_error"] is True

    result = await engine.recover_if_possible()
    await asyncio.sleep(0.1)

    snapshot = await engine.get_snapshot()
    assert result["status"] == "started"
    assert snapshot["state"] == "COMPLETED"
    assert snapshot["last_error"] == ""


@pytest.mark.asyncio
async def test_provider_channel_503_is_marked_recoverable():
    engine = _build_engine("Recovered after provider retry.")
    async with engine._state_lock:
        engine._sm.transition(EngineState.ERROR)
        engine._last_error = (
            "openai.InternalServerError: Error code: 503 - "
            "{'error': {'code': 'model_not_found', "
            "'message': 'No available channel for model gpt-5.4 under group auto'}}"
        )

    snapshot = await engine.get_snapshot()
    assert snapshot["recoverable_error"] is True

    result = await engine.recover_if_possible()
    await asyncio.sleep(0.1)

    snapshot = await engine.get_snapshot()
    assert result["status"] == "started"
    assert snapshot["state"] == "COMPLETED"
    assert snapshot["last_error"] == ""


@pytest.mark.asyncio
async def test_recoverable_error_auto_recovers_without_frontend_trigger():
    llm = _FlakyLLM()
    engine = _build_engine_with_llm(llm)

    await engine.send_message("run a task")
    await asyncio.sleep(0.2)

    snapshot = await engine.get_snapshot()
    assert llm.calls == 2
    assert snapshot["state"] == "COMPLETED"
    assert snapshot["recoverable_error"] is False
    assert snapshot["last_error"] == ""
    assert snapshot["last_messages"][-1]["role"] == "assistant"
    assert "Recovered automatically." in snapshot["last_messages"][-1]["content"][0]["text"]


@pytest.mark.asyncio
async def test_auth_error_is_not_recoverable():
    engine = _build_engine("Should not run.")
    async with engine._state_lock:
        engine._sm.transition(EngineState.ERROR)
        engine._last_error = "Error code: 401 - Unauthorized"

    snapshot = await engine.get_snapshot()
    result = await engine.recover_if_possible()

    assert snapshot["recoverable_error"] is False
    assert result["status"] == "ignored"
    assert result["reason"] == "not_recoverable"


@pytest.mark.asyncio
async def test_engine_cancel():
    class _SlowLLM:
        async def chat(self, messages, tools=None):
            await asyncio.sleep(10)  # blocks until cancelled
            return Message(role="assistant", content=[TextBlock(text="Never")])
        async def stream_chat(self, messages, tools=None, on_token=None):
            return await self.chat(messages, tools)
        async def complete(self, prompt):
            return ""

    session_id = "cancel-test"
    emitter = EventEmitter(session_id)
    llm = _SlowLLM()
    store = MemorySessionStore()
    registry = ToolRegistry()
    overflow = OverflowStore()
    executor = ToolExecutor(registry=registry, overflow=overflow, emitter=emitter)
    compressor = ContextCompressor(summarizer=llm, config=CompressionConfig())
    loop = ReactLoop(
        llm=llm,
        tool_registry=registry,
        tool_executor=executor,
        compressor=compressor,
        emitter=emitter,
        max_rounds=5,
    )
    engine = AgentEngine(
        config=EngineConfig(session_id=session_id),
        loop=loop,
        session_store=store,
        emitter=emitter,
        tool_registry=registry,
    )

    await engine.send_message("Start.")
    await asyncio.sleep(0.05)
    await engine.cancel()
    await asyncio.sleep(0.2)
    snapshot = await engine.get_snapshot()
    # After cancel, engine goes back to WAITING_INPUT (not ERROR)
    assert snapshot["state"] == "WAITING_INPUT"


@pytest.mark.asyncio
async def test_engine_session_reuse():
    engine = _build_engine("Reply.")
    await engine.send_message("First message.")
    await asyncio.sleep(0.1)
    assert (await engine.get_snapshot())["state"] == "COMPLETED"

    await engine.send_message("Second message.")
    await asyncio.sleep(0.1)
    assert (await engine.get_snapshot())["state"] == "COMPLETED"


# ──────────────────────────────────────────────────────────────────────
# Edit-and-regenerate (rewrite_message)
# ──────────────────────────────────────────────────────────────────────


# Reuses the synchronous _seed_messages defined above.


class TestRewriteMessage:
    @pytest.mark.asyncio
    async def test_rewrite_replaces_text_and_preserves_message_id(self):
        engine = _build_engine("Done.")
        # Pre-seed without a system prompt: first message is user A.
        ids = _seed_messages(engine, [
            ("user", "user A message"),
            ("assistant", "assistant A1"),
            ("user", "user B message"),
            ("assistant", "assistant B1"),
        ])
        a_id = ids[0]
        b_id = ids[1]

        result = await engine.rewrite_message(a_id, "user A REWRITTEN")
        assert result["found"] is True
        assert result["busy"] is False
        assert result["is_system"] is False
        assert result["rollback_count"] == 3   # A1, B, B1
        assert result["session_version"] >= 1

        # Memory state: only the rewritten user A survives (no system prompt configured)
        msgs = engine._messages
        assert len(msgs) == 1
        # The user message is the ORIGINAL object — ID preserved
        assert msgs[-1].message_id == a_id
        assert msgs[-1].text_content() == "user A REWRITTEN"

        # Snapshot reflects the same content
        snap = await engine.get_snapshot()
        assert snap["session_version"] == result["session_version"]
        assert snap["last_messages"][-1]["message_id"] == a_id
        assert snap["last_messages"][-1]["content"][0]["text"] == "user A REWRITTEN"
        assert b_id not in {m["message_id"] for m in snap["last_messages"]}

    @pytest.mark.asyncio
    async def test_rewrite_clears_pending_queues(self):
        engine = _build_engine("Done.")
        ids = _seed_messages(engine, [("user", "anchor")])
        # Populate pending states that should be cleared
        async with engine._pending_commands_lock:
            engine._pending_commands.append(_PendingFakeCmd())
        async with engine._pending_spawns_lock:
            engine._pending_spawns.append(_PendingFakeSpawn())
        await engine.rewrite_message(ids[0], "rewritten")
        async with engine._pending_commands_lock:
            assert engine._pending_commands == []
        async with engine._pending_spawns_lock:
            assert engine._pending_spawns == []

    @pytest.mark.asyncio
    async def test_rewrite_unknown_message_id_returns_not_found(self):
        engine = _build_engine("Done.")
        result = await engine.rewrite_message("does-not-exist", "x")
        assert result["found"] is False
        assert result["busy"] is False
        assert result["rollback_count"] == 0
        # session_version unchanged
        assert result["session_version"] == 0

    @pytest.mark.asyncio
    async def test_rewrite_refuses_when_engine_is_running(self):
        """
        Use a slow LLM so send_message keeps engine RUNNING. Then attempt
        to rewrite and verify busy=True and that _messages is unchanged.
        """
        class _SlowLLM:
            async def chat(self, messages, tools=None):
                await asyncio.sleep(10)
                return Message(role="assistant", content=[TextBlock(text="never")])
            async def stream_chat(self, messages, tools=None, on_token=None):
                return await self.chat(messages, tools)
            async def complete(self, prompt):
                return ""

        emitter = EventEmitter("running-rewrite")
        llm = _SlowLLM()
        store = MemorySessionStore()
        registry = ToolRegistry()
        overflow = OverflowStore()
        executor = ToolExecutor(registry=registry, overflow=overflow, emitter=emitter)
        compressor = ContextCompressor(summarizer=llm, config=CompressionConfig())
        loop = ReactLoop(
            llm=llm, tool_registry=registry, tool_executor=executor,
            compressor=compressor, emitter=emitter, max_rounds=2,
        )
        engine = AgentEngine(
            config=EngineConfig(session_id="running-rewrite"),
            loop=loop, session_store=store, emitter=emitter, tool_registry=registry,
        )

        await engine.send_message("go slow")
        await asyncio.sleep(0.05)
        snap = await engine.get_snapshot()
        assert snap["state"] == "RUNNING"

        ids = _seed_messages(engine, [("user", "seeded for rewrite")])
        before_len = len(engine._messages)
        result = await engine.rewrite_message(ids[0], "anything")
        assert result["found"] is True
        assert result["busy"] is True
        assert result["rollback_count"] == 0
        # No rollback should have happened
        assert len(engine._messages) == before_len

        await engine.cancel()

    @pytest.mark.asyncio
    async def test_rewrite_refuses_system_prompt(self):
        engine = _build_engine("Done.", system_prompt="SYS")
        # Seed a user + assistant for context, then point rewrite at idx 0 (system)
        _seed_messages(engine, [
            ("user", "user A"),
            ("assistant", "assistant A1"),
        ])
        system_msg = engine._messages[0]
        assert system_msg.role == "system"
        result = await engine.rewrite_message(system_msg.message_id, "hijack")
        assert result["found"] is True
        assert result["is_system"] is True
        assert result["rollback_count"] == 0
        # System prompt unchanged
        assert engine._messages[0].text_content() == "SYS"
        # All other messages still present
        assert len(engine._messages) == 3

    @pytest.mark.asyncio
    async def test_rewrite_persists_to_session_store(self):
        engine = _build_engine("Done.")
        ids = _seed_messages(engine, [
            ("user", "anchor"),
            ("assistant", "reply1"),
            ("user", "tobedeleted"),
            ("assistant", "reply2"),
        ])
        await engine.rewrite_message(ids[0], "rewritten anchor")
        # Load from the store — session_store persisted
        stored = await engine._session_store.load("test-engine")
        assert stored is not None
        stored_texts = [m.text_content() for m in stored.messages]
        # Only system + rewritten-anchor survive on disk
        assert stored_texts[-1] == "rewritten anchor"
        assert "tobedeleted" not in stored_texts


def _PendingFakeCmd():
    from harness.engine.engine import PendingCommand
    return PendingCommand(
        index=99,
        text="stale",
        submitted_at=0.0,
    )


def _PendingFakeSpawn():
    from harness.engine.engine import PendingSpawn
    return PendingSpawn(
        index=99,
        sub_id="sub_fake",
        task="stale task",
        display_name="stale",
        submitted_at=0.0,
    )
