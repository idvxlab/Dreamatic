from __future__ import annotations

import asyncio
import json

import pytest

from harness.observability.events import EventEmitter
from harness.tools.builtin.tool_output import make_read_tool_output_tool
from harness.tools.executor import ToolExecutor
from harness.tools.overflow import OverflowStore
from harness.tools.registry import ToolRegistry
from harness.types.messages import ToolCallBlock
from harness.types.tools import ToolExecutionResult, ToolSchema


@pytest.mark.asyncio
async def test_executor_propagates_structured_tool_error():
    registry = ToolRegistry()

    async def fail_command():
        return ToolExecutionResult("command failed", is_error=True)

    registry.register(
        ToolSchema(name="structured_fail", description="test", params=[]),
        fail_command,
    )
    executor = ToolExecutor(
        registry=registry,
        overflow=OverflowStore(),
        emitter=EventEmitter("structured-error-test"),
    )

    [result] = await executor.execute_all(
        [
            ToolCallBlock(
                tool_call_id="structured-error",
                tool_name="structured_fail",
                tool_input={},
            )
        ],
        round_idx=0,
    )

    assert result.is_error is True
    assert result.content == "command failed"


@pytest.mark.asyncio
async def test_executor_serializes_todo_writes_in_one_batch():
    registry = ToolRegistry()
    active = 0
    max_active = 0
    events: list[str] = []

    async def record_todo(action: str):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        events.append(f"start:{action}")
        await asyncio.sleep(0.01)
        events.append(f"end:{action}")
        active -= 1
        return action

    registry.register(
        ToolSchema(name="todo_write", description="test", params=[]),
        record_todo,
    )
    executor = ToolExecutor(
        registry=registry,
        overflow=OverflowStore(),
        emitter=EventEmitter("serialized-todo-test"),
    )

    results = await executor.execute_all(
        [
            ToolCallBlock(
                tool_call_id="complete-current",
                tool_name="todo_write",
                tool_input={"action": "complete"},
            ),
            ToolCallBlock(
                tool_call_id="start-next",
                tool_name="todo_write",
                tool_input={"action": "start"},
            ),
        ],
        round_idx=0,
    )

    assert max_active == 1
    assert events == [
        "start:complete",
        "end:complete",
        "start:start",
        "end:start",
    ]
    assert [result.content for result in results] == ["complete", "start"]


@pytest.mark.asyncio
async def test_read_tool_output_pages_stored_overflow():
    store = OverflowStore()
    ref_id = await store.store("abcdefghij")
    read_output = make_read_tool_output_tool(store)

    first = json.loads(await read_output(ref_id, offset=0, limit=4))
    second = json.loads(
        await read_output(ref_id, offset=first["next_offset"], limit=10)
    )

    assert first == {
        "ok": True,
        "ref_id": ref_id,
        "offset": 0,
        "next_offset": 4,
        "done": False,
        "total_characters": 10,
        "content": "abcd",
    }
    assert second["content"] == "efghij"
    assert second["done"] is True


@pytest.mark.asyncio
async def test_read_tool_output_reports_expired_reference():
    read_output = make_read_tool_output_tool(OverflowStore())

    payload = json.loads(await read_output("missing"))

    assert payload["ok"] is False
    assert "expired" in payload["error"]


@pytest.mark.asyncio
async def test_real_powershell_stops_after_error_and_preserves_utf8(tmp_path):
    import shutil

    from harness.tools.builtin.powershell_tool import powershell_tool

    if not (shutil.which("pwsh.exe") or shutil.which("powershell.exe") or shutil.which("pwsh")):
        pytest.skip("PowerShell is not installed")

    marker = tmp_path / "must-not-exist.txt"
    failed = await powershell_tool(
        script=(
            "Write-Output '中文输出'; "
            "Write-Error 'stop here'; "
            f"Set-Content -LiteralPath '{marker}' -Value 'unsafe'"
        )
    )

    assert failed.is_error is True
    assert "中文输出" in failed.content
    assert not marker.exists()


@pytest.mark.asyncio
async def test_powershell_rejects_bash_heredoc_before_execution(monkeypatch):
    module = __import__(
        "harness.tools.builtin.powershell_tool",
        fromlist=["powershell_tool"],
    )

    def unexpected_run(*args, **kwargs):
        raise AssertionError("unsupported Bash syntax must not reach PowerShell")

    monkeypatch.setattr(module.subprocess, "run", unexpected_run)
    result = await module.powershell_tool(
        script="python - <<'PY'\nprint('hello')\nPY"
    )

    assert result.is_error is True
    assert "Bash heredoc" in result.content

@pytest.mark.asyncio
async def test_real_pwsh_native_failure_stops_and_preserves_diagnostics(
    tmp_path, monkeypatch
):
    import importlib
    import shutil
    import sys

    module = importlib.import_module("harness.tools.builtin.powershell_tool")
    executable = shutil.which("pwsh.exe") or shutil.which("pwsh")
    if not executable:
        pytest.skip("PowerShell 7 is required for native-command fail-fast semantics")

    monkeypatch.setattr(module, "_find_powershell", lambda: executable)
    marker = tmp_path / "native-failure-must-stop.txt"
    python = sys.executable.replace("'", "''")
    result = await module.powershell_tool(
        script=(
            f"& '{python}' -c \"import sys; "
            "print('validator detail', file=sys.stderr); sys.exit(7)\"; "
            f"Set-Content -LiteralPath '{marker}' -Value 'unsafe'"
        )
    )

    assert result.is_error is True
    assert "validator detail" in result.content
    assert not marker.exists()


@pytest.mark.asyncio
async def test_real_powershell_best_effort_mode_continues_but_reports_error(tmp_path):
    import shutil

    from harness.tools.builtin.powershell_tool import powershell_tool

    if not (shutil.which("pwsh.exe") or shutil.which("powershell.exe") or shutil.which("pwsh")):
        pytest.skip("PowerShell is not installed")

    marker = tmp_path / "best-effort-continued.txt"
    result = await powershell_tool(
        script=(
            "Write-Error 'expected probe failure'; "
            f"Set-Content -LiteralPath '{marker}' -Value 'continued'"
        ),
        stopOnError=False,
    )

    assert marker.exists()
    assert result.is_error is True
    assert "expected probe failure" in result.content

@pytest.mark.asyncio
async def test_executor_overflow_can_be_read_back_through_registered_tool():
    store = OverflowStore()
    registry = ToolRegistry()

    async def large_output():
        return "0123456789" * 20

    registry.register(
        ToolSchema(name="large_output", description="test", params=[]),
        large_output,
    )
    from harness.tools.builtin.tool_output import READ_TOOL_OUTPUT_SCHEMA

    registry.register(READ_TOOL_OUTPUT_SCHEMA, make_read_tool_output_tool(store))
    executor = ToolExecutor(
        registry=registry,
        overflow=store,
        emitter=EventEmitter("overflow-round-trip"),
        limits={"large_output": 40, "read_tool_output": 1000},
    )

    [overflowed] = await executor.execute_all(
        [ToolCallBlock(tool_call_id="large", tool_name="large_output", tool_input={})],
        round_idx=0,
    )
    ref_id = overflowed.content.split("ref:", 1)[1].rstrip("]")
    [recovered] = await executor.execute_all(
        [
            ToolCallBlock(
                tool_call_id="read",
                tool_name="read_tool_output",
                tool_input={"ref_id": ref_id, "offset": 0, "limit": 200},
            )
        ],
        round_idx=1,
    )

    payload = json.loads(recovered.content)
    assert overflowed.is_overflow_ref is True
    assert recovered.is_overflow_ref is False
    assert payload["content"] == "0123456789" * 20
    assert payload["done"] is True
