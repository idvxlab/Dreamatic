"""
Central message protocol definitions.

INVIOLABLE RULES (enforced by validate_message_sequence):
  1. An assistant message containing tool_calls MUST be immediately followed
     by a tool message whose tool_result IDs exactly match the tool_call IDs.
  2. Nothing may be inserted between that pair.

Violating either rule causes a 400 from every major LLM provider.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Union


Role = Literal["system", "user", "assistant", "tool"]


def new_message_id() -> str:
    return str(uuid.uuid4())


@dataclass
class TextBlock:
    text: str
    type: Literal["text"] = field(default="text", init=False)


@dataclass
class ImageBlock:
    """A persisted user image attachment available to multimodal providers."""
    path: str
    media_type: str
    name: str = ""
    attachment_id: str = ""
    url: str = ""
    type: Literal["image"] = field(default="image", init=False)


@dataclass
class ThinkingBlock:
    """
    Anthropic extended thinking block.
    `signature` must be replayed verbatim on subsequent requests —
    never modify or omit it.
    """
    thinking: str
    signature: str = ""
    type: Literal["thinking"] = field(default="thinking", init=False)


@dataclass
class ToolCallBlock:
    """A single tool invocation requested by the assistant."""
    tool_call_id: str
    tool_name: str
    tool_input: dict[str, Any] = field(default_factory=dict)
    type: Literal["tool_call"] = field(default="tool_call", init=False)


@dataclass
class ToolResultBlock:
    """
    The result that MUST immediately follow a ToolCallBlock in the next message.
    If `is_overflow_ref` is True, `content` is a storage key, not literal text.
    If `is_interrupt` is True, the engine pauses the run loop here; the
    placeholder `content` will be replaced by the real answer when the
    interrupt is resolved (reply / reject / expire).
    """
    tool_call_id: str
    content: str
    is_error: bool = False
    is_overflow_ref: bool = False
    is_interrupt: bool = False   # set by interruptible tools (e.g. ask_user)
    tool_name: str = ""
    type: Literal["tool_result"] = field(default="tool_result", init=False)


ContentBlock = Union[TextBlock, ImageBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock]


@dataclass
class Message:
    role: Role
    content: list[ContentBlock]
    # Metadata — NOT sent to LLM; used by engine and storage
    round_index: int = 0
    is_compressed: bool = False
    message_id: str = field(default_factory=new_message_id)

    def has_tool_calls(self) -> bool:
        return any(isinstance(b, ToolCallBlock) for b in self.content)

    def tool_calls(self) -> list[ToolCallBlock]:
        return [b for b in self.content if isinstance(b, ToolCallBlock)]

    def has_thinking(self) -> bool:
        return any(isinstance(b, ThinkingBlock) for b in self.content)

    def text_content(self) -> str:
        """Concatenate all TextBlock texts."""
        return "\n".join(b.text for b in self.content if isinstance(b, TextBlock))


class ProtocolViolationError(RuntimeError):
    """Raised when the message sequence violates the tool_call/tool_result protocol."""


def validate_message_sequence(messages: list[Message]) -> None:
    """
    Raise ProtocolViolationError if the sequence violates the protocol:
    - An assistant message with tool_calls is not immediately followed by
      a tool message.
    - The tool_call IDs in the assistant message do not exactly match the
      tool_result IDs in the following tool message.
    - A tool message appears without a preceding assistant tool-call message.
    """
    for i, msg in enumerate(messages):
        if msg.role == "assistant" and msg.has_tool_calls():
            if i + 1 >= len(messages):
                raise ProtocolViolationError(
                    f"Message at index {i} has tool_calls but is the last message "
                    f"(no following tool message)"
                )
            next_msg = messages[i + 1]
            if next_msg.role != "tool":
                raise ProtocolViolationError(
                    f"Message[{i}] has tool_calls but message[{i+1}] has "
                    f"role={next_msg.role!r} instead of 'tool'"
                )
            call_ids = {b.tool_call_id for b in msg.tool_calls()}
            result_ids = {
                b.tool_call_id
                for b in next_msg.content
                if isinstance(b, ToolResultBlock)
            }
            if call_ids != result_ids:
                raise ProtocolViolationError(
                    f"Message[{i}] tool_call IDs {call_ids} do not match "
                    f"message[{i+1}] tool_result IDs {result_ids}"
                )

        if msg.role == "tool":
            if i == 0 or messages[i - 1].role != "assistant":
                raise ProtocolViolationError(
                    f"Message[{i}] has role='tool' but is not preceded by "
                    f"an assistant message"
                )
            prev = messages[i - 1]
            if not prev.has_tool_calls():
                raise ProtocolViolationError(
                    f"Message[{i}] has role='tool' but message[{i-1}] has no tool_calls"
                )


def repair_message_sequence(messages: list[Message]) -> list[Message]:
    """
    Return a protocol-safe copy of messages.

    This is a recovery guard for persisted or compressed histories. If an
    assistant tool_call is missing its immediate tool_result, synthesize an
    error result so the next LLM request remains valid and the model can
    recover instead of the provider rejecting the whole request.
    """
    repaired: list[Message] = []
    i = 0
    while i < len(messages):
        msg = messages[i]

        # Drop orphan tool messages; providers reject them and there is no
        # preceding assistant call they can answer.
        if msg.role == "tool" and (
            not repaired
            or repaired[-1].role != "assistant"
            or not repaired[-1].has_tool_calls()
        ):
            i += 1
            continue

        repaired.append(msg)

        if msg.role == "assistant" and msg.has_tool_calls():
            call_ids = [b.tool_call_id for b in msg.tool_calls()]
            next_msg = messages[i + 1] if i + 1 < len(messages) else None
            if next_msg is not None and next_msg.role == "tool":
                next_blocks = [
                    block
                    for block in next_msg.content
                    if isinstance(block, ToolResultBlock)
                    and block.tool_call_id in set(call_ids)
                ]
                present = {
                    block.tool_call_id
                    for block in next_blocks
                    if isinstance(block, ToolResultBlock)
                }
                for call_id in call_ids:
                    if call_id not in present:
                        next_blocks.append(_missing_tool_result(call_id))
                repaired.append(
                    Message(
                        role="tool",
                        content=next_blocks,
                        round_index=next_msg.round_index,
                        is_compressed=next_msg.is_compressed,
                    )
                )
                i += 2
                continue

            repaired.append(
                Message(
                    role="tool",
                    content=[_missing_tool_result(call_id) for call_id in call_ids],
                    round_index=msg.round_index,
                    is_compressed=True,
                )
            )

        i += 1

    return repaired


def _missing_tool_result(call_id: str) -> ToolResultBlock:
    return ToolResultBlock(
        tool_call_id=call_id,
        content=(
            "Error: previous tool result was missing from the persisted "
            "conversation history. Continue by reassessing the current state "
            "and retrying the necessary action if it is still needed."
        ),
        is_error=True,
    )
