"""Tests for spawn_agent / spawn_agents tools and AgentEngine.run_to_completion()."""
from __future__ import annotations

import asyncio
import pytest

from harness.agents import AgentProfile
from harness.engine.engine import AgentEngine, EngineConfig
from harness.engine.loop import ReactLoop
from harness.engine.compression import CompressionConfig, ContextCompressor
from harness.engine.state_machine import EngineState
from harness.observability.events import EventEmitter
from harness.storage.backends.memory import MemorySessionStore
from harness.storage.backends.memory import InMemoryPlanStore
from harness.storage.plan_store import PlanItem, PlanState
from harness.tools.executor import ToolExecutor
from harness.tools.overflow import OverflowStore
from harness.tools.registry import ToolRegistry
from harness.tools.builtin.spawn_agent import (
    MAX_SPAWN_DEPTH,
    make_spawn_agent_tool,
    make_spawn_agents_tool,
)
from harness.types.messages import Message, TextBlock, ToolCallBlock, ToolResultBlock


# ── Shared mock helpers ────────────────────────────────────────────────────────

class _MockLLM:
    """Returns a configurable fixed text reply with no tool calls."""
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


def _build_engine(
    reply_text: str = "Done.",
    session_id: str = "test",
    max_rounds: int = 50,
) -> AgentEngine:
    emitter = EventEmitter(session_id)
    llm = _MockLLM(reply_text)
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
    return AgentEngine(
        config=EngineConfig(session_id=session_id, max_rounds=max_rounds),
        loop=loop,
        session_store=store,
        emitter=emitter,
        tool_registry=registry,
    )


# ── run_to_completion() ────────────────────────────────────────────────────────

class TestRunToCompletion:
    @pytest.mark.asyncio
    async def test_returns_last_assistant_text(self):
        engine = _build_engine("The answer is 42.")
        result = await engine.run_to_completion("What is the answer?")
        assert result == "The answer is 42."

    @pytest.mark.asyncio
    async def test_engine_reaches_completed_state(self):
        engine = _build_engine("Done.")
        await engine.run_to_completion("Go.")
        snap = await engine.get_snapshot()
        assert snap["state"] == "COMPLETED"
        assert not snap["is_running"]

    @pytest.mark.asyncio
    async def test_messages_contain_user_and_assistant(self):
        engine = _build_engine("Hi!")
        await engine.run_to_completion("Hello")
        snap = await engine.get_snapshot()
        roles = [m["role"] for m in snap["last_messages"]]
        assert "user" in roles
        assert "assistant" in roles

    @pytest.mark.asyncio
    async def test_no_response_fallback(self):
        """Engine that returns empty text → fallback string."""
        engine = _build_engine("")
        result = await engine.run_to_completion("ping")
        assert "模型连续返回空内容" in result

    @pytest.mark.asyncio
    async def test_recoverable_error_auto_recovers_inline(self, monkeypatch):
        """Sub-agent run_to_completion recovers without opening the child session."""
        engine = _build_engine("unused")
        async def no_sleep():
            return None

        monkeypatch.setattr(engine, "_sleep_before_subagent_recovery", no_sleep)
        calls = 0

        async def fake_guarded():
            nonlocal calls
            calls += 1
            if calls == 1:
                engine._last_error = "Connection error."
                async with engine._state_lock:
                    engine._sm.transition(EngineState.ERROR)
                return
            engine._messages.append(
                Message(role="assistant", content=[TextBlock(text="Recovered.")])
            )
            async with engine._state_lock:
                engine._sm.transition(EngineState.COMPLETED)

        engine._run_loop_guarded = fake_guarded

        result = await engine.run_to_completion("ping")

        assert result == "Recovered."
        assert calls == 2

    @pytest.mark.asyncio
    async def test_network_recoverable_error_retries_beyond_two_attempts(self, monkeypatch):
        """Network failures should keep retrying instead of returning early to the parent."""
        engine = _build_engine("unused")

        async def no_sleep():
            return None

        monkeypatch.setattr(engine, "_sleep_before_subagent_recovery", no_sleep)
        calls = 0

        async def fake_guarded():
            nonlocal calls
            calls += 1
            if calls <= 3:
                engine._last_error = "httpx.RemoteProtocolError: peer closed connection without sending complete message body (incomplete chunked read)"
                async with engine._state_lock:
                    engine._sm.transition(EngineState.ERROR)
                return
            engine._messages.append(
                Message(role="assistant", content=[TextBlock(text="Recovered after repeated network errors.")])
            )
            async with engine._state_lock:
                engine._sm.transition(EngineState.COMPLETED)

        engine._run_loop_guarded = fake_guarded

        result = await engine.run_to_completion("ping")

        assert result == "Recovered after repeated network errors."
        assert calls == 4

    @pytest.mark.asyncio
    async def test_tool_tail_auto_continues_inline(self):
        """Sub-agent run_to_completion continues after tool results without opening it."""
        engine = _build_engine("unused")
        calls = 0

        async def fake_guarded():
            nonlocal calls
            calls += 1
            if calls == 1:
                engine._messages.append(
                    Message(
                        role="assistant",
                        content=[
                            ToolCallBlock(
                                tool_call_id="call-1",
                                tool_name="read_file",
                                tool_input={"path": "README.md"},
                            )
                        ],
                    )
                )
                engine._messages.append(
                    Message(
                        role="tool",
                        content=[
                            ToolResultBlock(
                                tool_call_id="call-1",
                                tool_name="read_file",
                                content="file contents",
                                is_error=False,
                            )
                        ],
                    )
                )
                async with engine._state_lock:
                    engine._sm.transition(EngineState.WAITING_INPUT)
                return
            engine._messages.append(
                Message(role="assistant", content=[TextBlock(text="Finished after tool.")])
            )
            async with engine._state_lock:
                engine._sm.transition(EngineState.COMPLETED)

        engine._run_loop_guarded = fake_guarded

        result = await engine.run_to_completion("ping")

        assert result == "Finished after tool."
        assert calls == 2

    @pytest.mark.asyncio
    async def test_tool_tail_continues_beyond_four_inline_cycles(self):
        """Long sub-agent tasks should not be mistaken for completion after four batches."""
        engine = _build_engine("unused", max_rounds=20)
        calls = 0

        async def fake_guarded():
            nonlocal calls
            calls += 1
            if calls <= 6:
                call_id = f"call-{calls}"
                engine._messages.append(
                    Message(
                        role="assistant",
                        content=[
                            TextBlock(text=f"Intermediate batch {calls}."),
                            ToolCallBlock(
                                tool_call_id=call_id,
                                tool_name="read_file",
                                tool_input={"path": f"file-{calls}.md"},
                            ),
                        ],
                    )
                )
                engine._messages.append(
                    Message(
                        role="tool",
                        content=[
                            ToolResultBlock(
                                tool_call_id=call_id,
                                tool_name="read_file",
                                content=f"contents {calls}",
                                is_error=False,
                            )
                        ],
                    )
                )
                async with engine._state_lock:
                    engine._sm.transition(EngineState.WAITING_INPUT)
                return
            engine._messages.append(
                Message(role="assistant", content=[TextBlock(text="Finished after long tool chain.")])
            )
            async with engine._state_lock:
                engine._sm.transition(EngineState.COMPLETED)

        engine._run_loop_guarded = fake_guarded

        result = await engine.run_to_completion("ping")

        assert result == "Finished after long tool chain."
        assert calls == 7

    @pytest.mark.asyncio
    async def test_incomplete_subagent_does_not_return_no_response_or_clear_pending(self):
        """An incomplete child must remain pending and report an explicit error."""
        parent = _build_engine("parent", session_id="parent-session")
        engine = _build_engine("unused", session_id="child-session", max_rounds=1)
        await parent.register_pending_spawn(
            task="child task",
            sub_id="child-session",
            display_name="child",
        )

        async def fake_guarded():
            engine._messages.append(
                Message(
                    role="assistant",
                    content=[
                        ToolCallBlock(
                            tool_call_id="call-stuck",
                            tool_name="read_file",
                            tool_input={"path": "README.md"},
                        )
                    ],
                )
            )
            engine._messages.append(
                Message(
                    role="tool",
                    content=[
                        ToolResultBlock(
                            tool_call_id="call-stuck",
                            tool_name="read_file",
                            content="file contents",
                            is_error=False,
                        )
                    ],
                )
            )
            async with engine._state_lock:
                engine._sm.transition(EngineState.WAITING_INPUT)

        engine._run_loop_guarded = fake_guarded

        result = await engine.run_to_completion("ping", parent_engine=parent)
        parent_snap = await parent.get_snapshot()

        assert result.startswith("Error: sub-agent child-session did not complete")
        assert "(no response)" not in result
        assert any(ps["sub_id"] == "child-session" for ps in parent_snap["pending_spawns"])

    @pytest.mark.asyncio
    async def test_can_reuse_after_completion(self):
        """run_to_completion on a fresh engine; state machine should allow it."""
        engine = _build_engine("First.")
        r1 = await engine.run_to_completion("First task")
        assert r1 == "First."
        # Reuse: state goes COMPLETED → WAITING_INPUT → RUNNING via send_message
        await engine.send_message("Second task")
        await asyncio.sleep(0.05)
        snap = await engine.get_snapshot()
        assert snap["state"] == "COMPLETED"

    @pytest.mark.asyncio
    async def test_run_to_completion_can_continue_after_completion(self):
        engine = _build_engine("First.")
        assert await engine.run_to_completion("First task") == "First."
        engine._loop._llm = _MockLLM("Second.")
        assert await engine.run_to_completion("Continue") == "Second."


# ── spawn_agent tool ───────────────────────────────────────────────────────────

class _FakeHarnessCfg:
    """Minimal stand-in for HarnessConfig used by spawn tool factories."""
    class compression:
        token_window = 128_000
        auto_trigger_ratio = 0.65
        micro_keep_recent = 6
        summary_provider = ""

    class engine:
        max_rounds = 5

    class tools:
        enabled = None
        limits: dict = {}

    providers: dict = {}
    mcp_servers: dict = {}


class _FakeProviderCfg:
    name = "openai-compatible"
    model = "mock"
    api_key = ""
    base_url = ""
    timeout = 10.0
    max_tokens = 256
    temperature = 0.0
    extra: dict = {}


def _make_mock_build_engine(reply_text: str):
    """Return a build_engine replacement that always uses _MockLLM."""
    def _build(session_id, provider_cfg, harness_cfg, session_store,
                system_prompt="", allowed_tools=None, registry=None,
                spawn_depth=0, engine_registry=None, **kwargs):
        return _build_engine(reply_text=reply_text, session_id=session_id)
    return _build


class TestSpawnAgentTool:
    @pytest.mark.asyncio
    async def test_returns_sub_agent_response(self, monkeypatch):
        """spawn_agent_tool runs a sub-engine and returns its text."""
        import harness.tools.builtin.spawn_agent as sa_mod
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("Sub result."),
        )
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )
        result = await tool(task="Do something")
        assert "Sub result." in result
        assert "Sub-agent" in result

    @pytest.mark.asyncio
    async def test_can_spawn_registered_agent_profile(self, monkeypatch):
        """spawn_agent can create a child from an AgentProfile/persona name."""
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("Planner result."),
        )
        store = MemorySessionStore()
        registry = {}
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=store,
            spawn_depth=0,
            engine_registry=registry,
        )

        result = await tool(task="Plan the work", agent="planner")
        assert "Planner result." in result
        sub_id = next(iter(registry))
        record = await store.load(sub_id)
        assert record is not None
        assert record.metadata["persona"] == "planner"

    @pytest.mark.asyncio
    async def test_parent_agent_can_disable_spawning(self, monkeypatch):
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("Should not run."),
        )

        def fake_load_profile(agent_id: str) -> AgentProfile:
            if agent_id == "locked":
                return AgentProfile(agent_id="locked", name="locked", can_spawn=False)
            return AgentProfile(agent_id=agent_id, name=agent_id)

        monkeypatch.setattr("harness.agents.load_agent_profile", fake_load_profile)
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
            parent_agent_id="locked",
        )

        result = await tool(task="Try to spawn", agent="planner")

        assert "not allowed to spawn" in result

    @pytest.mark.asyncio
    async def test_parent_agent_spawn_allowlist_is_enforced(self, monkeypatch):
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("Should not run."),
        )

        def fake_load_profile(agent_id: str) -> AgentProfile:
            if agent_id == "manager":
                return AgentProfile(
                    agent_id="manager",
                    name="manager",
                    spawn_allowlist=["planner"],
                )
            return AgentProfile(agent_id=agent_id, name=agent_id)

        monkeypatch.setattr("harness.agents.load_agent_profile", fake_load_profile)
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
            parent_agent_id="manager",
        )

        result = await tool(task="Try to spawn", agent="builder")

        assert "cannot spawn agent 'builder'" in result
        assert "planner" in result

    @pytest.mark.asyncio
    async def test_child_profile_default_approval_mode_is_applied(self, monkeypatch):
        captured: dict = {}

        def capture_build_engine(**kwargs):
            captured.update(kwargs)
            return _build_engine(reply_text="ok", session_id=kwargs["session_id"])

        def fake_load_profile(agent_id: str) -> AgentProfile:
            if agent_id == "planner":
                return AgentProfile(
                    agent_id="planner",
                    name="planner",
                    default_approval_mode="auto",
                )
            return AgentProfile(agent_id=agent_id, name=agent_id)

        monkeypatch.setattr("harness.factory.build_engine", capture_build_engine)
        monkeypatch.setattr("harness.agents.load_agent_profile", fake_load_profile)
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
            parent_approval_mode="ask",
        )

        result = await tool(task="Plan the work", agent="planner")

        assert "ok" in result
        assert captured["agent_id"] == "planner"
        assert captured["approval_mode"] == "auto"

    @pytest.mark.asyncio
    async def test_registered_profile_tools_are_not_truncated_by_parent_tools(self, monkeypatch):
        captured: dict = {}

        def capture_build_engine(**kwargs):
            captured.update(kwargs)
            return _build_engine(reply_text="ok", session_id=kwargs["session_id"])

        def fake_load_profile(agent_id: str) -> AgentProfile:
            if agent_id == "design-designer":
                return AgentProfile(
                    agent_id="design-designer",
                    name="design-designer",
                    allowed_tools=[
                        "read_file",
                        "write_file",
                        "image_generate",
                        "image_edit",
                        "artifact_lint",
                    ],
                )
            return AgentProfile(agent_id=agent_id, name=agent_id)

        monkeypatch.setattr("harness.factory.build_engine", capture_build_engine)
        monkeypatch.setattr("harness.agents.load_agent_profile", fake_load_profile)
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )

        result = await tool(
            task="Create artifacts",
            agent="design-designer",
            tools=["read_file", "write_file"],
        )

        assert "ok" in result
        assert captured["allowed_tools"] == [
            "read_file",
            "write_file",
            "image_generate",
            "image_edit",
            "artifact_lint",
        ]

    @pytest.mark.asyncio
    async def test_spawn_agent_moves_extra_run_context_into_task(self, monkeypatch):
        seen: dict = {}

        async def fake_run_to_completion(self_engine, task, **kwargs):
            seen["task"] = task
            return "ok"

        monkeypatch.setattr(AgentEngine, "run_to_completion", fake_run_to_completion)
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("ignored"),
        )
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )

        result = await tool(
            task="Do the research",
            agent="planner",
            runDir=".design-harness/runs/test",
            runId="test",
            finalDir="outputs/runs/test/final",
        )

        assert "ok" in result
        assert "Run dir: .design-harness/runs/test" in seen["task"]
        assert "Run id: test" in seen["task"]
        assert "Final dir: outputs/runs/test/final" in seen["task"]
        assert seen["task"].endswith("Do the research")

    @pytest.mark.asyncio
    async def test_spawn_agent_binds_parent_plan_item(self, monkeypatch):
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("Bound result."),
        )
        store = MemorySessionStore()
        plan_store = InMemoryPlanStore()
        await plan_store.save_plan(
            PlanState(
                plan_id="plan-parent",
                session_id="parent-session",
                items=[PlanItem(item_id="item-1", content="Delegate this")],
            )
        )
        registry = {}
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=store,
            spawn_depth=0,
            engine_registry=registry,
            parent_session_id="parent-session",
            plan_store=plan_store,
        )

        result = await tool(task="Delegate this", plan_item_id="item-1")
        assert "Bound result." in result
        sub_id = next(iter(registry))
        record = await store.load(sub_id)
        assert record is not None
        assert record.metadata["plan_item_id"] == "item-1"

        parent_plan = await plan_store.load_by_session("parent-session")
        assert parent_plan is not None
        assert parent_plan.items[0].assigned_session_id == sub_id

    @pytest.mark.asyncio
    async def test_depth_limit_returns_error_string(self):
        """At MAX_SPAWN_DEPTH, returns an error string instead of spawning."""
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=MAX_SPAWN_DEPTH,  # already at limit
        )
        result = await tool(task="Should not run")
        assert "maximum" in result.lower()
        assert "depth" in result.lower()

    @pytest.mark.asyncio
    async def test_sub_agent_exception_returns_error_string(self, monkeypatch):
        """If sub-engine raises, the tool returns an error string (never raises)."""
        def _failing_build(**kwargs):
            raise RuntimeError("provider down")

        monkeypatch.setattr("harness.factory.build_engine", _failing_build)
        tool = make_spawn_agent_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )
        result = await tool(task="Will fail")
        assert "Error:" in result


# ── spawn_agents tool ──────────────────────────────────────────────────────────

class TestSpawnAgentsTool:
    @pytest.mark.asyncio
    async def test_parallel_results_all_present(self, monkeypatch):
        """All sub-agent results appear in the combined output."""
        call_count = 0

        async def _fake_run_to_completion(self_engine, task, **kwargs):
            nonlocal call_count
            call_count += 1
            return f"result_for_{task}"

        monkeypatch.setattr(AgentEngine, "run_to_completion", _fake_run_to_completion)
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("ignored"),
        )
        tool = make_spawn_agents_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )
        result = await tool(agents=[
            {"task": "alpha"},
            {"task": "beta"},
            {"task": "gamma"},
        ])
        assert call_count == 3
        assert "result_for_alpha" in result
        assert "result_for_beta" in result
        assert "result_for_gamma" in result

    @pytest.mark.asyncio
    async def test_empty_agents_list_returns_error(self):
        tool = make_spawn_agents_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )
        result = await tool(agents=[])
        assert result.startswith("Error:")

    @pytest.mark.asyncio
    async def test_depth_limit_returns_error_string(self):
        tool = make_spawn_agents_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=MAX_SPAWN_DEPTH,
        )
        result = await tool(agents=[{"task": "nope"}])
        assert "maximum" in result.lower()

    @pytest.mark.asyncio
    async def test_results_separated_by_divider(self, monkeypatch):
        """Multiple results are joined with the '---' divider."""
        async def _fake_run(self_engine, task):
            return f"answer:{task}"

        monkeypatch.setattr(AgentEngine, "run_to_completion", _fake_run)
        monkeypatch.setattr(
            "harness.factory.build_engine",
            _make_mock_build_engine("ignored"),
        )
        tool = make_spawn_agents_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )
        result = await tool(agents=[{"task": "A"}, {"task": "B"}])
        assert "---" in result

    @pytest.mark.asyncio
    async def test_registered_profile_tools_are_not_truncated_in_parallel_spawn(self, monkeypatch):
        captured: list[dict] = []

        async def _fake_run(self_engine, task, **kwargs):
            return f"answer:{task}"

        def capture_build_engine(**kwargs):
            captured.append(dict(kwargs))
            return _build_engine(reply_text="ignored", session_id=kwargs["session_id"])

        def fake_load_profile(agent_id: str) -> AgentProfile:
            if agent_id == "design-designer":
                return AgentProfile(
                    agent_id="design-designer",
                    name="design-designer",
                    allowed_tools=["read_file", "image_generate", "artifact_lint"],
                )
            return AgentProfile(agent_id=agent_id, name=agent_id)

        monkeypatch.setattr(AgentEngine, "run_to_completion", _fake_run)
        monkeypatch.setattr("harness.factory.build_engine", capture_build_engine)
        monkeypatch.setattr("harness.agents.load_agent_profile", fake_load_profile)
        tool = make_spawn_agents_tool(
            harness_cfg=_FakeHarnessCfg(),
            provider_cfg=_FakeProviderCfg(),
            session_store=MemorySessionStore(),
            spawn_depth=0,
        )

        result = await tool(agents=[
            {
                "task": "design",
                "agent": "design-designer",
                "tools": ["read_file"],
            }
        ])

        assert "answer:design" in result
        assert captured[0]["allowed_tools"] == [
            "read_file",
            "image_generate",
            "artifact_lint",
        ]
