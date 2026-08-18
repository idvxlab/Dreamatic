"""
Two-layer context compression.

Layer 1 — Micro (cheap, no LLM call):
  Triggered when message count grows large.
  Clears ToolResultBlock content in old rounds, preserving structural pairs
  so the message protocol invariant remains valid.

Layer 2 — Auto (expensive, calls a small model):
  Triggered when estimated token usage reaches 65% of the context window.
  Summarizes old messages, then re-injects system identity and task goal.
  Re-injection is MANDATORY — skipping it causes the agent to drift off-topic
  after many rounds because the identity and goal disappear from context.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from harness.types.messages import Message

from harness.types.messages import Message, TextBlock, ToolCallBlock, ToolResultBlock


_MICRO_COMPRESSION_PROTECTED_TOOLS = frozenset({"use_skill"})


@dataclass
class CompressionConfig:
    token_window: int = 128_000
    auto_trigger_ratio: float = 0.65
    micro_keep_recent: int = 6       # keep last N rounds fully intact
    task_goal: str = ""              # injected after every auto-compression
    system_identity: str = ""        # injected after every auto-compression
    transcript_dir: str = ".myharness/transcripts"
    session_id: str = ""


class ContextCompressor:
    """
    Called once at the start of each round, before the LLM call.
    Mutates the message list in-place (via slice assignment).
    """

    def __init__(self, summarizer, config: CompressionConfig) -> None:
        """
        summarizer: an LLMProvider instance (typically a cheap/small model).
                    Only `complete(prompt: str) -> str` is used.
        """
        self._summarizer = summarizer
        self._cfg = config
        # Non-invasive observer — purely additive, never changes compression logic.
        # Register a callable of type Callable[[str, int, int], None] to receive
        # (event_type, messages_before, messages_after) each time maybe_compress()
        # produces a result different from the input list.
        self._observers: list[Callable[[str, int, int], None]] = []

    def add_observer(self, fn: "Callable[[str, int, int], None]") -> None:
        """Register an observer that fires when compression triggers. Non-invasive."""
        self._observers.append(fn)

    def _notify_observers(self, event: str, before: int, after: int) -> None:
        for fn in self._observers:
            fn(event, before, after)

    async def maybe_compress(
        self, messages: list[Message], round_idx: int
    ) -> list[Message]:
        before = len(messages)
        tokens = _estimate_tokens(messages)
        ratio = tokens / self._cfg.token_window

        if ratio >= self._cfg.auto_trigger_ratio:
            result = await self._auto_compress(messages, round_idx)
            self._notify_observers("compression_auto", before, len(result))
            return result

        keep_threshold = self._cfg.micro_keep_recent * 4
        if len(messages) > keep_threshold:
            result = self._micro_compress(messages)
            self._notify_observers("compression_micro", before, len(result))
            return result

        return messages

    # ------------------------------------------------------------------
    # Layer 1: Micro — clear old tool result content
    # ------------------------------------------------------------------

    def _micro_compress(self, messages: list[Message]) -> list[Message]:
        keep_from = max(0, len(messages) - self._cfg.micro_keep_recent * 2)
        protected_call_ids = _tool_call_ids_for(
            messages, _MICRO_COMPRESSION_PROTECTED_TOOLS
        )
        result: list[Message] = []
        for i, msg in enumerate(messages):
            if i < keep_from and msg.role == "tool":
                new_blocks = []
                for block in msg.content:
                    if (
                        isinstance(block, ToolResultBlock)
                        and block.tool_call_id not in protected_call_ids
                    ):
                        new_blocks.append(
                            ToolResultBlock(
                                tool_call_id=block.tool_call_id,
                                content="[cleared by micro-compression]",
                                is_error=block.is_error,
                                tool_name=block.tool_name,
                            )
                        )
                    else:
                        new_blocks.append(block)
                result.append(
                    Message(
                        role=msg.role,
                        content=new_blocks,
                        round_index=msg.round_index,
                        is_compressed=True,
                    )
                )
            else:
                result.append(msg)
        return result

    # ------------------------------------------------------------------
    # Layer 2: Auto — summarize + re-inject identity and goal
    # ------------------------------------------------------------------

    async def _auto_compress(
        self, messages: list[Message], round_idx: int
    ) -> list[Message]:
        cfg = self._cfg
        keep_from = max(0, len(messages) - cfg.micro_keep_recent * 2)
        old_msgs = messages[:keep_from]
        recent_msgs = messages[keep_from:]

        summary_prompt = _build_summary_prompt(old_msgs)
        _save_transcript(messages, cfg, round_idx)
        summary_text = await self._summarizer.complete(summary_prompt)
        active_skills = _loaded_skill_names(messages)

        rebuilt: list[Message] = []

        # Re-inject system identity (MANDATORY after any auto-compression)
        if cfg.system_identity:
            rebuilt.append(
                Message(
                    role="system",
                    content=[TextBlock(text=cfg.system_identity)],
                    round_index=0,
                    is_compressed=True,
                )
            )

        # Re-inject task goal (prevents multi-round topic drift)
        if cfg.task_goal:
            rebuilt.append(
                Message(
                    role="user",
                    content=[TextBlock(text=f"[Task goal reminder]: {cfg.task_goal}")],
                    round_index=0,
                    is_compressed=True,
                )
            )

        # Keep only compact activation state across the full compression
        # boundary. The Skill body is reloaded on demand instead of being
        # duplicated as a system instruction on every model round.
        if active_skills:
            rebuilt.append(
                Message(
                    role="system",
                    content=[
                        TextBlock(
                            text=(
                                "Skills loaded before context compression: "
                                f"{', '.join(active_skills)}. "
                                "If one is still needed for the current task, "
                                "reload it with use_skill before continuing."
                            )
                        )
                    ],
                    round_index=round_idx,
                    is_compressed=True,
                )
            )

        # Conversation summary replaces all old messages
        rebuilt.append(
            Message(
                role="user",
                content=[
                    TextBlock(
                        text=(
                            f"[Conversation summary up to round {round_idx}]:\n"
                            f"{summary_text}"
                        )
                    )
                ],
                round_index=round_idx,
                is_compressed=True,
            )
        )

        rebuilt.extend(recent_msgs)
        return rebuilt


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _tool_call_ids_for(
    messages: list[Message], tool_names: set[str] | frozenset[str]
) -> set[str]:
    return {
        block.tool_call_id
        for msg in messages
        for block in msg.content
        if isinstance(block, ToolCallBlock) and block.tool_name in tool_names
    }


def _loaded_skill_names(messages: list[Message]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for msg in messages:
        for block in msg.content:
            if not isinstance(block, ToolCallBlock) or block.tool_name != "use_skill":
                continue
            name = str(block.tool_input.get("name") or "").strip()
            if name and name not in seen:
                seen.add(name)
                names.append(name)
    return names

def _estimate_tokens(messages: list[Message]) -> int:
    """Fast approximation: 4 chars ≈ 1 token."""
    total = 0
    for msg in messages:
        for block in msg.content:
            if hasattr(block, "text"):
                total += len(block.text)
            elif hasattr(block, "content"):
                total += len(block.content)
            elif hasattr(block, "thinking"):
                total += len(block.thinking)
            elif hasattr(block, "tool_input"):
                total += len(str(block.tool_input))
    return total // 4


def _build_summary_prompt(messages: list[Message]) -> str:
    lines = [
        "Summarize the following conversation history concisely. "
        "Preserve: decisions made, files modified, errors encountered, "
        "tools called and their outcomes, and current state of work. "
        "Do NOT include raw tool outputs verbatim.\n"
    ]
    for msg in messages:
        for block in msg.content:
            if isinstance(block, TextBlock) and block.text.strip():
                lines.append(f"[{msg.role}]: {block.text[:500]}")
    return "\n".join(lines)


def _save_transcript(
    messages: list[Message], cfg: CompressionConfig, round_idx: int
) -> Path | None:
    """Persist full pre-compression messages as JSONL for later recovery."""
    if not cfg.transcript_dir:
        return None
    try:
        root = Path(cfg.transcript_dir)
        session_dir = root / (cfg.session_id or "unknown_session")
        session_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        path = session_dir / f"round_{round_idx}_{stamp}.jsonl"
        with path.open("w", encoding="utf-8") as fh:
            for msg in messages:
                fh.write(json.dumps(_message_to_dict(msg), ensure_ascii=False))
                fh.write("\n")
        return path
    except Exception:
        return None


def _message_to_dict(msg: Message) -> dict:
    blocks = []
    for block in msg.content:
        data = {"type": getattr(block, "type", "")}
        for attr in (
            "text",
            "thinking",
            "tool_call_id",
            "tool_name",
            "tool_input",
            "content",
            "is_error",
            "path",
            "media_type",
            "name",
            "attachment_id",
            "url",
        ):
            if hasattr(block, attr):
                data[attr] = getattr(block, attr)
        blocks.append(data)
    return {
        "role": msg.role,
        "message_id": msg.message_id,
        "round_index": msg.round_index,
        "is_compressed": msg.is_compressed,
        "content": blocks,
    }
