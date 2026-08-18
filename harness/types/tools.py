from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable


@dataclass
class ToolParam:
    name: str
    type: str          # "string" | "integer" | "number" | "boolean" | "object" | "array"
    description: str
    required: bool = True
    enum: list[Any] = field(default_factory=list)
    items: dict[str, Any] | None = None


@dataclass
class ToolSchema:
    name: str
    description: str
    params: list[ToolParam] = field(default_factory=list)


@dataclass
class ToolExecutionResult:
    """Structured return value for handlers that need to report failure."""
    content: str
    is_error: bool = False


@dataclass
class ToolResult:
    tool_call_id: str
    content: str
    is_error: bool = False
    is_overflow_ref: bool = False  # content is a storage key, not literal text


# A tool handler is an async callable that accepts keyword arguments matching
# its ToolSchema params and returns text or a structured execution result.
ToolHandler = Callable[..., Awaitable[str | ToolExecutionResult]]
