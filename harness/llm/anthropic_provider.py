from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import anthropic

from harness.llm.base import LLMConfig, LLMProvider, TokenCallback
from harness.types.messages import (
    Message,
    TextBlock,
    ImageBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from harness.types.tools import ToolSchema


class AnthropicProvider(LLMProvider):
    def __init__(self, config: LLMConfig) -> None:
        super().__init__(config)
        kwargs: dict[str, Any] = {
            "api_key": config.api_key,
            "timeout": config.timeout,
        }
        if config.base_url:
            kwargs["base_url"] = config.base_url
        self._client = anthropic.AsyncAnthropic(**kwargs)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[Message],
        tools: list[ToolSchema] | None = None,
    ) -> Message:
        system_text, remaining = self._split_system(messages)
        kwargs: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
            "messages": remaining,
        }
        if system_text:
            kwargs["system"] = system_text
        if tools:
            kwargs["tools"] = [self._to_anthropic_tool(t) for t in tools]

        thinking_cfg = self._thinking_params()
        if thinking_cfg.get("enabled"):
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_cfg.get("budget_tokens", 5000),
            }

        response = await self._client.messages.create(**kwargs)
        return self._from_anthropic_response(response)

    async def complete(self, prompt: str) -> str:
        response = await self._client.messages.create(
            model=self.config.model,
            max_tokens=self.config.max_tokens,
            temperature=self.config.temperature,
            messages=[{"role": "user", "content": prompt}],
        )
        for block in response.content:
            if block.type == "text":
                return block.text
        return ""

    async def stream_chat(
        self,
        messages: list[Message],
        tools: list[ToolSchema] | None = None,
        on_token: TokenCallback | None = None,
    ) -> Message:
        system_text, remaining = self._split_system(messages)
        kwargs: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
            "messages": remaining,
        }
        if system_text:
            kwargs["system"] = system_text
        if tools:
            kwargs["tools"] = [self._to_anthropic_tool(t) for t in tools]

        # Extended thinking: same as chat() — text_stream still yields text tokens
        # (thinking blocks are NOT yielded by text_stream, so on_token stays clean)
        thinking_cfg = self._thinking_params()
        if thinking_cfg.get("enabled"):
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_cfg.get("budget_tokens", 5000),
            }

        async with self._client.messages.stream(**kwargs) as stream:
            if on_token is not None:
                if thinking_cfg.get("enabled"):
                    # With thinking: use raw events so we can detect the thinking phase
                    # and emit a sentinel before text tokens start.
                    # "\x00THINKING\x00" → ws.py maps this to {"type": "thinking"} frame.
                    in_thinking = False
                    async for event in stream:
                        etype = getattr(event, "type", "")
                        if etype == "content_block_start":
                            btype = getattr(getattr(event, "content_block", None), "type", "")
                            if btype == "thinking" and not in_thinking:
                                in_thinking = True
                                await on_token("\x00THINKING\x00")  # thinking-start sentinel
                            elif btype == "text":
                                in_thinking = False
                        elif etype == "content_block_delta":
                            delta = getattr(event, "delta", None)
                            # text_delta has .text; thinking_delta has .thinking
                            text = getattr(delta, "text", None)
                            if text and not in_thinking:
                                await on_token(text)
                            thinking_chunk = getattr(delta, "thinking", None)
                            if thinking_chunk and in_thinking:
                                await on_token("\x00THINKING_TOKEN\x00" + thinking_chunk)
                else:
                    # No thinking: simpler text_stream is sufficient
                    async for text in stream.text_stream:
                        await on_token(text)
            # get_final_message() must be called inside the context manager
            response = await stream.get_final_message()

        return self._from_anthropic_response(response)

    # ------------------------------------------------------------------
    # Conversion: internal -> Anthropic format
    # ------------------------------------------------------------------

    def _split_system(
        self, messages: list[Message]
    ) -> tuple[str, list[dict[str, Any]]]:
        """Extract system messages into a single string; convert the rest."""
        system_parts: list[str] = []
        remaining: list[dict[str, Any]] = []

        for msg in messages:
            if msg.role == "system":
                text = "\n".join(
                    b.text for b in msg.content if isinstance(b, TextBlock)
                )
                if text:
                    system_parts.append(text)
            else:
                converted = self._to_anthropic_message(msg)
                if converted is not None:
                    remaining.append(converted)

        return "\n\n".join(system_parts), remaining

    def _to_anthropic_message(self, msg: Message) -> dict[str, Any] | None:
        if msg.role == "user":
            content_blocks: list[dict[str, Any]] = []
            for block in msg.content:
                if isinstance(block, TextBlock):
                    content_blocks.append({"type": "text", "text": block.text})
                elif isinstance(block, ImageBlock):
                    encoded = base64.b64encode(Path(block.path).read_bytes()).decode("ascii")
                    content_blocks.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": block.media_type,
                            "data": encoded,
                        },
                    })
            if not content_blocks:
                return None
            return {"role": "user", "content": content_blocks}

        elif msg.role == "assistant":
            content_blocks = []
            for block in msg.content:
                if isinstance(block, TextBlock):
                    content_blocks.append({"type": "text", "text": block.text})
                elif isinstance(block, ThinkingBlock):
                    # Signature must be replayed verbatim
                    content_blocks.append(
                        {
                            "type": "thinking",
                            "thinking": block.thinking,
                            "signature": block.signature,
                        }
                    )
                elif isinstance(block, ToolCallBlock):
                    content_blocks.append(
                        {
                            "type": "tool_use",
                            "id": block.tool_call_id,
                            "name": block.tool_name,
                            "input": block.tool_input,
                        }
                    )
            if not content_blocks:
                return None
            return {"role": "assistant", "content": content_blocks}

        elif msg.role == "tool":
            # Anthropic wraps tool results in a user message
            tool_result_blocks: list[dict[str, Any]] = []
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    result_block: dict[str, Any] = {
                        "type": "tool_result",
                        "tool_use_id": block.tool_call_id,
                        "content": block.content,
                    }
                    if block.is_error:
                        result_block["is_error"] = True
                    tool_result_blocks.append(result_block)
            if not tool_result_blocks:
                return None
            return {"role": "user", "content": tool_result_blocks}

        return None

    def _to_anthropic_tool(self, schema: ToolSchema) -> dict[str, Any]:
        required: list[str] = []
        properties: dict[str, Any] = {}

        for param in schema.params:
            prop: dict[str, Any] = {
                "type": param.type,
                "description": param.description,
            }
            if param.enum:
                prop["enum"] = param.enum
            properties[param.name] = prop
            if param.required:
                required.append(param.name)

        return {
            "name": schema.name,
            "description": schema.description,
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        }

    # ------------------------------------------------------------------
    # Conversion: Anthropic response -> internal format
    # ------------------------------------------------------------------

    def _from_anthropic_response(self, response: Any) -> Message:
        content: list[Any] = []

        for block in response.content:
            if block.type == "text":
                content.append(TextBlock(text=block.text))
            elif block.type == "thinking":
                content.append(
                    ThinkingBlock(
                        thinking=block.thinking,
                        signature=block.signature,
                    )
                )
            elif block.type == "tool_use":
                content.append(
                    ToolCallBlock(
                        tool_call_id=block.id,
                        tool_name=block.name,
                        tool_input=block.input if isinstance(block.input, dict) else {},
                    )
                )

        return Message(role="assistant", content=content)
