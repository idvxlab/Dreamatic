from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import yaml
from dotenv import load_dotenv

# 自动加载项目根目录的 .env 文件（若存在）
# override=False：环境变量已存在时不覆盖（系统变量优先）
load_dotenv(override=False)


def _expand_env_ref(value: str) -> str:
    """Expand a simple ${ENV_VAR} reference; leave literal values unchanged."""
    if value.startswith("${") and value.endswith("}"):
        env_var = value[2:-1]
        return os.environ.get(env_var, "")
    return value


def _first_env(names: list[str]) -> str:
    for name in names:
        if value := os.environ.get(name):
            return value
    return ""


_PROVIDER_ALIASES: dict[str, str] = {
    "my-361api": "361api-openai",
    "361api": "361api-openai",
    "my-361api-mini": "361api-mini",
    "361api-mini": "361api-mini",
}


@dataclass
class ProviderConfig:
    name: str          # "openai" | "anthropic" | "openai-compatible"
    model: str
    api_key: str
    base_url: str = ""
    timeout: float = 60.0
    max_tokens: int = 4096
    temperature: float = 0.0
    # Provider-specific extras: thinking budget, etc.
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class CompressionSettings:
    token_window: int = 128_000
    auto_trigger_ratio: float = 0.65
    micro_keep_recent: int = 6       # rounds to keep fully intact
    summary_provider: str = ""       # name of a ProviderConfig for summaries


@dataclass
class EngineSettings:
    max_rounds: int = 50


@dataclass
class StorageSettings:
    backend: str = "sqlite"          # "sqlite" | "memory"
    path: str = "./harness.db"


# 内置工具的默认输出上限（字符数）
_DEFAULT_LIMITS: dict[str, int] = {
    "read_file": 20_000,
    "search":    10_000,
    "shell":     15_000,
    "use_skill": 50_000,
    "read_skill_file": 25_000,
}
_ALL_BUILTIN_TOOLS = list(_DEFAULT_LIMITS.keys())


@dataclass
class ToolsSettings:
    # None 表示"未在 config.yaml 里配置"，CLI 会用全部内置工具
    enabled: list[str] | None = None
    limits: dict[str, int] = field(default_factory=lambda: dict(_DEFAULT_LIMITS))
    # Tools that require user confirmation before execution (approval flow)
    confirm_tools: list[str] = field(default_factory=lambda: ["shell", "powershell"])


@dataclass
class MCPServerConfig:
    """Configuration for a single MCP Server."""
    transport: str = "stdio"     # "stdio" or remote HTTP-style transports
    command: list[str] = field(default_factory=list)  # executable + args
    url: str = ""                # remote MCP endpoint URL
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class HarnessConfig:
    providers: dict[str, ProviderConfig] = field(default_factory=dict)
    default_provider: str = ""
    engine: EngineSettings = field(default_factory=EngineSettings)
    compression: CompressionSettings = field(default_factory=CompressionSettings)
    storage: StorageSettings = field(default_factory=StorageSettings)
    tools: ToolsSettings = field(default_factory=ToolsSettings)
    mcp_servers: dict[str, MCPServerConfig] = field(default_factory=dict)

    @staticmethod
    def _normalize_provider_name(name: str) -> str:
        if not name:
            return name
        return _PROVIDER_ALIASES.get(name, name)

    @classmethod
    def from_yaml(cls, path: str) -> "HarnessConfig":
        with open(path, encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        providers: dict[str, ProviderConfig] = {}
        for pname, pcfg in raw.get("providers", {}).items():
            # Expand ${ENV_VAR} in api_key, with optional fallback env aliases.
            api_key = _expand_env_ref(pcfg.get("api_key", ""))
            api_key_env = pcfg.get("api_key_env", [])
            if isinstance(api_key_env, str):
                api_key_env = [api_key_env]
            if not api_key:
                api_key = _first_env(list(api_key_env))
            providers[pname] = ProviderConfig(
                name=pcfg.get("name", pname),
                model=_expand_env_ref(pcfg["model"]),
                api_key=api_key,
                base_url=_expand_env_ref(pcfg.get("base_url", "")),
                timeout=float(pcfg.get("timeout", 60.0)),
                max_tokens=int(pcfg.get("max_tokens", 4096)),
                temperature=float(pcfg.get("temperature", 0.0)),
                extra=pcfg.get("extra", {}),
            )

        engine_raw = raw.get("engine", {})
        comp_raw = raw.get("compression", {})
        storage_raw = raw.get("storage", {})

        tools_raw = raw.get("tools", {})
        tools_cfg = ToolsSettings(
            enabled=tools_raw.get("enabled", None),
            limits={**_DEFAULT_LIMITS, **tools_raw.get("limits", {})},
            confirm_tools=tools_raw.get("confirm_tools", ["shell", "powershell"]),
        )

        mcp_servers: dict[str, MCPServerConfig] = {}
        for sname, scfg in raw.get("mcp_servers", {}).items():
            headers_raw = scfg.get("headers", {}) or {}
            headers = {
                str(k): _expand_env_ref(str(v))
                for k, v in headers_raw.items()
            } if isinstance(headers_raw, dict) else {}
            mcp_servers[sname] = MCPServerConfig(
                transport=scfg.get("transport", "stdio"),
                command=list(scfg.get("command", [])),
                url=_expand_env_ref(str(scfg.get("url", ""))),
                headers=headers,
            )

        default_provider = os.environ.get("HARNESS_DEFAULT_PROVIDER", "").strip()
        if default_provider:
            default_provider = cls._normalize_provider_name(default_provider)
        else:
            default_provider = cls._normalize_provider_name(
                raw.get("default_provider", "")
            )

        compression = (
            CompressionSettings(**comp_raw) if comp_raw else CompressionSettings()
        )
        compression.summary_provider = cls._normalize_provider_name(
            compression.summary_provider
        )

        return cls(
            providers=providers,
            default_provider=default_provider,
            engine=EngineSettings(**engine_raw) if engine_raw else EngineSettings(),
            compression=compression,
            storage=StorageSettings(**storage_raw) if storage_raw else StorageSettings(),
            tools=tools_cfg,
            mcp_servers=mcp_servers,
        )

    @classmethod
    def from_env(cls) -> "HarnessConfig":
        """Build a minimal config from well-known environment variables."""
        providers: dict[str, ProviderConfig] = {}

        if key := _first_env(
            [
                "THREE_SIX_ONE_API_KEY",
                "THREESIXONE_API_KEY",
                "API_361_KEY",
                "361API_API_KEY",
                "BLTCY_API_KEY",
            ]
        ):
            providers["361api-openai"] = ProviderConfig(
                name="openai-compatible",
                model=os.environ.get("THREE_SIX_ONE_MODEL", "gpt-4o"),
                api_key=key,
                base_url=os.environ.get(
                    "THREE_SIX_ONE_BASE_URL",
                    "https://www.361api.com/v1",
                ),
            )

        if key := os.environ.get("OPENAI_API_KEY"):
            providers["openai"] = ProviderConfig(
                name="openai",
                model=os.environ.get("OPENAI_MODEL", "gpt-4o"),
                api_key=key,
                base_url=os.environ.get("OPENAI_BASE_URL", ""),
            )

        if key := os.environ.get("ANTHROPIC_API_KEY"):
            providers["anthropic"] = ProviderConfig(
                name="anthropic",
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
                api_key=key,
                extra={"thinking": {"enabled": False}},
            )

        default = cls._normalize_provider_name(
            os.environ.get("HARNESS_DEFAULT_PROVIDER", "")
        )
        if not default and providers:
            default = next(iter(providers))

        return cls(providers=providers, default_provider=default)
