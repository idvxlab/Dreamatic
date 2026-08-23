"""
spawn_agent / spawn_agents built-in tools.

spawn_agent  — create ONE sub-agent, run it to completion, return its response.
spawn_agents — create MULTIPLE sub-agents in parallel, return all responses.

Design notes:
  - Handler factories (make_*) accept runtime deps as closure args to avoid
    carrying them through the ToolRegistry (which stores plain async callables).
  - `from harness.factory import build_engine` is a lazy import inside the
    handler body to break the spawn_agent.py ↔ factory.py circular import.
  - MAX_SPAWN_DEPTH prevents infinite recursion: depth 0 = top-level agent,
    depth 3 = deepest allowed child. Exceeding returns an error string.
"""
from __future__ import annotations

import asyncio
import re
import uuid
from typing import TYPE_CHECKING

from harness.types.tools import ToolSchema, ToolParam

if TYPE_CHECKING:
    from harness.config import HarnessConfig, ProviderConfig
    from harness.storage.memory_store import MemoryStore
    from harness.storage.plan_store import PlanStore
    from harness.storage.session import SessionStore

MAX_SPAWN_DEPTH = 3

SPAWN_AGENT_SCHEMA = ToolSchema(
    name="spawn_agent",
    description=(
        "Create a sub-agent to handle a specific subtask. The sub-agent runs to "
        "completion and returns its final response. Use this to delegate a focused "
        "piece of work to a specialised agent with an optional custom system prompt "
        "and tool set."
    ),
    params=[
        ToolParam(
            name="agent",
            type="string",
            description="Optional registered agent profile name, e.g. builder, planner, reviewer, debugger, or docs-writer.",
            required=False,
        ),
        ToolParam(
            name="task",
            type="string",
            description="The task or goal for the sub-agent.",
        ),
        ToolParam(
            name="plan_item_id",
            type="string",
            description="Optional parent plan item id this sub-agent is assigned to.",
            required=False,
        ),
        ToolParam(
            name="system_prompt",
            type="string",
            description="Optional system prompt override for the sub-agent.",
            required=False,
        ),
        ToolParam(
            name="tools",
            type="array",
            description=(
                "Tool names to give the sub-agent. "
                "Omit to inherit the parent's global config."
            ),
            required=False,
            items={"type": "string"},
        ),
    ],
)

SPAWN_AGENTS_SCHEMA = ToolSchema(
    name="spawn_agents",
    description=(
        "Run multiple sub-agents in parallel. Each agent receives its own task and "
        "runs independently. All results are returned together once every agent "
        "finishes. Use this to parallelise independent subtasks."
    ),
    params=[
        ToolParam(
            name="agents",
            type="array",
            description=(
                "List of agent configurations. "
                "Each item: {task: str, agent?: str, plan_item_id?: str, system_prompt?: str, tools?: list[str]}"
            ),
            required=True,
            items={"type": "object"},
        ),
    ],
)


def _make_display_name(task: str) -> str:
    """
    Generate a short readable display name from a task description.

    Rules (in priority order):
    1. Extract first 4-16 Chinese characters if present.
    2. Fallback: first 4-16 word-characters.
    3. Ultimate fallback: first 12 bytes of the task.
    """
    task = task.strip()
    if not task:
        return "子代理"

    # Try Chinese characters first (4-16 chars)
    cn_match = re.search(r'[\u4e00-\u9fff]{4,16}', task)
    if cn_match:
        name = cn_match.group()
        # Remove leading verbs that make it sound like an action
        name = re.sub(r'^(请|帮我|给我|请帮|请给|要|需要|应该|请将|将)\s*', '', name).strip()
        if 2 <= len(name) <= 20:
            return name

    # Try a meaningful English phrase (4-16 word chars, may include spaces)
    # Look for a natural phrase by splitting on punctuation and taking first chunk
    chunks = re.split(r'[，。！？、；：\n]', task)
    chunk = chunks[0].strip() if chunks else task
    # Remove leading action words
    chunk = re.sub(
        r'^(Please|Can you|Could you|Help me|I need|I want|I want you to|Please help|Please do|Please make|Please create|Please write|Please fix|Please analyze|Please review|Please implement|Please check|Please search|Please find|Please read|Please list|Please show|Please tell|Please explain|Please give|Please provide)\s*',
        '', chunk, flags=re.IGNORECASE
    ).strip()
    if 2 <= len(chunk) <= 20:
        return chunk

    # Ultimate fallback
    return task[:12].rstrip() or "子代理"


def _inject_display_name(
    engine_registry: dict | None,
    sub_id: str,
    display_name: str,
    task: str,
) -> None:
    """
    Inject display_name into the session store metadata for the sub-agent.
    Also store it in engine_registry if available.
    """
    if engine_registry is not None and sub_id in engine_registry:
        engine_registry[sub_id]._config.spawn_depth  # ensure engine exists
        # We'll store display_name in the session store metadata directly
        # since AgentEngine doesn't have a display_name field yet
    # The actual metadata write happens after build_engine, see below


def _check_spawn_permission(parent_agent_id: str, target_agent: str) -> str:
    if not parent_agent_id:
        return ""
    try:
        from harness.agents import load_agent_profile  # noqa: PLC0415

        profile = load_agent_profile(parent_agent_id)
    except Exception:
        return ""
    if not profile.can_spawn:
        return f"Error: agent '{parent_agent_id}' is not allowed to spawn sub-agents."
    allowlist = profile.spawn_allowlist
    if allowlist is not None:
        if not target_agent:
            return (
                f"Error: agent '{parent_agent_id}' must choose one of its "
                f"allowed child agents: {allowlist}."
            )
        if target_agent not in allowlist:
            return (
                f"Error: agent '{parent_agent_id}' cannot spawn agent "
                f"'{target_agent}'. Allowed: {allowlist}."
            )
    return ""


def _augment_task_with_extra_context(task: str, extra: dict) -> str:
    """Move accidental top-level spawn parameters into the child task text."""
    if not extra:
        return task
    labels = {
        "runDir": "Run dir",
        "runId": "Run id",
        "finalDir": "Final dir",
        "run_dir": "Run dir",
        "run_id": "Run id",
        "final_dir": "Final dir",
    }
    lines: list[str] = []
    for key, label in labels.items():
        value = extra.get(key)
        if value not in (None, ""):
            lines.append(f"{label}: {value}")
    for key, value in extra.items():
        if key in labels or value in (None, ""):
            continue
        lines.append(f"{key}: {value}")
    if not lines:
        return task
    return "\n".join(lines + ["", task])


async def _inherited_run_id(session_store: "SessionStore", parent_session_id: str) -> str:
    if not parent_session_id:
        return ""
    try:
        parent = await session_store.load(parent_session_id)
    except Exception:
        return ""
    if not parent or not isinstance(parent.metadata, dict):
        return ""
    return str(parent.metadata.get("active_run_id") or "")


def make_spawn_agent_tool(
    harness_cfg: "HarnessConfig",
    provider_cfg: "ProviderConfig",
    session_store: "SessionStore",
    spawn_depth: int = 0,
    engine_registry: "dict | None" = None,
    parent_session_id: str = "",
    parent_agent_id: str = "",
    parent_approval_mode: str = "ask",
    memory_store: "MemoryStore | None" = None,
    plan_store: "PlanStore | None" = None,
):
    """Return a spawn_agent handler closed over the given runtime dependencies."""

    async def spawn_agent_tool(
        task: str,
        agent: str = "",
        plan_item_id: str = "",
        system_prompt: str = "",
        tools: list[str] | None = None,
        **extra,
    ) -> str:
        # Lazy import breaks the spawn_agent.py ↔ factory.py circular dependency
        from harness.factory import build_engine  # noqa: PLC0415
        from harness.agents import load_agent_profile  # noqa: PLC0415

        if spawn_depth >= MAX_SPAWN_DEPTH:
            return (
                f"Error: maximum agent spawn depth ({MAX_SPAWN_DEPTH}) reached. "
                "Cannot create further sub-agents."
            )
        permission_error = _check_spawn_permission(parent_agent_id, (agent or "").strip())
        if permission_error:
            return permission_error

        sub_id = f"sub_{uuid.uuid4().hex[:8]}"
        display_name = _make_display_name(task)
        child_task = _augment_task_with_extra_context(task, extra)
        try:
            profile_name = (agent or "").strip()
            child_provider_cfg = provider_cfg
            child_system_prompt = system_prompt
            child_tools = tools
            child_approval_mode = parent_approval_mode
            if profile_name:
                try:
                    profile = load_agent_profile(profile_name)
                except ValueError as exc:
                    return f"[Sub-agent {sub_id} | {display_name}]\nError: {exc}"
                if not child_system_prompt:
                    child_system_prompt = profile.system_prompt
                # A registered profile owns its executable tool contract.
                # Parent-provided `tools` is easy for the model to misuse as a
                # partial list, which can silently remove required tools from a
                # specialised child such as design-designer. For registered
                # agents, always use the profile allowlist.
                child_tools = profile.allowed_tools
                if profile.provider and profile.provider in harness_cfg.providers:
                    child_provider_cfg = harness_cfg.providers[profile.provider]
                if profile.default_approval_mode:
                    child_approval_mode = profile.default_approval_mode

            sub_engine = build_engine(
                session_id=sub_id,
                provider_cfg=child_provider_cfg,
                harness_cfg=harness_cfg,
                session_store=session_store,
                system_prompt=child_system_prompt,
                allowed_tools=child_tools,        # None → inherit global config
                spawn_depth=spawn_depth + 1,
                engine_registry=engine_registry,
                provider_name=profile_name or child_provider_cfg.name,
                agent_id=profile_name,
                approval_mode=child_approval_mode,
                memory_store=memory_store,
                plan_store=plan_store,
            )
            if engine_registry is not None:
                engine_registry[sub_id] = sub_engine

            # Persist display_name into session store metadata
            try:
                meta: dict = {}
                existing = await session_store.load(sub_id)
                if existing and isinstance(existing.metadata, dict):
                    meta = dict(existing.metadata)
                meta["display_name"] = display_name
                meta["spawn_depth"] = spawn_depth + 1
                if profile_name:
                    meta["persona"] = profile_name
                if plan_item_id:
                    meta["plan_item_id"] = plan_item_id
                if parent_session_id:
                    meta["parent_session_id"] = parent_session_id
                active_run_id = await _inherited_run_id(session_store, parent_session_id)
                if active_run_id:
                    meta["active_run_id"] = active_run_id
                await session_store.save(sub_id, [], metadata=meta)
            except Exception:
                pass
            if parent_session_id and plan_item_id and plan_store is not None:
                try:
                    parent_plan = await plan_store.load_by_session(parent_session_id)
                    if parent_plan is not None:
                        await plan_store.bind_item(
                            parent_plan.plan_id,
                            plan_item_id,
                            assigned_session_id=sub_id,
                        )
                except Exception:
                    pass

            parent = (
                engine_registry.get(parent_session_id)
                if parent_session_id and engine_registry else None
            )
            spawn_index: int | None = None
            if parent is not None:
                try:
                    spawn_index = await parent.register_pending_spawn(
                        task=child_task, sub_id=sub_id, display_name=display_name,
                    )
                except Exception:
                    pass
            try:
                result = await sub_engine.run_to_completion(child_task, parent_engine=parent)
            except Exception as exc:
                result = f"Error: {exc}"
            return f"[Sub-agent {sub_id} | {display_name}]\n{result}"
        except Exception as exc:
            return f"[Sub-agent {sub_id} | {display_name}]\nError: {exc}"

    return spawn_agent_tool


def make_spawn_agents_tool(
    harness_cfg: "HarnessConfig",
    provider_cfg: "ProviderConfig",
    session_store: "SessionStore",
    spawn_depth: int = 0,
    engine_registry: "dict | None" = None,
    parent_session_id: str = "",
    parent_agent_id: str = "",
    parent_approval_mode: str = "ask",
    memory_store: "MemoryStore | None" = None,
    plan_store: "PlanStore | None" = None,
):
    """Return a spawn_agents handler closed over the given runtime dependencies."""

    async def spawn_agents_tool(agents: list[dict]) -> str:
        from harness.factory import build_engine  # noqa: PLC0415
        from harness.agents import load_agent_profile  # noqa: PLC0415

        if spawn_depth >= MAX_SPAWN_DEPTH:
            return (
                f"Error: maximum agent spawn depth ({MAX_SPAWN_DEPTH}) reached. "
                "Cannot create further sub-agents."
            )
        if not agents:
            return "Error: agents list is empty."
        for cfg in agents:
            target_agent = str(cfg.get("agent", "") or "").strip()
            permission_error = _check_spawn_permission(parent_agent_id, target_agent)
            if permission_error:
                return permission_error

        async def run_one(cfg: dict) -> str:
            sub_id = f"sub_{uuid.uuid4().hex[:8]}"
            task = cfg.get("task", "")
            extra = {
                k: v for k, v in cfg.items()
                if k not in {"task", "agent", "plan_item_id", "system_prompt", "tools"}
            }
            child_task = _augment_task_with_extra_context(task, extra)
            plan_item_id = str(cfg.get("plan_item_id", "") or "").strip()
            display_name = _make_display_name(task)
            profile_name = str(cfg.get("agent", "") or "").strip()
            child_provider_cfg = provider_cfg
            child_system_prompt = cfg.get("system_prompt", "")
            child_tools = cfg.get("tools")
            child_approval_mode = parent_approval_mode
            if profile_name:
                try:
                    profile = load_agent_profile(profile_name)
                except ValueError as exc:
                    return f"[Sub-agent {sub_id} | {display_name}]\nError: {exc}"
                if not child_system_prompt:
                    child_system_prompt = profile.system_prompt
                # A registered profile owns its executable tool contract.
                # Parent-provided `tools` is easy for the model to misuse as a
                # partial list, which can silently remove required tools from a
                # specialised child such as design-designer. For registered
                # agents, always use the profile allowlist.
                child_tools = profile.allowed_tools
                if profile.provider and profile.provider in harness_cfg.providers:
                    child_provider_cfg = harness_cfg.providers[profile.provider]
                if profile.default_approval_mode:
                    child_approval_mode = profile.default_approval_mode
            sub_engine = build_engine(
                session_id=sub_id,
                provider_cfg=child_provider_cfg,
                harness_cfg=harness_cfg,
                session_store=session_store,
                system_prompt=child_system_prompt,
                allowed_tools=child_tools,
                spawn_depth=spawn_depth + 1,
                engine_registry=engine_registry,
                provider_name=profile_name or child_provider_cfg.name,
                agent_id=profile_name,
                approval_mode=child_approval_mode,
                memory_store=memory_store,
                plan_store=plan_store,
            )
            if engine_registry is not None:
                engine_registry[sub_id] = sub_engine

            # Persist display_name into session store metadata
            try:
                meta: dict = {}
                existing = await session_store.load(sub_id)
                if existing and isinstance(existing.metadata, dict):
                    meta = dict(existing.metadata)
                meta["display_name"] = display_name
                meta["spawn_depth"] = spawn_depth + 1
                if profile_name:
                    meta["persona"] = profile_name
                if plan_item_id:
                    meta["plan_item_id"] = plan_item_id
                if parent_session_id:
                    meta["parent_session_id"] = parent_session_id
                active_run_id = await _inherited_run_id(session_store, parent_session_id)
                if active_run_id:
                    meta["active_run_id"] = active_run_id
                await session_store.save(sub_id, [], metadata=meta)
            except Exception:
                pass
            if parent_session_id and plan_item_id and plan_store is not None:
                try:
                    parent_plan = await plan_store.load_by_session(parent_session_id)
                    if parent_plan is not None:
                        await plan_store.bind_item(
                            parent_plan.plan_id,
                            plan_item_id,
                            assigned_session_id=sub_id,
                        )
                except Exception:
                    pass

            parent = (
                engine_registry.get(parent_session_id)
                if parent_session_id and engine_registry else None
            )
            spawn_index: int | None = None
            if parent is not None:
                try:
                    spawn_index = await parent.register_pending_spawn(
                        task=child_task, sub_id=sub_id, display_name=display_name,
                    )
                except Exception:
                    pass
            try:
                result = await sub_engine.run_to_completion(child_task, parent_engine=parent)
            except Exception as exc:
                result = f"Error: {exc}"
            return f"[Sub-agent {sub_id} | {display_name}]\n{result}"

        results = await asyncio.gather(*[run_one(cfg) for cfg in agents])
        return "\n\n---\n\n".join(results)

    return spawn_agents_tool
