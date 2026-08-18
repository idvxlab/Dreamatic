from __future__ import annotations

import json

import pytest

from harness.llm.base import LLMConfig, LLMProvider
from harness.tools.builtin.inspect_image import (
    INSPECT_IMAGE_SCHEMA,
    MAX_IMAGE_BYTES,
    make_inspect_image_tool,
)
from harness.types.messages import ImageBlock, Message, TextBlock


class RecordingVisionProvider(LLMProvider):
    def __init__(self) -> None:
        super().__init__(LLMConfig(model="vision-test", api_key="test"))
        self.messages: list[Message] = []
        self.tools = "not-called"

    async def chat(self, messages, tools=None):
        self.messages = messages
        self.tools = tools
        return Message(
            role="assistant",
            content=[TextBlock("The image contains a centered blue square.")],
        )

    async def complete(self, prompt: str) -> str:
        return "unused"


@pytest.mark.asyncio
async def test_inspect_image_sends_local_pixels_to_current_provider(tmp_path):
    image = tmp_path / "artifact.png"
    image.write_bytes(b"fake-png")
    provider = RecordingVisionProvider()
    tool = make_inspect_image_tool(provider, workspace_root=tmp_path)

    payload = json.loads(await tool(str(image), "Check visible alignment."))

    assert payload["ok"] is True
    assert payload["analysis"].startswith("The image contains")
    assert provider.tools is None
    assert len(provider.messages) == 1
    blocks = provider.messages[0].content
    assert isinstance(blocks[0], TextBlock)
    assert blocks[0].text == "Check visible alignment."
    assert isinstance(blocks[1], ImageBlock)
    assert blocks[1].path == str(image.resolve())
    assert blocks[1].media_type == "image/png"


@pytest.mark.asyncio
async def test_inspect_image_rejects_path_outside_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"fake-png")
    tool = make_inspect_image_tool(
        RecordingVisionProvider(), workspace_root=workspace
    )

    payload = json.loads(await tool(str(outside)))

    assert payload["ok"] is False
    assert "inside the workspace" in payload["error"]


@pytest.mark.asyncio
async def test_inspect_image_rejects_unsupported_format(tmp_path):
    image = tmp_path / "artifact.gif"
    image.write_bytes(b"gif")
    tool = make_inspect_image_tool(
        RecordingVisionProvider(), workspace_root=tmp_path
    )

    payload = json.loads(await tool(str(image)))

    assert payload["ok"] is False
    assert "Unsupported image format" in payload["error"]


@pytest.mark.asyncio
async def test_inspect_image_rejects_oversized_file(tmp_path):
    image = tmp_path / "artifact.webp"
    image.write_bytes(b"x" * (MAX_IMAGE_BYTES + 1))
    tool = make_inspect_image_tool(
        RecordingVisionProvider(), workspace_root=tmp_path
    )

    payload = json.loads(await tool(str(image)))

    assert payload["ok"] is False
    assert "too large" in payload["error"]


def test_inspect_image_schema_explains_visual_pixel_review():
    assert INSPECT_IMAGE_SCHEMA.name == "inspect_image"
    assert "actual pixels" in INSPECT_IMAGE_SCHEMA.description
    assert [param.name for param in INSPECT_IMAGE_SCHEMA.params] == [
        "path",
        "question",
    ]
