from __future__ import annotations

import base64

import pytest

from api import rest
from harness.engine.engine import serialize_message
from harness.llm.anthropic_provider import AnthropicProvider
from harness.llm.base import LLMConfig
from harness.llm.openai_provider import OpenAIProvider
from harness.storage.backends.sqlite import _messages_from_json, _messages_to_json
from harness.types.messages import ImageBlock, Message, TextBlock


def _image(path, *, attachment_id: str = "image-1") -> ImageBlock:
    return ImageBlock(
        path=str(path),
        media_type="image/png",
        name="reference.png",
        attachment_id=attachment_id,
        url=f"/sessions/session-1/attachments/{attachment_id}",
    )


def test_image_block_round_trips_through_sqlite_wire_format(tmp_path):
    path = tmp_path / "reference.png"
    path.write_bytes(b"image-bytes")
    messages = [Message(role="user", content=[TextBlock("Review this"), _image(path)])]

    restored = _messages_from_json(_messages_to_json(messages))

    image = restored[0].content[1]
    assert isinstance(image, ImageBlock)
    assert image.path == str(path)
    assert image.media_type == "image/png"
    assert image.attachment_id == "image-1"


def test_api_serialization_exposes_url_but_not_local_path(tmp_path):
    path = tmp_path / "private.png"
    message = Message(role="user", content=[_image(path)])

    block = serialize_message(message)["content"][0]

    assert block["url"].endswith("/image-1")
    assert "path" not in block


def test_openai_user_image_uses_image_url_content_block(tmp_path):
    path = tmp_path / "reference.png"
    path.write_bytes(b"image-bytes")
    provider = OpenAIProvider(LLMConfig(model="test", api_key="test"))
    message = Message(role="user", content=[TextBlock("Review this"), _image(path)])

    converted = provider._to_openai_messages([message])[0]

    assert converted["content"][0] == {"type": "text", "text": "Review this"}
    assert converted["content"][1]["type"] == "image_url"
    assert converted["content"][1]["image_url"]["url"].startswith(
        "data:image/png;base64,"
    )


def test_anthropic_user_image_uses_base64_source(tmp_path):
    path = tmp_path / "reference.png"
    path.write_bytes(b"image-bytes")
    provider = AnthropicProvider(LLMConfig(model="test", api_key="test"))
    message = Message(role="user", content=[TextBlock("Review this"), _image(path)])

    converted = provider._to_anthropic_message(message)

    assert converted is not None
    image = converted["content"][1]
    assert image["type"] == "image"
    assert image["source"]["media_type"] == "image/png"
    assert base64.b64decode(image["source"]["data"]) == b"image-bytes"


def test_attachment_save_validates_and_persists_png(tmp_path, monkeypatch):
    monkeypatch.setattr(rest, "ATTACHMENTS_DIR", tmp_path)
    png = b"\x89PNG\r\n\x1a\n" + b"payload"
    request = rest.ImageAttachmentRequest(
        name="reference.png",
        media_type="image/png",
        data=base64.b64encode(png).decode("ascii"),
    )

    images = rest._save_image_attachments("session-1", [request])

    assert len(images) == 1
    assert images[0].url.startswith("/sessions/session-1/attachments/")
    assert images[0].path.endswith(".png")
    stored = rest._attachment_session_dir("session-1") / f"{images[0].attachment_id}.png"
    assert stored.read_bytes() == png


def test_attachment_save_rejects_mismatched_media_type(tmp_path, monkeypatch):
    monkeypatch.setattr(rest, "ATTACHMENTS_DIR", tmp_path)
    request = rest.ImageAttachmentRequest(
        name="not-a-png.png",
        media_type="image/png",
        data=base64.b64encode(b"not an image").decode("ascii"),
    )

    with pytest.raises(rest.HTTPException, match="does not match"):
        rest._save_image_attachments("session-1", [request])


def test_frontend_contains_image_attachment_flow():
    html = (rest.ROOT_DIR / "static" / "index.html").read_text(encoding="utf-8")

    assert 'id="image-file-input"' in html
    assert "handleImageFiles" in html
    assert "buildMessageImageGallery" in html
    assert "JSON.stringify({ args, images })" in html
