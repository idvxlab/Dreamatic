from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import pytest

from api import rest as rest_api
from api.canvas_publish import (
    CanvasPublishError,
    CanvasPublishValidationError,
    extract_authored_html,
    finalize_publish,
    generate_published_html,
    infer_domain_skill_name,
    normalize_authored_image_paths,
    normalize_layout_plan,
    persist_canvas_state,
    validate_published_html,
    validate_run_id,
)


def _make_run(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = tmp_path / "project"
    outputs = root / "outputs"
    run_dir = root / ".design-harness" / "runs" / "run-1"
    images = run_dir / "artifacts" / "generated-images"
    images.mkdir(parents=True)
    (images / "D1-01.png").write_bytes(b"png-bytes")
    (images / "D1-01.png.json").write_text(
        json.dumps({"id": "D1-01", "purpose": "Hero render"}),
        encoding="utf-8",
    )
    (run_dir / "artifacts" / "artifact-manifest.json").write_text(
        json.dumps({"artifacts": [{"id": "D1-01", "file": "generated-images/D1-01.png", "priority": "critical"}]}),
        encoding="utf-8",
    )
    return root, outputs, run_dir


def _canvas_state() -> dict:
    return {
        "version": 1,
        "bounds": {"x": 10, "y": 20, "width": 600, "height": 400},
        "elements": [
            {
                "id": "image-1",
                "type": "image",
                "src": "/outputs/runs/run-1/final/artifacts/generated-images/D1-01.png",
                "x": 10,
                "y": 20,
                "width": 400,
                "height": 240,
                "role": "asset",
            },
            {
                "id": "text-1",
                "type": "text",
                "text": "用户修改后的设计说明",
                "x": 10,
                "y": 280,
                "width": 300,
                "height": 30,
                "role": "annotation",
            },
        ],
    }


@pytest.mark.parametrize("run_id", ["../escape", "a/b", "a\\b", "", "run id"])
def test_validate_run_id_rejects_unsafe_values(run_id: str) -> None:
    with pytest.raises(CanvasPublishError):
        validate_run_id(run_id)


def test_persist_canvas_state_enriches_local_assets(tmp_path: Path) -> None:
    root, outputs, run_dir = _make_run(tmp_path)

    result = persist_canvas_state(root, outputs, "run-1", _canvas_state(), [])

    image = result["state"]["elements"][0]
    assert image["assetId"] == "D1-01"
    assert image["assetPath"] == "artifacts/generated-images/D1-01.png"
    assert image["sidecarPath"] == "artifacts/generated-images/D1-01.png.json"
    assert image["artifactMetadata"]["priority"] == "critical"
    assert image["sidecarMetadata"]["purpose"] == "Hero render"
    assert result["state"]["publishingView"][0]["assetPath"] == "artifacts/generated-images/D1-01.png"
    assert result["state"]["publishingView"][1]["text"] == "用户修改后的设计说明"
    publish_input = result["publish_input"]
    assert publish_input["assets"][0]["assetId"] == "D1-01"
    assert publish_input["texts"][0]["elementId"] == "text-1"
    assert "x" not in publish_input["assets"][0]
    assert (run_dir / "canvas" / "canvas-state.json").is_file()
    assert (outputs / "runs" / "run-1" / "final" / "canvas" / "canvas-state.json").is_file()


def test_persist_canvas_state_saves_embedded_image_and_rewrites_element(tmp_path: Path) -> None:
    root, outputs, run_dir = _make_run(tmp_path)
    state = _canvas_state()
    state["elements"].append(
        {"id": "paste 1", "type": "image", "src": "blob:test", "x": 0, "y": 0, "width": 10, "height": 10}
    )
    payload = base64.b64encode(b"pasted-image").decode("ascii")

    result = persist_canvas_state(
        root,
        outputs,
        "run-1",
        state,
        [{"element_id": "paste 1", "data_url": f"data:image/png;base64,{payload}", "name": "Paste"}],
    )

    pasted = result["state"]["elements"][-1]
    assert pasted["assetPath"] == "artifacts/user-assets/user-paste-1.png"
    assert pasted["src"] == pasted["assetPath"]
    assert (run_dir / pasted["assetPath"]).read_bytes() == b"pasted-image"
    assert Path(str(run_dir / pasted["assetPath"]) + ".json").is_file()
    assert (outputs / "runs" / "run-1" / "final" / pasted["assetPath"]).is_file()


def test_validate_and_finalize_published_html(tmp_path: Path) -> None:
    root, outputs, run_dir = _make_run(tmp_path)
    persisted = persist_canvas_state(root, outputs, "run-1", _canvas_state(), [])
    html_file = run_dir / "artifacts" / "01-gallery-edited.html"
    html_file.write_text(
        """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设计成果</title>
        <style>body { margin: 0; color: #111; }</style></head><body><main>
        <img src="generated-images/D1-01.png" alt="Hero render">
        <p>用户修改后的设计说明</p></main></body></html>""",
        encoding="utf-8",
    )

    validation = validate_published_html(html_file, run_dir, persisted["state"])
    finalized = finalize_publish(outputs, "run-1", run_dir, persisted["state"], html_file, validation)

    assert validation["image_count"] == 1
    assert validation["text_count"] == 1
    assert Path(finalized["html_file"]).is_file()
    assert (outputs / "runs" / "run-1" / "final" / "canvas" / "canvas-publish-manifest.json").is_file()


def test_layout_plan_and_renderer_preserve_canvas_content(tmp_path: Path) -> None:
    root, outputs, run_dir = _make_run(tmp_path)
    persisted = persist_canvas_state(root, outputs, "run-1", _canvas_state(), [])
    plan = normalize_layout_plan(
        {"title": "Edited", "sections": [{"title": "Views", "assetIds": ["D1-01"], "textIds": ["text-1"]}]},
        persisted["publish_input"],
    )
    html_file = run_dir / "artifacts" / "rendered.html"
    generate_published_html(persisted["publish_input"], plan, html_file)
    html = html_file.read_text(encoding="utf-8")
    assert "generated-images/D1-01.png" in html
    assert "用户修改后的设计说明" in html
    assert 'class="nav"' in html
    assert 'href="#g1"' in html
    assert 'class="group-badge"' in html
    assert "<script" not in html


def test_designer_helpers_infer_domain_and_extract_html() -> None:
    publish_input = {
        "assets": [
            {"sidecarMetadata": {"domain_type": "product-design"}},
            {"sidecarMetadata": {"domain_type": "product-design"}},
            {"sidecarMetadata": {"domain_type": "brand_cultural_design"}},
        ]
    }
    assert infer_domain_skill_name(publish_input) == "product-design"
    assert extract_authored_html("<html><head><title>x</title></head><body></body></html>").startswith(
        "<!doctype html>"
    )
    response_with_continuation = (
        "I will author the page.\n<!doctype html><html><head><title>x</title></head>\n"
        "<body><main>continued</main></body></html>\nDone."
    )
    assert "<main>continued</main>" in extract_authored_html(response_with_continuation)
    with pytest.raises(CanvasPublishError):
        extract_authored_html("not html")


def test_designer_image_paths_are_normalized_from_publish_input() -> None:
    publish_input = {
        "assets": [
            {"assetId": "D5-03", "assetPath": "artifacts/edits/D5-03.png"},
            {"assetId": "D1-01", "assetPath": "artifacts/generated-images/D1-01.png"},
        ]
    }
    html = '<img src="generated-images/D5-03.png"><img src="generated-images/D1-01.png">'
    normalized = normalize_authored_image_paths(html, publish_input)
    assert 'src="edits/D5-03.png"' in normalized
    assert 'src="generated-images/D1-01.png"' in normalized


def test_renderer_does_not_repeat_structured_captions(tmp_path: Path) -> None:
    root, outputs, run_dir = _make_run(tmp_path)
    state = _canvas_state()
    state["elements"][0].update({"title": "展示图", "description": "图片说明"})
    state["elements"][1].update({"text": "图片说明", "role": "caption-description", "relatedAssetIds": ["D1-01"]})
    persisted = persist_canvas_state(root, outputs, "run-1", state, [])
    plan = normalize_layout_plan(
        {"title": "Edited", "sections": [{"title": "Views", "assetIds": ["D1-01"], "textIds": ["text-1"]}]},
        persisted["publish_input"],
    )
    html_file = run_dir / "artifacts" / "rendered.html"
    generate_published_html(persisted["publish_input"], plan, html_file)
    html = html_file.read_text(encoding="utf-8")
    assert html.count("图片说明") == 1


@pytest.mark.parametrize(
    ("html", "issue"),
    [
        ("<html><head><title>x</title></head><body><script>alert(1)</script></body></html>", "script"),
        ("<html><head><title>x</title></head><body><img src='https://example.com/a.png'></body></html>", "remote"),
        ("<html><head><title>x</title></head><body><p>用户修改后的设计说明</p></body></html>", "must appear"),
        ("<html><head><title>x</title></head><body><img src='generated-images/D1-01.png'></body></html>", "Canvas text is missing"),
    ],
)
def test_validator_rejects_unsafe_or_incomplete_output(tmp_path: Path, html: str, issue: str) -> None:
    root, outputs, run_dir = _make_run(tmp_path)
    persisted = persist_canvas_state(root, outputs, "run-1", _canvas_state(), [])
    html_file = run_dir / "artifacts" / "01-gallery-edited.html"
    html_file.write_text(html + (" " * 220), encoding="utf-8")

    with pytest.raises(CanvasPublishValidationError) as exc_info:
        validate_published_html(html_file, run_dir, persisted["state"])

    assert issue.casefold() in str(exc_info.value).casefold()


def test_cancel_canvas_publish_job_stops_running_task() -> None:
    async def exercise() -> None:
        job_id = "cancel-test-job"
        started = asyncio.Event()

        async def worker() -> None:
            started.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(worker())
        await started.wait()
        rest_api._canvas_publish_jobs[job_id] = {
            "job_id": job_id,
            "session_id": "session-1",
            "run_id": "run-1",
            "status": "running",
            "stage": "composing",
            "message": "AI 正在重新编排页面",
            "error": "",
        }
        rest_api._canvas_publish_tasks.add(task)
        rest_api._canvas_publish_tasks_by_job[job_id] = task
        try:
            result = await rest_api.cancel_canvas_publish_job(job_id)
            assert result["status"] == "cancelled"
            assert result["message"] == "导出已取消"
            assert task.cancelled()
        finally:
            rest_api._canvas_publish_jobs.pop(job_id, None)
            rest_api._canvas_publish_tasks.discard(task)
            rest_api._canvas_publish_tasks_by_job.pop(job_id, None)

    asyncio.run(exercise())
