from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

from api.canvas_publish import validate_run_id


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _artifact_relative_path(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/").lstrip("./")
    if raw.startswith("artifacts/"):
        raw = raw[len("artifacts/"):]
    if not raw or raw.startswith("../"):
        return ""
    return raw


def _manifest_items(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("artifacts", "items", "deliverables"):
        value = manifest.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _sidecar_asset(sidecar: Path, artifacts_dir: Path) -> tuple[Path, dict[str, Any]] | None:
    # Image sidecars use "image.png.json". A few older runs store "image.json".
    candidates = [Path(str(sidecar)[:-5])]
    if sidecar.suffix == ".json":
        candidates.extend(sidecar.with_suffix(ext) for ext in IMAGE_EXTENSIONS)
    image = next((candidate for candidate in candidates if candidate.is_file()), None)
    if image is None or image.suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    try:
        image.resolve().relative_to(artifacts_dir.resolve())
    except ValueError:
        return None
    return image, _read_json(sidecar)


def _asset_url(run_id: str, asset_path: str, source: str) -> str:
    if source == "run":
        return f"/run-assets/{run_id}/{asset_path}"
    return f"/outputs/runs/{run_id}/final/{asset_path}"


def _path_priority(asset_path: str) -> int:
    if "/edits/" in f"/{asset_path}":
        return 3
    if "/user-assets/" in f"/{asset_path}":
        return 2
    return 1


def _rewrite_canvas_state_urls(
    state: dict[str, Any],
    run_id: str,
    source: str,
    assets_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    elements = state.get("elements")
    if not isinstance(elements, list):
        return {}
    missing_asset_ids = {
        str(element.get("assetId"))
        for element in elements
        if isinstance(element, dict)
        and element.get("type") == "image"
        and element.get("assetId")
        and str(element.get("assetId")) not in assets_by_id
    }
    rewritten: list[dict[str, Any]] = []
    for original in elements:
        if not isinstance(original, dict):
            continue
        related_ids = original.get("relatedAssetIds")
        if isinstance(related_ids, list) and any(
            str(asset_id) in missing_asset_ids for asset_id in related_ids
        ):
            continue
        element = dict(original)
        if element.get("type") == "image":
            asset_path = str(element.get("assetPath") or "").replace("\\", "/").lstrip("/")
            asset_id = str(element.get("assetId") or "")
            asset = assets_by_id.get(asset_id)
            if asset is None:
                continue
            asset_path = str(asset["assetPath"])
            element["assetPath"] = asset_path
            element["sidecarPath"] = asset.get("sidecarPath", "")
            element["title"] = asset.get("title") or element.get("title", "")
            element["description"] = asset.get("description") or element.get("description", "")
            element["artifactMetadata"] = asset.get("artifactMetadata", {})
            element["sidecarMetadata"] = asset.get("sidecarMetadata", {})
            element["src"] = _asset_url(run_id, asset_path, source)
        rewritten.append(element)
    return {**state, "elements": rewritten}


def build_canvas_asset_index(
    runs_dir: Path, outputs_dir: Path, run_id: str
) -> dict[str, Any]:
    run_id = validate_run_id(run_id)
    live_run_dir = runs_dir / run_id
    final_dir = outputs_dir / "runs" / run_id / "final"
    if live_run_dir.is_dir():
        source = "run"
        root = live_run_dir
    elif final_dir.is_dir():
        source = "final"
        root = final_dir
    else:
        raise FileNotFoundError(f"Run '{run_id}' was not found")

    artifacts_dir = root / "artifacts"
    manifest = _read_json(artifacts_dir / "artifact-manifest.json")
    manifest_by_path: dict[str, dict[str, Any]] = {}
    for item in _manifest_items(manifest):
        relative = _artifact_relative_path(item.get("file") or item.get("path") or item.get("assetPath"))
        if relative:
            manifest_by_path[f"artifacts/{relative}"] = item

    candidates: dict[str, dict[str, Any]] = {}
    sidecars = list(artifacts_dir.rglob("*.json")) if artifacts_dir.is_dir() else []
    for sidecar in sidecars:
        resolved = _sidecar_asset(sidecar, artifacts_dir)
        if resolved is None:
            continue
        image, metadata = resolved
        relative = image.relative_to(root).as_posix()
        entry = manifest_by_path.get(relative, {})
        asset_id = str(entry.get("id") or metadata.get("id") or image.stem)
        candidate = {
            "assetId": asset_id,
            "assetPath": relative,
            "url": _asset_url(run_id, relative, source),
            "title": str(entry.get("title") or metadata.get("title") or metadata.get("purpose") or asset_id),
            "description": str(entry.get("description") or metadata.get("description") or metadata.get("purpose") or ""),
            "group": str(entry.get("group") or metadata.get("group") or entry.get("category") or metadata.get("deliverable_category") or "新增素材"),
            "category": str(entry.get("category") or metadata.get("deliverable_category") or ""),
            "priority": str(entry.get("priority") or metadata.get("priority") or ""),
            "method": str(entry.get("method") or metadata.get("tool") or metadata.get("method") or ""),
            "sidecarPath": sidecar.relative_to(root).as_posix(),
            "artifactMetadata": entry,
            "sidecarMetadata": metadata,
        }
        previous = candidates.get(asset_id)
        if previous is None or _path_priority(relative) >= _path_priority(previous["assetPath"]):
            candidates[asset_id] = candidate

    # A manifest can be written before its sidecars. Keep valid manifest images visible.
    for relative, entry in manifest_by_path.items():
        image = root / relative
        if not image.is_file() or image.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        asset_id = str(entry.get("id") or image.stem)
        if asset_id in candidates:
            continue
        candidates[asset_id] = {
            "assetId": asset_id,
            "assetPath": relative,
            "url": _asset_url(run_id, relative, source),
            "title": str(entry.get("title") or asset_id),
            "description": str(entry.get("description") or ""),
            "group": str(entry.get("group") or entry.get("category") or "新增素材"),
            "category": str(entry.get("category") or ""),
            "priority": str(entry.get("priority") or ""),
            "method": str(entry.get("method") or ""),
            "sidecarPath": "",
            "artifactMetadata": entry,
            "sidecarMetadata": {},
        }

    canvas_state = _read_json(root / "canvas" / "canvas-state.json")
    excluded_asset_ids = {
        str(value) for value in canvas_state.get("excludedAssetIds", [])
    } if isinstance(canvas_state.get("excludedAssetIds"), list) else set()
    assets = sorted(
        (
            asset for asset in candidates.values()
            if str(asset.get("assetId") or "") not in excluded_asset_ids
        ),
        key=lambda item: (item.get("group", ""), item.get("assetId", "")),
    )
    assets_by_id = {str(item["assetId"]): item for item in assets}
    canvas_state = _rewrite_canvas_state_urls(
        canvas_state, run_id, source, assets_by_id
    )

    tracked_files = [artifacts_dir / "artifact-manifest.json", root / "canvas" / "canvas-state.json"]
    tracked_files.extend(sidecars)
    tracked_files.extend(root / str(asset["assetPath"]) for asset in assets)
    revision_parts: list[str] = []
    for path in tracked_files:
        if not path.is_file():
            continue
        stat = path.stat()
        revision_parts.append(f"file:{path.as_posix()}:{stat.st_mtime_ns}:{stat.st_size}")
    revision_parts.extend(
        f"asset:{asset['assetId']}:{asset['assetPath']}" for asset in assets
    )
    revision = hashlib.sha256("\n".join(sorted(revision_parts)).encode("utf-8")).hexdigest()[:16]
    return {
        "runId": run_id,
        "source": source,
        "revision": revision,
        "assets": assets,
        "canvasState": canvas_state or None,
        "galleryUrl": _asset_url(run_id, "artifacts/00-gallery.html", source)
        if (artifacts_dir / "00-gallery.html").is_file()
        else "",
    }
