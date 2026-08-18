from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.agents import load_agent_profile
from harness.config import HarnessConfig
from harness.factory import build_engine
from harness.storage.backends.memory import (
    InMemoryMemoryStore,
    InMemoryPlanStore,
    MemorySessionStore,
)
from harness.tools.builtin.design_image import (
    IMAGE_EDIT_SCHEMA,
    IMAGE_GENERATE_SCHEMA,
    image_edit_tool,
    image_generate_tool,
)
from harness.tools.builtin.design_run import (
    design_bus_post_tool,
    design_bus_read_tool,
    run_init_tool,
)
from harness.tools.builtin.design_research import (
    research_asset_discover_tool,
    research_asset_fetch_tool,
    research_asset_validate_tool,
    research_fetch_tool,
)
from harness.tools.builtin.design_artifacts import artifact_lint_tool, export_package_tool


def test_design_designer_engine_has_image_and_lint_tools():
    cfg = HarnessConfig.from_yaml("config.yaml")
    profile = load_agent_profile("design-designer")
    provider = cfg.providers[cfg.default_provider]

    engine = build_engine(
        session_id="test-design-designer-tools",
        provider_cfg=provider,
        harness_cfg=cfg,
        session_store=MemorySessionStore(),
        system_prompt=profile.system_prompt,
        allowed_tools=profile.allowed_tools,
        provider_name="design-designer",
        agent_id="design-designer",
        memory_store=InMemoryMemoryStore(),
        plan_store=InMemoryPlanStore(),
    )

    tool_names = {schema.name for schema in engine.tool_schemas}
    assert {
        "image_generate", "image_edit", "inspect_image", "artifact_lint",
        "read_tool_output",
    }.issubset(tool_names)
    assert "image_generate" in engine._config.system_prompt
    assert "image_edit" in engine._config.system_prompt
    assert "inspect_image" in engine._config.system_prompt
    assert "artifact_lint" in engine._config.system_prompt


def test_image_tool_schemas_hide_batch_and_accept_domain_metadata():
    generate_params = {param.name for param in IMAGE_GENERATE_SCHEMA.params}
    edit_params = {param.name for param in IMAGE_EDIT_SCHEMA.params}

    assert "batchDir" not in generate_params
    assert "batchDir" not in edit_params
    assert {"domainType", "deliverableCategory"}.issubset(generate_params)
    assert {"domainType", "deliverableCategory"}.issubset(edit_params)


@pytest.mark.asyncio
async def test_image_generate_mock_writes_file(monkeypatch, tmp_path):
    monkeypatch.setenv("DESIGN_IMAGE_BACKEND", "mock")

    raw = await image_generate_tool(
        prompt="blue icon",
        runId="r1",
        runDir=str(tmp_path),
        id="hero",
        domainType="product_design",
        deliverableCategory="hero render",
    )

    payload = json.loads(raw)
    assert payload["ok"] is True
    out = Path(payload["items"][0]["file"])
    assert out.exists()
    sidecar = json.loads(out.with_suffix(out.suffix + ".json").read_text(encoding="utf-8"))
    assert sidecar["domain_type"] == "product_design"
    assert sidecar["deliverable_category"] == "hero render"


@pytest.mark.asyncio
async def test_image_edit_mock_writes_file(monkeypatch, tmp_path):
    monkeypatch.setenv("DESIGN_IMAGE_BACKEND", "mock")
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"\x89PNG\r\n\x1a\n")

    raw = await image_edit_tool(
        prompt="edit icon",
        referenceImagePaths=[str(ref)],
        runId="r1",
        runDir=str(tmp_path),
        id="edited",
        domainType="architecture_space_design",
        deliverableCategory="interior perspective",
    )

    payload = json.loads(raw)
    assert payload["ok"] is True
    out = Path(payload["items"][0]["file"])
    assert out.exists()
    sidecar = json.loads(out.with_suffix(out.suffix + ".json").read_text(encoding="utf-8"))
    assert sidecar["domain_type"] == "architecture_space_design"
    assert sidecar["deliverable_category"] == "interior perspective"


@pytest.mark.asyncio
async def test_run_init_and_design_bus_round_trip(monkeypatch, tmp_path):
    monkeypatch.setenv("DESIGN_HARNESS_ROOT", str(tmp_path / "harness"))
    monkeypatch.setenv("DESIGN_OUTPUTS_ROOT", str(tmp_path / "outputs"))

    init = json.loads(
        await run_init_tool(
            brief="Design a small exhibition identity.",
            resolvedScope='{"language":"zh+en","domain_type":"architecture_space_design"}',
            domainContext='{"domain_type":"architecture_space_design","label":"Architecture & Space Design"}',
            runIdOverride="run-a",
        )
    )
    assert init["ok"] is True
    assert init["mode"] == "default"
    assert Path(init["paths"]["bus"]).exists()
    assert Path(init["paths"]["modelsDir"]).is_dir()
    assert Path(init["paths"]["modelRendersDir"]).is_dir()
    brief_json = json.loads(Path(init["runDir"], "brief.json").read_text(encoding="utf-8"))
    assert brief_json["resolvedScope"]["domain_type"] == "architecture_space_design"
    assert brief_json["domainContext"]["label"] == "Architecture & Space Design"

    post = json.loads(
        await design_bus_post_tool(
            runId=init["runId"],
            runDir=init["runDir"],
            from_agent="design-primary",
            to="design-planner",
            type="kickoff",
            summary="Start planning.",
        )
    )
    assert post["ok"] is True

    read = json.loads(
        await design_bus_read_tool(
            runId=init["runId"],
            runDir=init["runDir"],
            agent="design-planner",
        )
    )
    assert read["count"] == 1
    assert read["messages"][0]["summary"] == "Start planning."


@pytest.mark.asyncio
async def test_run_init_uses_numbered_id_when_override_exists(monkeypatch, tmp_path):
    monkeypatch.setenv("DESIGN_HARNESS_ROOT", str(tmp_path / "harness"))
    monkeypatch.setenv("DESIGN_OUTPUTS_ROOT", str(tmp_path / "outputs"))

    first = json.loads(
        await run_init_tool(
            brief="Design a product concept.",
            resolvedScope='{"domain_type":"product_design"}',
            runIdOverride="same-run",
        )
    )
    second = json.loads(
        await run_init_tool(
            brief="Design a product concept again.",
            resolvedScope='{"domain_type":"product_design"}',
            runIdOverride="same-run",
        )
    )

    assert first["ok"] is True
    assert second["ok"] is True
    assert first["runId"] == "same-run"
    assert second["runId"] == "same-run-2"
    assert Path(first["runDir"]).exists()
    assert Path(second["runDir"]).exists()


@pytest.mark.asyncio
async def test_run_init_minimal_creates_only_run_directory(monkeypatch, tmp_path):
    harness_root = tmp_path / "harness"
    outputs_root = tmp_path / "outputs"
    monkeypatch.setenv("DESIGN_HARNESS_ROOT", str(harness_root))
    monkeypatch.setenv("DESIGN_OUTPUTS_ROOT", str(outputs_root))

    result = json.loads(
        await run_init_tool(
            brief="Create a custom infographic.",
            mode="minimal",
            workflowSkill="custom-infographic-workflow",
            runIdOverride="minimal-run",
        )
    )

    run_dir = Path(result["runDir"])
    assert result["ok"] is True
    assert result["mode"] == "minimal"
    assert result["paths"] == {"runDir": str(run_dir)}
    assert run_dir.is_dir()
    assert list(run_dir.iterdir()) == []
    assert not outputs_root.exists()


@pytest.mark.asyncio
async def test_run_init_rejects_unknown_mode(monkeypatch, tmp_path):
    harness_root = tmp_path / "harness"
    monkeypatch.setenv("DESIGN_HARNESS_ROOT", str(harness_root))

    result = json.loads(
        await run_init_tool(
            brief="Create a custom infographic.",
            mode="custom",
            runIdOverride="invalid-run",
        )
    )

    assert result["ok"] is False
    assert result["allowed"] == ["default", "minimal"]
    assert not harness_root.exists()


@pytest.mark.asyncio
async def test_research_fetch_records_evidence(tmp_path):
    run_dir = tmp_path / "run"

    raw = await research_fetch_tool(
        runId="r1",
        runDir=str(run_dir),
        title="Official homepage",
        url="https://example.com",
        kind="homepage",
        notes="Primary identity source.",
        implies_existing_asset=True,
        asset_kind="logo",
    )

    payload = json.loads(raw)
    assert payload["ok"] is True
    evidence = json.loads((run_dir / "research/evidence.json").read_text(encoding="utf-8"))
    assert len(evidence["official_sources"]) == 1
    assert evidence["existing_brand_assets_found"] is True


@pytest.mark.asyncio
async def test_research_asset_discover_finds_page_images(monkeypatch, tmp_path):
    html = tmp_path / "index.html"
    html.write_text(
        """
        <html><head>
          <meta property="og:image" content="/hero.png">
          <link rel="icon" href="/favicon.png">
        </head><body>
          <img src="/logo.png">
          <div style="background-image:url('/campus.jpg')"></div>
        </body></html>
        """,
        encoding="utf-8",
    )

    async def fake_fetch(url: str, max_bytes: int):
        return html.read_text(encoding="utf-8"), "https://dreamatic.test/index.html"

    monkeypatch.setattr("harness.tools.builtin.design_research._fetch_text", fake_fetch)

    payload = json.loads(
        await research_asset_discover_tool(
            runId="r1",
            pageUrl="https://dreamatic.test/index.html",
            includeCss=False,
        )
    )

    assert payload["ok"] is True
    urls = {c["url"] for c in payload["candidates"]}
    assert "https://dreamatic.test/logo.png" in urls
    assert "https://dreamatic.test/hero.png" in urls


@pytest.mark.asyncio
async def test_research_asset_fetch_and_validate(monkeypatch, tmp_path):
    import httpx

    run_dir = tmp_path / "run"
    png = _png_bytes(width=128, height=128)

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers=None):
            return httpx.Response(
                200,
                content=png,
                headers={"content-type": "image/png"},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr("harness.tools.builtin.design_research.httpx.AsyncClient", FakeClient)

    fetched = json.loads(
        await research_asset_fetch_tool(
            runId="r1",
            runDir=str(run_dir),
            id="cmf-reference",
            url="https://dreamatic.test/logo.png",
            kind="cmf",
        )
    )
    assert fetched["ok"] is True

    validation = json.loads(
        await research_asset_validate_tool(
            runId="r1",
            runDir=str(run_dir),
            minUsableAssets=1,
            requireLogo=False,
        )
    )
    assert validation["ok"] is True
    assert validation["ready"] is True
    assert validation["summary"]["by_kind"]["cmf"] == 1


@pytest.mark.asyncio
async def test_artifact_lint_and_export_package(tmp_path):
    run_dir = tmp_path / "run"
    artifacts = run_dir / "artifacts"
    research_assets = run_dir / "research" / "assets"
    artifacts.mkdir(parents=True)
    research_assets.mkdir(parents=True)
    (run_dir / "brief.json").write_text(
        json.dumps(
            {
                "brief": "Design a poster.",
                "resolvedScope": {"domain_type": "poster_advertising_design"},
            }
        ),
        encoding="utf-8",
    )
    (run_dir / "bus.jsonl").write_text("", encoding="utf-8")
    (artifacts / "poster.png").write_bytes(_png_bytes(width=128, height=128))
    (artifacts / "poster.png.json").write_text(
        json.dumps({"deliverable_category": "main poster"}),
        encoding="utf-8",
    )
    (research_assets / "reference.png").write_bytes(_png_bytes(width=64, height=64))
    (artifacts / "00-gallery.html").write_text(
        "<!doctype html><html><head><title>Gallery</title></head><body><img src='poster.png'></body></html>",
        encoding="utf-8",
    )

    lint = json.loads(
        await artifact_lint_tool(
            runId="r1",
            runDir=str(run_dir),
            minPngs=1,
            requireGallery=True,
        )
    )
    assert lint["ok"] is True
    assert lint["domain_type"] == "poster_advertising_design"
    assert lint["summary"]["deliverable_categories"] == {"main poster": 1}

    (artifacts / "00-gallery.html").write_text(
        (
            "<!doctype html><html><head><title>Gallery</title></head><body>"
            "<img src='poster.png'>"
            "<img src='../research/assets/reference.png'>"
            "</body></html>"
        ),
        encoding="utf-8",
    )
    lint_with_reference = json.loads(
        await artifact_lint_tool(
            runId="r1",
            runDir=str(run_dir),
            minPngs=1,
            requireGallery=True,
        )
    )
    assert lint_with_reference["ok"] is True

    (artifacts / "00-gallery.html").write_text(
        (
            "<!doctype html><html><head><title>Gallery</title></head><body>"
            "<img src='poster.png'>"
            "<img src='../research/assets/missing-reference.png'>"
            "</body></html>"
        ),
        encoding="utf-8",
    )
    lint_with_missing_reference = json.loads(
        await artifact_lint_tool(
            runId="r1",
            runDir=str(run_dir),
            minPngs=1,
            requireGallery=True,
        )
    )
    assert lint_with_missing_reference["ok"] is False
    assert any(
        issue["rule"] == "html.image_exists"
        for issue in lint_with_missing_reference["errors"]
    )

    (artifacts / "00-gallery.html").write_text(
        "<!doctype html><html><head><title>Gallery</title></head><body><img src='poster.png'></body></html>",
        encoding="utf-8",
    )

    exported = json.loads(
        await export_package_tool(
            runId="r1",
            runDir=str(run_dir),
            finalDir=str(tmp_path / "final"),
        )
    )
    assert exported["ok"] is True
    assert exported["domain_type"] == "poster_advertising_design"
    assert (tmp_path / "final/package-manifest.json").exists()
    package_manifest = json.loads((tmp_path / "final/package-manifest.json").read_text(encoding="utf-8"))
    assert package_manifest["domain_type"] == "poster_advertising_design"
    index = tmp_path / "final/00-index.html"
    assert index.exists()
    html = index.read_text(encoding="utf-8")
    assert "Final Deliverables" in html
    assert "Reference Library" in html
    assert "artifacts/poster.png" in html
    assert "research/assets/reference.png" in html
    assert html.index("Final Deliverables") < html.index("artifacts/poster.png")
    assert html.index("Reference Library") < html.index("research/assets/reference.png")


def _png_bytes(width: int = 1, height: int = 1) -> bytes:
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
