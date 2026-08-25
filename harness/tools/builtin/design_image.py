from __future__ import annotations

import base64
import hashlib
import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from harness.types.tools import ToolParam, ToolSchema


IMAGE_GENERATE_SCHEMA = ToolSchema(
    name="image_generate",
    description=(
        "Generate one or more images with an OpenAI-compatible image generation "
        "endpoint. Writes image files and JSON sidecars, then returns their paths."
    ),
    params=[
        ToolParam(name="prompt", type="string", description="Image generation prompt."),
        ToolParam(name="id", type="string", description="Stable image id / filename stem.", required=False),
        ToolParam(name="path", type="string", description="Optional explicit output file path.", required=False),
        ToolParam(name="runId", type="string", description="Optional design run id.", required=False),
        ToolParam(name="runDir", type="string", description="Optional design run directory.", required=False),
        ToolParam(name="purpose", type="string", description="Human-readable purpose for the image.", required=False),
        ToolParam(name="domainType", type="string", description="Optional design domain type for sidecar metadata.", required=False),
        ToolParam(name="deliverableCategory", type="string", description="Optional deliverable category for sidecar metadata.", required=False),
        ToolParam(name="negativePrompt", type="string", description="Optional negative prompt.", required=False),
        ToolParam(
            name="size",
            type="string",
            description=(
                "Requested image size, default 1024x1024. Seedream requests below "
                "the provider minimum are upgraded automatically while preserving orientation."
            ),
            required=False,
        ),
        ToolParam(name="count", type="integer", description="Number of images, default 1.", required=False),
        ToolParam(name="model", type="string", description="Image model override.", required=False),
        ToolParam(name="background", type="string", description="Optional background setting.", required=False),
        ToolParam(name="quality", type="string", description="Optional quality setting.", required=False),
    ],
)


IMAGE_EDIT_SCHEMA = ToolSchema(
    name="image_edit",
    description=(
        "Edit one or more reference images with an OpenAI-compatible image edit "
        "endpoint. Writes edited image files and JSON sidecars, then returns their paths."
    ),
    params=[
        ToolParam(name="prompt", type="string", description="Image edit prompt."),
        ToolParam(
            name="referenceImagePaths",
            type="array",
            description="Reference image file paths.",
            items={"type": "string"},
        ),
        ToolParam(name="id", type="string", description="Stable image id / filename stem.", required=False),
        ToolParam(name="path", type="string", description="Optional explicit output file path.", required=False),
        ToolParam(name="runId", type="string", description="Optional design run id.", required=False),
        ToolParam(name="runDir", type="string", description="Optional design run directory.", required=False),
        ToolParam(name="purpose", type="string", description="Human-readable purpose for the image.", required=False),
        ToolParam(name="domainType", type="string", description="Optional design domain type for sidecar metadata.", required=False),
        ToolParam(name="deliverableCategory", type="string", description="Optional deliverable category for sidecar metadata.", required=False),
        ToolParam(name="maskPath", type="string", description="Optional mask image path.", required=False),
        ToolParam(
            name="size",
            type="string",
            description=(
                "Requested image size, default 1024x1024. Seedream requests below "
                "the provider minimum are upgraded automatically while preserving orientation."
            ),
            required=False,
        ),
        ToolParam(name="count", type="integer", description="Number of edited images, default 1.", required=False),
        ToolParam(name="model", type="string", description="Image model override.", required=False),
    ],
)


PLACEHOLDER_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
VALID_SIZES = {
    "1024x1024",
    "1024x1536",
    "1536x1024",
    "1024x1792",
    "1792x1024",
    "1440x2560",
    "1920x1920",
    "2048x2048",
    "2560x1440",
}
SEEDREAM_MIN_PIXELS = 3_686_400
SEEDREAM_SAFE_SIZES = {
    "square": "2048x2048",
    "landscape": "2560x1440",
    "portrait": "1440x2560",
}


def _load_project_env_once() -> None:
    if getattr(_load_project_env_once, "_loaded", False):
        return
    setattr(_load_project_env_once, "_loaded", True)
    env_path = Path.cwd() / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _slug(value: str, default: str = "image") -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", (value or "").strip()).strip("-._")
    return (value or default)[:80]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _api_key() -> str:
    _load_project_env_once()
    return (
        os.getenv("DREAMATIC_IMAGE_API_KEY")
        or os.getenv("DREAMATIC_API_KEY")
        or os.getenv("DESIGN_IMAGE_API_KEY")
        or os.getenv("OPENAI_HUB_API_KEY")
        or ""
    )


def _base_url() -> str:
    _load_project_env_once()
    return (
        os.getenv("DREAMATIC_IMAGE_BASE_URL")
        or os.getenv("DREAMATIC_BASE_URL")
        or os.getenv("DESIGN_IMAGE_BASE_URL")
        or os.getenv("OPENAI_HUB_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")


def _generation_endpoint() -> str:
    _load_project_env_once()
    return (
        os.getenv("DREAMATIC_IMAGE_GENERATION_ENDPOINT")
        or os.getenv("DESIGN_IMAGE_ENDPOINT")
        or f"{_base_url()}/images/generations"
    )


def _edit_endpoint() -> str:
    _load_project_env_once()
    return (
        os.getenv("DREAMATIC_IMAGE_EDIT_ENDPOINT")
        or os.getenv("DESIGN_IMAGE_EDIT_ENDPOINT")
        or f"{_base_url()}/images/edits"
    )


def _model(model: str | None) -> str:
    _load_project_env_once()
    return (
        model
        or os.getenv("DREAMATIC_IMAGE_MODEL")
        or os.getenv("DESIGN_IMAGE_MODEL")
        or os.getenv("OPENAI_HUB_IMAGE_MODEL")
        or "gpt-image-2"
    )


def _backend() -> str:
    _load_project_env_once()
    return (os.getenv("DREAMATIC_IMAGE_BACKEND") or os.getenv("DESIGN_IMAGE_BACKEND") or "codex").lower()


def _coerce_count(value: int | None) -> int:
    try:
        count = int(value if value is not None else 1)
    except (TypeError, ValueError):
        count = 1
    return max(1, min(count, 4))


def _requested_size(value: str | None) -> str:
    return (
        value
        or os.getenv("DREAMATIC_IMAGE_DEFAULT_SIZE")
        or os.getenv("DESIGN_IMAGE_DEFAULT_SIZE")
        or "1024x1024"
    ).strip()


def _size_dimensions(size: str) -> tuple[int, int]:
    width, height = size.lower().split("x", maxsplit=1)
    return int(width), int(height)


def _is_seedream_model(model: str) -> bool:
    return "seedream" in model.casefold()


def _coerce_size(value: str | None, model: str | None = None) -> str:
    size = _requested_size(value)
    if size not in VALID_SIZES:
        raise ValueError(f"Invalid size {size!r}. Use one of: {', '.join(sorted(VALID_SIZES))}")
    width, height = _size_dimensions(size)
    if _is_seedream_model(model or "") and width * height < SEEDREAM_MIN_PIXELS:
        orientation = "square" if width == height else "landscape" if width > height else "portrait"
        return SEEDREAM_SAFE_SIZES[orientation]
    return size


def _size_result_fields(requested_size: str, actual_size: str) -> dict[str, Any]:
    fields: dict[str, Any] = {"size": actual_size}
    if requested_size != actual_size:
        fields.update(
            {
                "size_adjusted_from": requested_size,
                "size_adjustment_reason": (
                    f"Seedream requires at least {SEEDREAM_MIN_PIXELS} pixels; "
                    "the request was upgraded while preserving orientation."
                ),
            }
        )
    return fields


def _output_dir(runDir: str | None, subdir: str) -> Path:
    if runDir:
        return Path(runDir) / "artifacts" / subdir
    return Path("outputs") / "images" / subdir


def _output_paths(
    *,
    explicit_path: str | None,
    runDir: str | None,
    subdir: str,
    image_id: str | None,
    count: int,
) -> list[Path]:
    if explicit_path:
        base = Path(explicit_path)
        if count == 1:
            return [base]
        stem = base.stem
        suffix = base.suffix or ".png"
        return [base.with_name(f"{stem}-{idx + 1}{suffix}") for idx in range(count)]
    out_dir = _output_dir(runDir, subdir)
    stem = _slug(image_id or f"image-{int(time.time())}")
    if count == 1:
        return [out_dir / f"{stem}.png"]
    return [out_dir / f"{stem}-{idx + 1}.png" for idx in range(count)]


async def _download_url(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.content


async def _image_bytes_from_item(item: dict[str, Any]) -> bytes:
    if b64 := item.get("b64_json"):
        return base64.b64decode(b64)
    if url := item.get("url"):
        return await _download_url(str(url))
    raise ValueError("Image API response item has neither b64_json nor url")


async def _write_items(
    *,
    items: list[dict[str, Any]],
    paths: list[Path],
    metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    written: list[dict[str, Any]] = []
    for item, path in zip(items, paths):
        data = await _image_bytes_from_item(item)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        sidecar = {
            **metadata,
            "file": str(path),
            "sha256": _sha256(data),
            "bytes": len(data),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        path.with_suffix(path.suffix + ".json").write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written.append(
            {
                "file": str(path),
                "relativePath": path.name,
                "sha256": sidecar["sha256"],
                "bytes": len(data),
            }
        )
    return written


async def image_generate_tool(
    prompt: str,
    id: str | None = None,
    path: str | None = None,
    runId: str | None = None,
    runDir: str | None = None,
    purpose: str | None = None,
    domainType: str | None = None,
    deliverableCategory: str | None = None,
    negativePrompt: str | None = None,
    size: str | None = None,
    count: int | None = None,
    model: str | None = None,
    background: str | None = None,
    quality: str | None = None,
) -> str:
    if not prompt or not prompt.strip():
        return _json({"ok": False, "error": "prompt is required"})
    try:
        image_model = _model(model)
        image_count = _coerce_count(count)
        requested_size = _requested_size(size)
        image_size = _coerce_size(size, image_model)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc)})
    size_fields = _size_result_fields(requested_size, image_size)

    out_paths = _output_paths(
        explicit_path=path,
        runDir=runDir,
        subdir="generated-images",
        image_id=id,
        count=image_count,
    )

    if _backend() == "mock":
        items = [{"b64_json": base64.b64encode(PLACEHOLDER_PNG).decode("ascii")} for _ in range(image_count)]
        written = await _write_items(
            items=items,
            paths=out_paths,
            metadata={
                "tool": "image_generate",
                "backend": "mock",
                "runId": runId,
                "domain_type": domainType,
                "deliverable_category": deliverableCategory,
                "purpose": purpose,
                "prompt": prompt,
                "model": image_model,
                **size_fields,
            },
        )
        return _json({"ok": True, "backend": "mock", "model": image_model, **size_fields, "items": written})

    key = _api_key()
    if not key:
        return _json({"ok": False, "error": "Missing DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, DESIGN_IMAGE_API_KEY, or OPENAI_HUB_API_KEY"})

    payload: dict[str, Any] = {
        "model": image_model,
        "prompt": prompt if not negativePrompt else f"{prompt}\n\nAvoid: {negativePrompt}",
        "n": image_count,
        "size": image_size,
    }
    if background:
        payload["background"] = background
    if quality:
        payload["quality"] = quality

    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(
                _generation_endpoint(),
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.RequestError as exc:
        return _json(
            {
                "ok": False,
                "error": "image generation request failed",
                "detail": f"{type(exc).__name__}: {exc}",
            }
        )

    if response.status_code >= 400:
        return _json({"ok": False, "status": response.status_code, "error": _safe_response(response)})

    body = response.json()
    data = body.get("data") or []
    if not isinstance(data, list) or not data:
        return _json({"ok": False, "status": response.status_code, "error": "No image data returned"})

    written = await _write_items(
        items=data[:image_count],
        paths=out_paths,
        metadata={
            "tool": "image_generate",
            "backend": "codex",
            "endpoint": _generation_endpoint(),
            "model": payload["model"],
            "runId": runId,
            "id": id,
            "domain_type": domainType,
            "deliverable_category": deliverableCategory,
            "purpose": purpose,
            "prompt": prompt,
            "negative_prompt": negativePrompt,
            **size_fields,
        },
    )
    return _json(
        {"ok": True, "backend": "codex", "model": payload["model"], **size_fields, "items": written}
    )


async def image_edit_tool(
    prompt: str,
    referenceImagePaths: list[str],
    id: str | None = None,
    path: str | None = None,
    runId: str | None = None,
    runDir: str | None = None,
    purpose: str | None = None,
    domainType: str | None = None,
    deliverableCategory: str | None = None,
    maskPath: str | None = None,
    size: str | None = None,
    count: int | None = None,
    model: str | None = None,
) -> str:
    if not prompt or not prompt.strip():
        return _json({"ok": False, "error": "prompt is required"})
    if not referenceImagePaths:
        return _json({"ok": False, "error": "referenceImagePaths must contain at least one image"})
    refs = [Path(p) for p in referenceImagePaths]
    missing = [str(p) for p in refs if not p.exists()]
    if missing:
        return _json({"ok": False, "error": "reference image not found", "missing": missing})
    if maskPath and not Path(maskPath).exists():
        return _json({"ok": False, "error": f"maskPath not found: {maskPath}"})
    try:
        image_model = _model(model)
        image_count = _coerce_count(count)
        requested_size = _requested_size(size)
        image_size = _coerce_size(size, image_model)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc)})
    size_fields = _size_result_fields(requested_size, image_size)

    out_paths = _output_paths(
        explicit_path=path,
        runDir=runDir,
        subdir="edits",
        image_id=id,
        count=image_count,
    )

    if _backend() == "mock":
        items = [{"b64_json": base64.b64encode(PLACEHOLDER_PNG).decode("ascii")} for _ in range(image_count)]
        written = await _write_items(
            items=items,
            paths=out_paths,
            metadata={
                "tool": "image_edit",
                "backend": "mock",
                "runId": runId,
                "domain_type": domainType,
                "deliverable_category": deliverableCategory,
                "purpose": purpose,
                "prompt": prompt,
                "model": image_model,
                **size_fields,
            },
        )
        return _json({"ok": True, "backend": "mock", "model": image_model, **size_fields, "items": written})

    key = _api_key()
    if not key:
        return _json({"ok": False, "error": "Missing DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, DESIGN_IMAGE_API_KEY, or OPENAI_HUB_API_KEY"})

    form = {
        "model": image_model,
        "prompt": prompt,
        "n": str(image_count),
        "size": image_size,
    }
    try:
        response = await asyncio.to_thread(
            _post_edit_request_sync,
            endpoint=_edit_endpoint(),
            key=key,
            form=form,
            refs=refs,
            mask_path=Path(maskPath) if maskPath else None,
        )
    except httpx.RequestError as exc:
        return _json(
            {
                "ok": False,
                "error": "image edit request failed",
                "detail": f"{type(exc).__name__}: {exc}",
            }
        )

    if response.status_code >= 400:
        return _json({"ok": False, "status": response.status_code, "error": _safe_response(response)})

    body = response.json()
    data = body.get("data") or []
    if not isinstance(data, list) or not data:
        return _json({"ok": False, "status": response.status_code, "error": "No image data returned"})

    ref_meta = [{"path": str(p), "sha256": _sha256(p.read_bytes())} for p in refs]
    written = await _write_items(
        items=data[:image_count],
        paths=out_paths,
        metadata={
            "tool": "image_edit",
            "backend": "codex",
            "endpoint": _edit_endpoint(),
            "model": form["model"],
            "runId": runId,
            "id": id,
            "domain_type": domainType,
            "deliverable_category": deliverableCategory,
            "purpose": purpose,
            "prompt": prompt,
            **size_fields,
            "references": ref_meta,
            "maskPath": maskPath,
        },
    )
    return _json(
        {"ok": True, "backend": "codex", "model": form["model"], **size_fields, "items": written}
    )


def _mime_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    return "image/png"


def _post_edit_request_sync(
    *,
    endpoint: str,
    key: str,
    form: dict[str, str],
    refs: list[Path],
    mask_path: Path | None,
) -> httpx.Response:
    # Some OpenAI-compatible routers are flaky with async multipart uploads on
    # Windows/proxy stacks. Keep the tool async externally, but perform this
    # one multipart request with the synchronous client in a worker thread.
    files: list[tuple[str, tuple[str, Any, str]]] = []
    opened = []
    try:
        for ref in refs:
            fh = ref.open("rb")
            opened.append(fh)
            files.append(("image", (ref.name, fh, _mime_for(ref))))
        if mask_path:
            fh = mask_path.open("rb")
            opened.append(fh)
            files.append(("mask", (mask_path.name, fh, _mime_for(mask_path))))
        with httpx.Client(timeout=180) as client:
            return client.post(
                endpoint,
                headers={"Authorization": f"Bearer {key}"},
                data=form,
                files=files,
            )
    finally:
        for fh in opened:
            fh.close()


def _safe_response(response: httpx.Response) -> Any:
    try:
        payload = response.json()
    except Exception:
        return response.text[:1000]
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        err = payload["error"]
        return {k: err.get(k) for k in ("message", "type", "code", "param") if k in err}
    return payload
