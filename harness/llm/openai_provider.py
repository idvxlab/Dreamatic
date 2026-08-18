from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import openai

from harness.llm.base import LLMConfig, LLMProvider, TokenCallback
from harness.types.messages import (
    Message,
    TextBlock,
    ImageBlock,
    ToolCallBlock,
    ToolResultBlock,
    ThinkingBlock,
)
from harness.types.tools import ToolSchema

_THINKING_START = "\x00THINKING\x00"
_THINKING_TOKEN_PREFIX = "\x00THINKING_TOKEN\x00"


def _parse_tool_arguments(raw_args: Any) -> dict[str, Any]:
    """
    Parse OpenAI-compatible tool-call arguments defensively.

    Some compatible providers occasionally stream or return truncated JSON
    arguments. Treat those as a tool-call input error instead of letting the
    engine crash; the executor will return a normal tool_result that asks the
    model to retry with valid JSON.
    """
    if isinstance(raw_args, dict):
        return raw_args
    raw_text = raw_args if isinstance(raw_args, str) else str(raw_args or "")
    try:
        parsed = json.loads(raw_text or "{}")
    except Exception as exc:
        return {
            "_invalid_tool_arguments": True,
            "_raw": raw_text,
            "_error": str(exc),
        }
    if isinstance(parsed, dict):
        return parsed
    return {
        "_invalid_tool_arguments": True,
        "_raw": raw_text,
        "_error": "Tool arguments must be a JSON object.",
    }


def _get_extra_field(obj: Any, name: str) -> Any:
    """Read provider-specific fields preserved by the OpenAI SDK."""
    if isinstance(obj, dict):
        return obj.get(name)
    value = getattr(obj, name, None)
    if value is not None:
        return value
    extra = getattr(obj, "model_extra", None)
    if isinstance(extra, dict):
        return extra.get(name)
    if hasattr(obj, "model_dump"):
        try:
            data = obj.model_dump()
            if isinstance(data, dict):
                return data.get(name)
        except Exception:
            return None
    return None


def _reasoning_content(obj: Any) -> str:
    value = _get_extra_field(obj, "reasoning_content")
    if isinstance(value, str):
        return value
    return ""


class OpenAIProvider(LLMProvider):
    def __init__(self, config: LLMConfig) -> None:
        super().__init__(config)
        kwargs: dict[str, Any] = {
            "api_key": config.api_key,
            "timeout": config.timeout,
        }
        if config.base_url:
            kwargs["base_url"] = config.base_url
        self._client = openai.AsyncOpenAI(**kwargs)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def _apply_extra_options(self, kwargs: dict[str, Any]) -> None:
        reasoning_effort = self.config.extra.get("reasoning_effort")
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort

    async def chat(
        self,
        messages: list[Message],
        tools: list[ToolSchema] | None = None,
    ) -> Message:
        oai_messages = self._to_openai_messages(messages)
        kwargs: dict[str, Any] = {
            "model": self.config.model,
            "messages": oai_messages,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
        }
        self._apply_extra_options(kwargs)
        if tools:
            kwargs["tools"] = [self._to_openai_tool(t) for t in tools]
            kwargs["tool_choice"] = "auto"

        response = await self._client.chat.completions.create(**kwargs)
        return self._from_openai_response(response)

    async def complete(self, prompt: str) -> str:
        oai_messages = [{"role": "user", "content": prompt}]
        kwargs: dict[str, Any] = {
            "model": self.config.model,
            "messages": oai_messages,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
        }
        self._apply_extra_options(kwargs)
        response = await self._client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        return choice.message.content or ""

    async def stream_chat(
        self,
        messages: list[Message],
        tools: list[ToolSchema] | None = None,
        on_token: TokenCallback | None = None,
    ) -> Message:
        oai_messages = self._to_openai_messages(messages)
        kwargs: dict[str, Any] = {
            "model": self.config.model,
            "messages": oai_messages,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
            "stream": True,
        }
        self._apply_extra_options(kwargs)
        if tools:
            kwargs["tools"] = [self._to_openai_tool(t) for t in tools]
            kwargs["tool_choice"] = "auto"

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        reasoning_started = False
        # idx -> {id, name, args}
        tool_calls_raw: dict[int, dict[str, str]] = {}

        response = await self._client.chat.completions.create(**kwargs)
        async for chunk in response:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning_delta = _reasoning_content(delta)
            if reasoning_delta:
                reasoning_parts.append(reasoning_delta)
                if on_token is not None:
                    if not reasoning_started:
                        await on_token(_THINKING_START)
                        reasoning_started = True
                    await on_token(_THINKING_TOKEN_PREFIX + reasoning_delta)
            if delta.content:
                if on_token is not None:
                    await on_token(delta.content)
                text_parts.append(delta.content)
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tool_calls_raw:
                        tool_calls_raw[idx] = {"id": "", "name": "", "args": ""}
                    if tc_delta.id:
                        tool_calls_raw[idx]["id"] += tc_delta.id
                    if tc_delta.function and tc_delta.function.name:
                        tool_calls_raw[idx]["name"] += tc_delta.function.name
                    if tc_delta.function and tc_delta.function.arguments:
                        tool_calls_raw[idx]["args"] += tc_delta.function.arguments

        content: list[Any] = []
        if reasoning_parts:
            content.append(ThinkingBlock(thinking="".join(reasoning_parts)))
        if text_parts:
            content.append(TextBlock(text="".join(text_parts)))
        for idx in sorted(tool_calls_raw):
            raw = tool_calls_raw[idx]
            tool_input = _parse_tool_arguments(raw["args"])
            content.append(
                ToolCallBlock(
                    tool_call_id=raw["id"],
                    tool_name=raw["name"],
                    tool_input=tool_input,
                )
            )
        return Message(role="assistant", content=content)

    # ------------------------------------------------------------------
    # Conversion: internal -> OpenAI format
    # ------------------------------------------------------------------

    def _to_openai_messages(self, messages: list[Message]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for msg in messages:
            if msg.role == "system":
                text = "\n".join(
                    b.text for b in msg.content if isinstance(b, TextBlock)
                )
                result.append({"role": "system", "content": text})

            elif msg.role == "user":
                text = "\n".join(
                    b.text for b in msg.content if isinstance(b, TextBlock)
                )
                images = [b for b in msg.content if isinstance(b, ImageBlock)]
                if not images:
                    result.append({"role": "user", "content": text})
                    continue
                content: list[dict[str, Any]] = []
                if text:
                    content.append({"type": "text", "text": text})
                for image in images:
                    encoded = base64.b64encode(Path(image.path).read_bytes()).decode("ascii")
                    content.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image.media_type};base64,{encoded}",
                        },
                    })
                result.append({"role": "user", "content": content})

            elif msg.role == "assistant":
                text_parts = [
                    b.text for b in msg.content if isinstance(b, TextBlock)
                ]
                reasoning_parts = [
                    b.thinking for b in msg.content if isinstance(b, ThinkingBlock)
                ]
                tool_calls = [
                    b for b in msg.content if isinstance(b, ToolCallBlock)
                ]
                oai_msg: dict[str, Any] = {
                    "role": "assistant",
                    "content": "\n".join(text_parts) if text_parts else None,
                }
                if reasoning_parts:
                    oai_msg["reasoning_content"] = "\n".join(reasoning_parts)
                if tool_calls:
                    oai_msg["tool_calls"] = [
                        {
                            "id": tc.tool_call_id,
                            "type": "function",
                            "function": {
                                "name": tc.tool_name,
                                "arguments": json.dumps(tc.tool_input),
                            },
                        }
                        for tc in tool_calls
                    ]
                result.append(oai_msg)

            elif msg.role == "tool":
                # Flatten: one dict per ToolResultBlock
                for block in msg.content:
                    if isinstance(block, ToolResultBlock):
                        result.append(
                            {
                                "role": "tool",
                                "tool_call_id": block.tool_call_id,
                                "content": block.content,
                            }
                        )

        return result

    def _to_openai_tool(self, schema: ToolSchema) -> dict[str, Any]:
        required: list[str] = []
        properties: dict[str, Any] = {}

        for param in schema.params:
            prop: dict[str, Any] = {
                "type": param.type,
                "description": param.description,
            }
            if param.enum:
                prop["enum"] = param.enum
            if param.items:
                prop["items"] = param.items
            properties[param.name] = prop
            if param.required:
                required.append(param.name)

        return {
            "type": "function",
            "function": {
                "name": schema.name,
                "description": schema.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        }

    # ------------------------------------------------------------------
    # Conversion: OpenAI response -> internal format
    # ------------------------------------------------------------------

    def _from_openai_response(self, response: Any) -> Message:
        choice = response.choices[0]
        oai_msg = choice.message
        content: list[Any] = []
        reasoning = _reasoning_content(oai_msg)
        if reasoning:
            content.append(ThinkingBlock(thinking=reasoning))

        if oai_msg.content:
            content.append(TextBlock(text=oai_msg.content))

        if oai_msg.tool_calls:
            for tc in oai_msg.tool_calls:
                tool_input = _parse_tool_arguments(tc.function.arguments)
                content.append(
                    ToolCallBlock(
                        tool_call_id=tc.id,
                        tool_name=tc.function.name,
                        tool_input=tool_input,
                    )
                )

        return Message(role="assistant", content=content)
