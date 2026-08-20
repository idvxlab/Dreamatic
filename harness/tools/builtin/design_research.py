from __future__ import annotations

import hashlib
import html
import json
import re
import struct
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from harness.types.tools import ToolParam, ToolSchema


RESEARCH_FETCH_SCHEMA = ToolSchema(
    name="research_fetch",
    description="Record a research evidence entry under <runDir>/research/evidence.json.",
    params=[
        ToolParam(name="runId", type="string", description="Design run id."),
        ToolParam(name="runDir", type="string", description="Design run directory."),
        ToolParam(name="title", type="string", description="Source title."),
        ToolParam(name="url", type="string", description="Canonical source URL."),
        ToolParam(name="kind", type="string", description="homepage | news | gallery | wiki | blog | social | spec | other."),
        ToolParam(name="notes", type="string", description="Key facts and design implications."),
        ToolParam(name="cacheText", type="boolean", description="Fetch and cache text body.", required=False),
        ToolParam(name="implies_existing_asset", type="boolean", description="Whether this source confirms an existing asset.", required=False),
        ToolParam(name="asset_kind", type="string", description="Asset kind if applicable.", required=False),
        ToolParam(name="asset_description", type="string", description="Asset description if applicable.", required=False),
        ToolParam(name="duplication_risk", type="string", description="high | medium | low.", required=False),
    ],
)


RESEARCH_ASSET_DISCOVER_SCHEMA = ToolSchema(
    name="research_asset_discover",
    description="Scan an HTML page for candidate image URLs. Read-only; does not download images.",
    params=[
        ToolParam(name="runId", type="string", description="Design run id."),
        ToolParam(name="pageUrl", type="string", description="HTML page URL to scan."),
        ToolParam(name="target", type="string", description="Optional target name to boost candidate scores.", required=False),
        ToolParam(name="includeCss", type="boolean", description="Fetch same-origin CSS and scan url(...).", required=False),
        ToolParam(name="maxCssFiles", type="integer", description="Max CSS files, default 3.", required=False),
        ToolParam(name="maxCandidates", type="integer", description="Max candidates, default 30.", required=False),
    ],
)


RESEARCH_ASSET_FETCH_SCHEMA = ToolSchema(
    name="research_asset_fetch",
    description="Download a reference image into <runDir>/research/assets and update manifest.json.",
    params=[
        ToolParam(name="runId", type="string", description="Design run id."),
        ToolParam(name="runDir", type="string", description="Design run directory."),
        ToolParam(name="id", type="string", description="Stable asset id."),
        ToolParam(name="url", type="string", description="Image URL to download."),
        ToolParam(
            name="kind",
            type="string",
            description=(
                "Reference kind. Common values: logo, campus, application, peer, competitor, "
                "usage_context, cmf, detail, lifestyle, site, precedent, material, lighting, "
                "campaign, typography, format, other."
            ),
        ),
        ToolParam(name="description", type="string", description="Optional human description.", required=False),
        ToolParam(name="sourcePageUrl", type="string", description="Page where asset was discovered.", required=False),
        ToolParam(name="doNotReplace", type="boolean", description="Protect from regeneration.", required=False),
        ToolParam(name="allowedForEdit", type="boolean", description="May be used by image_edit.", required=False),
        ToolParam(name="licenseNote", type="string", description="Licensing/provenance note.", required=False),
        ToolParam(name="timeoutMs", type="integer", description="Timeout in ms.", required=False),
    ],
)


RESEARCH_ASSET_VALIDATE_SCHEMA = ToolSchema(
    name="research_asset_validate",
    description="Validate <runDir>/research/assets/manifest.json and write validation.json.",
    params=[
        ToolParam(name="runId", type="string", description="Design run id."),
        ToolParam(name="runDir", type="string", description="Design run directory."),
        ToolParam(name="minUsableAssets", type="integer", description="Minimum usable assets for ready=true.", required=False),
        ToolParam(name="requireLogo", type="boolean", description="Require logo/protected reference for ready=true.", required=False),
    ],
)


SOURCE_KINDS = {"homepage", "news", "gallery", "wiki", "blog", "social", "spec", "other"}
ASSET_KINDS = {
    "logo",
    "campus",
    "application",
    "peer",
    "competitor",
    "usage_context",
    "cmf",
    "detail",
    "lifestyle",
    "site",
    "precedent",
    "material",
    "lighting",
    "campaign",
    "typography",
    "format",
    "other",
}
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}
MAX_CACHE_BYTES = 1_000_000
MAX_ASSET_BYTES = 15_000_000


async def research_fetch_tool(
    runId: str,
    runDir: str,
    title: str,
    url: str,
    kind: str,
    notes: str,
    cacheText: bool | None = None,
    implies_existing_asset: bool | None = None,
    asset_kind: str | None = None,
    asset_description: str | None = None,
    duplication_risk: str | None = None,
) -> str:
    if kind not in SOURCE_KINDS:
        return _json({"ok": False, "error": f"invalid kind: {kind}", "allowed": sorted(SOURCE_KINDS)})
    research_dir = Path(runDir) / "research"
    research_dir.mkdir(parents=True, exist_ok=True)
    evidence_path = research_dir / "evidence.json"

    current = _read_json(
        evidence_path,
        {
            "runId": runId,
            "target": "",
            "language": "zh",
            "summary": "",
            "official_sources": [],
            "existing_brand_assets_found": False,
            "existing_brand_assets": [],
            "do_not_duplicate": [],
            "safe_design_directions": [],
            "competitor_or_peer_references": [],
            "open_questions": [],
        },
    )

    source_id = str(uuid.uuid4())
    entry: dict[str, Any] = {
        "id": source_id,
        "title": title,
        "url": url,
        "retrieved_at": _now_iso(),
        "kind": kind,
        "notes": notes,
    }
    cache_info: dict[str, Any] = {}
    if cacheText:
        cache_info = await _cache_text_source(url, research_dir / "sources", source_id, runDir)
        entry.update(cache_info)

    current.setdefault("official_sources", []).append(entry)
    if implies_existing_asset:
        current["existing_brand_assets_found"] = True
        current.setdefault("existing_brand_assets", []).append(
            {
                "kind": asset_kind or "other",
                "evidence_url": url,
                "description": asset_description or notes,
                "duplication_risk": duplication_risk or "medium",
            }
        )

    evidence_path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return _json(
        {
            "ok": True,
            "file": str(evidence_path),
            "source_id": source_id,
            "total_sources": len(current.get("official_sources", [])),
            "existing_brand_assets_found": bool(current.get("existing_brand_assets_found")),
            **({"cache": cache_info} if cacheText else {}),
        }
    )


async def research_asset_discover_tool(
    runId: str,
    pageUrl: str,
    target: str | None = None,
    includeCss: bool | None = None,
    maxCssFiles: int | None = None,
    maxCandidates: int | None = None,
) -> str:
    css_cap = max(0, min(int(maxCssFiles if maxCssFiles is not None else 3), 8))
    candidate_cap = max(1, min(int(maxCandidates if maxCandidates is not None else 30), 100))
    include_css = True if includeCss is None else bool(includeCss)
    try:
        html_text, final_url = await _fetch_text(pageUrl, max_bytes=1_500_000)
    except Exception as exc:
        return _json({"ok": False, "error": f"failed to fetch page: {exc}"})

    raw: list[tuple[str, str]] = []
    raw += [(u, "og_image") for u in _meta_contents(html_text, "property", "og:image")]
    raw += [(u, "twitter_image") for u in _meta_contents(html_text, "name", "twitter:image")]
    raw += [(u, "icon") for u in _link_hrefs(html_text)]
    raw += [(u, "img") for u in _img_sources(html_text)]
    raw += [(u, "css_background") for u in _css_urls(html_text)]
    raw += [(u, "jsonld_image") for u in _jsonld_images(html_text)]

    if include_css and css_cap:
        base_origin = _origin(final_url)
        for href in _stylesheet_hrefs(html_text)[:css_cap]:
            css_url = urljoin(final_url, html.unescape(href))
            if _origin(css_url) != base_origin:
                continue
            try:
                css_text, _ = await _fetch_text(css_url, max_bytes=400_000)
                raw += [(urljoin(css_url, u), "css_background") for u in _css_urls(css_text)]
            except Exception:
                continue

    by_url: dict[str, dict[str, Any]] = {}
    base_origin = _origin(final_url)
    for href, typ in raw:
        resolved = urljoin(final_url, html.unescape(href.strip()))
        parsed = urlparse(resolved)
        if parsed.scheme not in {"http", "https"}:
            continue
        score, kind, reasons = _score_candidate(resolved, typ, _origin(resolved) == base_origin, target)
        previous = by_url.get(resolved)
        if not previous or score > int(previous["score"]):
            by_url[resolved] = {
                "url": resolved,
                "candidate_type": typ,
                "suggested_kind": kind,
                "same_origin": _origin(resolved) == base_origin,
                "score": score,
                "reasons": reasons,
            }

    candidates = sorted(by_url.values(), key=lambda x: int(x["score"]), reverse=True)[:candidate_cap]
    return _json(
        {
            "ok": True,
            "runId": runId,
            "page_url": pageUrl,
            "final_url": final_url,
            "page_origin": base_origin,
            "total_seen": len(raw),
            "total_unique": len(by_url),
            "returned": len(candidates),
            "candidates": candidates,
        }
    )


async def research_asset_fetch_tool(
    runId: str,
    runDir: str,
    id: str,
    url: str,
    kind: str,
    description: str | None = None,
    sourcePageUrl: str | None = None,
    doNotReplace: bool | None = None,
    allowedForEdit: bool | None = None,
    licenseNote: str | None = None,
    timeoutMs: int | None = None,
) -> str:
    if kind not in ASSET_KINDS:
        return _json({"ok": False, "error": f"invalid kind: {kind}", "allowed": sorted(ASSET_KINDS)})
    timeout = max(1.0, min(float(timeoutMs or 30_000) / 1000.0, 120.0))
    assets_dir = Path(runDir) / "research" / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": "Dreamatic-researcher/1.0"})
        if response.status_code >= 400:
            return _json({"ok": False, "status": response.status_code, "error": f"HTTP {response.status_code}"})
        data = response.content
    except httpx.RequestError as exc:
        return _json({"ok": False, "error": f"request failed: {type(exc).__name__}: {exc}"})
    except Exception as exc:
        return _json({"ok": False, "error": f"download failed: {type(exc).__name__}: {exc}"})

    if not data:
        return _json({"ok": False, "error": "0-byte body"})
    if len(data) > MAX_ASSET_BYTES:
        return _json({"ok": False, "error": f"asset too large: {len(data)} bytes"})

    mime = response.headers.get("content-type", "application/octet-stream").split(";", 1)[0].strip().lower()
    ext = _ext_from_url(url) or _ext_from_mime(mime) or _sniff_ext(data)
    if ext == "jpeg":
        ext = "jpg"
    if ext not in IMAGE_EXTS:
        return _json({"ok": False, "error": f"unsupported image type: {ext or mime}"})

    safe_id = _slug(id, "asset")
    sha = hashlib.sha256(data).hexdigest()
    manifest_path = assets_dir / "manifest.json"
    manifest = _read_json(manifest_path, {"runId": runId, "updated_at": _now_iso(), "assets": []})
    duplicate = next((a for a in manifest.get("assets", []) if a.get("sha256") == sha and a.get("id") != safe_id), None)
    if duplicate:
        return _json({"ok": False, "error": "duplicate asset", "duplicate_id": duplicate.get("id")})

    file_name = f"{safe_id}.{ext}"
    file_path = assets_dir / file_name
    file_path.write_bytes(data)
    dims = _image_dimensions(data)
    quality = _quality_flags(kind, dims, len(data), url)
    if quality["hard_issues"]:
        file_path.unlink(missing_ok=True)
        return _json({"ok": False, "error": "hard quality issues", "issues": quality["hard_issues"]})

    asset = {
        "id": safe_id,
        "file": file_name,
        "source_url": url,
        **({"source_page_url": sourcePageUrl} if sourcePageUrl else {}),
        "source_domain": urlparse(url).hostname or "",
        "kind": kind,
        "do_not_replace": bool(doNotReplace) if doNotReplace is not None else kind == "logo",
        "allowed_for_edit": True if allowedForEdit is None else bool(allowedForEdit),
        "license_note": licenseNote or "",
        "description": description or "",
        "retrieved_at": _now_iso(),
        "sha256": sha,
        "bytes": len(data),
        "mime": mime,
        **(dims or {}),
        **({"quality_flags": quality["warnings"]} if quality["warnings"] else {}),
    }
    (assets_dir / f"{file_name}.json").write_text(json.dumps(asset, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest["assets"] = [a for a in manifest.get("assets", []) if a.get("id") != safe_id] + [asset]
    manifest["updated_at"] = _now_iso()
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    return _json(
        {
            "ok": True,
            "runId": runId,
            "asset": asset,
            "assets_dir": str(assets_dir),
            "manifest_path": str(manifest_path),
            "total_assets": len(manifest["assets"]),
            "quality_warnings": quality["warnings"],
        }
    )


async def research_asset_validate_tool(
    runId: str,
    runDir: str,
    minUsableAssets: int | None = None,
    requireLogo: bool | None = None,
) -> str:
    min_usable = max(1, int(minUsableAssets if minUsableAssets is not None else 4))
    require_logo = True if requireLogo is None else bool(requireLogo)
    assets_dir = Path(runDir) / "research" / "assets"
    manifest_path = assets_dir / "manifest.json"
    if not manifest_path.exists():
        return _json({"ok": False, "error": f"manifest not found: {manifest_path}"})
    manifest = _read_json(manifest_path, {"runId": runId, "assets": []})
    issues: list[dict[str, Any]] = []
    seen_sha: dict[str, str] = {}
    usable = 0
    summary = {
        "total_assets": len(manifest.get("assets", [])),
        "usable_assets": 0,
        "flagged_assets": 0,
        "missing_files": 0,
        "sha_mismatches": 0,
        "duplicates": 0,
        "logo_count": 0,
        "protected_count": 0,
        "with_dimensions": 0,
        "by_kind": {k: 0 for k in sorted(ASSET_KINDS)},
    }

    for asset in manifest.get("assets", []):
        aid = asset.get("id", "")
        kind = asset.get("kind") if asset.get("kind") in ASSET_KINDS else "other"
        summary["by_kind"][kind] += 1
        if kind == "logo":
            summary["logo_count"] += 1
        if asset.get("do_not_replace"):
            summary["protected_count"] += 1
        if asset.get("width") and asset.get("height"):
            summary["with_dimensions"] += 1
        if asset.get("quality_flags"):
            summary["flagged_assets"] += 1

        hard = False
        file_path = assets_dir / str(asset.get("file", ""))
        if not file_path.exists() or file_path.stat().st_size == 0:
            summary["missing_files"] += 1
            hard = True
            issues.append({"asset_id": aid, "severity": "error", "code": "missing_file", "detail": str(file_path)})
            continue
        data = file_path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if asset.get("sha256") and asset.get("sha256") != sha:
            summary["sha_mismatches"] += 1
            hard = True
            issues.append({"asset_id": aid, "severity": "error", "code": "sha_mismatch", "detail": sha})
        if sha in seen_sha and seen_sha[sha] != aid:
            summary["duplicates"] += 1
            hard = True
            issues.append({"asset_id": aid, "severity": "error", "code": "duplicate_sha", "detail": seen_sha[sha]})
        seen_sha.setdefault(sha, aid)
        dims = _image_dimensions(data)
        quality = _quality_flags(kind, dims, len(data), str(asset.get("source_url", "")))
        for code in quality["hard_issues"]:
            hard = True
            issues.append({"asset_id": aid, "severity": "error", "code": code, "detail": "hard quality issue"})
        for code in quality["warnings"]:
            issues.append({"asset_id": aid, "severity": "warning", "code": code, "detail": "quality warning"})
        if not hard:
            usable += 1

    summary["usable_assets"] = usable
    ready_reasons: list[str] = []
    if usable < min_usable:
        ready_reasons.append(f"usable_assets={usable} < minUsableAssets={min_usable}")
    if require_logo and summary["logo_count"] == 0 and summary["protected_count"] == 0:
        ready_reasons.append("no logo or protected reference asset present")
    errors = [i for i in issues if i["severity"] == "error"]
    if errors:
        ready_reasons.append(f"{len(errors)} error-severity issue(s) present")
    validation = {
        "runId": runId,
        "validated_at": _now_iso(),
        "manifest_path": str(manifest_path),
        "ready": not ready_reasons,
        "ready_reasons": ready_reasons,
        "summary": summary,
        "issues": issues,
    }
    out = assets_dir / "validation.json"
    out.write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    return _json(
        {
            "ok": True,
            "runId": runId,
            "validation_path": str(out),
            "ready": validation["ready"],
            "ready_reasons": ready_reasons,
            "summary": summary,
            "issue_count": len(issues),
            "errors": len(errors),
            "warnings": len(issues) - len(errors),
        }
    )


async def _cache_text_source(url: str, sources_dir: Path, source_id: str, run_dir: str) -> dict[str, Any]:
    try:
        text, final_url = await _fetch_text(url, max_bytes=MAX_CACHE_BYTES)
    except Exception as exc:
        return {"cache_error": str(exc)}
    sources_dir.mkdir(parents=True, exist_ok=True)
    path = sources_dir / f"{source_id}.txt"
    path.write_text(text, encoding="utf-8")
    return {
        "final_url": final_url,
        "content_bytes": len(text.encode("utf-8")),
        "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "cache_path": str(Path(path).relative_to(run_dir)),
    }


async def _fetch_text(url: str, max_bytes: int) -> tuple[str, str]:
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.get(url, headers={"User-Agent": "Dreamatic-researcher/1.0"})
        response.raise_for_status()
        data = response.content[:max_bytes]
        return data.decode(response.encoding or "utf-8", errors="replace"), str(response.url)


def _meta_contents(text: str, attr: str, name: str) -> list[str]:
    pattern = re.compile(rf"<meta[^>]+{attr}=[\"']{re.escape(name)}[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>", re.I)
    pattern_rev = re.compile(rf"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+{attr}=[\"']{re.escape(name)}[\"'][^>]*>", re.I)
    return pattern.findall(text) + pattern_rev.findall(text)


def _link_hrefs(text: str) -> list[str]:
    out = []
    for tag in re.findall(r"<link[^>]+>", text, flags=re.I):
        if re.search(r"rel=[\"'][^\"']*(?:icon|apple-touch-icon)[^\"']*[\"']", tag, flags=re.I):
            m = re.search(r"href=[\"']([^\"']+)[\"']", tag, flags=re.I)
            if m:
                out.append(m.group(1))
    return out


def _img_sources(text: str) -> list[str]:
    out = []
    for tag in re.findall(r"<img[^>]+>", text, flags=re.I):
        for attr in ("src", "data-src", "data-original", "data-lazy-src"):
            m = re.search(rf"{attr}=[\"']([^\"']+)[\"']", tag, flags=re.I)
            if m:
                out.append(m.group(1))
        m = re.search(r"srcset=[\"']([^\"']+)[\"']", tag, flags=re.I)
        if m:
            for part in m.group(1).split(","):
                if part.strip():
                    out.append(part.strip().split()[0])
    return out


def _stylesheet_hrefs(text: str) -> list[str]:
    out = []
    for tag in re.findall(r"<link[^>]+>", text, flags=re.I):
        if re.search(r"rel=[\"'][^\"']*stylesheet[^\"']*[\"']", tag, flags=re.I):
            m = re.search(r"href=[\"']([^\"']+)[\"']", tag, flags=re.I)
            if m:
                out.append(m.group(1))
    return out


def _css_urls(text: str) -> list[str]:
    return [m for m in re.findall(r"url\((?:[\"']?)([^)\"']+)(?:[\"']?)\)", text, flags=re.I) if not m.startswith("data:")]


def _jsonld_images(text: str) -> list[str]:
    out = []
    for body in re.findall(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", text, flags=re.I | re.S):
        try:
            data = json.loads(html.unescape(body.strip()))
        except Exception:
            continue
        stack = [data]
        while stack:
            value = stack.pop()
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"image", "logo"}:
                        if isinstance(item, str):
                            out.append(item)
                        elif isinstance(item, list):
                            out.extend([x for x in item if isinstance(x, str)])
                    stack.append(item)
            elif isinstance(value, list):
                stack.extend(value)
    return out


def _score_candidate(url: str, typ: str, same_origin: bool, target: str | None) -> tuple[int, str, list[str]]:
    lower = url.lower()
    score = 10
    reasons = [typ]
    if typ in {"og_image", "twitter_image", "jsonld_image"}:
        score += 30
    if same_origin:
        score += 10
        reasons.append("same-origin")
    if any(w in lower for w in ["logo", "brand", "vi", "identity"]):
        score += 28
        kind = "logo"
        reasons.append("logo-like")
    elif any(w in lower for w in ["campus", "building", "photo", "gallery"]):
        score += 16
        kind = "campus"
    elif any(w in lower for w in ["app", "case", "work", "project"]):
        score += 10
        kind = "application"
    else:
        kind = "other"
    if target and target.lower() in lower:
        score += 8
        reasons.append("target-match")
    if any(w in lower for w in ["favicon", "sprite", "blank", "placeholder"]):
        score -= 20
        reasons.append("low-value")
    return score, kind, reasons


def _quality_flags(kind: str, dims: dict[str, Any] | None, byte_count: int, url: str) -> dict[str, list[str]]:
    hard: list[str] = []
    warnings: list[str] = []
    if byte_count < 100:
        hard.append("too_small_bytes")
    if dims:
        width = int(dims.get("width") or 0)
        height = int(dims.get("height") or 0)
        if width and height:
            if width < 64 or height < 64:
                hard.append("too_small_pixels")
            if kind == "logo" and (width < 128 or height < 128):
                warnings.append("low_resolution_logo")
            ratio = width / height
            if ratio > 8 or ratio < 0.125:
                warnings.append("extreme_aspect_ratio")
    else:
        warnings.append("dimensions_unknown")
    if "favicon" in url.lower() and kind == "logo":
        warnings.append("favicon_as_logo")
    return {"hard_issues": hard, "warnings": warnings}


def _image_dimensions(data: bytes) -> dict[str, Any] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return {"width": width, "height": height, "aspect_ratio": round(width / height, 4) if height else None}
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            size = int.from_bytes(data[i + 2 : i + 4], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(data[i + 5 : i + 7], "big")
                width = int.from_bytes(data[i + 7 : i + 9], "big")
                return {"width": width, "height": height, "aspect_ratio": round(width / height, 4) if height else None}
            i += 2 + size
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        # Basic VP8X dimensions.
        idx = data.find(b"VP8X")
        if idx >= 0 and idx + 20 <= len(data):
            width = 1 + int.from_bytes(data[idx + 12 : idx + 15], "little")
            height = 1 + int.from_bytes(data[idx + 15 : idx + 18], "little")
            return {"width": width, "height": height, "aspect_ratio": round(width / height, 4) if height else None}
    return None


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _ext_from_url(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower().lstrip(".")
    return suffix


def _ext_from_mime(mime: str) -> str:
    return {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(mime, "")


def _sniff_ext(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    if data.startswith(b"GIF"):
        return "gif"
    return ""


def _origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def _slug(value: str, default: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", (value or "").strip()).strip("-._")
    return (value or default)[:80]


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)
