"""
REST API for the agent harness.

Backend is the single source of truth.
Frontends MUST pull state from GET /sessions/{id}/state — never cache locally.
Switching sessions: call /state to get last_messages + is_running.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
from typing import Any

if os.name == "nt" and hasattr(asyncio, "WindowsProactorEventLoopPolicy"):
    # MCP stdio servers require subprocess support on Windows.
    # Under SelectorEventLoopPolicy, asyncio subprocess APIs can fail with a
    # blank NotImplementedError inside uvicorn/reload workers.
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from dotenv import load_dotenv
load_dotenv(override=False)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from harness.commands import CommandSystem
from harness.commands.models import CommandContext, CommandResult, substitute_args
from harness.agents import list_agent_profiles
from harness.config import HarnessConfig, ProviderConfig
from harness.engine.engine import AgentEngine
from harness.factory import build_engine, build_engine_with_mcp
from harness.skills import (
    load_skill,
    load_persona,
    list_skills, list_personas,
    resolve_project_skill_path,
    read_file_safe, write_file_safe,
    SKILLS_DIR, PERSONAS_DIR,
)
from harness.storage.backends.memory import (
    InMemoryMemoryStore,
    InMemoryPlanStore,
    MemorySessionStore,
)
from harness.storage.backends.sqlite import (
    SQLiteMemoryStore,
    SQLitePlanStore,
    SQLiteSessionStore,
)
from harness.types.messages import Message, TextBlock, ToolCallBlock

from api.canvas_publish import (
    CanvasPublishError,
    extract_authored_html,
    finalize_publish,
    infer_domain_skill_name,
    normalize_authored_image_paths,
    next_gallery_export_name,
    persist_canvas_state,
    utc_now,
    validate_published_html,
    validate_run_id,
)
from api.canvas_assets import build_canvas_asset_index

app = FastAPI(title="Dreamatic", version="0.1.0")
api_logger = logging.getLogger("harness.api")

# Active engines: session_id -> AgentEngine
_engines: dict[str, AgentEngine] = {}
_engine_meta: dict[str, dict[str, Any]] = {}   # session_id -> {persona, provider}
_engine_mcp_clients: dict[str, list] = {}

# Shared config — loaded once at startup
_config: HarnessConfig | None = None
_session_store = MemorySessionStore()
_memory_store = InMemoryMemoryStore()
_plan_store = InMemoryPlanStore()
_cmd_system: CommandSystem | None = None
_canvas_publish_jobs: dict[str, dict[str, Any]] = {}
_canvas_publish_tasks: set[asyncio.Task] = set()
_canvas_publish_tasks_by_job: dict[str, asyncio.Task] = {}
_canvas_publish_engines_by_job: dict[str, AgentEngine] = {}

ENV_SETTINGS_FILE = Path(__file__).resolve().parent.parent / ".env"
DREAMATIC_SETTINGS_FILE = Path(__file__).resolve().parent.parent / ".dreamatic" / "settings.json"
MANAGED_ENV_KEYS = [
    "DREAMATIC_PROVIDER_TYPE",
    "DREAMATIC_API_KEY",
    "DREAMATIC_BASE_URL",
    "DREAMATIC_MODEL",
    "DREAMATIC_SUMMARY_PROVIDER_TYPE",
    "DREAMATIC_SUMMARY_API_KEY",
    "DREAMATIC_SUMMARY_BASE_URL",
    "DREAMATIC_SUMMARY_MODEL",
    "DREAMATIC_IMAGE_API_KEY",
    "DREAMATIC_IMAGE_BASE_URL",
    "DREAMATIC_IMAGE_MODEL",
    "DREAMATIC_IMAGE_GENERATION_ENDPOINT",
    "DREAMATIC_IMAGE_EDIT_ENDPOINT",
    "DREAMATIC_IMAGE_BACKEND",
    "DREAMATIC_IMAGE_DEFAULT_SIZE",
    "DREAMATIC_VIDEO_API_KEY",
    "DREAMATIC_VIDEO_BASE_URL",
    "DREAMATIC_VIDEO_MODEL",
    "DREAMATIC_VIDEO_ENDPOINT",
    "DREAMATIC_VIDEO_BACKEND",
    "DREAMATIC_VIDEO_DEFAULT_RESOLUTION",
    "DREAMATIC_VIDEO_DEFAULT_DURATION",
    "DREAMATIC_HUNYUAN3D_API_KEY",
    "DREAMATIC_HUNYUAN3D_BASE_URL",
    "DREAMATIC_HUNYUAN3D_MODEL",
    "DREAMATIC_SEARCH_PROVIDER",
    "DREAMATIC_SEARCH_API_KEY",
    "HARNESS_DEFAULT_PROVIDER",
    "OPENAI_HUB_API_KEY",
    "OPENAI_HUB_BASE_URL",
    "OPENAI_HUB_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "THREE_SIX_ONE_API_KEY",
    "THREE_SIX_ONE_BASE_URL",
    "THREE_SIX_ONE_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "API_CZ_KEY",
    "API_CZ_BASE_URL",
    "API_CZ_MODEL",
    "SERPER_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "DESIGN_IMAGE_API_KEY",
    "DESIGN_IMAGE_BASE_URL",
    "DESIGN_IMAGE_MODEL",
    "DESIGN_IMAGE_ENDPOINT",
    "DESIGN_IMAGE_EDIT_ENDPOINT",
    "DESIGN_IMAGE_BACKEND",
    "DESIGN_IMAGE_DEFAULT_SIZE",
    "OPENAI_HUB_IMAGE_MODEL",
]

MODEL_PROVIDER_TYPES = {"openai-compatible", "openai", "anthropic"}
MODEL_MODULE_IDS = ("agent", "compression", "image", "search", "video", "model3d")
AGENT_PROVIDER_ID = "dreamatic-agent"
COMPRESSION_PROVIDER_ID = "dreamatic-compression"


def _settings_default() -> dict[str, Any]:
    return {"version": 2, "modules": {module_id: {} for module_id in MODEL_MODULE_IDS}}


def _normalize_provider_type(value: Any) -> str:
    provider_type = str(value or "openai-compatible").strip()
    return provider_type if provider_type in MODEL_PROVIDER_TYPES else "openai-compatible"


def _normalize_model_module(module_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    if module_id in {"agent", "compression"}:
        return {
            "provider_type": _normalize_provider_type(raw.get("provider_type")),
            "api_key": str(raw.get("api_key") or "").strip(),
            "base_url": str(raw.get("base_url") or "").strip(),
            "model": str(raw.get("model") or "").strip(),
        }
    if module_id == "image":
        base_url = str(raw.get("base_url") or "").strip()
        generation_endpoint = str(raw.get("generation_endpoint") or "").strip()
        edit_endpoint = str(raw.get("edit_endpoint") or "").strip()
        if base_url:
            root = base_url.rstrip("/")
            generation_endpoint = generation_endpoint or f"{root}/images/generations"
            edit_endpoint = edit_endpoint or f"{root}/images/edits"
        return {
            "api_key": str(raw.get("api_key") or "").strip(),
            "base_url": base_url,
            "model": str(raw.get("model") or "").strip(),
            "generation_endpoint": generation_endpoint,
            "edit_endpoint": edit_endpoint,
            "backend": str(raw.get("backend") or "").strip(),
            "default_size": str(raw.get("default_size") or "1024x1024").strip(),
        }
    if module_id == "search":
        provider = str(raw.get("provider") or "").strip().casefold()
        if provider not in {"", "serper", "brave"}:
            provider = ""
        return {"provider": provider, "api_key": str(raw.get("api_key") or "").strip()}
    if module_id == "video":
        duration = raw.get("default_duration", 5)
        try:
            duration = max(1, int(duration))
        except (TypeError, ValueError):
            duration = 5
        return {
            "api_key": str(raw.get("api_key") or "").strip(),
            "base_url": str(raw.get("base_url") or "").strip(),
            "model": str(raw.get("model") or "").strip(),
            "endpoint": str(raw.get("endpoint") or "").strip(),
            "backend": str(raw.get("backend") or "").strip(),
            "default_resolution": str(raw.get("default_resolution") or "720p").strip(),
            "default_duration": duration,
        }
    if module_id == "model3d":
        return {
            "api_key": str(raw.get("api_key") or "").strip(),
            "base_url": str(raw.get("base_url") or "").strip(),
            "model": str(raw.get("model") or "").strip(),
        }
    raise ValueError(f"Unknown model module: {module_id}")


def _normalize_modules(raw: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        module_id: _normalize_model_module(module_id, raw.get(module_id, {}))
        for module_id in MODEL_MODULE_IDS
    }


def _legacy_profile_to_modules(profile: dict[str, Any]) -> dict[str, dict[str, Any]]:
    base_url = str(profile.get("base_url") or "").strip()
    api_key = str(profile.get("api_key") or "").strip()
    return _normalize_modules({
        "agent": {
            "provider_type": profile.get("provider_type"),
            "api_key": api_key,
            "base_url": base_url,
            "model": profile.get("model"),
        },
        "compression": {
            "provider_type": profile.get("provider_type"),
            "api_key": profile.get("summary_api_key") or api_key,
            "base_url": profile.get("summary_base_url") or base_url,
            "model": profile.get("summary_model"),
        },
        "image": {
            "api_key": profile.get("image_api_key") or api_key,
            "base_url": profile.get("image_base_url") or base_url,
            "model": profile.get("image_model"),
            "generation_endpoint": profile.get("image_generation_endpoint"),
            "edit_endpoint": profile.get("image_edit_endpoint"),
            "default_size": profile.get("image_default_size"),
        },
        "search": {
            "provider": profile.get("search_provider"),
            "api_key": profile.get("search_api_key"),
        },
    })


def _load_dreamatic_settings() -> dict[str, Any]:
    if not DREAMATIC_SETTINGS_FILE.exists():
        return {"version": 2, "modules": _modules_from_env(_read_managed_env_values())}
    try:
        data = json.loads(DREAMATIC_SETTINGS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _settings_default()
    if isinstance(data.get("modules"), dict):
        return {"version": 2, "modules": _normalize_modules(data["modules"])}

    profiles = [p for p in data.get("profiles", []) if isinstance(p, dict)]
    active_id = str(data.get("active_profile_id") or "")
    selected = next((p for p in profiles if str(p.get("id") or "") == active_id), None)
    selected = selected or (profiles[0] if profiles else None)
    if selected:
        legacy_modules = _legacy_profile_to_modules(selected)
        env_modules = _modules_from_env(_read_managed_env_values())
        for module_id in MODEL_MODULE_IDS:
            for key, value in env_modules[module_id].items():
                if not legacy_modules[module_id].get(key):
                    legacy_modules[module_id][key] = value
        return {"version": 2, "modules": _normalize_modules(legacy_modules)}
    return {"version": 2, "modules": _modules_from_env(_read_managed_env_values())}


def _save_dreamatic_settings(settings: dict[str, Any]) -> None:
    DREAMATIC_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    DREAMATIC_SETTINGS_FILE.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _parse_env_content(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        values[key] = value
    return values


def _quote_env_value(value: str) -> str:
    value = str(value or "")
    if not value:
        return ""
    if any(ch.isspace() for ch in value) or "#" in value or '"' in value:
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def _read_managed_env_values() -> dict[str, str]:
    file_values: dict[str, str] = {}
    if ENV_SETTINGS_FILE.exists():
        file_values = _parse_env_content(ENV_SETTINGS_FILE.read_text(encoding="utf-8"))
    return {key: file_values.get(key, os.environ.get(key, "")) for key in MANAGED_ENV_KEYS}


def _modules_from_env(values: dict[str, str]) -> dict[str, dict[str, Any]]:
    values = _derive_env_defaults(values)
    return _normalize_modules({
        "agent": {
            "provider_type": values.get("DREAMATIC_PROVIDER_TYPE") or "openai-compatible",
            "api_key": values.get("DREAMATIC_API_KEY") or values.get("OPENAI_HUB_API_KEY") or values.get("OPENAI_API_KEY") or values.get("API_CZ_KEY"),
            "base_url": values.get("DREAMATIC_BASE_URL") or values.get("OPENAI_HUB_BASE_URL") or values.get("OPENAI_BASE_URL") or values.get("API_CZ_BASE_URL"),
            "model": values.get("DREAMATIC_MODEL") or values.get("OPENAI_HUB_MODEL") or values.get("OPENAI_MODEL") or values.get("API_CZ_MODEL"),
        },
        "compression": {
            "provider_type": values.get("DREAMATIC_SUMMARY_PROVIDER_TYPE") or values.get("DREAMATIC_PROVIDER_TYPE") or "openai-compatible",
            "api_key": values.get("DREAMATIC_SUMMARY_API_KEY") or values.get("DREAMATIC_API_KEY") or values.get("OPENAI_HUB_API_KEY") or values.get("OPENAI_API_KEY") or values.get("API_CZ_KEY"),
            "base_url": values.get("DREAMATIC_SUMMARY_BASE_URL") or values.get("DREAMATIC_BASE_URL") or values.get("OPENAI_HUB_BASE_URL") or values.get("OPENAI_BASE_URL") or values.get("API_CZ_BASE_URL"),
            "model": values.get("DREAMATIC_SUMMARY_MODEL"),
        },
        "image": {
            "api_key": values.get("DREAMATIC_IMAGE_API_KEY") or values.get("DESIGN_IMAGE_API_KEY"),
            "base_url": values.get("DREAMATIC_IMAGE_BASE_URL") or values.get("DESIGN_IMAGE_BASE_URL"),
            "model": values.get("DREAMATIC_IMAGE_MODEL") or values.get("DESIGN_IMAGE_MODEL"),
            "generation_endpoint": values.get("DREAMATIC_IMAGE_GENERATION_ENDPOINT") or (
                "" if values.get("DREAMATIC_IMAGE_BASE_URL") else values.get("DESIGN_IMAGE_ENDPOINT")
            ),
            "edit_endpoint": values.get("DREAMATIC_IMAGE_EDIT_ENDPOINT") or (
                "" if values.get("DREAMATIC_IMAGE_BASE_URL") else values.get("DESIGN_IMAGE_EDIT_ENDPOINT")
            ),
            "backend": values.get("DREAMATIC_IMAGE_BACKEND") or values.get("DESIGN_IMAGE_BACKEND"),
            "default_size": values.get("DREAMATIC_IMAGE_DEFAULT_SIZE") or values.get("DESIGN_IMAGE_DEFAULT_SIZE"),
        },
        "search": {
            "provider": values.get("DREAMATIC_SEARCH_PROVIDER"),
            "api_key": values.get("DREAMATIC_SEARCH_API_KEY"),
        },
        "video": {
            "api_key": values.get("DREAMATIC_VIDEO_API_KEY"),
            "base_url": values.get("DREAMATIC_VIDEO_BASE_URL"),
            "model": values.get("DREAMATIC_VIDEO_MODEL"),
            "endpoint": values.get("DREAMATIC_VIDEO_ENDPOINT"),
            "backend": values.get("DREAMATIC_VIDEO_BACKEND"),
            "default_resolution": values.get("DREAMATIC_VIDEO_DEFAULT_RESOLUTION"),
            "default_duration": values.get("DREAMATIC_VIDEO_DEFAULT_DURATION") or 5,
        },
        "model3d": {
            "api_key": values.get("DREAMATIC_HUNYUAN3D_API_KEY"),
            "base_url": values.get("DREAMATIC_HUNYUAN3D_BASE_URL"),
            "model": values.get("DREAMATIC_HUNYUAN3D_MODEL"),
        },
    })


def _modules_to_env_values(modules: dict[str, dict[str, Any]]) -> dict[str, str]:
    agent = modules["agent"]
    compression = modules["compression"]
    image = modules["image"]
    search = modules["search"]
    video = modules["video"]
    model3d = modules["model3d"]
    search_key = str(search.get("api_key") or "")
    return {
        "DREAMATIC_PROVIDER_TYPE": str(agent.get("provider_type") or "openai-compatible"),
        "DREAMATIC_API_KEY": str(agent.get("api_key") or ""),
        "DREAMATIC_BASE_URL": str(agent.get("base_url") or ""),
        "DREAMATIC_MODEL": str(agent.get("model") or ""),
        "DREAMATIC_SUMMARY_PROVIDER_TYPE": str(compression.get("provider_type") or "openai-compatible"),
        "DREAMATIC_SUMMARY_API_KEY": str(compression.get("api_key") or ""),
        "DREAMATIC_SUMMARY_BASE_URL": str(compression.get("base_url") or ""),
        "DREAMATIC_SUMMARY_MODEL": str(compression.get("model") or ""),
        "DREAMATIC_IMAGE_API_KEY": str(image.get("api_key") or ""),
        "DREAMATIC_IMAGE_BASE_URL": str(image.get("base_url") or ""),
        "DREAMATIC_IMAGE_MODEL": str(image.get("model") or ""),
        "DREAMATIC_IMAGE_GENERATION_ENDPOINT": str(image.get("generation_endpoint") or ""),
        "DREAMATIC_IMAGE_EDIT_ENDPOINT": str(image.get("edit_endpoint") or ""),
        "DREAMATIC_IMAGE_BACKEND": str(image.get("backend") or ""),
        "DREAMATIC_IMAGE_DEFAULT_SIZE": str(image.get("default_size") or ""),
        "DREAMATIC_SEARCH_PROVIDER": str(search.get("provider") or ""),
        "DREAMATIC_SEARCH_API_KEY": search_key,
        "SERPER_API_KEY": search_key if search.get("provider") == "serper" else "",
        "BRAVE_SEARCH_API_KEY": search_key if search.get("provider") == "brave" else "",
        "DREAMATIC_VIDEO_API_KEY": str(video.get("api_key") or ""),
        "DREAMATIC_VIDEO_BASE_URL": str(video.get("base_url") or ""),
        "DREAMATIC_VIDEO_MODEL": str(video.get("model") or ""),
        "DREAMATIC_VIDEO_ENDPOINT": str(video.get("endpoint") or ""),
        "DREAMATIC_VIDEO_BACKEND": str(video.get("backend") or ""),
        "DREAMATIC_VIDEO_DEFAULT_RESOLUTION": str(video.get("default_resolution") or ""),
        "DREAMATIC_VIDEO_DEFAULT_DURATION": str(video.get("default_duration") or ""),
        "DREAMATIC_HUNYUAN3D_API_KEY": str(model3d.get("api_key") or ""),
        "DREAMATIC_HUNYUAN3D_BASE_URL": str(model3d.get("base_url") or ""),
        "DREAMATIC_HUNYUAN3D_MODEL": str(model3d.get("model") or ""),
    }


def _write_managed_env_values(values: dict[str, str]) -> None:
    existing_lines: list[str] = []
    if ENV_SETTINGS_FILE.exists():
        existing_lines = ENV_SETTINGS_FILE.read_text(encoding="utf-8").splitlines()

    managed = {key: str(values.get(key, "") or "") for key in MANAGED_ENV_KEYS}
    preserved: list[str] = []
    seen_managed: set[str] = set()
    for line in existing_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            preserved.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in managed:
            seen_managed.add(key)
            continue
        preserved.append(line)

    output = preserved[:]
    if output and output[-1].strip():
        output.append("")
    output.append("# Dreamatic runtime settings")
    for key in MANAGED_ENV_KEYS:
        output.append(f"{key}={_quote_env_value(managed.get(key, ''))}")

    ENV_SETTINGS_FILE.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")


def _derive_env_defaults(values: dict[str, str]) -> dict[str, str]:
    next_values = {key: str(values.get(key, "") or "") for key in MANAGED_ENV_KEYS}
    if not next_values["HARNESS_DEFAULT_PROVIDER"]:
        next_values["HARNESS_DEFAULT_PROVIDER"] = "openai-hub"
    if not next_values["OPENAI_HUB_BASE_URL"]:
        next_values["OPENAI_HUB_BASE_URL"] = "https://api.openai-hub.com/v1"
    if not next_values["OPENAI_HUB_MODEL"]:
        next_values["OPENAI_HUB_MODEL"] = "gpt-4o"
    if not next_values["DESIGN_IMAGE_BASE_URL"]:
        next_values["DESIGN_IMAGE_BASE_URL"] = next_values["OPENAI_HUB_BASE_URL"]
    if not next_values["DESIGN_IMAGE_MODEL"]:
        next_values["DESIGN_IMAGE_MODEL"] = (
            next_values["OPENAI_HUB_IMAGE_MODEL"] or "gpt-image-2"
        )
    image_base = next_values["DESIGN_IMAGE_BASE_URL"].rstrip("/")
    if image_base:
        if not next_values["DESIGN_IMAGE_ENDPOINT"]:
            next_values["DESIGN_IMAGE_ENDPOINT"] = f"{image_base}/images/generations"
        if not next_values["DESIGN_IMAGE_EDIT_ENDPOINT"]:
            next_values["DESIGN_IMAGE_EDIT_ENDPOINT"] = f"{image_base}/images/edits"
    if not next_values["DESIGN_IMAGE_API_KEY"]:
        next_values["DESIGN_IMAGE_API_KEY"] = next_values["OPENAI_HUB_API_KEY"]
    if not next_values["DREAMATIC_SUMMARY_BASE_URL"]:
        next_values["DREAMATIC_SUMMARY_BASE_URL"] = next_values["DREAMATIC_BASE_URL"]
    if not next_values["DREAMATIC_SUMMARY_API_KEY"]:
        next_values["DREAMATIC_SUMMARY_API_KEY"] = next_values["DREAMATIC_API_KEY"]
    if not next_values["DREAMATIC_SEARCH_PROVIDER"]:
        if next_values["SERPER_API_KEY"]:
            next_values["DREAMATIC_SEARCH_PROVIDER"] = "serper"
            next_values["DREAMATIC_SEARCH_API_KEY"] = next_values["SERPER_API_KEY"]
        elif next_values["BRAVE_SEARCH_API_KEY"]:
            next_values["DREAMATIC_SEARCH_PROVIDER"] = "brave"
            next_values["DREAMATIC_SEARCH_API_KEY"] = next_values["BRAVE_SEARCH_API_KEY"]
    if not next_values["DREAMATIC_SEARCH_API_KEY"]:
        if next_values["DREAMATIC_SEARCH_PROVIDER"] == "serper":
            next_values["DREAMATIC_SEARCH_API_KEY"] = next_values["SERPER_API_KEY"]
        elif next_values["DREAMATIC_SEARCH_PROVIDER"] == "brave":
            next_values["DREAMATIC_SEARCH_API_KEY"] = next_values["BRAVE_SEARCH_API_KEY"]
    return next_values


def _apply_runtime_env(values: dict[str, str]) -> None:
    for key in MANAGED_ENV_KEYS:
        value = str(values.get(key, "") or "")
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


def _module_to_provider_config(module: dict[str, Any], *, max_tokens: int) -> ProviderConfig:
    return ProviderConfig(
        name=str(module.get("provider_type") or "openai-compatible"),
        model=str(module.get("model") or ""),
        api_key=str(module.get("api_key") or ""),
        base_url=str(module.get("base_url") or ""),
        max_tokens=max_tokens,
        temperature=0.0,
    )


def _apply_model_modules_to_config(cfg: HarnessConfig) -> None:
    settings = _load_dreamatic_settings()
    modules = _normalize_modules(settings.get("modules", {}))
    _apply_runtime_env({**_read_managed_env_values(), **_modules_to_env_values(modules)})

    agent = modules["agent"]
    if agent.get("model"):
        cfg.providers[AGENT_PROVIDER_ID] = _module_to_provider_config(agent, max_tokens=4096)
        cfg.default_provider = AGENT_PROVIDER_ID

    compression = modules["compression"]
    if compression.get("model"):
        cfg.providers[COMPRESSION_PROVIDER_ID] = _module_to_provider_config(
            compression, max_tokens=2048
        )
        cfg.compression.summary_provider = COMPRESSION_PROVIDER_ID
    elif cfg.compression.summary_provider not in cfg.providers:
        cfg.compression.summary_provider = ""


def _session_config_for_provider(cfg: HarnessConfig, provider_name: str) -> HarnessConfig:
    return deepcopy(cfg)


def _reload_runtime_config() -> None:
    global _config
    try:
        _config = HarnessConfig.from_yaml("config.yaml")
    except FileNotFoundError:
        _config = HarnessConfig.from_env()
    _apply_model_modules_to_config(_config)


# ── Startup ────────────────────────────────────────────────────────────

@app.on_event("startup")
async def _startup() -> None:
    global _config, _session_store, _memory_store, _plan_store, _cmd_system
    _reload_runtime_config()

    if _config.storage.backend == "sqlite":
        _session_store = SQLiteSessionStore(_config.storage.path)
        _memory_store = SQLiteMemoryStore(_config.storage.path)
        _plan_store = SQLitePlanStore(_config.storage.path)
    else:
        _memory_store = InMemoryMemoryStore()
        _plan_store = InMemoryPlanStore()

    _cmd_system = CommandSystem()
    _cmd_system.initialize()


@app.on_event("shutdown")
async def _shutdown() -> None:
    for session_id in list(_engine_mcp_clients.keys()):
        await _close_session_mcp_clients(session_id)


# ── Static files ───────────────────────────────────────────────────────

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
OUTPUTS_DIR = ROOT_DIR / "outputs"
RUNS_DIR = ROOT_DIR / ".design-harness" / "runs"

@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return Response(status_code=204)

@app.get("/", include_in_schema=False)
async def serve_index() -> FileResponse:
    index = STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="Frontend not found. Run setup first.")
    return FileResponse(
        str(index),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

@app.on_event("startup")
async def _mount_static() -> None:
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    if OUTPUTS_DIR.exists():
        app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
    if RUNS_DIR.exists():
        # Research assets exist here before export_package copies them to outputs/.
        app.mount("/run-assets", StaticFiles(directory=str(RUNS_DIR)), name="run-assets")


# ── Request / response models ──────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    session_id: str = ""       # optional; pass to restore after server reload
    persona: str = "design-primary"  # load from personas/{name}.md (preferred)
    system_prompt: str = ""     # fallback if no persona
    allowed_tools: list[str] | None = None
    approval_mode: str = ""     # "ask" | "auto" | "full" — picked at session start


class SendMessageRequest(BaseModel):
    text: str


class UpdateSessionRequest(BaseModel):
    display_name: str | None = None
    pinned: bool | None = None
    archived: bool | None = None
    persona: str | None = None


class CanvasRunBindingRequest(BaseModel):
    run_id: str


class RewriteMessageRequest(BaseModel):
    text: str


class SetModeRequest(BaseModel):
    question_mode: str   # "question" | "noquestion"


class SetApprovalModeRequest(BaseModel):
    approval_mode: str   # "ask" | "auto" | "full"


class MemoryAddRequest(BaseModel):
    content: str
    scope: str = "global"
    tags: list[str] | None = None
    session_id: str = ""


class ClarificationAnswerRequest(BaseModel):
    """Legacy single-question reply shape."""
    request_id: str
    answer: str | list[str]


class QuestionReplyRequest(BaseModel):
    answers: list[list[str]]


class ConfigWriteRequest(BaseModel):
    content: str


class CreateFileRequest(BaseModel):
    name: str
    content: str


class RuntimeEnvSettingsRequest(BaseModel):
    values: dict[str, str] = {}


class RuntimeEnvImportRequest(BaseModel):
    content: str


class ModelModuleRequest(BaseModel):
    module: dict[str, Any]


class CanvasEmbeddedAsset(BaseModel):
    element_id: str
    data_url: str
    name: str = ""


class CanvasPublishRequest(BaseModel):
    run_id: str
    canvas_state: dict[str, Any]
    embedded_assets: list[CanvasEmbeddedAsset] = Field(default_factory=list)


async def _build_session_engine(
    session_id: str,
    provider_name: str,
    cfg: HarnessConfig,
    system_prompt: str,
    allowed_tools: list[str] | None,
    persona_name: str,
    question_mode: str,
    approval_mode: str = "ask",
) -> tuple[AgentEngine, list]:
    if persona_name and (not system_prompt or allowed_tools is None):
        try:
            persona = load_persona(persona_name)
            if not system_prompt:
                system_prompt = persona.get("system_prompt", system_prompt)
            if allowed_tools is None:
                allowed_tools = persona.get("allowed_tools") or allowed_tools
            if persona.get("provider") and not provider_name:
                provider_name = persona["provider"]
        except ValueError:
            # Keep the restore path tolerant: stale persona names should not
            # make an otherwise persisted session unreadable.
            pass

    if provider_name not in cfg.providers:
        # Paranoid guard: caller should have already validated/fallen back,
        # but if we get here with an unknown provider, log it and use the
        # default rather than 500-ing on every state poll.
        import logging
        fallback = cfg.default_provider
        if fallback in cfg.providers:
            logging.getLogger("harness.api").warning(
                "_build_session_engine: provider %r not in config; "
                "falling back to default %r (session=%s)",
                provider_name, fallback, session_id,
            )
            provider_name = fallback
        else:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Provider '{provider_name}' not in config and no "
                    f"valid default to fall back to. "
                    f"Available: {list(cfg.providers.keys())}"
                ),
            )
    session_cfg = _session_config_for_provider(cfg, provider_name)
    if cfg.mcp_servers:
        engine, mcp_clients = await build_engine_with_mcp(
            session_id=session_id,
            provider_cfg=session_cfg.providers[provider_name],
            harness_cfg=session_cfg,
            session_store=_session_store,
            memory_store=_memory_store,
            plan_store=_plan_store,
            system_prompt=system_prompt,
            allowed_tools=allowed_tools,
            engine_registry=_engines,
            provider_name=provider_name,
            agent_id=persona_name,
            question_mode=question_mode,
            approval_mode=approval_mode,
        )
        return engine, mcp_clients

    return (
        build_engine(
            session_id=session_id,
            provider_cfg=session_cfg.providers[provider_name],
            harness_cfg=session_cfg,
            session_store=_session_store,
            memory_store=_memory_store,
            plan_store=_plan_store,
            system_prompt=system_prompt,
            allowed_tools=allowed_tools,
            engine_registry=_engines,
            provider_name=provider_name,
            agent_id=persona_name,
            question_mode=question_mode,
            approval_mode=approval_mode,
        ),
        [],
    )


async def _close_session_mcp_clients(session_id: str) -> None:
    clients = _engine_mcp_clients.pop(session_id, [])
    for client in clients:
        try:
            await client.close()
        except Exception:
            pass


async def _refresh_session_engine(session_id: str) -> bool:
    engine = _engines.get(session_id)
    if engine is None:
        return False
    snap = await engine.get_snapshot()
    if snap.get("is_running"):
        _engine_meta.setdefault(session_id, {})["model_config_stale"] = True
        return False

    meta = dict(_engine_meta.get(session_id, {}))
    try:
        rec = await _session_store.load(session_id)
        if rec and isinstance(rec.metadata, dict):
            meta = {**rec.metadata, **meta}
    except Exception:
        pass

    cfg = _require_config()
    provider_name = cfg.default_provider
    persona_name = str(meta.get("persona", ""))
    question_mode = str(meta.get("question_mode", "question") or "question")
    approval_mode = str(meta.get("approval_mode", "ask") or "ask")
    if approval_mode not in ("ask", "auto", "full"):
        approval_mode = "ask"

    await _close_session_mcp_clients(session_id)
    new_engine, mcp_clients = await _build_session_engine(
        session_id=session_id,
        provider_name=provider_name,
        cfg=cfg,
        system_prompt="",
        allowed_tools=None,
        persona_name=persona_name,
        question_mode=question_mode,
        approval_mode=approval_mode,
    )
    await new_engine.restore_from_store()
    _attach_engine_meta_sync(session_id, new_engine)
    _engines[session_id] = new_engine
    _engine_mcp_clients[session_id] = mcp_clients
    _engine_meta[session_id] = {
        **meta,
        "provider": provider_name,
        "model_config_stale": False,
    }
    try:
        await _session_store.update_metadata(session_id, provider=provider_name)
    except Exception:
        pass
    return True


async def _refresh_idle_session_engines() -> None:
    for session_id in list(_engines):
        try:
            await _refresh_session_engine(session_id)
        except Exception as exc:
            api_logger.warning(
                "could not refresh session engine after model settings change session=%s error=%s",
                session_id,
                exc,
            )


def _attach_engine_meta_sync(session_id: str, engine: AgentEngine) -> None:
    """Keep lightweight session metadata aligned with engine events."""

    async def _on_event(event: dict[str, Any]) -> None:
        if event.get("type") != "title_generated":
            return
        detail = event.get("data") or {}
        title = (detail.get("title") or "").strip()
        if not title:
            return
        _engine_meta.setdefault(session_id, {})["title"] = title

    engine.add_event_listener(_on_event)


_TOOL_QUERY_PATTERNS = [
    re.compile(r"(?:what|which|list|show).{0,20}tools?", re.IGNORECASE),
    re.compile(r"available tools?", re.IGNORECASE),
]

# Strict Chinese patterns for tool inventory queries.
# These must form a complete phrase at the START of the text.
# No partial matches like "工具链" or "工具调用".
_TOOL_QUERY_KEYWORDS_ZH = [
    # 列出工具 / 列出可用工具 / 列出所有工具 / 列出功能
    re.compile(r"^(?:列出|列出所有|列出可用|列出功能|列出所有工具|列出可用工具|出工具|出可用工具|出所有工具|出功能)"),
    # 有哪些工具 / 有哪些可用工具 / 有哪些功能
    re.compile(r"^(?:有|有哪些|有什么|有哪些工具|有哪些可用工具|哪些|哪些工具|哪些可用工具|哪些可用|哪些工具)"),
    # 当前工具 / 当前可用工具 / 现在工具
    re.compile(r"^(?:当前|当前工具|当前可用|当前可用工具|现在|现在工具|现在可用|现在可用工具)"),
    # 显示工具 / 查看工具列表 / 看看工具
    re.compile(r"^(?:显示|显示工具|显示可用|显示可用工具|查看|查看工具|查看工具列表|看看|看看工具)"),
    # 工具列表 / 功能清单 (standalone phrase only)
    re.compile(r"^(?:工具列表|功能清单|工具清单|功能列表)"),
]

# Keywords that signal the user wants to execute a task (not just query tools).
_TASK_EXECUTION_KEYWORDS = [
    "执行", "测试", "验收", "运行", "创建", "生成", "调用", "完成",
    "实施", "开始", "构建", "设计", "开发", "实现", "处理", "操作",
    "制作", "编写", "调试", "修复", "优化", "分析", "检查",
    "验证", "导出", "导入", "上传", "下载", "部署", "启动", "停止",
]


def _is_tool_inventory_query(text: str) -> bool:
    """Check if the user is explicitly asking for a tool inventory list.

    Must be a direct query about available tools, NOT a task that happens
    to mention tools (e.g. "执行工具链测试" is a task, not a query).
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    # Skip commands (starting with /)
    if cleaned.startswith("/"):
        return False
    # Check English patterns first
    if any(p.search(cleaned) for p in _TOOL_QUERY_PATTERNS):
        return True
    # Check strict Chinese patterns (must start with the phrase)
    return any(p.search(cleaned) for p in _TOOL_QUERY_KEYWORDS_ZH)


def _is_task_execution_request(text: str) -> bool:
    """Check if the user is requesting task execution (vs pure information query).

    Tasks that should always enter the Agent Loop include requests that:
    - Create something
    - Execute operations
    - Run tests or validations
    - Build or generate outputs
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    return any(keyword in cleaned for keyword in _TASK_EXECUTION_KEYWORDS)


def _render_tool_inventory(engine: AgentEngine) -> str:
    schemas = sorted(engine.tool_schemas, key=lambda s: s.name)
    if not schemas:
        return "\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u5de5\u5177\u3002"

    mcp_tools = [s for s in schemas if "__" in s.name]
    builtin_tools = [s for s in schemas if "__" not in s.name]

    lines = ["\u4ee5\u4e0b\u662f\u5f53\u524d\u4f1a\u8bdd\u91cc\u771f\u5b9e\u53ef\u8c03\u7528\u7684\u5de5\u5177\uff1a"]
    if _config and _config.mcp_servers and not mcp_tools:
        configured = ", ".join(sorted(_config.mcp_servers.keys()))
        lines.append("")
        lines.append(
            "\u8b66\u544a\uff1a\u5df2\u914d\u7f6e MCP \u670d\u52a1\u5668"
            f" ({configured})\uff0c\u4f46\u5f53\u524d\u4f1a\u8bdd\u6ca1\u6709\u6210\u529f\u8fde\u4e0a\u5b83\u4eec\u3002"
        )
        lines.append(
            "\u8fd9\u901a\u5e38\u610f\u5473\u7740\u540e\u7aef\u542f\u52a8\u65f6 MCP \u8fde\u63a5\u5931\u8d25\uff0c"
            "\u8bf7\u91cd\u542f\u540e\u7aef\u5e76\u65b0\u5efa\u4f1a\u8bdd\uff0c\u540c\u65f6\u67e5\u770b\u65e5\u5fd7\u91cc "
            "'Failed to connect MCP Server' \u6216 'connect attempt' \u76f8\u5173\u4fe1\u606f\u3002"
        )
    if mcp_tools:
        lines.append("")
        lines.append("MCP \u5de5\u5177\uff1a")
        for s in mcp_tools:
            desc = (s.description or "").strip()
            lines.append(f"- {s.name}: {desc}")
    if builtin_tools:
        lines.append("")
        lines.append("\u5185\u5efa\u5de5\u5177\uff1a")
        for s in builtin_tools:
            desc = (s.description or "").strip()
            lines.append(f"- {s.name}: {desc}")
    return "\n".join(lines)


async def _respond_with_local_text(
    session_id: str,
    engine: AgentEngine,
    user_text: str,
    assistant_text: str,
) -> None:
    user_msg = Message(role="user", content=[TextBlock(text=user_text)])
    assistant_msg = Message(role="assistant", content=[TextBlock(text=assistant_text)])

    async with engine._state_lock:
        engine._messages.append(user_msg)
        engine._messages.append(assistant_msg)

    for listener in list(engine._message_listeners):
        try:
            await listener(assistant_msg)
        except Exception:
            pass

    try:
        rec = await _session_store.load(session_id)
        meta = dict(rec.metadata) if rec and isinstance(rec.metadata, dict) else None
    except Exception:
        meta = None

    try:
        await _session_store.save(session_id, engine._messages, metadata=meta)
    except Exception:
        pass

    await engine._notify_state_listeners()


# ── Session routes ─────────────────────────────────────────────────────

@app.post("/sessions", status_code=201)
async def create_session(req: CreateSessionRequest) -> dict[str, Any]:
    cfg = _require_config()

    provider_name, system_prompt, allowed_tools = _resolve_session_config(req, cfg)

    if provider_name not in cfg.providers:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{provider_name}' not found in config. "
                   f"Available: {list(cfg.providers.keys())}",
        )

    session_id = req.session_id or str(uuid.uuid4())
    # If restoring an existing session, load its previous question_mode
    question_mode = "question"
    persona_default_approval = ""
    if req.persona:
        try:
            persona_meta = load_persona(req.persona)
            persona_default_approval = str(persona_meta.get("default_approval_mode", ""))
        except Exception:
            persona_default_approval = ""
    approval_mode = (
        req.approval_mode
        if req.approval_mode in ("ask", "auto", "full")
        else persona_default_approval
        if persona_default_approval in ("ask", "auto", "full")
        else "ask"
    )
    restored_meta: dict[str, Any] = {}
    restored_messages: list[Message] = []
    try:
        rec = await _session_store.load(session_id)
        if rec and isinstance(rec.metadata, dict):
            restored_meta = dict(rec.metadata)
            restored_messages = list(rec.messages)
            question_mode = rec.metadata.get("question_mode", "question") or "question"
            # Only honor a *stored* approval_mode when the caller didn't
            # explicitly pick one in this request body — that way the new
            # modal can pick a mode for already-persisted sessions.
            if not req.approval_mode:
                stored_am = rec.metadata.get("approval_mode")
                if stored_am in ("ask", "auto", "full"):
                    approval_mode = stored_am
    except Exception:
        pass
    engine, mcp_clients = await _build_session_engine(
        session_id=session_id,
        provider_name=provider_name,
        cfg=cfg,
        system_prompt=system_prompt,
        allowed_tools=allowed_tools,
        persona_name=req.persona,
        question_mode=question_mode,
        approval_mode=approval_mode,
    )
    if session_id in _engines:
        await _close_session_mcp_clients(session_id)
    await engine.restore_from_store()
    _attach_engine_meta_sync(session_id, engine)
    _engines[session_id] = engine
    _engine_mcp_clients[session_id] = mcp_clients
    _engine_meta[session_id] = {
        **restored_meta,
        "provider": provider_name,
        "persona":  req.persona,
        "question_mode": question_mode,
        "approval_mode": approval_mode,
    }
    # Ensure the session appears in the persistent store immediately
    try:
        await _session_store.save(
            session_id,
            restored_messages,
            metadata=dict(_engine_meta[session_id]),
        )
    except Exception:
        pass
    return {
        "session_id": session_id,
        "provider":   provider_name,
        "persona":    req.persona,
    }


@app.post("/sessions/{session_id}/messages")
async def send_message(session_id: str, req: SendMessageRequest) -> dict[str, Any]:
    if _engine_meta.get(session_id, {}).get("model_config_stale"):
        await _refresh_session_engine(session_id)
    engine = _get_engine(session_id)

    # Route decision:
    # - If the user is explicitly querying the tool inventory (not executing a task),
    #   respond locally without entering the agent loop.
    # - Tasks always enter the Agent Loop, even if they mention tools.
    is_tool_query = _is_tool_inventory_query(req.text)
    is_task_request = _is_task_execution_request(req.text)

    if is_tool_query and not is_task_request:
        snap = await engine.get_snapshot()
        if not snap.get("is_running"):
            await _respond_with_local_text(
                session_id=session_id,
                engine=engine,
                user_text=req.text,
                assistant_text=_render_tool_inventory(engine),
            )
            return {"status": "completed-locally"}

    result = await engine.send_message(req.text)
    # result == {"status": "started"|"queued", "queued": bool,
    #            "index": int|None, "text": str,
    #            "pending_commands": [...]} — pass through verbatim so
    # the frontend can show queued items in a dedicated panel.
    return result


@app.patch("/sessions/{session_id}/messages/{message_id}")
async def rewrite_message(
    session_id: str, message_id: str,
    re_run: bool = False,
    req: RewriteMessageRequest | None = None,
) -> dict[str, Any]:
    """
    Rewrite a user message by message_id and roll back all subsequent messages.

    Body: { "text": "new message content" }
    Query param re_run=true: immediately re-execute from the rewritten message.

    Status codes:
      200 — rewrite succeeded; result has {found: True, busy: False, ...}
      404 — message_id not found
      409 — engine is RUNNING (must cancel first)
      422 — target is the synthetic system prompt (idx 0 role=system)

    Returns {found, busy, is_system, rollback_count, session_version}.
    """
    engine = _get_engine(session_id)
    if req is None:
        raise HTTPException(status_code=400, detail="Request body required")
    new_text = (req.text or "").strip()
    if not new_text:
        raise HTTPException(status_code=400, detail="text must be non-empty")
    result = await engine.rewrite_message(message_id, new_text)
    if not result["found"]:
        raise HTTPException(status_code=404, detail=f"Message {message_id!r} not found")
    if result.get("busy"):
        # Engine is RUNNING — frontend should disable the edit button during RUNNING.
        raise HTTPException(
            status_code=409,
            detail=(
                "Engine is currently RUNNING. Cancel the current run before "
                "rewriting a historical message."
            ),
        )
    if result.get("is_system"):
        # Refuse to edit the synthetic system prompt; return 422 (Unprocessable Entity)
        raise HTTPException(
            status_code=422,
            detail="Cannot edit the synthetic system prompt",
        )
    if re_run:
        # Fire-and-forget — re_run_from is async and non-blocking
        result["re_run_triggered"] = True
        asyncio.create_task(engine.re_run_from(message_id))
    return result


@app.get("/sessions/{session_id}/state")
async def get_state(session_id: str) -> dict[str, Any]:
    engine = _engines.get(session_id)
    if engine is None:
        # Session not in memory — try to restore from persistent store
        stored = await _session_store.load(session_id)
        if stored is None:
            raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
        # Auto-restore engine
        cfg = _require_config()
        store_meta = stored.metadata if isinstance(stored.metadata, dict) else {}
        stored_provider = store_meta.get("provider")
        provider_name = stored_provider or cfg.default_provider
        if provider_name not in cfg.providers:
            # Stored provider name is stale (renamed/removed in config.yaml).
            # Fall back to default; only raise if the default itself is gone,
            # which means the server is in an unrecoverable config state.
            fallback = cfg.default_provider
            if fallback not in cfg.providers:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"Session '{session_id}' was created with provider "
                        f"'{stored_provider}' which no longer exists in "
                        f"config.yaml, AND default_provider "
                        f"'{fallback}' is also missing. "
                        f"Available: {list(cfg.providers.keys())}"
                    ),
                )
            import logging
            logging.getLogger("harness.api").warning(
                "Session %s stored provider '%s' not in config; "
                "falling back to default '%s'",
                session_id, provider_name, fallback,
            )
            provider_name = fallback
        question_mode = store_meta.get("question_mode", "question") or "question"
        approval_mode = store_meta.get("approval_mode", "ask") or "ask"
        if approval_mode not in ("ask", "auto", "full"):
            approval_mode = "ask"
        engine, mcp_clients = await _build_session_engine(
            session_id=session_id,
            provider_name=provider_name,
            cfg=cfg,
            system_prompt="",
            allowed_tools=None,
            persona_name=str(store_meta.get("persona", "")),
            question_mode=question_mode,
            approval_mode=approval_mode,
        )
        await engine.restore_from_store()
        _attach_engine_meta_sync(session_id, engine)
        _engines[session_id] = engine
        _engine_mcp_clients[session_id] = mcp_clients
        _engine_meta[session_id] = {
            "provider": provider_name,
            "persona": store_meta.get("persona", ""),
            "question_mode": question_mode,
            "approval_mode": approval_mode,
        }
    snapshot = await engine.get_snapshot()
    meta = dict(_engine_meta.get(session_id, {}))
    try:
        rec = await _session_store.load(session_id)
        if rec and isinstance(rec.metadata, dict):
            store_meta = rec.metadata
            # Durable identity fields should come from the session record.
            # Sub-agent engines are created from spawn_agent and may already be
            # live in _engines before _engine_meta has been populated for that
            # child. If we only trust _engine_meta, the UI can show the parent
            # persona (for example design-primary) while the child prompt is
            # actually design-research/design-designer.
            for key in (
                "persona",
                "provider",
                "spawn_depth",
                "parent_session_id",
                "question_mode",
                "approval_mode",
                "active_run_id",
            ):
                if key in store_meta and store_meta.get(key) not in (None, ""):
                    meta[key] = store_meta.get(key)
            if not meta.get("title"):
                meta["title"] = store_meta.get("title", "")
            if not meta.get("display_name"):
                meta["display_name"] = store_meta.get("display_name", "")
    except Exception:
        pass
    if meta:
        _engine_meta[session_id] = {**_engine_meta.get(session_id, {}), **meta}
    snapshot["meta"] = meta
    return snapshot


def _run_id_from_messages(messages: list[Message]) -> str:
    """Recover bindings for sessions created before active_run_id existed."""
    for message in reversed(messages):
        for block in reversed(message.content):
            if getattr(block, "tool_name", "") != "run_init":
                continue
            try:
                payload = json.loads(str(getattr(block, "content", "") or ""))
            except json.JSONDecodeError:
                continue
            run_id = str(payload.get("runId") or "").strip() if isinstance(payload, dict) else ""
            if run_id:
                return run_id
    return ""


@app.get("/sessions/{session_id}/canvas-assets")
async def get_canvas_assets(session_id: str) -> dict[str, Any]:
    record = await _session_store.load(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    metadata = dict(record.metadata) if isinstance(record.metadata, dict) else {}
    run_id = str(metadata.get("active_run_id") or "")
    if not run_id:
        run_id = _run_id_from_messages(record.messages)
        if run_id:
            metadata["active_run_id"] = run_id
            await _session_store.save(session_id, record.messages, metadata=metadata)
            _engine_meta.setdefault(session_id, {})["active_run_id"] = run_id
    if not run_id:
        return {
            "runId": "",
            "source": "",
            "revision": "0",
            "assets": [],
            "canvasState": None,
            "galleryUrl": "",
        }
    try:
        return build_canvas_asset_index(RUNS_DIR, OUTPUTS_DIR, run_id)
    except (CanvasPublishError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.patch("/sessions/{session_id}/canvas-run")
async def bind_canvas_run(
    session_id: str, req: CanvasRunBindingRequest
) -> dict[str, Any]:
    record = await _session_store.load(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    try:
        run_id = validate_run_id(req.run_id)
        index = build_canvas_asset_index(RUNS_DIR, OUTPUTS_DIR, run_id)
    except (CanvasPublishError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    metadata = dict(record.metadata) if isinstance(record.metadata, dict) else {}
    metadata["active_run_id"] = run_id
    await _session_store.save(session_id, record.messages, metadata=metadata)
    _engine_meta.setdefault(session_id, {})["active_run_id"] = run_id
    engine = _engines.get(session_id)
    if engine is not None:
        await engine._emit_event({
            "type": "canvas.run_bound",
            "data": {"runId": run_id, "sourceSessionId": session_id},
        })
    return {
        "session_id": session_id,
        "active_run_id": run_id,
        "asset_count": len(index.get("assets", [])),
    }


@app.post("/sessions/{session_id}/continue")
async def continue_session(session_id: str) -> dict[str, Any]:
    engine = _engines.get(session_id)
    if engine is None:
        await get_state(session_id)
        engine = _engines.get(session_id)
    if engine is None:
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' not found",
        )
    return await engine.continue_if_needed()


@app.post("/sessions/{session_id}/recover")
async def recover_session(session_id: str) -> dict[str, Any]:
    engine = _engines.get(session_id)
    if engine is None:
        await get_state(session_id)
        engine = _engines.get(session_id)
    if engine is None:
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' not found",
        )
    return await engine.recover_if_possible()


@app.get("/memory")
async def list_memory(
    query: str = "",
    scope: str = "",
    limit: int = 50,
) -> dict[str, Any]:
    entries = await _memory_store.search(
        query=query,
        scope=scope,
        limit=max(1, min(limit, 100)),
    )
    return {"memories": [asdict(entry) for entry in entries]}


@app.post("/memory", status_code=201)
async def add_memory(req: MemoryAddRequest) -> dict[str, Any]:
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content must be non-empty")
    entry = await _memory_store.add(
        content=content,
        scope=(req.scope or "global").strip() or "global",
        tags=req.tags or [],
        created_by_session=req.session_id,
    )
    return {"memory": asdict(entry)}


@app.delete("/memory/{entry_id}", status_code=204)
async def delete_memory(entry_id: str):
    deleted = await _memory_store.delete(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Memory '{entry_id}' not found")
    return Response(status_code=204)


@app.post("/sessions/{session_id}/cancel")
async def cancel_session(session_id: str) -> dict[str, Any]:
    engine = _get_engine(session_id)
    await engine.cancel()
    return {"status": "cancel_requested"}


@app.post("/sessions/{session_id}/confirm")
async def confirm_action(session_id: str) -> dict[str, Any]:
    engine = _get_engine(session_id)
    await engine.confirm()
    return {"status": "confirmed"}


@app.post("/sessions/{session_id}/deny")
async def deny_action(session_id: str) -> dict[str, Any]:
    engine = _get_engine(session_id)
    await engine.deny()
    return {"status": "denied"}


@app.delete("/sessions/{session_id}/pending/{index}")
async def cancel_pending_command(session_id: str, index: int) -> dict[str, Any]:
    """
    Cancel a queued command (pending_commands index) or pending sub-agent spawn.
    Returns {"cancelled": true} if found, 404 otherwise.
    """
    engine = _get_engine(session_id)

    # Try pending commands first
    if await engine.cancel_pending_command(index):
        return {"cancelled": True, "type": "command", "index": index}

    # Try pending spawns
    if await engine.cancel_pending_spawn(index):
        return {"cancelled": True, "type": "spawn", "index": index}

    raise HTTPException(status_code=404, detail=f"Pending item {index} not found")


@app.patch("/sessions/{session_id}/mode")
async def set_session_mode(session_id: str, req: SetModeRequest) -> dict[str, Any]:
    """
    Update a session's question mode ("question" or "noquestion").
    Toggling on at runtime registers the ask_user tool on the existing engine.
    Toggling off unregisters it (the LLM will no longer see it in its tool list).
    """
    engine = _get_engine(session_id)
    new_mode = await engine.set_question_mode(req.question_mode)
    if _engine_meta.get(session_id) is not None:
        _engine_meta[session_id]["question_mode"] = new_mode

    # Update tool registry: register or unregister ask_user
    try:
        from harness.tools.builtin.ask_user import (
            ASK_USER_SCHEMA, make_ask_user_tool,
        )
        reg = engine._tool_registry
        existing = {t.schema.name for t in reg.discover()} if reg else set()
        if new_mode == "question" and "ask_user" not in existing:
            reg.register(ASK_USER_SCHEMA, make_ask_user_tool(engine))
        elif new_mode == "noquestion" and "ask_user" in existing:
            reg.unregister("ask_user")
    except Exception as e:
        # Tool registry update is best-effort
        pass

    # Push state so frontend sees the change
    await engine._notify_state_listeners()
    return {"session_id": session_id, "question_mode": new_mode}


@app.patch("/sessions/{session_id}/approval-mode")
async def set_session_approval_mode(
    session_id: str, req: SetApprovalModeRequest
) -> dict[str, Any]:
    """
    Update a session's approval mode at runtime ("ask" | "auto" | "full").

    Takes effect on the NEXT tool call — the in-flight one, if any, is
    unaffected. Persists to session metadata so the mode survives restarts.
    """
    engine = _get_engine(session_id)
    new_mode = await engine.set_approval_mode(req.approval_mode)
    if _engine_meta.get(session_id) is not None:
        _engine_meta[session_id]["approval_mode"] = new_mode

    # Push state so frontend sees the change
    await engine._notify_state_listeners()
    return {"session_id": session_id, "approval_mode": new_mode}


@app.post("/sessions/{session_id}/clarifications")
async def submit_clarification(
    session_id: str, req: ClarificationAnswerRequest
) -> dict[str, Any]:
    """
    Submit the user's answer to a pending clarification question.
    Unblocks the running ask_user tool and lets the loop continue.
    """
    engine = _get_engine(session_id)
    result = await engine.submit_clarification_answer(req.request_id, req.answer)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("detail", "not found"))
    return result


# ── New OpenCode-style question endpoints ──────────────────────────────────
#
# These coexist with the legacy /clarifications endpoints. Frontends that
# already speak the old shape keep working; new clients should prefer these.

@app.post("/sessions/{session_id}/questions/{request_id}/reply")
async def reply_to_question(
    session_id: str, request_id: str, req: QuestionReplyRequest
) -> dict[str, Any]:
    """
    Submit answers for a pending question request.

    Body: { "answers": [["opt1", "opt2"], ["opt3"]] }
      - answers.length must equal questions.length (validated server-side)
      - per-question validation: see harness.types.questions.validate_answers_against_questions

    Returns {"ok": true, ...} or raises 404 / 400 with {"detail": ...}.
    The agent run resumes immediately on success.
    """
    engine = _get_engine(session_id)
    result = await engine.submit_question_reply(request_id, req.answers)
    if result.get("ok"):
        return result
    # Validation failures → 400; missing request → 404
    code = result.get("code")
    if code == "invalid_answers":
        raise HTTPException(status_code=400, detail=result.get("detail", "invalid"))
    raise HTTPException(status_code=404, detail=result.get("detail", "not found"))


@app.post("/sessions/{session_id}/questions/{request_id}/reject")
async def reject_question(session_id: str, request_id: str) -> dict[str, Any]:
    """
    Skip / reject a pending question. The agent run resumes with a synthetic
    "user skipped" message; the LLM is expected to proceed with defaults.
    """
    engine = _get_engine(session_id)
    result = await engine.reject_question(request_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("detail", "not found"))
    return result


@app.get("/sessions")
async def list_sessions() -> dict[str, Any]:
    sessions: list[dict[str, Any]] = []
    try:
        store_records = await _session_store.list_sessions()
    except Exception:
        store_records = []

    seen: set[str] = set()
    for rec in store_records:
        seen.add(rec.session_id)
        eng = _engines.get(rec.session_id)
        meta = dict(_engine_meta.get(rec.session_id, {}))
        store_meta = rec.metadata if isinstance(rec.metadata, dict) else {}
        sessions.append({
            "session_id": rec.session_id,
            "state": eng._sm.state.name if eng else "COMPLETED",
            "persona": meta.get("persona", store_meta.get("persona", "")),
            "provider": meta.get("provider", store_meta.get("provider", "")),
            "title": meta.get("title", "") or store_meta.get("title", getattr(rec, "title", "")),
            "display_name": rec.display_name or store_meta.get("display_name", ""),
            "pinned": rec.pinned,
            "archived": rec.archived,
            "spawn_depth": meta.get("spawn_depth", store_meta.get("spawn_depth", 0)),
            "parent_session_id": meta.get("parent_session_id", store_meta.get("parent_session_id", "")),
            "question_mode": eng.get_question_mode() if eng else store_meta.get("question_mode", "noquestion"),
            "active_run_id": meta.get("active_run_id", store_meta.get("active_run_id", "")),
        })

    for sid, eng in _engines.items():
        if sid not in seen:
            meta = _engine_meta.get(sid, {})
            sessions.append({
                "session_id": sid,
                "state": eng._sm.state.name,
                "persona": meta.get("persona", ""),
                "provider": meta.get("provider", ""),
                "title": meta.get("title", ""),
                "display_name": meta.get("display_name", ""),
                "pinned": False,
                "archived": False,
                "spawn_depth": meta.get("spawn_depth", 0),
                "parent_session_id": meta.get("parent_session_id", ""),
                "question_mode": eng.get_question_mode(),
                "active_run_id": meta.get("active_run_id", ""),
            })
    return {"sessions": sessions}


@app.patch("/sessions/{session_id}")
async def update_session(session_id: str, req: UpdateSessionRequest) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if req.display_name is not None:
        kwargs["display_name"] = req.display_name
    if req.pinned is not None:
        kwargs["pinned"] = req.pinned
    if req.archived is not None:
        kwargs["archived"] = req.archived
    if req.persona is not None:
        engine = _engines.get(session_id)
        if engine is None:
            raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
        if req.persona == "":
            # Clear persona — use empty system_prompt
            await engine.set_persona("", "")
            _engine_meta[session_id]["persona"] = ""
        else:
            try:
                persona = load_persona(req.persona)
            except ValueError as e:
                raise HTTPException(status_code=404, detail=str(e))
            sp = persona.get("system_prompt", "")
            await engine.set_persona(req.persona, sp)
            _engine_meta[session_id]["persona"] = req.persona
    if kwargs:
        await _session_store.update_metadata(session_id, **kwargs)
    result: dict[str, Any] = {"status": "updated", "session_id": session_id}
    if req.persona is not None:
        result["persona"] = req.persona
    return result


@app.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, cascade: bool = False):
    engine = _engines.pop(session_id, None)
    if engine is not None:
        await engine.cancel()
        _engine_meta.pop(session_id, None)
    await _close_session_mcp_clients(session_id)

    if cascade:
        # Recursively delete all descendant sessions
        all_records = await _session_store.list_sessions()
        children = _find_descendants(session_id, all_records)
        for child_id in children:
            child_engine = _engines.pop(child_id, None)
            if child_engine is not None:
                await child_engine.cancel()
                _engine_meta.pop(child_id, None)
            await _close_session_mcp_clients(child_id)
            await _session_store.delete(child_id)

    # Always delete from persistent store
    await _session_store.delete(session_id)


def _find_descendants(root_id: str, records: list) -> set[str]:
    """Recursively find all descendant session IDs given a root parent."""
    by_parent: dict[str, list[str]] = {}
    for r in records:
        pid = (r.metadata or {}).get("parent_session_id", "")
        if pid:
            by_parent.setdefault(pid, []).append(r.session_id)
    result: set[str] = set()
    stack = [root_id]
    while stack:
        pid = stack.pop()
        for child_id in by_parent.get(pid, []):
            if child_id not in result:
                result.add(child_id)
                stack.append(child_id)
    return result


# ── Config overview ────────────────────────────────────────────────────

@app.get("/config/overview")
async def config_overview() -> dict[str, Any]:
    """All config data needed to render the frontend sidebar."""
    cfg = _require_config()
    providers = list(cfg.providers.keys())
    return {
        "skills":           list_skills(),
        "personas":         list_personas(),      # [{name, description}]
        "providers":        providers,
        "default_provider": cfg.default_provider if cfg.default_provider in providers else (providers[0] if providers else ""),
        "tools_enabled":    cfg.tools.enabled,
    }


# ── Skills CRUD (folder-based) ─────────────────────────────────────────

@app.get("/settings/runtime-env")
async def api_get_runtime_env_settings() -> dict[str, Any]:
    cfg = _require_config()
    values = _derive_env_defaults(_read_managed_env_values())
    masked = dict(values)
    for key in list(masked):
        if "API_KEY" in key and masked[key]:
            masked[key] = "********" + masked[key][-4:]
    return {
        "keys": MANAGED_ENV_KEYS,
        "values": values,
        "masked": masked,
        "providers": list(cfg.providers.keys()),
        "default_provider": cfg.default_provider,
        "env_path": str(ENV_SETTINGS_FILE.as_posix()),
    }


def _public_module(module: dict[str, Any]) -> dict[str, Any]:
    public = dict(module)
    api_key = str(public.pop("api_key", "") or "")
    public["has_api_key"] = bool(api_key)
    public["api_key_hint"] = f"••••{api_key[-4:]}" if api_key else ""
    return public


@app.get("/settings/model-modules")
async def api_get_model_modules() -> dict[str, Any]:
    api_logger.info("settings model modules requested")
    settings = _load_dreamatic_settings()
    modules = _normalize_modules(settings.get("modules", {}))
    return {
        "version": 2,
        "modules": {key: _public_module(value) for key, value in modules.items()},
        "settings_path": str(DREAMATIC_SETTINGS_FILE.as_posix()),
    }


@app.put("/settings/model-modules/{module_id}")
async def api_save_model_module(module_id: str, req: ModelModuleRequest) -> dict[str, Any]:
    if module_id not in MODEL_MODULE_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown model module '{module_id}'")
    api_logger.info("settings model module save requested module=%s", module_id)
    settings = _load_dreamatic_settings()
    modules = _normalize_modules(settings.get("modules", {}))
    incoming = dict(req.module)
    if not str(incoming.get("api_key") or "").strip():
        incoming["api_key"] = modules[module_id].get("api_key", "")
    modules[module_id] = _normalize_model_module(module_id, incoming)
    _save_dreamatic_settings({"version": 2, "modules": modules})
    _reload_runtime_config()
    if module_id in {"agent", "compression"}:
        await _refresh_idle_session_engines()
    return {
        "status": "saved",
        "module_id": module_id,
        "module": _public_module(modules[module_id]),
    }


@app.post("/settings/model-modules/import-env")
async def api_import_model_modules_from_env(req: RuntimeEnvImportRequest) -> dict[str, Any]:
    api_logger.info("settings module env recognition requested chars=%s", len(req.content or ""))
    parsed = _parse_env_content(req.content)
    values = {key: parsed.get(key, "") for key in MANAGED_ENV_KEYS}
    modules = _modules_from_env(values)
    return {
        "status": "recognized",
        "modules": modules,
        "recognized_keys": sorted(k for k in parsed if k in MANAGED_ENV_KEYS),
        "ignored_keys": sorted(k for k in parsed if k not in MANAGED_ENV_KEYS),
    }


@app.put("/settings/runtime-env")
async def api_save_runtime_env_settings(req: RuntimeEnvSettingsRequest) -> dict[str, Any]:
    current = _read_managed_env_values()
    incoming = {
        key: str(req.values.get(key, current.get(key, "")) or "")
        for key in MANAGED_ENV_KEYS
    }
    values = _derive_env_defaults(incoming)
    _write_managed_env_values(values)
    _apply_runtime_env(values)
    _reload_runtime_config()
    cfg = _require_config()
    return {
        "status": "saved",
        "providers": list(cfg.providers.keys()),
        "default_provider": cfg.default_provider,
        "env_path": str(ENV_SETTINGS_FILE.as_posix()),
    }


@app.post("/settings/runtime-env/import")
async def api_import_runtime_env_settings(req: RuntimeEnvImportRequest) -> dict[str, Any]:
    parsed = _parse_env_content(req.content)
    current = _read_managed_env_values()
    imported = {key: parsed[key] for key in MANAGED_ENV_KEYS if key in parsed}
    values = _derive_env_defaults({**current, **imported})
    _write_managed_env_values(values)
    _apply_runtime_env(values)
    _reload_runtime_config()
    cfg = _require_config()
    return {
        "status": "imported",
        "imported_keys": sorted(imported.keys()),
        "ignored_keys": sorted(k for k in parsed.keys() if k not in MANAGED_ENV_KEYS),
        "providers": list(cfg.providers.keys()),
        "default_provider": cfg.default_provider,
        "env_path": str(ENV_SETTINGS_FILE.as_posix()),
    }


@app.get("/config/skills")
async def api_list_skills() -> dict[str, Any]:
    skills = list_skills(include_paths=True)
    for skill in skills:
        skill["editable"] = skill.get("source") in {"project", "project-claude"}
    return {"skills": skills}


@app.get("/config/skills/{name}")
async def api_get_skill(name: str) -> dict[str, Any]:
    _check_safe_name(name)
    try:
        meta = load_skill(name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    source_file = meta.get("_source_file")
    if not source_file:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")

    path = Path(str(source_file))
    fmt = "folder" if path.name == "SKILL.md" else "md"
    return {
        "name": name,
        "content": path.read_text(encoding="utf-8"),
        "format": fmt,
        "source": meta.get("_source", ""),
        "path": str(meta.get("_display_path", path.as_posix())),
        "editable": meta.get("_source", "") in {"project", "project-claude"},
    }


@app.put("/config/skills/{name}")
async def api_save_skill(name: str, req: ConfigWriteRequest) -> dict[str, Any]:
    _check_safe_name(name)
    existing = _find_skill_meta(name)
    if existing is not None and existing.get("_source") not in {"project", "project-claude"}:
        raise HTTPException(
            status_code=403,
            detail=f"Skill '{name}' is read-only because it comes from a global directory",
        )
    resolved = resolve_project_skill_path(name)
    target = resolved[0] if resolved is not None else (SKILLS_DIR / name / "SKILL.md")
    write_file_safe(target, req.content)
    return {"status": "saved", "name": name, "path": str(target.as_posix())}


@app.post("/config/skills")
async def api_create_skill(req: CreateFileRequest) -> dict[str, Any]:
    _check_safe_name(req.name)
    path = SKILLS_DIR / req.name / "SKILL.md"
    if path.exists():
        raise HTTPException(status_code=409, detail=f"Skill '{req.name}' already exists")
    write_file_safe(path, req.content)
    return {"status": "created", "name": req.name, "path": str(path.as_posix())}


@app.delete("/config/skills/{name}", status_code=204)
async def api_delete_skill(name: str):
    import shutil
    _check_safe_name(name)
    existing = _find_skill_meta(name)
    if existing is not None and existing.get("_source") not in {"project", "project-claude"}:
        raise HTTPException(
            status_code=403,
            detail=f"Skill '{name}' is read-only because it comes from a global directory",
        )
    resolved = resolve_project_skill_path(name)
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")

    skill_path, _source = resolved
    if skill_path.name == "SKILL.md" and skill_path.parent.is_dir():
        shutil.rmtree(skill_path.parent)
        return
    if skill_path.exists():
        skill_path.unlink()
        return
    raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")


# ── Personas CRUD ──────────────────────────────────────────────────────

@app.get("/config/personas")
async def api_list_personas() -> dict[str, Any]:
    return {"personas": list_personas()}


@app.get("/config/agents")
async def api_list_agents(include_hidden: bool = True) -> dict[str, Any]:
    return {"agents": list_agent_profiles(include_hidden=include_hidden)}


@app.get("/config/personas/{name}")
async def api_get_persona(name: str) -> dict[str, Any]:
    path = PERSONAS_DIR / f"{name}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Persona '{name}' not found")
    return {"name": name, "content": path.read_text(encoding="utf-8")}


@app.put("/config/personas/{name}")
async def api_save_persona(name: str, req: ConfigWriteRequest) -> dict[str, Any]:
    _check_safe_name(name)
    write_file_safe(PERSONAS_DIR / f"{name}.md", req.content)
    return {"status": "saved", "name": name}


@app.post("/config/personas")
async def api_create_persona(req: CreateFileRequest) -> dict[str, Any]:
    _check_safe_name(req.name)
    path = PERSONAS_DIR / f"{req.name}.md"
    if path.exists():
        raise HTTPException(status_code=409, detail=f"Persona '{req.name}' already exists")
    write_file_safe(path, req.content)
    return {"status": "created", "name": req.name}


@app.delete("/config/personas/{name}", status_code=204)
async def api_delete_persona(name: str):
    path = PERSONAS_DIR / f"{name}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Persona '{name}' not found")
    path.unlink()


# ── config.yaml CRUD ───────────────────────────────────────────────────

@app.get("/config/yaml")
async def api_get_yaml() -> dict[str, Any]:
    path = Path("config.yaml")
    if not path.exists():
        raise HTTPException(status_code=404, detail="config.yaml not found")
    return {"content": path.read_text(encoding="utf-8")}


@app.put("/config/yaml")
async def api_save_yaml(req: ConfigWriteRequest) -> dict[str, Any]:
    import yaml
    try:
        yaml.safe_load(req.content)   # validate before writing
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")
    Path("config.yaml").write_text(req.content, encoding="utf-8")
    return {"status": "saved"}


# ── Canvas HTML publishing ─────────────────────────────────────────────

_CANVAS_PUBLISH_STAGES = {
    "preparing": (0, "正在整理画布内容"),
    "reading": (1, "正在读取图文资产"),
    "composing": (2, "AI 正在重新编排页面"),
    "validating": (3, "正在校验导出结果"),
    "completed": (4, "HTML 已导出"),
}


def _update_canvas_publish_job(job_id: str, stage: str, message: str = "") -> None:
    job = _canvas_publish_jobs.get(job_id)
    if not job:
        return
    current_index = _CANVAS_PUBLISH_STAGES.get(job.get("stage", "preparing"), (0, ""))[0]
    next_index, default_message = _CANVAS_PUBLISH_STAGES.get(stage, (current_index, message))
    if stage != "failed" and next_index < current_index:
        return
    job["stage"] = stage
    job["message"] = message or default_message
    job["updated_at"] = utc_now()


def _public_canvas_publish_job(job: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in job.items() if key != "session_id"}


async def _run_canvas_publish_job(
    job_id: str,
    session_engine: AgentEngine,
    persisted: dict[str, Any],
) -> None:
    job = _canvas_publish_jobs[job_id]
    run_id = persisted["run_id"]
    run_dir: Path = persisted["run_dir"]
    input_file: Path = persisted["publish_input_file"]
    canvas_state = persisted["state"]
    publish_input = persisted["publish_input"]
    output_name = str(job["output_filename"])
    output_html = run_dir / "artifacts" / output_name
    publisher_engine: AgentEngine | None = None
    try:
        job["status"] = "running"
        _update_canvas_publish_job(job_id, "reading")
        cfg = _require_config()
        provider_name = (
            session_engine._config.provider_name
            or _engine_meta.get(job["session_id"], {}).get("provider")
            or cfg.default_provider
        )
        if provider_name not in cfg.providers:
            provider_name = cfg.default_provider
        session_cfg = _session_config_for_provider(cfg, provider_name)
        domain_skill_name = infer_domain_skill_name(publish_input)
        skill_names = (
            "canvas-html-publishing",
            "default-production-stage",
            "visual-composition",
            domain_skill_name,
        )
        skill_prompts = []
        for skill_name in skill_names:
            loaded_skill = load_skill(skill_name, project_only=True)
            skill_prompts.append(
                f"\n\n# Loaded Skill: {skill_name}\n\n"
                + str(loaded_skill.get("system_prompt") or "")
            )
        publisher_provider_cfg = deepcopy(session_cfg.providers[provider_name])
        publisher_provider_cfg.max_tokens = max(publisher_provider_cfg.max_tokens, 8192)
        publisher_engine = build_engine(
                session_id=f"canvas-publish-{job_id}-designer",
                provider_cfg=publisher_provider_cfg,
                harness_cfg=session_cfg,
                session_store=MemorySessionStore(),
                memory_store=InMemoryMemoryStore(),
                plan_store=InMemoryPlanStore(),
                system_prompt="".join(skill_prompts),
                allowed_tools=["think", "read_file"],
                engine_registry={},
                provider_name=provider_name,
                agent_id="canvas-html-designer",
                question_mode="noquestion",
                approval_mode="full",
            )
        designer_fragments: list[str] = []

        async def _collect_designer_text(message: Message) -> None:
            if message.role != "assistant":
                return
            for block in message.content:
                if isinstance(block, TextBlock) and block.text:
                    designer_fragments.append(block.text)

        publisher_engine.add_message_listener(_collect_designer_text)
        for tool_name in ("spawn_agent", "spawn_agents", "use_skill", "list_skills", "write_file", "edit_file", "list_dir"):
            publisher_engine._tool_registry.unregister(tool_name)
        _canvas_publish_engines_by_job[job_id] = publisher_engine
        _update_canvas_publish_job(job_id, "composing")
        task = (
            "Act as the Designer for a bounded canvas HTML export. Production of images is "
            "already complete; apply only the gallery-presentation parts of the loaded Skills.\n\n"
            f"Read the sole content input at: {input_file.resolve()}\n"
            f"The final HTML will live at: {output_html.resolve()}\n\n"
            "Author a complete, polished, standalone responsive HTML design-review gallery. "
            "Return ONLY the full HTML document, starting with <!doctype html> and ending with "
            "</html>; do not use markdown fences and do not call write tools. Use inline CSS, "
            "local image paths relative to the artifacts directory (remove the leading "
            "'artifacts/' from assetPath), no scripts, no remote resources, and no data URLs. "
            "Derive a project-specific visual system from the supplied titles, descriptions, "
            "domain metadata, and image metadata. Include a strong hero, a sticky table-of-"
            "contents with working section anchors, responsive category sections, deliberate "
            "image hierarchy, asset ids, captions, and meaningful metadata tags. Include every "
            "non-decorative asset at least once; an anchor or hero image may be reused in a "
            "prominent overview as well as its detailed card when that improves hierarchy. "
            "Preserve every ordinary user text verbatim, but "
            "do not repeat chapter-title, caption-title, or caption-description text as separate "
            "blocks because those roles are already represented by section/card UI. Use only the "
            "exact assetPath values from the supplied input; never invent image filenames, paths, "
            "assets, project claims, or user copy, and do not read the original gallery, "
            "brief, plans, manifests, or any file other than the supplied publish input."
        )
        result_text = await asyncio.wait_for(publisher_engine.run_to_completion(task), timeout=300)
        authored_html: str | None = None
        for continuation_index in range(3):
            if job.get("status") == "cancelling":
                raise asyncio.CancelledError
            candidates = list(reversed(designer_fragments))
            candidates.append("\n".join(designer_fragments) if designer_fragments else result_text)
            for candidate in candidates:
                try:
                    authored_html = extract_authored_html(candidate)
                    break
                except CanvasPublishError:
                    continue
            if authored_html is not None:
                break
            if continuation_index == 2:
                break
            _update_canvas_publish_job(
                job_id,
                "composing",
                f"页面较长，正在继续生成（{continuation_index + 1}/2）",
            )
            await asyncio.wait_for(
                publisher_engine.run_to_completion(
                    "Your HTML output was truncated by the response token limit. Continue "
                    "exactly from the last emitted character. Do not restart the document, "
                    "do not repeat earlier markup, and finish all remaining sections plus "
                    "the closing </body></html> tags. Return only the continuation."
                ),
                timeout=300,
            )
        if authored_html is None:
            emitted_chars = sum(len(fragment) for fragment in designer_fragments)
            raise CanvasPublishError(
                "Designer output remained incomplete after continuation "
                f"({len(designer_fragments)} fragments, {emitted_chars} characters)"
            )
        if output_html.exists():
            output_html.unlink()
        authored_html = normalize_authored_image_paths(authored_html, publish_input)
        output_html.write_text(authored_html, encoding="utf-8")
        _update_canvas_publish_job(job_id, "validating")
        if not output_html.is_file():
            raise CanvasPublishError(f"The publishing task did not create {output_name}")
        validation = validate_published_html(output_html, run_dir, canvas_state)

        finalize_publish(
            OUTPUTS_DIR,
            run_id,
            run_dir,
            canvas_state,
            output_html,
            validation,
            output_name=output_name,
        )
        version = uuid.uuid4().hex[:8]
        job.update({
            "status": "completed",
            "html_url": f"/outputs/runs/{run_id}/final/artifacts/{output_name}?v={version}",
            "download_url": f"/outputs/runs/{run_id}/final/artifacts/{output_name}?v={version}",
            "manifest_url": f"/outputs/runs/{run_id}/final/canvas/canvas-publish-manifest.json?v={version}",
            "error": "",
        })
        _update_canvas_publish_job(job_id, "completed")
    except asyncio.TimeoutError:
        if publisher_engine is not None:
            await publisher_engine.cancel()
        job.update({"status": "failed", "stage": "failed", "message": "导出超时", "error": "The publishing task timed out"})
        job["updated_at"] = utc_now()
    except asyncio.CancelledError:
        if publisher_engine is not None:
            try:
                await publisher_engine.cancel()
            except Exception:
                api_logger.exception("Failed to stop canvas publisher engine (job=%s)", job_id)
        job.update({
            "status": "cancelled",
            "stage": "cancelled",
            "message": "导出已取消",
            "error": "",
            "updated_at": utc_now(),
        })
        raise
    except Exception as exc:
        api_logger.exception("Canvas HTML publishing failed (job=%s, run=%s)", job_id, run_id)
        detail = str(exc).strip() or exc.__class__.__name__
        job.update({"status": "failed", "stage": "failed", "message": "导出失败", "error": detail[:2000]})
        job["updated_at"] = utc_now()
    finally:
        _canvas_publish_engines_by_job.pop(job_id, None)


@app.post("/sessions/{session_id}/canvas-publish", status_code=202)
async def start_canvas_publish(session_id: str, req: CanvasPublishRequest) -> dict[str, Any]:
    session_engine = _get_engine(session_id)
    try:
        run_id = validate_run_id(req.run_id)
        embedded_assets = [
            asset.model_dump() if hasattr(asset, "model_dump") else asset.dict()
            for asset in req.embedded_assets
        ]
        persisted = persist_canvas_state(ROOT_DIR, OUTPUTS_DIR, run_id, req.canvas_state, embedded_assets)
    except CanvasPublishError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    now = utc_now()
    final_artifacts = OUTPUTS_DIR / "runs" / run_id / "final" / "artifacts"
    output_filename = next_gallery_export_name(persisted["run_dir"], final_artifacts)
    job = {
        "job_id": job_id,
        "session_id": session_id,
        "run_id": run_id,
        "output_filename": output_filename,
        "status": "queued",
        "stage": "preparing",
        "message": _CANVAS_PUBLISH_STAGES["preparing"][1],
        "html_url": "",
        "download_url": "",
        "manifest_url": "",
        "error": "",
        "created_at": now,
        "updated_at": now,
    }
    _canvas_publish_jobs[job_id] = job
    task = asyncio.create_task(_run_canvas_publish_job(job_id, session_engine, persisted))
    _canvas_publish_tasks.add(task)
    _canvas_publish_tasks_by_job[job_id] = task

    def _forget_publish_task(done_task: asyncio.Task) -> None:
        _canvas_publish_tasks.discard(done_task)
        if _canvas_publish_tasks_by_job.get(job_id) is done_task:
            _canvas_publish_tasks_by_job.pop(job_id, None)

    task.add_done_callback(_forget_publish_task)
    return _public_canvas_publish_job(job)


@app.get("/canvas-publish/jobs/{job_id}")
async def get_canvas_publish_job(job_id: str) -> dict[str, Any]:
    job = _canvas_publish_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Canvas publish job not found")
    return _public_canvas_publish_job(job)


@app.post("/canvas-publish/jobs/{job_id}/cancel")
async def cancel_canvas_publish_job(job_id: str) -> dict[str, Any]:
    job = _canvas_publish_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Canvas publish job not found")
    if job.get("status") in {"completed", "failed", "cancelled"}:
        return _public_canvas_publish_job(job)

    job.update({
        "status": "cancelling",
        "message": "正在取消导出",
        "updated_at": utc_now(),
    })
    publisher_engine = _canvas_publish_engines_by_job.get(job_id)
    if publisher_engine is not None:
        await publisher_engine.cancel()
    task = _canvas_publish_tasks_by_job.get(job_id)
    if task is None or task.done():
        job.update({
            "status": "cancelled",
            "stage": "cancelled",
            "message": "导出已取消",
            "error": "",
            "updated_at": utc_now(),
        })
        return _public_canvas_publish_job(job)

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    if job.get("status") == "cancelling":
        job.update({
            "status": "cancelled",
            "stage": "cancelled",
            "message": "导出已取消",
            "error": "",
            "updated_at": utc_now(),
        })
    return _public_canvas_publish_job(job)


# ── Commands ───────────────────────────────────────────────────────────

class ExecuteCommandRequest(BaseModel):
    args: dict[str, str] = {}


@app.get("/commands")
async def api_list_commands() -> dict[str, Any]:
    """Return all registered commands (builtin + custom)."""
    if _cmd_system is None:
        return {"commands": []}
    return {"commands": _cmd_system.list_all()}


@app.post("/sessions/{session_id}/commands/{command_id}")
async def api_execute_command(
    session_id: str,
    command_id: str,
    req: ExecuteCommandRequest,
) -> dict[str, Any]:
    """Execute a command inside a session.

    - For prompt commands: sends the resolved text to the AI engine.
    - For internal commands: executes the action and returns the result.
    - For commands needing args: if args are provided, substitutes them
      and sends; otherwise returns ``kind: "needs-args"`` so the
      frontend can prompt the user.
    """
    engine = _get_engine(session_id)
    if _cmd_system is None:
        raise HTTPException(status_code=503, detail="Command system not ready")

    cmd = _cmd_system.resolve(command_id)
    if cmd is None or cmd.handler is None:
        raise HTTPException(
            status_code=404,
            detail=f"Command '{command_id}' not found. Try GET /commands.",
        )

    meta = _engine_meta.get(session_id, {})
    ctx = CommandContext(
        engine=engine,
        config=_config,
        session_id=session_id,
        system_prompt="",
        allowed_tools=None,
        provider_name=meta.get("provider", ""),
    )

    result = cmd.handler(cmd, ctx)

    if result.kind == "prompt":
        await engine.send_message(result.prompt_text)
        return {"kind": "prompt", "text": result.prompt_text, "sent": True}

    if result.kind == "internal":
        msg = _execute_internal_action(result, engine)
        return {
            "kind": "internal",
            "action": result.action,
            "message": msg,
        }

    if result.kind == "needs-args":
        if req.args:
            filled = substitute_args(result.raw_content, req.args)
            await engine.send_message(filled)
            return {"kind": "prompt", "text": filled, "sent": True}
        return {
            "kind": "needs-args",
            "args_needed": result.args_needed,
            "command_id": result.command_id,
            "message": f"Command '{cmd.title}' requires parameters",
        }

    if result.kind == "error":
        raise HTTPException(status_code=400, detail=result.message)

    return {"kind": "none"}


def _execute_internal_action(
    result: CommandResult,
    engine: AgentEngine,
) -> str:
    """Execute an internal action synchronously and return a message string."""
    action = result.action

    if action == "help" and _cmd_system:
        cmds = _cmd_system.list_all()
        lines = ["Available commands:"]
        for c in cmds:
            params = f" [params: {', '.join(c['params'])}]" if c["params"] else ""
            lines.append(
                f"  {c['id']:<30} {c['title']:<20} {c['description']}{params}"
            )
        return "\n".join(lines)

    if action == "list-tools" and engine:
        schemas = sorted(engine.tool_schemas, key=lambda s: s.name)
        lines = ["Available tools:"]
        for s in schemas:
            desc = s.description or ""
            lines.append(f"  {s.name:<22} — {desc}")
        return "\n".join(lines)

    if action == "list-skills":
        from harness.skills import list_skills as _ls
        skills = _ls()
        if not skills:
            return "No skills available. Create: skills/<name>/SKILL.md"
        lines = ["Available skills:"]
        for s in skills:
            lines.append(f"  {s['name']:<28} {s.get('description', '')}")
        return "\n".join(lines)

    if action == "list-personas":
        from harness.skills import list_personas as _lp
        personas = _lp()
        if not personas:
            return "No personas available. Create: personas/<name>.md"
        lines = ["Available personas:"]
        for p in personas:
            desc = f" — {p.get('description', '')}" if p.get("description") else ""
            lines.append(f"  {p['name']}{desc}")
        return "\n".join(lines)

    if action == "show-state" and engine:
        import asyncio
        snap = asyncio.run(engine.get_snapshot())
        return (
            f"State: {snap['state']}  "
            f"Messages: {len(snap.get('last_messages', []))}"
        )

    return f"Action: {action}"


# ── Helpers ────────────────────────────────────────────────────────────

def _check_safe_name(name: str) -> None:
    """Prevent path traversal in file names."""
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail=f"Invalid name: '{name}'")


def _find_skill_meta(name: str) -> dict[str, Any] | None:
    try:
        return load_skill(name)
    except ValueError:
        return None


def _require_config() -> HarnessConfig:
    if _config is None:
        raise HTTPException(status_code=503, detail="Config not loaded yet")
    return _config


def _get_engine(session_id: str) -> AgentEngine:
    if session_id not in _engines:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    return _engines[session_id]


def _resolve_session_config(
    req: CreateSessionRequest, cfg: HarnessConfig
) -> tuple[str, str, list[str] | None]:
    """Returns (provider, system_prompt, allowed_tools)."""
    provider = cfg.default_provider
    system_prompt = req.system_prompt
    allowed_tools = req.allowed_tools

    if req.persona:
        try:
            persona = load_persona(req.persona)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        system_prompt = persona.get("system_prompt", system_prompt)
        allowed_tools = persona.get("allowed_tools") or allowed_tools

    return provider, system_prompt, allowed_tools


# ── WebSocket router ────────────────────────────────────────────────────
# Imported at the bottom to avoid circular import:
#   ws.py  imports  _engines / _get_engine  from here (defined above ✓)
#   rest.py imports router from ws.py (done after everything is defined ✓)
from api.ws import router as _ws_router  # noqa: E402
app.include_router(_ws_router)
