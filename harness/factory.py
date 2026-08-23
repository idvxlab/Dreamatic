"""
Engine factory — single source of truth for building an AgentEngine.

Both cli.py and api/rest.py import build_engine() from here.
To add a new tool, register it in ALL_TOOLS and add it to config.yaml tools.enabled.

MCP Support
-----------
Use ``build_engine_with_mcp()`` (async) when config.yaml has ``mcp_servers``
defined.  It returns ``(AgentEngine, list[MCPClient])``; callers are responsible
for calling ``await client.close()`` on each MCPClient when done.
"""
from __future__ import annotations

import asyncio
import json

import logging
from pathlib import Path

from harness.config import HarnessConfig, ProviderConfig
from harness.engine.compression import CompressionConfig, ContextCompressor
from harness.engine.engine import AgentEngine, EngineConfig
from harness.engine.loop import ReactLoop
from harness.engine.prompt_cache import PromptCache
from harness.hooks import HookManager
from harness.llm.registry import build_provider
from harness.observability.events import EventEmitter
from harness.skills import list_skills, build_skill_system_addendum
from harness.storage.session import SessionStore
from harness.storage.memory_store import MemoryStore
from harness.storage.plan_store import PlanStore
from harness.storage.backends.memory import InMemoryMemoryStore, InMemoryPlanStore
from harness.tools.builtin import (
    READ_FILE_SCHEMA, read_file_tool,
    SEARCH_SCHEMA, search_tool,
    SHELL_SCHEMA, shell_tool,
    USE_SKILL_SCHEMA, use_skill_tool,
    LIST_SKILLS_SCHEMA, list_skills_tool,
    GLOB_SCHEMA, glob_tool,
    GREP_SCHEMA, grep_tool,
    POWERSHELL_SCHEMA, powershell_tool,
    WRITE_FILE_SCHEMA, write_file_tool,
    WRITE_JSON_SCHEMA, write_json_tool,
    CREATE_DIRECTORY_SCHEMA, create_directory_tool,
    LIST_DIR_SCHEMA, list_dir_tool,
    EDIT_FILE_SCHEMA, edit_file_tool,
    WEB_FETCH_SCHEMA, web_fetch_tool,
    WEB_SEARCH_SCHEMA, web_search_tool,
    THINK_SCHEMA, think_tool,
    MEMORY_SCHEMA, make_memory_tool,
    TODO_WRITE_SCHEMA, todo_write_tool, make_todo_write_tool,
    BACKGROUND_TASK_SCHEMA, background_task_tool,
    IMAGE_GENERATE_SCHEMA, image_generate_tool,
    IMAGE_EDIT_SCHEMA, image_edit_tool,
    VIDEO_GENERATE_SCHEMA, video_generate_tool,
    RUN_INIT_SCHEMA, run_init_tool,
    DESIGN_BUS_POST_SCHEMA, design_bus_post_tool,
    DESIGN_BUS_READ_SCHEMA, design_bus_read_tool,
    RESEARCH_FETCH_SCHEMA, research_fetch_tool,
    RESEARCH_ASSET_DISCOVER_SCHEMA, research_asset_discover_tool,
    RESEARCH_ASSET_FETCH_SCHEMA, research_asset_fetch_tool,
    RESEARCH_ASSET_VALIDATE_SCHEMA, research_asset_validate_tool,
    ARTIFACT_LINT_SCHEMA, artifact_lint_tool,
    EXPORT_PACKAGE_SCHEMA, export_package_tool,
    HUNYUAN3D_SCHEMA, hunyuan3d_tool,
)
from harness.tools.executor import ToolExecutor
from harness.tools.overflow import OverflowStore
from harness.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)


async def _bind_run_to_session_tree(
    session_store: SessionStore,
    engine_registry: dict | None,
    session_id: str,
    run_id: str,
) -> None:
    """Persist a run binding on the creating session and all of its parents."""
    current_id = session_id
    visited: set[str] = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        record = await session_store.load(current_id)
        metadata = dict(record.metadata) if record and isinstance(record.metadata, dict) else {}
        metadata["active_run_id"] = run_id
        messages = record.messages if record else []
        await session_store.save(current_id, messages, metadata=metadata)
        if engine_registry is not None:
            engine = engine_registry.get(current_id)
            if engine is not None:
                await engine._emit_event({
                    "type": "canvas.run_bound",
                    "data": {"runId": run_id, "sourceSessionId": session_id},
                })
        current_id = str(metadata.get("parent_session_id") or "")


def _make_bound_run_init_tool(
    session_store: SessionStore,
    engine_registry: dict | None,
    session_id: str,
):
    async def bound_run_init_tool(**kwargs) -> str:
        result = await run_init_tool(**kwargs)
        try:
            payload = json.loads(result)
        except (TypeError, json.JSONDecodeError):
            return result
        run_id = str(payload.get("runId") or "").strip()
        if payload.get("ok") is not False and run_id:
            await _bind_run_to_session_tree(
                session_store, engine_registry, session_id, run_id
            )
        return result

    return bound_run_init_tool

# ── Question-mode prompt blocks (module-level so the engine can re-stamp
# the system message at runtime when the user toggles question_mode). ──────

QUESTION_INSTRUCTIONS = (
    "\n\n## Question Mode (STRUCTURED clarification only)\n"
    "Question Mode is ENABLED. When you need to clarify the user's intent, "
    "you MUST use the `ask_user` tool. Plain-text questions (numbered lists, "
    "markdown with A/B/C/D, or sentences like '请告诉我网站的目标是…') are "
    "FORBIDDEN in this mode — the frontend will not render them as clickable "
    "options. Only a real `ask_user` tool call produces the question UI.\n\n"
    "### When you MUST call `ask_user`\n"
    "- The user request is broad / open-ended (e.g. '帮我设计一个网站', "
    "'build me a project', '写个 app') and at least one critical "
    "constraint is missing.\n"
    "- A decision is irreversible or expensive to undo and the user "
    "would clearly prefer to pick the option themselves.\n"
    "- You need 2-5 distinct values from a known option set.\n\n"
    "### When you must NOT call `ask_user`\n"
    "- The user request is already concrete. Just do the work.\n"
    "- You can reasonably default the unknown values. State the assumption.\n"
    "- You already asked once this turn. (At most one clarification round.)\n\n"
    "### Tool contract\n"
    "```\n"
    'ask_user(questions: list[QuestionPrompt]) -> InterruptibleToolResult\n'
    "```\n"
    "  - Each QuestionPrompt has: `question` (text), `header` (short title), "
    "`options` (2-5 items, each `{label, description}`), `multiple` (bool), "
    "`custom` (bool — allow free-text).\n"
    "  - The tool returns IMMEDIATELY. The run loop pauses at the engine level.\n"
    "  - When the user picks options in the UI, the engine feeds you a normal "
    "tool_result with their answers. You then continue the real task.\n\n"
    "### Call format (full example)\n"
    "{\n"
    '  "questions": [\n'
    "    {\n"
    '      "header": "网站目标",\n'
    '      "question": "网站的主要用途是什么？",\n'
    '      "options": [\n'
    '        {"label": "展示公司信息", "description": "企业官网、品牌介绍、团队展示"},\n'
    '        {"label": "提供在线服务", "description": "适合预约、咨询、SaaS"},\n'
    '        {"label": "销售产品",     "description": "电商、商品、支付"},\n'
    '        {"label": "作品/案例展示", "description": "作品集、设计案例"}\n'
    "      ],\n"
    '      "multiple": false,\n'
    '      "custom": true\n'
    "    },\n"
    "    {\n"
    '      "header": "核心功能",\n'
    '      "question": "你希望包含哪些功能？",\n'
    '      "options": [\n'
    '        {"label": "首页"},\n'
    '        {"label": "关于我们"},\n'
    '        {"label": "产品/服务展示"},\n'
    '        {"label": "联系表单"},\n'
    '        {"label": "登录/注册"},\n'
    '        {"label": "在线支付"}\n'
    "      ],\n"
    '      "multiple": true,\n'
    '      "custom": true\n'
    "    }\n"
    "  ]\n"
    "}\n\n"
    "### Hard rules (violations break the UI)\n"
    "  1. NEVER output clarification questions as plain assistant text. "
    "No '1. ... 2. ... 3. ...' lists. No 'A. xxx  B. xxx' markdown. "
    "No '请告诉我…' sentences. The UI only renders tool-call payloads.\n"
    "  2. When the request is broad, your FIRST turn response must include "
    "an `ask_user` tool call. Do not write a preamble text before calling — "
    "go straight to the tool call.\n"
    "  3. Each option needs a short `description` (1-2 lines). Mark the "
    "recommended option by prefixing its description with 'Recommended'.\n"
    "  4. 1-5 questions per call. 2-5 options per question. Don't ask "
    "trivial things — only what materially changes the plan.\n"
    "  5. After the user answers, NEVER ask again unless a brand-new "
    "ambiguity appears. Proceed with their answers.\n"
)

NOQUESTION_INSTRUCTIONS = (
    "\n\n## Direct Execution Mode (no question mode)\n"
    "This session is in direct execution mode. Do NOT proactively ask the user questions.\n"
    "For any uncertainty, make reasonable default assumptions and explicitly state them in your final answer.\n"
    "The `ask_user` tool is not available in this mode.\n"
)


# Central tool registry — add new tools here only
ALL_TOOLS: dict[str, tuple] = {
    "read_file":   (READ_FILE_SCHEMA,   read_file_tool),
    "write_file":  (WRITE_FILE_SCHEMA,  write_file_tool),
    "write_json":  (WRITE_JSON_SCHEMA,  write_json_tool),
    "edit_file":   (EDIT_FILE_SCHEMA,   edit_file_tool),
    "search":      (SEARCH_SCHEMA,      search_tool),
    "shell":       (SHELL_SCHEMA,       shell_tool),
    "glob":        (GLOB_SCHEMA,        glob_tool),
    "grep":        (GREP_SCHEMA,        grep_tool),
    "powershell":  (POWERSHELL_SCHEMA,  powershell_tool),
    "web_fetch":   (WEB_FETCH_SCHEMA,   web_fetch_tool),
    "web_search":  (WEB_SEARCH_SCHEMA,  web_search_tool),
    "create_directory": (CREATE_DIRECTORY_SCHEMA, create_directory_tool),
    "list_dir":    (LIST_DIR_SCHEMA,    list_dir_tool),
    "think":       (THINK_SCHEMA,       think_tool),
    "memory":      (MEMORY_SCHEMA,      None),
    "todo_write":  (TODO_WRITE_SCHEMA,  todo_write_tool),
    "background_task": (BACKGROUND_TASK_SCHEMA, background_task_tool),
    "image_generate": (IMAGE_GENERATE_SCHEMA, image_generate_tool),
    "image_edit": (IMAGE_EDIT_SCHEMA, image_edit_tool),
    "video_generate": (VIDEO_GENERATE_SCHEMA, video_generate_tool),
    "hunyuan3d": (HUNYUAN3D_SCHEMA, hunyuan3d_tool),
    "run_init": (RUN_INIT_SCHEMA, run_init_tool),
    "design_bus_post": (DESIGN_BUS_POST_SCHEMA, design_bus_post_tool),
    "design_bus_read": (DESIGN_BUS_READ_SCHEMA, design_bus_read_tool),
    "research_fetch": (RESEARCH_FETCH_SCHEMA, research_fetch_tool),
    "research_asset_discover": (RESEARCH_ASSET_DISCOVER_SCHEMA, research_asset_discover_tool),
    "research_asset_fetch": (RESEARCH_ASSET_FETCH_SCHEMA, research_asset_fetch_tool),
    "research_asset_validate": (RESEARCH_ASSET_VALIDATE_SCHEMA, research_asset_validate_tool),
    "artifact_lint": (ARTIFACT_LINT_SCHEMA, artifact_lint_tool),
    "export_package": (EXPORT_PACKAGE_SCHEMA, export_package_tool),
}


def build_engine(
    session_id: str,
    provider_cfg: ProviderConfig,
    harness_cfg: HarnessConfig,
    session_store: SessionStore,
    system_prompt: str = "",
    allowed_tools: list[str] | None = None,
    registry: ToolRegistry | None = None,
    spawn_depth: int = 0,
    engine_registry: dict | None = None,
    provider_name: str = "",
    agent_id: str = "",
    question_mode: str = "noquestion",
    approval_mode: str = "ask",
    memory_store: MemoryStore | None = None,
    plan_store: PlanStore | None = None,
) -> AgentEngine:
    """
    Build a fully wired AgentEngine for a session.

    Args:
        session_id:    Unique session identifier.
        provider_cfg:  LLM provider config (model, api_key, etc.).
        harness_cfg:   Global harness config (compression, tools, engine settings).
        session_store: Where to persist messages (MemorySessionStore or SQLiteSessionStore).
        system_prompt: Base system prompt. Skill descriptions are appended automatically.
        allowed_tools: Persona-level tool whitelist. None means use global config.
        registry:      Pre-built ToolRegistry (e.g. pre-populated with MCP tools).
                       When None, a fresh registry is created from ALL_TOOLS.
        spawn_depth:   Current agent nesting depth (0 = top-level). Used to limit
                       recursive sub-agent creation via spawn_agent/spawn_agents.
        question_mode: "question" enables the ask_user clarification tool and adds
                       clarifying instructions to the system prompt. "noquestion"
                       (default) means proceed with reasonable defaults.
    """
    emitter = EventEmitter(session_id)
    if memory_store is None:
        memory_store = InMemoryMemoryStore()
    if plan_store is None:
        plan_store = InMemoryPlanStore()
    llm = build_provider(provider_cfg)

    comp = harness_cfg.compression
    summarizer = (
        build_provider(harness_cfg.providers[comp.summary_provider])
        if comp.summary_provider and comp.summary_provider in harness_cfg.providers
        else llm
    )

    skills = list_skills()

    # Require step-by-step reasoning before each tool call (like extended thinking)
    _REASONING_INSTRUCTIONS = (
        "\n\n## 逐步推理（必须遵守）\n"
        "在每次调用任何工具之前，**必须**先调用 `think` 工具写出你的推理过程，包括：\n"
        "1. 当前状态：我现在知道什么？\n"
        "2. 需要什么：完成任务需要哪些信息或操作？\n"
        "3. 工具选择：应该用哪个工具？为什么选这个而不是其他工具？\n"
        "4. 参数规划：工具的参数应该填什么？\n"
        "\n"
        "每次工具返回结果后，也要先用 `think` 分析结果，再决定下一步行动。\n"
        "\n"
        "**示例流程**：用户问'当前目录有哪些文件?'\n"
        "→ think: 用户想知道当前目录的文件列表。我没有直接获取 cwd 的工具，"
        "但可以用 glob(pattern='*', path='.') 列出当前目录所有文件。选 glob 而不是 shell，"
        "因为 glob 跨平台且不依赖 Unix 命令。\n"
        "→ glob(pattern='*', path='.')\n"
        "→ think: glob 返回了 N 个文件，包括 xxx。用户的问题已回答，整理后给出结论。\n"
        "→ [最终回复]\n"
    )

    _PLANNING_INSTRUCTIONS = (
        "\n\n## Planning with todo_write\n"
        "For any non-trivial task, you MUST maintain a visible plan with "
        "`todo_write`. Non-trivial means: multi-step work, code edits, debugging, "
        "git operations, merging, architecture/documentation work, research, "
        "or any task that may need verification.\n"
        "Required flow:\n"
        "1. Before doing the work, call `think`, then call "
        "`todo_write(action=\"set\")` with 2-6 concrete steps for the current "
        "session_id.\n"
        "2. Keep exactly one item `in_progress` while working.\n"
        "3. After finishing a step, call `todo_write(action=\"update\")` to mark "
        "it `completed`, then move the next step to `in_progress`.\n"
        "4. There is only one visible plan per session. When the user asks for "
        "a new plan, revised plan, more detailed plan, or changes the task "
        "scope, call `todo_write(action=\"set\")` with the full replacement "
        "plan. Do not preserve stale items unless the user explicitly asks "
        "to keep them.\n"
        "5. Do not create plans for one-shot factual answers, greetings, or very "
        "small edits that can be completed in one action.\n"
        "The frontend renders this plan for the user, so skipping `todo_write` "
        "makes progress invisible.\n"
    )

    
    _RECOVERY_INSTRUCTIONS = (
        "\n\n## Tool Failure Recovery\n"
        "When a tool returns an error:\n"
        "1. Read the error message carefully — it usually explains the cause.\n"
        "2. Do NOT repeat the exact same call. Try an alternative approach:\n"
        "   - Wrong tool for the task? Switch to the correct built-in tool "
        "(e.g. use glob instead of shell ls, use read_file instead of shell cat).\n"
        "   - Bad arguments? Fix the parameters and retry.\n"
        "   - Command not found? The executable may not be installed or not on PATH — "
        "tell the user and suggest how to install it.\n"
        "3. Explain what went wrong and what you tried differently.\n"
        "4. If all alternatives are exhausted, report clearly what failed and why.\n"
    )
    # Project context (MYHARNESS.md)
    _project_md = Path("MYHARNESS.md")
    _project_context = ""
    if _project_md.exists():
        _project_context = (
            "\n\n## Project Context (MYHARNESS.md)\n"
            "The following is the project's memory file. "
            "Follow its guidelines and use the commands it describes.\n\n"
            + _project_md.read_text(encoding="utf-8")
            + "\n\n---\n"
        )

    # Question-mode instructions: only appended when user enabled it.
    question_block = (
        QUESTION_INSTRUCTIONS if question_mode == "question"
        else NOQUESTION_INSTRUCTIONS
    )

    full_system = (
        _project_context
        + system_prompt
        + build_skill_system_addendum(skills)
        + _REASONING_INSTRUCTIONS
        + _PLANNING_INSTRUCTIONS
        + _RECOVERY_INSTRUCTIONS
        + question_block
    )

    compressor = ContextCompressor(
        summarizer=summarizer,
        config=CompressionConfig(
            token_window=comp.token_window,
            auto_trigger_ratio=comp.auto_trigger_ratio,
            micro_keep_recent=comp.micro_keep_recent,
            system_identity=full_system,
            session_id=session_id,
        ),
    )

    # Resolve which tools to load:
    #   persona allowed_tools  ∩  global enabled  (or all if global is None)
    global_enabled = harness_cfg.tools.enabled
    if allowed_tools is not None:
        tools_to_load = [t for t in allowed_tools if global_enabled is None or t in global_enabled]
    else:
        tools_to_load = global_enabled if global_enabled is not None else list(ALL_TOOLS.keys())

    logger.info(
        "[build_engine] session=%s | ALL_TOOLS keys=%s",
        session_id, list(ALL_TOOLS.keys()),
    )
    logger.info(
        "[build_engine] session=%s | global_enabled=%s | allowed_tools=%s | tools_to_load=%s",
        session_id, global_enabled, allowed_tools, tools_to_load,
    )

    if registry is None:
        registry = ToolRegistry()
    for name in tools_to_load:
        if name in ALL_TOOLS:
            schema, handler = ALL_TOOLS[name]
            if name == "todo_write":
                handler = make_todo_write_tool(
                    session_store,
                    plan_store,
                    bound_session_id=session_id,
                )
            elif name == "memory":
                handler = make_memory_tool(memory_store)
            elif name == "run_init":
                handler = _make_bound_run_init_tool(
                    session_store, engine_registry, session_id
                )
            registry.register(schema, handler)
            logger.info("[build_engine] registered tool: %s", name)
        elif name == "ask_user":
            # ask_user is a session-specific tool (needs the engine closure)
            # and is registered later in this function. Skip silently here.
            continue
        else:
            logger.warning("[build_engine] tool '%s' in tools_to_load but NOT in ALL_TOOLS — skipped", name)

    # Skill discovery/loading remains available even when the session started
    # with no Skills, so a Skill installed later can be found without rebuilding
    # the engine. These read-only tools are not controlled by persona allowlists.
    registry.register(USE_SKILL_SCHEMA, use_skill_tool)
    registry.register(LIST_SKILLS_SCHEMA, list_skills_tool)

    # spawn_agent / spawn_agents: registered conditionally by depth (not via ALL_TOOLS
    # because they need runtime dependencies passed as closure args)
    from harness.tools.builtin.spawn_agent import (
        SPAWN_AGENT_SCHEMA, make_spawn_agent_tool,
        SPAWN_AGENTS_SCHEMA, make_spawn_agents_tool,
        MAX_SPAWN_DEPTH,
    )
    if spawn_depth < MAX_SPAWN_DEPTH:
        registry.register(
            SPAWN_AGENT_SCHEMA,
            make_spawn_agent_tool(
                harness_cfg, provider_cfg, session_store, spawn_depth, engine_registry,
                parent_session_id=session_id,
                parent_agent_id=agent_id,
                parent_approval_mode=approval_mode,
                memory_store=memory_store,
                plan_store=plan_store,
            ),
        )
        registry.register(
            SPAWN_AGENTS_SCHEMA,
            make_spawn_agents_tool(
                harness_cfg, provider_cfg, session_store, spawn_depth, engine_registry,
                parent_session_id=session_id,
                parent_agent_id=agent_id,
                parent_approval_mode=approval_mode,
                memory_store=memory_store,
                plan_store=plan_store,
            ),
        )

    # Build the PromptCache — caches immutable base + mode blocks so that
    # subsequent round loops can re-use the fragments without re-concatenation.
    # The cache lives on the engine and is passed into the loop.
    prompt_cache = PromptCache()

    # Cache the immutable base fragment (system_prompt + skills + reasoning + recovery).
    # The persona's raw system_prompt is cached separately so it can be swapped
    # at runtime via engine.set_persona() without rebuilding the engine.
    prompt_cache.set_persona_system_prompt(system_prompt)
    _base_fragment = (
        _project_context
        + system_prompt
        + build_skill_system_addendum(skills)
        + _REASONING_INSTRUCTIONS
        + _PLANNING_INSTRUCTIONS
        + _RECOVERY_INSTRUCTIONS
    )
    prompt_cache.set_system_prompt(_base_fragment)

    # Cache the question / noquestion mode blocks individually.
    prompt_cache.set_mode_block("question", QUESTION_INSTRUCTIONS)
    prompt_cache.set_mode_block("noquestion", NOQUESTION_INSTRUCTIONS)

    # Append the definitive tool list to the system prompt so the LLM can
    # accurately answer "what tools do you have?" from the actual registry.
    registered = registry.discover()
    logger.info(
        "[build_engine] session=%s | final registry (%d tools): %s",
        session_id, len(registered), [t.schema.name for t in registered],
    )
    if registered:
        tool_lines = [
            "",
            "## Your Executable Tools (Authoritative List)",
            "IMPORTANT: The following is the COMPLETE and ONLY list of callable tools",
            "available to you right now. Do NOT mention any tools not in this list.",
            "Do NOT list Skills as tools — Skills are workflow presets, not callable functions.",
            "",
        ]
        for t in registered:
            desc = (t.schema.description or "").strip()
            tool_lines.append(f"- **{t.schema.name}**: {desc}")
        full_system = _base_fragment + question_block + "\n" + "\n".join(tool_lines)
    else:
        full_system = _base_fragment + question_block

    overflow = OverflowStore()
    hooks = HookManager()
    executor = ToolExecutor(
        registry=registry,
        overflow=overflow,
        emitter=emitter,
        limits=harness_cfg.tools.limits,
        hooks=hooks,
        session_id=session_id,
    )

    loop = ReactLoop(
        llm=llm,
        tool_registry=registry,
        tool_executor=executor,
        compressor=compressor,
        emitter=emitter,
        max_rounds=harness_cfg.engine.max_rounds,
        prompt_cache=prompt_cache,
        hooks=hooks,
        session_id=session_id,
    )

    engine = AgentEngine(
        config=EngineConfig(
            session_id=session_id,
            system_prompt=full_system,
            confirm_tools=frozenset(harness_cfg.tools.confirm_tools),
            provider_name=provider_name,
            agent_id=agent_id,
            spawn_depth=spawn_depth,
            question_mode=question_mode,
            approval_mode=approval_mode,
            memory_store=memory_store,
            plan_store=plan_store,
        ),
        loop=loop,
        session_store=session_store,
        emitter=emitter,
        tool_registry=registry,
        prompt_cache=prompt_cache,
    )

    # Register ask_user only when question_mode == "question".
    # The tool needs the engine reference, so it's added after construction.
    if question_mode == "question":
        from harness.tools.builtin.ask_user import (
            ASK_USER_SCHEMA, make_ask_user_tool,
        )
        registry.register(ASK_USER_SCHEMA, make_ask_user_tool(engine))

    return engine


# ── MCP async helpers ────────────────────────────────────────────────────────

async def setup_mcp_servers(
    registry: ToolRegistry,
    harness_cfg: HarnessConfig,
) -> list:  # list[MCPClient]
    """Connect all MCP Servers declared in *harness_cfg* and register their
    tools into *registry*.

    Returns the list of connected MCPClient instances so the caller can
    ``await client.close()`` them on shutdown.

    Args:
        registry:    ToolRegistry to inject MCP tools into.
        harness_cfg: Config that may contain ``mcp_servers`` entries.

    Returns:
        List of active MCPClient instances (may be empty if none configured).
    """
    from harness.mcp.client import MCPClient
    from harness.mcp.bridge import register_mcp_server

    async def _connect_client_with_retries(
        client: MCPClient,
        server_name: str,
        server_cfg,
    ) -> bool:
        attempts = 3
        last_exc: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                if server_cfg.transport == "stdio":
                    if not server_cfg.command:
                        logger.warning("MCP Server '%s' has no command; skipping.", server_name)
                        return False
                    await client.connect(server_cfg.command)
                elif server_cfg.transport in {"http", "https", "remote", "streamable_http"}:
                    if not server_cfg.url:
                        logger.warning("MCP Server '%s' has no URL; skipping.", server_name)
                        return False
                    await client.connect_http(server_cfg.url, headers=server_cfg.headers)
                else:
                    logger.warning(
                        "MCP Server '%s' uses unsupported transport '%s'; skipping.",
                        server_name, server_cfg.transport,
                    )
                    return False
                return True
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "MCP Server '%s' connect attempt %d/%d failed: %r",
                    server_name, attempt, attempts, exc,
                )
                try:
                    await client.close()
                except Exception:
                    pass
                if attempt < attempts:
                    await asyncio.sleep(0.5 * attempt)
        assert last_exc is not None
        raise last_exc

    clients: list[MCPClient] = []
    for server_name, server_cfg in harness_cfg.mcp_servers.items():
        client = MCPClient(server_name=server_name)
        try:
            connected = await _connect_client_with_retries(client, server_name, server_cfg)
            if not connected:
                continue
            registered = await register_mcp_server(registry, client, prefix=server_name)
            logger.info(
                "MCP Server '%s' connected; %d tool(s) registered: %s",
                server_name, len(registered), registered,
            )
            clients.append(client)
        except Exception as exc:
            logger.error(
                "Failed to connect MCP Server '%s': %r", server_name, exc
            )
            await client.close()

    return clients


async def build_engine_with_mcp(
    session_id: str,
    provider_cfg: ProviderConfig,
    harness_cfg: HarnessConfig,
    session_store: SessionStore,
    system_prompt: str = "",
    allowed_tools: list[str] | None = None,
    engine_registry: dict | None = None,
    provider_name: str = "",
    agent_id: str = "",
    question_mode: str = "noquestion",
    approval_mode: str = "ask",
    memory_store: MemoryStore | None = None,
    plan_store: PlanStore | None = None,
) -> tuple[AgentEngine, list]:  # tuple[AgentEngine, list[MCPClient]]
    """Async variant of build_engine() that also initialises MCP Servers.

    Call this instead of ``build_engine()`` when ``mcp_servers`` are
    configured.  The returned MCPClient list must be closed by the caller::

        engine, mcp_clients = await build_engine_with_mcp(...)
        try:
            ...
        finally:
            for c in mcp_clients:
                await c.close()

    Args:
        session_id:    Unique session identifier.
        provider_cfg:  LLM provider config.
        harness_cfg:   Global harness config (may contain ``mcp_servers``).
        session_store: Session persistence backend.
        system_prompt: Base system prompt.
        allowed_tools: Persona-level tool whitelist.

    Returns:
        ``(engine, mcp_clients)`` tuple.
    """
    registry = ToolRegistry()
    mcp_clients = await setup_mcp_servers(registry, harness_cfg)

    engine = build_engine(
        session_id=session_id,
        provider_cfg=provider_cfg,
        harness_cfg=harness_cfg,
        session_store=session_store,
        system_prompt=system_prompt,
        allowed_tools=allowed_tools,
        registry=registry,
        engine_registry=engine_registry,
        provider_name=provider_name,
        agent_id=agent_id,
        question_mode=question_mode,
        approval_mode=approval_mode,
        memory_store=memory_store,
        plan_store=plan_store,
    )
    return engine, mcp_clients
