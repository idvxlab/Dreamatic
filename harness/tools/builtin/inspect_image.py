from __future__ import annotations

import json
from pathlib import Path

from harness.llm.base import LLMProvider
from harness.types.messages import ImageBlock, Message, TextBlock
from harness.types.tools import ToolParam, ToolSchema


INSPECT_IMAGE_SCHEMA = ToolSchema(
    name="inspect_image",
    description=(
        "Visually inspect a local PNG, JPEG, or WebP image with the current "
        "session's multimodal model. Use this to review actual pixels, verify "
        "generated artifacts, compare visible design details, and diagnose "
        "layout or rendering defects. This is a read-only tool."
    ),
    params=[
        ToolParam(
            name="path",
            type="string",
            description="Local image path inside the current project workspace.",
        ),
        ToolParam(
            name="question",
            type="string",
            description=(
                "Optional inspection question or acceptance criteria. When omitted, "
                "the image receives a general design-quality review."
            ),
            required=False,
        ),
    ],
)

SUPPORTED_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
DEFAULT_QUESTION = (
    "Inspect this image directly and report only what can be established from its "
    "visible pixels. First describe the image, then assess composition, hierarchy, "
    "alignment, spacing, typography, clipping, distortion, visual consistency, and "
    "production defects. Separate observed facts from uncertain inferences and give "
    "specific corrections where useful."
)


def make_inspect_image_tool(
    provider: LLMProvider,
    *,
    workspace_root: str | Path | None = None,
):
    root = Path(workspace_root or Path.cwd()).resolve()

    async def inspect_image_tool(path: str, question: str | None = None) -> str:
        try:
            image_path = _resolve_workspace_image(path, root)
        except ValueError as exc:
            return _json({"ok": False, "tool": "inspect_image", "error": str(exc)})

        size = image_path.stat().st_size
        if size > MAX_IMAGE_BYTES:
            return _json(
                {
                    "ok": False,
                    "tool": "inspect_image",
                    "error": (
                        f"Image is too large ({size} bytes). Maximum allowed size is "
                        f"{MAX_IMAGE_BYTES} bytes."
                    ),
                }
            )

        prompt = (question or "").strip() or DEFAULT_QUESTION
        message = Message(
            role="user",
            content=[
                TextBlock(prompt),
                ImageBlock(
                    path=str(image_path),
                    media_type=SUPPORTED_MEDIA_TYPES[image_path.suffix.lower()],
                    name=image_path.name,
                ),
            ],
        )
        try:
            response = await provider.chat([message], tools=None)
        except Exception as exc:
            return _json(
                {
                    "ok": False,
                    "tool": "inspect_image",
                    "path": str(image_path),
                    "error": "Visual inspection request failed",
                    "detail": f"{type(exc).__name__}: {exc}",
                }
            )

        analysis = response.text_content().strip()
        if not analysis:
            return _json(
                {
                    "ok": False,
                    "tool": "inspect_image",
                    "path": str(image_path),
                    "error": "The selected model returned no visible image analysis.",
                }
            )
        return _json(
            {
                "ok": True,
                "tool": "inspect_image",
                "path": str(image_path),
                "bytes": size,
                "analysis": analysis,
            }
        )

    return inspect_image_tool


def _resolve_workspace_image(raw_path: str, root: Path) -> Path:
    if not raw_path or not raw_path.strip():
        raise ValueError("path is required")
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"Image path must stay inside the workspace: {root}") from exc
    if not resolved.is_file():
        raise ValueError(f"Image file not found: {resolved}")
    if resolved.suffix.lower() not in SUPPORTED_MEDIA_TYPES:
        allowed = ", ".join(sorted(SUPPORTED_MEDIA_TYPES))
        raise ValueError(f"Unsupported image format. Use one of: {allowed}")
    return resolved


def _json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)
