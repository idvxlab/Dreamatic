from __future__ import annotations

import base64
import binascii
import json
import re
import shutil
from copy import deepcopy
from datetime import datetime, timezone
from html.parser import HTMLParser
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


SAFE_RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
SAFE_ELEMENT_ID_RE = re.compile(r"[^A-Za-z0-9._-]+")
EDITED_GALLERY_RE = re.compile(r"^(\d+)-gallery-edited\.html$", re.IGNORECASE)
DATA_URL_RE = re.compile(
    r"^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE,
)
REMOTE_REF_RE = re.compile(
    r"(?:https?:)?//|\b(?:src|href)\s*=\s*['\"]\s*(?:data|javascript):|url\(\s*['\"]?\s*data:",
    re.IGNORECASE,
)
MAX_EMBEDDED_ASSET_BYTES = 30 * 1024 * 1024


class CanvasPublishError(ValueError):
    pass


class CanvasPublishValidationError(CanvasPublishError):
    def __init__(self, issues: list[str]):
        self.issues = issues
        super().__init__("; ".join(issues))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_run_id(run_id: str) -> str:
    clean = str(run_id or "").strip()
    if not clean or not SAFE_RUN_ID_RE.fullmatch(clean):
        raise CanvasPublishError("Invalid run_id")
    return clean


def next_gallery_export_name(run_dir: Path, final_artifacts: Path | None = None) -> str:
    """Return the next historical gallery name without overwriting an export."""
    numbers: list[int] = []
    directories = [run_dir / "artifacts"]
    if final_artifacts is not None:
        directories.append(final_artifacts)
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in directory.glob("*-gallery-edited.html"):
            match = EDITED_GALLERY_RE.fullmatch(path.name)
            if match:
                numbers.append(int(match.group(1)))
    next_number = max(numbers, default=0) + 1
    return f"{next_number:02d}-gallery-edited.html"


def _safe_element_id(value: str) -> str:
    clean = SAFE_ELEMENT_ID_RE.sub("-", str(value or "").strip()).strip("-._")
    return (clean or "asset")[:96]


def _decode_data_url(data_url: str) -> tuple[str, bytes]:
    match = DATA_URL_RE.fullmatch(str(data_url or "").strip())
    if not match:
        raise CanvasPublishError("Embedded assets must be base64 PNG, JPEG, WebP, or GIF data URLs")
    mime_type = match.group(1).lower()
    try:
        payload = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CanvasPublishError("Embedded asset contains invalid base64 data") from exc
    if not payload or len(payload) > MAX_EMBEDDED_ASSET_BYTES:
        raise CanvasPublishError("Embedded asset is empty or exceeds 30 MB")
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}[mime_type]
    return extension, payload


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _derive_asset_path(src: str, run_id: str) -> str:
    raw = unquote(urlsplit(str(src or "")).path).replace("\\", "/")
    for marker in (f"/outputs/runs/{run_id}/final/", f"/run-assets/{run_id}/"):
        if marker in raw:
            return raw.split(marker, 1)[1].lstrip("/")
    if raw.startswith("artifacts/"):
        return raw
    return ""


def _safe_run_asset(run_dir: Path, asset_path: str) -> Path | None:
    clean = str(asset_path or "").replace("\\", "/").lstrip("/")
    if not clean.startswith("artifacts/"):
        return None
    candidate = (run_dir / clean).resolve()
    try:
        candidate.relative_to(run_dir.resolve())
    except ValueError:
        return None
    return candidate


def _build_publishing_view(elements: list[Any]) -> list[dict[str, Any]]:
    view: list[dict[str, Any]] = []
    common_fields = (
        "id", "type", "role", "x", "y", "width", "height", "zIndex",
        "fontSize", "textAlign", "relatedAssetIds", "isDecorative",
        "excludeFromPublish", "revisionOf", "modification",
    )
    for element in elements:
        if not isinstance(element, dict) or element.get("id") == "__draw_preview__":
            continue
        item = {key: element[key] for key in common_fields if key in element}
        if element.get("type") == "text":
            item["text"] = str(element.get("text") or "")
        elif element.get("type") == "image":
            for key in ("assetId", "assetPath", "sidecarPath", "title", "description", "source"):
                if element.get(key) not in (None, ""):
                    item[key] = element[key]
            artifact = element.get("artifactMetadata")
            if isinstance(artifact, dict):
                item["artifactMetadata"] = {
                    key: artifact[key]
                    for key in ("id", "title", "category", "group", "priority", "method")
                    if key in artifact
                }
            sidecar = element.get("sidecarMetadata")
            if isinstance(sidecar, dict):
                item["sidecarMetadata"] = {
                    key: sidecar[key]
                    for key in ("id", "purpose", "domain_type", "deliverable_category", "method", "source")
                    if key in sidecar
                }
        view.append(item)
    return view


def _build_publish_input(elements: list[Any], run_id: str) -> dict[str, Any]:
    """Create the small, semantic input consumed by the layout model.

    Coordinates and drawing geometry remain in canvas-state.json for recovery,
    but are deliberately excluded here: the model chooses the presentation
    hierarchy while the renderer owns the actual HTML and asset references.
    """
    assets: list[dict[str, Any]] = []
    texts: list[dict[str, Any]] = []
    for element in elements:
        if not isinstance(element, dict) or element.get("id") == "__draw_preview__":
            continue
        if element.get("excludeFromPublish"):
            continue
        element_id = str(element.get("id") or "")
        if not element_id:
            continue
        if element.get("type") == "image":
            if not element.get("assetPath") or element.get("isDecorative"):
                continue
            item: dict[str, Any] = {
                "elementId": element_id,
                "assetId": str(element.get("assetId") or element_id),
                "assetPath": str(element.get("assetPath")),
                "title": str(element.get("title") or element.get("name") or ""),
                "description": str(element.get("description") or ""),
                "role": str(element.get("role") or "asset"),
                "revision": str(element.get("revision") or element.get("modification") or "latest"),
                "isDecorative": bool(element.get("isDecorative")),
                "userNotes": element.get("userNotes") if isinstance(element.get("userNotes"), list) else [],
            }
            for key in ("artifactMetadata", "sidecarMetadata"):
                if isinstance(element.get(key), dict) and element[key]:
                    item[key] = element[key]
            assets.append(item)
        elif element.get("type") == "text":
            text = str(element.get("text") or "")
            if text.strip():
                texts.append({
                    "elementId": element_id,
                    "text": text,
                    "role": str(element.get("role") or "annotation"),
                    "relatedAssetIds": [str(value) for value in element.get("relatedAssetIds", [])]
                    if isinstance(element.get("relatedAssetIds"), list) else [],
                })
    return {
        "version": 1,
        "runId": run_id,
        "title": run_id,
        "assets": assets,
        "texts": texts,
    }


def persist_canvas_state(
    root_dir: Path,
    outputs_dir: Path,
    run_id: str,
    canvas_state: dict[str, Any],
    embedded_assets: list[dict[str, Any]],
) -> dict[str, Any]:
    run_id = validate_run_id(run_id)
    run_dir = root_dir / ".design-harness" / "runs" / run_id
    if not run_dir.is_dir():
        raise CanvasPublishError(f"Run '{run_id}' does not exist")

    state = deepcopy(canvas_state)
    if not isinstance(state, dict):
        raise CanvasPublishError("canvas_state must be an object")
    elements = state.get("elements")
    if not isinstance(elements, list) or not elements:
        raise CanvasPublishError("The canvas has no elements to publish")
    if len(elements) > 2000:
        raise CanvasPublishError("The canvas contains too many elements")

    state["version"] = 1
    state["runId"] = run_id
    state["savedAt"] = utc_now()
    element_by_id = {
        str(element.get("id")): element
        for element in elements
        if isinstance(element, dict) and element.get("id")
    }
    user_assets_dir = run_dir / "artifacts" / "user-assets"
    final_user_assets_dir = outputs_dir / "runs" / run_id / "final" / "artifacts" / "user-assets"

    for embedded in embedded_assets:
        element_id = str(embedded.get("element_id") or "")
        element = element_by_id.get(element_id)
        if element is None or element.get("type") != "image":
            raise CanvasPublishError(f"Embedded asset element '{element_id}' was not found")
        extension, payload = _decode_data_url(str(embedded.get("data_url") or ""))
        safe_id = _safe_element_id(element_id)
        filename = f"user-{safe_id}{extension}"
        user_assets_dir.mkdir(parents=True, exist_ok=True)
        final_user_assets_dir.mkdir(parents=True, exist_ok=True)
        asset_file = user_assets_dir / filename
        asset_file.write_bytes(payload)
        shutil.copy2(asset_file, final_user_assets_dir / filename)

        asset_id = f"user-{safe_id}"
        asset_path = f"artifacts/user-assets/{filename}"
        sidecar_path = f"{asset_path}.json"
        sidecar = {
            "id": asset_id,
            "source": "canvas_paste",
            "file": asset_path,
            "name": str(embedded.get("name") or element.get("name") or filename),
            "mime_type": str(embedded.get("data_url") or "").split(";", 1)[0].removeprefix("data:"),
            "bytes": len(payload),
            "created_at": utc_now(),
        }
        sidecar_file = Path(str(asset_file) + ".json")
        sidecar_file.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        shutil.copy2(sidecar_file, Path(str(final_user_assets_dir / filename) + ".json"))
        element.update({
            "assetId": asset_id,
            "assetPath": asset_path,
            "sidecarPath": sidecar_path,
            "src": asset_path,
            "source": "canvas_paste",
        })

    artifact_manifest = _read_json_object(run_dir / "artifacts" / "artifact-manifest.json")
    manifest_by_path: dict[str, dict[str, Any]] = {}
    for item in artifact_manifest.get("artifacts", []):
        if not isinstance(item, dict) or not item.get("file"):
            continue
        item_path = str(item["file"]).replace("\\", "/").lstrip("/")
        if not item_path.startswith("artifacts/"):
            item_path = f"artifacts/{item_path}"
        manifest_by_path[item_path] = item

    for element in elements:
        if not isinstance(element, dict) or element.get("type") != "image":
            continue
        asset_path = str(element.get("assetPath") or _derive_asset_path(element.get("src", ""), run_id))
        asset_path = asset_path.replace("\\", "/").lstrip("/")
        asset_file = _safe_run_asset(run_dir, asset_path)
        if not asset_path or asset_file is None or not asset_file.is_file():
            raise CanvasPublishError(f"Image element '{element.get('id', '')}' has no readable local asset")
        sidecar_path = str(element.get("sidecarPath") or f"{asset_path}.json").replace("\\", "/").lstrip("/")
        sidecar_file = _safe_run_asset(run_dir, sidecar_path)
        metadata = _read_json_object(sidecar_file) if sidecar_file else {}
        manifest_entry = manifest_by_path.get(asset_path, {})
        element["assetPath"] = asset_path
        element["sidecarPath"] = sidecar_path if sidecar_file and sidecar_file.is_file() else ""
        element["assetId"] = str(element.get("assetId") or manifest_entry.get("id") or metadata.get("id") or asset_file.stem)
        if manifest_entry:
            element["artifactMetadata"] = manifest_entry
        if metadata:
            element["sidecarMetadata"] = metadata

    known_asset_ids: set[str] = set()
    for asset_path, item in manifest_by_path.items():
        asset_file = _safe_run_asset(run_dir, asset_path)
        if asset_file and asset_file.is_file() and asset_file.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            known_asset_ids.add(str(item.get("id") or asset_file.stem))
    for sidecar_file in (run_dir / "artifacts").rglob("*.json"):
        image_file = Path(str(sidecar_file)[:-5])
        if not image_file.is_file() or image_file.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            continue
        metadata = _read_json_object(sidecar_file)
        known_asset_ids.add(str(metadata.get("id") or image_file.stem))
    visible_asset_ids = {
        str(element.get("assetId"))
        for element in elements
        if isinstance(element, dict)
        and element.get("type") == "image"
        and element.get("assetId")
    }
    excluded_asset_ids = sorted(known_asset_ids - visible_asset_ids)

    publishing_view = _build_publishing_view(elements)
    state = {
        "version": state.get("version", 1),
        "runId": run_id,
        "createdAt": state.get("createdAt", ""),
        "savedAt": state.get("savedAt", utc_now()),
        "bounds": state.get("bounds"),
        "excludedAssetIds": excluded_asset_ids,
        "publishingView": publishing_view,
        "elements": elements,
    }
    canvas_dir = run_dir / "canvas"
    final_canvas_dir = outputs_dir / "runs" / run_id / "final" / "canvas"
    canvas_dir.mkdir(parents=True, exist_ok=True)
    final_canvas_dir.mkdir(parents=True, exist_ok=True)
    state_file = canvas_dir / "canvas-state.json"
    serialized = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
    state_file.write_text(serialized, encoding="utf-8")
    (final_canvas_dir / "canvas-state.json").write_text(serialized, encoding="utf-8")
    publish_input = _build_publish_input(elements, run_id)
    input_text = json.dumps(publish_input, ensure_ascii=False, indent=2) + "\n"
    input_file = canvas_dir / "canvas-publish-input.json"
    input_file.write_text(input_text, encoding="utf-8")
    (final_canvas_dir / "canvas-publish-input.json").write_text(input_text, encoding="utf-8")
    return {
        "run_id": run_id, "run_dir": run_dir, "state": state,
        "state_file": state_file, "publish_input": publish_input,
        "publish_input_file": input_file,
    }


class _PublishedHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.images: list[str] = []
        self.text_parts: list[str] = []
        self.title_parts: list[str] = []
        self.in_title = False
        self.has_script = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lower = tag.casefold()
        if lower == "script":
            self.has_script = True
        if lower == "title":
            self.in_title = True
        if lower == "img":
            self.images.append(str(dict(attrs).get("src") or ""))

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        self.text_parts.append(data)
        if self.in_title:
            self.title_parts.append(data)


def _normalize_text(value: str) -> str:
    return " ".join(str(value or "").split())


def _is_inline_canvas_caption(item: dict[str, Any]) -> bool:
    """These canvas fields are rendered as section/card captions already."""
    return str(item.get("role") or "").casefold() in {
        "chapter-title", "caption-title", "caption-description",
    }


def _html_image_path(src: str) -> str:
    value = unquote(urlsplit(str(src or "")).path).replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value.lstrip("/")


def infer_domain_skill_name(publish_input: dict[str, Any]) -> str:
    """Choose the project domain Skill from the asset metadata majority."""
    aliases = {
        "product-design": "product-design",
        "product_design": "product-design",
        "brand-cultural-design": "brand-identity",
        "brand_cultural_design": "brand-identity",
        "architecture-space-design": "architecture-space",
        "architecture_space_design": "architecture-space",
        "poster-advertising-design": "poster-advertising",
        "poster_advertising_design": "poster-advertising",
    }
    counts: dict[str, int] = {}
    for asset in publish_input.get("assets", []):
        if not isinstance(asset, dict):
            continue
        for metadata_key in ("sidecarMetadata", "artifactMetadata"):
            metadata = asset.get(metadata_key)
            if not isinstance(metadata, dict):
                continue
            raw = str(metadata.get("domain_type") or metadata.get("domainType") or "").casefold()
            skill_name = aliases.get(raw)
            if skill_name:
                counts[skill_name] = counts.get(skill_name, 0) + 1
    return max(counts, key=counts.get) if counts else "product-design"


def extract_authored_html(response: str) -> str:
    """Extract one complete HTML document from a Designer response."""
    text = str(response or "").strip()
    # The engine may concatenate several continuation messages and the model
    # may add a short note after the document. Select only the first complete
    # HTML document instead of requiring it to occupy the entire response.
    match = re.search(r"(?is)(<!doctype\s+html\s*>\s*)?<html\b.*?</html>", text)
    if not match:
        raise CanvasPublishError("Designer did not return a complete HTML document")
    html = match.group(0).strip()
    if not html.casefold().startswith("<!doctype"):
        html = "<!doctype html>\n" + html
    return html + "\n"


def normalize_authored_image_paths(html: str, publish_input: dict[str, Any]) -> str:
    """Replace Designer-guessed image directories with authoritative paths."""
    paths_by_filename: dict[str, str] = {}
    ambiguous_filenames: set[str] = set()
    for asset in publish_input.get("assets", []):
        if not isinstance(asset, dict):
            continue
        expected = str(asset.get("assetPath") or "").replace("\\", "/").removeprefix("artifacts/")
        filename = expected.rsplit("/", 1)[-1]
        if not filename:
            continue
        if filename in paths_by_filename and paths_by_filename[filename] != expected:
            ambiguous_filenames.add(filename)
        else:
            paths_by_filename[filename] = expected
    for filename in ambiguous_filenames:
        paths_by_filename.pop(filename, None)

    src_re = re.compile(r"(?i)(\bsrc\s*=\s*)([\"'])(.*?)(\2)")
    img_re = re.compile(r"(?is)<img\b[^>]*>")

    def normalize_tag(match: re.Match[str]) -> str:
        tag = match.group(0)
        src_match = src_re.search(tag)
        if not src_match:
            return tag
        current = _html_image_path(src_match.group(3))
        filename = current.rsplit("/", 1)[-1]
        expected = paths_by_filename.get(filename)
        if not expected or current == expected:
            return tag
        replacement = f"{src_match.group(1)}{src_match.group(2)}{expected}{src_match.group(4)}"
        return tag[:src_match.start()] + replacement + tag[src_match.end():]

    return img_re.sub(normalize_tag, html)


def normalize_layout_plan(raw: Any, publish_input: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize a model-produced layout plan."""
    if not isinstance(raw, dict):
        raise CanvasPublishError("Layout model did not return a JSON object")
    assets = publish_input.get("assets", [])
    texts = publish_input.get("texts", [])
    asset_ids = {str(item.get("assetId")) for item in assets if isinstance(item, dict)}
    text_ids = {str(item.get("elementId")) for item in texts if isinstance(item, dict)}
    sections: list[dict[str, Any]] = []
    seen_assets: set[str] = set()
    seen_texts: set[str] = set()
    for index, section in enumerate(raw.get("sections", [])):
        if not isinstance(section, dict):
            continue
        requested_assets = [str(value) for value in section.get("assetIds", [])]
        requested_texts = [str(value) for value in section.get("textIds", [])]
        unknown_assets = [value for value in requested_assets if value not in asset_ids]
        unknown_texts = [value for value in requested_texts if value not in text_ids]
        if unknown_assets or unknown_texts:
            unknown = unknown_assets + unknown_texts
            raise CanvasPublishError("Layout plan references unknown IDs: " + ", ".join(unknown[:10]))
        section_assets = requested_assets
        section_texts = requested_texts
        section_assets = [value for value in section_assets if value not in seen_assets]
        section_texts = [value for value in section_texts if value not in seen_texts]
        if not section_assets and not section_texts:
            continue
        seen_assets.update(section_assets)
        seen_texts.update(section_texts)
        sections.append({
            "id": str(section.get("id") or f"section-{index + 1}"),
            "title": str(section.get("title") or "设计内容"),
            "assetIds": section_assets,
            "textIds": section_texts,
            "layout": str(section.get("layout") or "grid"),
        })
    # A model may omit an item; append it deterministically rather than losing
    # user content. This also makes the renderer safe against partial output.
    for asset in assets:
        if isinstance(asset, dict) and str(asset.get("assetId")) not in seen_assets:
            sections.append({"id": f"section-{len(sections) + 1}", "title": "其他素材",
                             "assetIds": [str(asset.get("assetId"))], "textIds": [], "layout": "grid"})
    for text in texts:
        if isinstance(text, dict) and str(text.get("elementId")) not in seen_texts:
            sections.append({"id": f"section-{len(sections) + 1}", "title": "设计说明",
                             "assetIds": [], "textIds": [str(text.get("elementId"))], "layout": "text"})
    return {"title": str(raw.get("title") or publish_input.get("title") or "设计成果"),
            "subtitle": str(raw.get("subtitle") or ""), "sections": sections}


def generate_published_html(
    publish_input: dict[str, Any], layout_plan: dict[str, Any], output_html: Path
) -> None:
    """Render a safe standalone page from semantic input and a layout plan."""
    assets = {str(item.get("assetId")): item for item in publish_input.get("assets", []) if isinstance(item, dict)}
    texts = {str(item.get("elementId")): item for item in publish_input.get("texts", []) if isinstance(item, dict)}
    chunks = ["<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>",
              escape(layout_plan["title"]), " — 交付物画廊</title><style>",
              ":root{--blue:#2B6B9E;--green:#3D8B5E;--gold:#C4943D;--red:#B83240;--purple:#7B5EA7;--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8b949e;--border:#30363d}*{margin:0;padding:0;box-sizing:border-box}html{scroll-behavior:smooth}body{font-family:'Helvetica Neue','Microsoft YaHei',Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.hero{background:linear-gradient(135deg,var(--blue),var(--gold) 50%,var(--red));padding:72px 40px;text-align:center;position:relative;overflow:hidden}.hero:before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.28)}.hero-content{position:relative;z-index:1}.hero h1{font-size:clamp(2rem,4vw,3.2rem);font-weight:300;letter-spacing:.08em;margin-bottom:12px;color:#fff}.hero h2{font-size:1.15rem;font-weight:400;color:rgba(255,255,255,.88)}.hero .meta{margin-top:18px;font-size:.82rem;color:rgba(255,255,255,.66)}.nav{background:var(--card);border-bottom:1px solid var(--border);padding:16px 40px;position:sticky;top:0;z-index:100;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.nav a{color:var(--muted);text-decoration:none;font-size:.8rem;padding:6px 14px;border-radius:20px;border:1px solid var(--border);white-space:nowrap;transition:all .2s}.nav a:hover{color:var(--text);border-color:var(--blue);background:rgba(43,107,158,.12)}.section{padding:60px 40px;max-width:1400px;margin:0 auto;scroll-margin-top:72px}.section-header{display:flex;align-items:center;gap:16px;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}.group-badge{background:var(--blue);color:#fff;font-size:.75rem;font-weight:600;padding:4px 12px;border-radius:4px;letter-spacing:.05em}.section-header h2{font-size:1.5rem;font-weight:400;letter-spacing:.03em}.section-header .count{color:var(--muted);font-size:.85rem;margin-left:auto}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:24px}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:transform .2s,border-color .2s}.card:hover{transform:translateY(-2px);border-color:var(--blue)}.card img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#20262d}.card img.square{aspect-ratio:1/1}.card-body{padding:16px 20px}.card-id{font-size:.7rem;color:var(--blue);font-weight:600;letter-spacing:.1em;margin-bottom:4px}.card-title{font-size:1rem;font-weight:500;margin-bottom:6px}.card-desc{font-size:.8rem;color:var(--muted);line-height:1.5}.card-tags{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}.tag{font-size:.65rem;padding:2px 8px;border-radius:10px;border:1px solid var(--border);color:var(--muted)}.tag-critical{border-color:var(--red);color:var(--red)}.tag-high{border-color:var(--gold);color:var(--gold)}.tag-edit{border-color:var(--green);color:var(--green)}.tag-gen{border-color:var(--purple);color:var(--purple)}.text-list{display:grid;gap:12px;margin-top:20px}.text-item{background:var(--card);border-left:3px solid var(--green);padding:14px 16px;line-height:1.7;white-space:pre-wrap}.footer{text-align:center;padding:40px;color:var(--muted);font-size:.8rem;border-top:1px solid var(--border)}@media(max-width:768px){.hero{padding:52px 20px}.hero h1{font-size:1.8rem}.section{padding:40px 20px}.grid{grid-template-columns:1fr}.nav{padding:12px 20px}}",
              "</style></head><body><header class=\"hero\"><div class=\"hero-content\"><h1>", escape(layout_plan["title"]), "</h1>"];
    if layout_plan.get("subtitle"):
        chunks += ["<h2>", escape(layout_plan["subtitle"]), "</h2>"]
    chunks += ["<div class=\"meta\">", escape(str(publish_input.get("runId") or "")), " · ", str(len(assets)), " Deliverables</div></div></header>"]
    chunks.append("<nav class=\"nav\">")
    for index, section in enumerate(layout_plan.get("sections", []), 1):
        chunks += ["<a href=\"#g", str(index), "\">G", str(index), " ", escape(section["title"]), "</a>"]
    chunks.append("</nav><main>")
    for index, section in enumerate(layout_plan.get("sections", []), 1):
        section_id = f"g{index}"
        section_assets = [assets[item_id] for item_id in section.get("assetIds", []) if item_id in assets and not assets[item_id].get("isDecorative")]
        chunks += ["<section class=\"section\" id=\"", section_id, "\"><div class=\"section-header\"><span class=\"group-badge\">G", str(index), "</span><h2>", escape(section["title"]), "</h2><span class=\"count\">", str(len(section_assets)), " 件</span></div>"]
        if section_assets:
            chunks.append("<div class=\"grid\">")
            for item in section_assets:
                relative = str(item.get("assetPath", "")).replace("\\", "/").removeprefix("artifacts/")
                title = str(item.get("title") or item.get("assetId") or "素材")
                description = str(item.get("description") or "")
                metadata = item.get("artifactMetadata") if isinstance(item.get("artifactMetadata"), dict) else {}
                method = str(metadata.get("method") or "")
                priority = str(metadata.get("priority") or "")
                size = str((item.get("sidecarMetadata") or {}).get("size") or "") if isinstance(item.get("sidecarMetadata"), dict) else ""
                image_class = " square" if "x" in size and size.split("x", 1)[0] == size.split("x", 1)[1] else ""
                chunks += ["<article class=\"card\"><img class=\"", image_class.strip(), "\" src=\"", escape(relative, quote=True), "\" alt=\"", escape(str(item.get("assetId") or title), quote=True), "\"><div class=\"card-body\"><div class=\"card-id\">", escape(str(item.get("assetId") or "")), "</div><div class=\"card-title\">", escape(title), "</div>"]
                if description:
                    chunks += ["<div class=\"card-desc\">", escape(description), "</div>"]
                tags = []
                if priority:
                    tags.append((priority, "tag-" + priority.casefold()))
                if method:
                    tags.append((method, "tag-" + ("edit" if "edit" in method else "gen" if "generate" in method else "")))
                if tags:
                    chunks.append("<div class=\"card-tags\">")
                    for label, klass in tags:
                        chunks += ["<span class=\"tag ", klass, "\">", escape(label), "</span>"]
                    chunks.append("</div>")
                for note in item.get("userNotes", []):
                    if str(note).strip():
                        chunks += ["<div class=\"card-desc\">", escape(str(note)), "</div>"]
                chunks.append("</div></article>")
            chunks.append("</div>")
        for text_id in section.get("textIds", []):
            if text_id in texts and not _is_inline_canvas_caption(texts[text_id]):
                chunks += ["<div class=\"text-list\"><div class=\"text-item\">", escape(str(texts[text_id].get("text") or "")), "</div></div>"]
        chunks.append("</section>")
    chunks.append("</main><footer class=\"footer\">Canvas export · generated from the latest edited assets</footer></body></html>")
    output_html.write_text("".join(chunks), encoding="utf-8")


def validate_published_html(html_file: Path, run_dir: Path, canvas_state: dict[str, Any]) -> dict[str, Any]:
    try:
        html = html_file.read_text(encoding="utf-8")
    except OSError as exc:
        raise CanvasPublishValidationError([f"Unable to read output HTML: {exc}"]) from exc
    issues: list[str] = []
    if len(html.strip()) < 200:
        issues.append("Output HTML is empty or incomplete")
    parser = _PublishedHTMLParser()
    try:
        parser.feed(html)
    except Exception as exc:
        issues.append(f"Output HTML could not be parsed: {exc}")
    if not _normalize_text(" ".join(parser.title_parts)):
        issues.append("Output HTML has no non-empty title")
    if parser.has_script or re.search(r"<\s*script\b", html, re.IGNORECASE):
        issues.append("Output HTML contains a script")
    if REMOTE_REF_RE.search(html):
        issues.append("Output HTML contains a remote, data, or javascript resource")

    image_counts: dict[str, int] = {}
    for src in parser.images:
        normalized = _html_image_path(src)
        image_counts[normalized] = image_counts.get(normalized, 0) + 1

    expected_images: list[dict[str, str]] = []
    expected_texts: list[str] = []
    for element in canvas_state.get("elements", []):
        if not isinstance(element, dict) or element.get("excludeFromPublish"):
            continue
        if element.get("type") == "image" and not element.get("isDecorative"):
            asset_path = str(element.get("assetPath") or "").replace("\\", "/")
            relative_path = asset_path.removeprefix("artifacts/")
            expected_images.append({"id": str(element.get("id") or ""), "path": relative_path})
            asset_file = _safe_run_asset(run_dir, asset_path)
            if asset_file is None or not asset_file.is_file():
                issues.append(f"Canvas image asset is missing: {asset_path}")
        if element.get("type") == "text":
            if _is_inline_canvas_caption(element):
                continue
            text = _normalize_text(str(element.get("text") or ""))
            if text:
                expected_texts.append(text)

    expected_image_counts: dict[str, int] = {}
    for image in expected_images:
        expected_image_counts[image["path"]] = expected_image_counts.get(image["path"], 0) + 1
    expected_paths = set(expected_image_counts)
    for path in image_counts:
        if path in expected_paths or REMOTE_REF_RE.match(path):
            continue
        # The Designer must not invent image filenames. A relative path that
        # is not present in the canvas publish input cannot be packaged with
        # this export, even if a similarly named file exists elsewhere.
        issues.append(f"Image path '{path}' is not a canvas asset")
    for path, expected_count in expected_image_counts.items():
        actual_count = image_counts.get(path, 0)
        # A gallery may intentionally reuse an asset, for example once in the
        # hero and once in its detailed card. The canvas count is the minimum
        # required coverage, not a strict upper bound on presentation uses.
        if actual_count < expected_count:
            issues.append(
                f"Image path '{path}' must appear at least {expected_count} time(s) (found {actual_count})"
            )

    page_text = _normalize_text(" ".join(parser.text_parts))
    for text in expected_texts:
        if text not in page_text:
            preview = text[:80] + ("..." if len(text) > 80 else "")
            issues.append(f"Canvas text is missing: {preview}")

    if issues:
        raise CanvasPublishValidationError(issues)
    return {"image_count": len(expected_images), "text_count": len(expected_texts), "images": expected_images}


def finalize_publish(
    outputs_dir: Path,
    run_id: str,
    run_dir: Path,
    canvas_state: dict[str, Any],
    source_html: Path,
    validation: dict[str, Any],
    output_name: str | None = None,
) -> dict[str, str]:
    final_artifacts = outputs_dir / "runs" / run_id / "final" / "artifacts"
    final_canvas = outputs_dir / "runs" / run_id / "final" / "canvas"
    final_artifacts.mkdir(parents=True, exist_ok=True)
    final_canvas.mkdir(parents=True, exist_ok=True)
    output_name = output_name or source_html.name
    if not EDITED_GALLERY_RE.fullmatch(output_name):
        raise CanvasPublishError("Invalid gallery export filename")
    final_html = final_artifacts / output_name
    shutil.copy2(source_html, final_html)
    manifest = {
        "run_id": run_id,
        "generated_at": utc_now(),
        "source": "canvas-publish-input.json",
        "output": f"artifacts/{output_name}",
        "included_images": validation.get("images", []),
        "text_count": validation.get("text_count", 0),
        "canvas_version": canvas_state.get("version", 1),
    }
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    (run_dir / "canvas" / "canvas-publish-manifest.json").write_text(manifest_text, encoding="utf-8")
    (final_canvas / "canvas-publish-manifest.json").write_text(manifest_text, encoding="utf-8")
    return {"html_file": str(final_html), "manifest_file": str(final_canvas / "canvas-publish-manifest.json")}
