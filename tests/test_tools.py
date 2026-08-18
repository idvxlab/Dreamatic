"""Tests for the tools layer."""
from __future__ import annotations

import sys
import subprocess
import importlib
import asyncio
import json

import pytest

from harness.tools.registry import ToolRegistry
from harness.tools.executor import ToolExecutor, LIMITS
from harness.tools.overflow import OverflowStore
from harness.tools.builtin.shell import SHELL_SCHEMA, shell_tool
from harness.tools.builtin.read_file import read_file_tool
from harness.tools.builtin.glob_tool import glob_tool
from harness.tools.builtin.write_file import write_file_tool
from harness.tools.builtin.write_json import WRITE_JSON_SCHEMA, write_json_tool
from harness.tools.builtin.edit_file import edit_file_tool
from harness.tools.builtin.web_fetch import web_fetch_tool
from harness.tools.builtin.web_search import web_search_tool
from harness.tools.builtin.think_tool import think_tool
from harness.tools.builtin.create_directory import create_directory_tool
from harness.tools.builtin.list_dir import list_dir_tool
from harness.tools.builtin.todo_tool import make_todo_write_tool, todo_write_tool
from harness.llm.base import LLMConfig
from harness.llm.openai_provider import OpenAIProvider
from harness.types.messages import ToolCallBlock
from harness.types.tools import ToolSchema, ToolParam
from harness.observability.events import EventEmitter


# ──────────────────────────────────────────────────────────────────────
# ToolRegistry
# ──────────────────────────────────────────────────────────────────────

class TestToolRegistry:
    def test_register_and_discover(self):
        reg = ToolRegistry()
        schema = ToolSchema(name="echo", description="Echo", params=[])
        reg.register(schema, lambda: None)
        tools = reg.discover()
        assert len(tools) == 1
        assert tools[0].schema.name == "echo"

    def test_discover_returns_fresh_list(self):
        reg = ToolRegistry()
        schema = ToolSchema(name="echo", description="Echo", params=[])
        reg.register(schema, lambda: None)
        list1 = reg.discover()
        list2 = reg.discover()
        assert list1 is not list2  # not the same object

    def test_unregister(self):
        reg = ToolRegistry()
        schema = ToolSchema(name="echo", description="Echo", params=[])
        reg.register(schema, lambda: None)
        reg.unregister("echo")
        assert reg.get("echo") is None
        assert len(reg.discover()) == 0

    def test_get_unknown_returns_none(self):
        reg = ToolRegistry()
        assert reg.get("nonexistent") is None


def test_openai_tool_schema_includes_array_items():
    provider = OpenAIProvider(LLMConfig(model="gpt-4o", api_key="sk-test"))

    tool = provider._to_openai_tool(SHELL_SCHEMA)

    command_schema = tool["function"]["parameters"]["properties"]["command"]
    assert command_schema["type"] == "array"
    assert command_schema["items"] == {"type": "string"}


def test_openai_tool_schema_includes_object_param():
    provider = OpenAIProvider(LLMConfig(model="gpt-4o", api_key="sk-test"))

    tool = provider._to_openai_tool(WRITE_JSON_SCHEMA)

    data_schema = tool["function"]["parameters"]["properties"]["data"]
    assert data_schema["type"] == "object"


# ──────────────────────────────────────────────────────────────────────
# ToolExecutor
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_executor_runs_tool():
    reg = ToolRegistry()
    schema = ToolSchema(name="greet", description="Greet", params=[
        ToolParam(name="name", type="string", description="Name")
    ])

    async def handler(name: str) -> str:
        return f"Hello, {name}!"

    reg.register(schema, handler)
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [ToolCallBlock(tool_call_id="c1", tool_name="greet", tool_input={"name": "World"})]
    results = await executor.execute_all(calls, round_idx=0)

    assert len(results) == 1
    assert results[0].content == "Hello, World!"
    assert not results[0].is_error


@pytest.mark.asyncio
async def test_executor_handles_unknown_tool():
    reg = ToolRegistry()
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [ToolCallBlock(tool_call_id="c1", tool_name="missing", tool_input={})]
    results = await executor.execute_all(calls, round_idx=0)

    assert results[0].is_error
    assert "not found" in results[0].content


@pytest.mark.asyncio
async def test_executor_returns_error_for_invalid_tool_arguments_without_calling_handler():
    reg = ToolRegistry()
    schema = ToolSchema(name="greet", description="Greet", params=[])
    called = False

    async def handler() -> str:
        nonlocal called
        called = True
        return "should not run"

    reg.register(schema, handler)
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [
        ToolCallBlock(
            tool_call_id="c-bad-json",
            tool_name="greet",
            tool_input={
                "_invalid_tool_arguments": True,
                "_raw": '{"name": "unterminated',
                "_error": "Unterminated string starting at",
            },
        )
    ]
    results = await executor.execute_all(calls, round_idx=0)

    assert not called
    assert results[0].is_error
    assert "invalid JSON arguments" in results[0].content
    assert "Retry this tool call" in results[0].content


@pytest.mark.asyncio
async def test_executor_moves_extra_spawn_agent_context_into_task():
    reg = ToolRegistry()
    schema = ToolSchema(name="spawn_agent", description="Spawn", params=[])
    seen = {}

    async def handler(task: str, agent: str = "") -> str:
        seen["task"] = task
        seen["agent"] = agent
        return "spawned"

    reg.register(schema, handler)
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [
        ToolCallBlock(
            tool_call_id="c1",
            tool_name="spawn_agent",
            tool_input={
                "task": "Research references",
                "agent": "design-research",
                "runDir": ".design-harness/runs/zhujiajiao",
                "runId": "zhujiajiao",
            },
        )
    ]
    results = await executor.execute_all(calls, round_idx=0)

    assert not results[0].is_error
    assert results[0].content == "spawned"
    assert seen["agent"] == "design-research"
    assert "Run dir: .design-harness/runs/zhujiajiao" in seen["task"]
    assert "Run id: zhujiajiao" in seen["task"]
    assert seen["task"].endswith("Research references")


@pytest.mark.asyncio
async def test_executor_overflow():
    reg = ToolRegistry()
    schema = ToolSchema(name="big_output", description="Big", params=[])

    async def handler() -> str:
        return "x" * 100_000  # well over any limit

    reg.register(schema, handler)
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [ToolCallBlock(tool_call_id="c1", tool_name="big_output", tool_input={})]
    results = await executor.execute_all(calls, round_idx=0)

    assert results[0].is_overflow_ref
    assert "ref:" in results[0].content


@pytest.mark.asyncio
async def test_executor_keeps_normal_skill_body_inline():
    reg = ToolRegistry()
    schema = ToolSchema(name="use_skill", description="Load skill", params=[])

    async def handler() -> str:
        return "skill instruction\n" * 600

    reg.register(schema, handler)
    executor = ToolExecutor(
        registry=reg,
        overflow=OverflowStore(),
        emitter=EventEmitter("skill-output"),
    )

    [result] = await executor.execute_all(
        [ToolCallBlock(tool_call_id="skill", tool_name="use_skill", tool_input={})],
        round_idx=0,
    )

    assert result.is_overflow_ref is False
    assert result.content.startswith("skill instruction")


@pytest.mark.asyncio
async def test_partial_config_limits_preserve_skill_defaults():
    reg = ToolRegistry()
    schema = ToolSchema(name="use_skill", description="Load skill", params=[])

    async def handler() -> str:
        return "skill instruction\n" * 600

    reg.register(schema, handler)
    executor = ToolExecutor(
        registry=reg,
        overflow=OverflowStore(),
        emitter=EventEmitter("skill-config-output"),
        limits={"read_file": 100},
    )

    [result] = await executor.execute_all(
        [ToolCallBlock(tool_call_id="skill", tool_name="use_skill", tool_input={})],
        round_idx=0,
    )

    assert result.is_overflow_ref is False
    assert result.content.startswith("skill instruction")


@pytest.mark.asyncio
async def test_executor_tool_exception():
    reg = ToolRegistry()
    schema = ToolSchema(name="fail", description="Fails", params=[])

    async def handler() -> str:
        raise RuntimeError("boom")

    reg.register(schema, handler)
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [ToolCallBlock(tool_call_id="c1", tool_name="fail", tool_input={})]
    results = await executor.execute_all(calls, round_idx=0)

    assert results[0].is_error
    assert "boom" in results[0].content


@pytest.mark.asyncio
async def test_executor_includes_exception_type_when_message_empty():
    reg = ToolRegistry()
    schema = ToolSchema(name="fail_empty", description="Fails", params=[])

    async def handler() -> str:
        raise RuntimeError()

    reg.register(schema, handler)
    emitter = EventEmitter("test")
    overflow = OverflowStore()
    executor = ToolExecutor(registry=reg, overflow=overflow, emitter=emitter)

    calls = [ToolCallBlock(tool_call_id="c1", tool_name="fail_empty", tool_input={})]
    results = await executor.execute_all(calls, round_idx=0)

    assert results[0].is_error
    assert "RuntimeError" in results[0].content


# ──────────────────────────────────────────────────────────────────────
# Builtin tools
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_shell_tool_basic():
    result = await shell_tool(command=["echo", "hello"])
    assert "hello" in result


@pytest.mark.asyncio
async def test_shell_tool_accepts_string():
    result = await shell_tool(command="echo world")
    assert "world" in result


@pytest.mark.asyncio
async def test_shell_tool_timeout():
    result = await shell_tool(
        command=[sys.executable, "-c", "import time; time.sleep(10)"],
        timeout=0.1,
    )
    assert "timed out" in result.lower()


@pytest.mark.asyncio
async def test_shell_tool_falls_back_to_current_python(monkeypatch):
    recorded: dict[str, object] = {}

    class DummyCompleted:
        returncode = 0
        stdout = b"Python test\n"
        stderr = b""

    def fake_run(cmd, **kwargs):
        recorded["cmd"] = list(cmd)
        return DummyCompleted()

    monkeypatch.setattr("harness.tools.builtin.shell.shutil.which", lambda *a, **k: None)
    monkeypatch.setattr(
        "harness.tools.builtin.shell.subprocess.run",
        fake_run,
    )

    result = await shell_tool(command=["python", "--version"])

    assert recorded["cmd"][0] == sys.executable
    assert "Python test" in result


@pytest.mark.asyncio
async def test_powershell_tool_accepts_command_alias(monkeypatch):
    ps_tool_module = importlib.import_module("harness.tools.builtin.powershell_tool")
    from harness.tools.builtin.powershell_tool import powershell_tool

    recorded: dict[str, object] = {}

    class DummyCompleted:
        returncode = 0
        stdout = b"D:\\MyHarnessPy\n"
        stderr = b""

    def fake_run(cmd, **kwargs):
        recorded["cmd"] = list(cmd)
        return DummyCompleted()

    monkeypatch.setattr(ps_tool_module.subprocess, "run", fake_run)

    result = await powershell_tool(command="Get-Location")

    assert "$ErrorActionPreference = 'Stop'" in recorded["cmd"][-1]
    assert "$OutputEncoding = $utf8" in recorded["cmd"][-1]
    assert "Get-Location" in recorded["cmd"][-1]
    assert result.is_error is False
    assert "D:\\MyHarnessPy" in result.content


@pytest.mark.asyncio
async def test_glob_tool_returns_files_only(tmp_path):
    (tmp_path / "actual.py").write_text("print('hello')\n", encoding="utf-8")
    (tmp_path / "folder.py").mkdir()

    result = await glob_tool(pattern="*.py", path=str(tmp_path))

    assert "actual.py" in result
    assert "folder.py" not in result


@pytest.mark.asyncio
async def test_read_file_tool(tmp_path):
    f = tmp_path / "test.txt"
    f.write_text("line1\nline2\nline3\n")
    result = await read_file_tool(path=str(f))
    assert "line1" in result
    assert "line3" in result


@pytest.mark.asyncio
async def test_read_file_tool_not_found():
    result = await read_file_tool(path="/nonexistent/file.txt")
    assert "Error" in result


@pytest.mark.asyncio
async def test_read_file_tool_offset_limit(tmp_path):
    f = tmp_path / "test.txt"
    f.write_text("\n".join(f"line{i}" for i in range(10)) + "\n")
    result = await read_file_tool(path=str(f), offset=2, limit=3)
    assert "line2" in result
    assert "line4" in result
    assert "line5" not in result


# ──────────────────────────────────────────────────────────────────────
# write_file
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_write_file_tool_overwrite(tmp_path):
    f = tmp_path / "hello.txt"
    result = await write_file_tool(path=str(f), content="hello world")
    assert "Written" in result
    assert f.read_text(encoding="utf-8") == "hello world"


@pytest.mark.asyncio
async def test_write_file_tool_append(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("first\n", encoding="utf-8")
    result = await write_file_tool(path=str(f), content="second", append=True)
    assert "Appended" in result
    assert f.read_text(encoding="utf-8") == "first\nsecond"


@pytest.mark.asyncio
async def test_write_file_tool_creates_parent(tmp_path):
    nested = tmp_path / "a" / "b"
    f = nested / "file.txt"
    result = await write_file_tool(path=str(f), content="nested")
    assert "Written" in result
    assert f.read_text(encoding="utf-8") == "nested"


@pytest.mark.asyncio
async def test_write_file_tool_invalid_path():
    # Write to an absolute path that cannot exist on this OS
    result = await write_file_tool(path="NUL:/impossible", content="x")
    assert "Error" in result


# ──────────────────────────────────────────────────────────────────────
# edit_file
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_edit_file_tool_replace(tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("hello world\nwelcome\n", encoding="utf-8")
    result = await edit_file_tool(path=str(f), old_string="world", new_string="there")
    assert "first" in result
    assert f.read_text(encoding="utf-8") == "hello there\nwelcome\n"


@pytest.mark.asyncio
async def test_edit_file_tool_replace_all(tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("foo bar foo baz foo\n", encoding="utf-8")
    result = await edit_file_tool(
        path=str(f), old_string="foo", new_string="FOO", replace_all=True
    )
    assert "all" in result
    assert f.read_text(encoding="utf-8") == "FOO bar FOO baz FOO\n"


@pytest.mark.asyncio
async def test_edit_file_tool_duplicate_without_flag(tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("foo foo foo\n", encoding="utf-8")
    result = await edit_file_tool(path=str(f), old_string="foo", new_string="FOO")
    assert "Error" in result
    assert "appears 3 times" in result


@pytest.mark.asyncio
async def test_edit_file_tool_not_found():
    result = await edit_file_tool(
        path="/nonexistent/file.txt",
        old_string="a",
        new_string="b",
    )
    assert "Error" in result
    assert "not found" in result


@pytest.mark.asyncio
async def test_edit_file_tool_not_matched(tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("hello world\n", encoding="utf-8")
    result = await edit_file_tool(path=str(f), old_string="not exist", new_string="X")
    assert "Error" in result
    assert "not found" in result


# ──────────────────────────────────────────────────────────────────────
# think_tool
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_think_tool_returns_thought():
    result = await think_tool(thought="Let me think step by step.")
    assert result == "Let me think step by step."


@pytest.mark.asyncio
async def test_think_tool_empty():
    result = await think_tool(thought="")
    assert result == ""


# ──────────────────────────────────────────────────────────────────────
# todo_write
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_todo_write_set():
    result = await todo_write_tool(
        session_id="s1",
        action="set",
        todos=[{"content": "task 1", "status": "pending"}],
    )
    assert "set with 1 item" in result


@pytest.mark.asyncio
async def test_todo_write_set_replaces_current_plan():
    await todo_write_tool(
        session_id="replace-plan",
        action="set",
        todos=[
            {"content": "old task", "status": "in_progress"},
            {"content": "old follow-up", "status": "pending"},
        ],
    )

    await todo_write_tool(
        session_id="replace-plan",
        action="set",
        todos=[{"content": "new detailed task", "status": "in_progress"}],
    )

    result = await todo_write_tool(session_id="replace-plan", action="get")
    assert "new detailed task" in result
    assert "old task" not in result
    assert "old follow-up" not in result


@pytest.mark.asyncio
async def test_todo_write_rejects_multiple_in_progress_on_set():
    result = await todo_write_tool(
        session_id="multi-progress",
        action="set",
        todos=[
            {"content": "task 1", "status": "in_progress"},
            {"content": "task 2", "status": "in_progress"},
        ],
    )
    assert "only one todo item may be in_progress" in result


@pytest.mark.asyncio
async def test_todo_write_get():
    await todo_write_tool(
        session_id="s2",
        action="set",
        todos=[
            {"content": "alpha", "status": "pending"},
            {"content": "beta", "status": "in_progress"},
        ],
    )
    result = await todo_write_tool(session_id="s2", action="get")
    assert "[pending]" in result
    assert "[in_progress]" in result
    assert "alpha" in result
    assert "beta" in result


@pytest.mark.asyncio
async def test_todo_write_update():
    await todo_write_tool(
        session_id="s3",
        action="set",
        todos=[{"content": "task", "status": "pending"}],
    )
    result = await todo_write_tool(
        session_id="s3", action="update", index=0, status="completed"
    )
    assert "completed" in result


@pytest.mark.asyncio
async def test_todo_write_rejects_second_in_progress_on_update():
    await todo_write_tool(
        session_id="second-progress",
        action="set",
        todos=[
            {"content": "task 1", "status": "in_progress"},
            {"content": "task 2", "status": "pending"},
        ],
    )
    result = await todo_write_tool(
        session_id="second-progress",
        action="update",
        index=1,
        status="in_progress",
    )
    assert "Item [0] is already in_progress" in result


@pytest.mark.asyncio
async def test_todo_write_update_invalid_status():
    await todo_write_tool(
        session_id="s4",
        action="set",
        todos=[{"content": "task", "status": "pending"}],
    )
    result = await todo_write_tool(
        session_id="s4", action="update", index=0, status="done"
    )
    assert "Error" in result
    assert "done" in result


@pytest.mark.asyncio
async def test_todo_write_get_empty():
    result = await todo_write_tool(session_id="nonexistent", action="get")
    assert "No todo" in result


@pytest.mark.asyncio
async def test_todo_write_persists_plan_state():
    from harness.storage.backends.memory import MemorySessionStore

    store = MemorySessionStore()
    await todo_write_tool(
        session_id="persisted-plan",
        action="set",
        todos=[{"content": "persist me", "status": "in_progress"}],
        session_store=store,
    )

    record = await store.load("persisted-plan")
    assert record is not None
    plan = record.metadata["plan_state"]
    assert plan["session_id"] == "persisted-plan"
    assert plan["status"] == "in_progress"
    assert plan["items"][0]["content"] == "persist me"

    result = await todo_write_tool(
        session_id="persisted-plan",
        action="get",
        session_store=store,
    )
    assert "persist me" in result
    assert "[in_progress]" in result


@pytest.mark.asyncio
async def test_todo_write_persists_to_plan_store():
    from harness.storage.backends.memory import InMemoryPlanStore, MemorySessionStore

    session_store = MemorySessionStore()
    plan_store = InMemoryPlanStore()
    await todo_write_tool(
        session_id="plan-store-session",
        action="set",
        todos=[{"content": "store as plan item", "status": "in_progress"}],
        session_store=session_store,
        plan_store=plan_store,
    )

    plan = await plan_store.load_by_session("plan-store-session")
    assert plan is not None
    assert plan.status == "in_progress"
    assert plan.items[0].content == "store as plan item"

    await todo_write_tool(
        session_id="plan-store-session",
        action="update",
        index=0,
        status="completed",
        session_store=session_store,
        plan_store=plan_store,
    )
    plan = await plan_store.load_by_session("plan-store-session")
    assert plan is not None
    assert plan.status == "completed"
    assert plan.items[0].status == "completed"


@pytest.mark.asyncio
async def test_bound_todo_write_uses_current_session_id():
    from harness.storage.backends.memory import InMemoryPlanStore, MemorySessionStore

    session_store = MemorySessionStore()
    plan_store = InMemoryPlanStore()
    tool = make_todo_write_tool(
        session_store,
        plan_store,
        bound_session_id="current-session",
    )

    await tool(
        session_id="tongji_a",
        action="set",
        todos=[{"content": "keep plan on the active session", "status": "pending"}],
    )

    current_plan = await plan_store.load_by_session("current-session")
    wrong_plan = await plan_store.load_by_session("tongji_a")
    wrong_record = await session_store.load("tongji_a")
    assert current_plan is not None
    assert current_plan.items[0].content == "keep plan on the active session"
    assert wrong_plan is None
    assert wrong_record is None


@pytest.mark.asyncio
async def test_bound_todo_write_does_not_require_session_id_argument():
    from harness.storage.backends.memory import InMemoryPlanStore, MemorySessionStore

    session_store = MemorySessionStore()
    plan_store = InMemoryPlanStore()
    tool = make_todo_write_tool(
        session_store,
        plan_store,
        bound_session_id="current-session",
    )

    await tool(
        action="set",
        todos=[{"content": "plan without exposed session id", "status": "pending"}],
    )

    current_plan = await plan_store.load_by_session("current-session")
    assert current_plan is not None
    assert current_plan.items[0].content == "plan without exposed session id"


@pytest.mark.asyncio
async def test_memory_tool_add_search_delete():
    from harness.storage.backends.memory import InMemoryMemoryStore
    from harness.tools.builtin.memory_tool import make_memory_tool

    tool = make_memory_tool(InMemoryMemoryStore())
    added = await tool(
        action="add",
        content="Remember that tests should avoid external network calls.",
        tags=["testing"],
        session_id="s-memory",
    )
    assert "mem_" in added
    assert "s-memory" in added

    found = await tool(action="search", query="external network", tags=["testing"])
    assert "tests should avoid" in found

    import json

    entry_id = json.loads(added)["entry_id"]
    deleted = await tool(action="delete", entry_id=entry_id)
    assert deleted == "Deleted."


@pytest.mark.asyncio
async def test_background_task_start_and_status():
    from harness.tools.builtin.background_task import background_task_tool

    started = await background_task_tool(
        action="start",
        command=[
            sys.executable,
            "-c",
            "print('background-ok')",
        ],
        timeout=10,
    )
    assert "Background task bg_" in started
    task_id = started.split("Background task ", 1)[1].split(" ", 1)[0]

    status = ""
    for _ in range(100):
        status = await background_task_tool(action="status", task_id=task_id)
        if "output:\nbackground-ok" in status:
            break
        await asyncio.sleep(0.05)

    assert "status: completed" in status
    assert "background-ok" in status


# ──────────────────────────────────────────────────────────────────────
# web_fetch (mock-free: just smoke-test it doesn't crash)
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_web_fetch_smoke():
    result = await web_fetch_tool(url="https://httpbin.org/html", max_length=500)
    # Should not be an error; content should be plain text
    assert "Error" not in result or len(result) < 200


@pytest.mark.asyncio
async def test_web_fetch_truncation():
    result = await web_fetch_tool(url="https://httpbin.org/bytes/1000", max_length=100)
    assert "truncated" in result.lower()
    assert len(result) <= 150  # rough check


@pytest.mark.asyncio
async def test_web_fetch_invalid_url():
    result = await web_fetch_tool(url="https://this-domain-does-not-exist-xyz.invalid/")
    assert "Error" in result


# ──────────────────────────────────────────────────────────────────────
# web_search (mock-free: just smoke-test it doesn't crash)
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_web_search_smoke():
    result = await web_search_tool(query="python httpx", max_results=3)
    # Should always return a string — results, "No results", or a graceful error message
    assert isinstance(result, str) and len(result) > 0

@pytest.mark.asyncio
async def test_create_directory_and_list_dir(tmp_path):
    nested = tmp_path / "demo" / "static"

    created = await create_directory_tool(str(nested))
    listed = await list_dir_tool(str(tmp_path), recursive=True)

    assert "Created directory" in created
    assert "demo/static" in listed.replace("\\", "/")


@pytest.mark.asyncio
async def test_write_json_tool_writes_nested_unicode_object(tmp_path):
    f = tmp_path / "plan" / "design_plan.json"
    payload = {
        "runId": "zhujiajiao-merchandise-system",
        "target_audience": {
            "primary": "古镇游客与文化消费人群",
            "tone_keywords": ["地域文化感", "收藏感"],
        },
        "deliverables": [
            {"id": "poster", "file": "artifacts/generated-images/poster.png"},
        ],
    }

    result = await write_json_tool(path=str(f), data=payload)

    assert "Written JSON object" in result
    assert json.loads(f.read_text(encoding="utf-8")) == payload
    assert "古镇游客" in f.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_powershell_tool_returns_structured_error(monkeypatch):
    ps_tool_module = importlib.import_module("harness.tools.builtin.powershell_tool")
    from harness.tools.builtin.powershell_tool import powershell_tool

    class DummyCompleted:
        returncode = 1
        stdout = "开始处理\n".encode("utf-8")
        stderr = "参数错误\n".encode("utf-8")

    monkeypatch.setattr(
        ps_tool_module.subprocess,
        "run",
        lambda *args, **kwargs: DummyCompleted(),
    )

    result = await powershell_tool(script="Write-Error 'bad'; Set-Content later.txt x")

    assert result.is_error is True
    assert "开始处理" in result.content
    assert "参数错误" in result.content
    assert "[exit code: 1]" in result.content
