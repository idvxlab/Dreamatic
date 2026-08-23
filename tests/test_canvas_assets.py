from __future__ import annotations

import json
from pathlib import Path

import pytest

from api import rest as rest_api
from api.canvas_assets import build_canvas_asset_index
from harness.factory import _bind_run_to_session_tree
from harness.storage.backends.memory import MemorySessionStore


def _write_asset(root: Path, relative: str, asset_id: str, purpose: str) -> None:
    image = root / relative
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"image")
    Path(str(image) + ".json").write_text(
        json.dumps({"id": asset_id, "purpose": purpose}), encoding="utf-8"
    )


def test_canvas_asset_index_prefers_edited_asset_and_restores_state(tmp_path: Path) -> None:
    runs = tmp_path / ".design-harness" / "runs"
    outputs = tmp_path / "outputs"
    run = runs / "run-1"
    _write_asset(run, "artifacts/generated-images/D1.png", "D1", "Original")
    _write_asset(run, "artifacts/edits/D1.png", "D1", "Edited")
    (run / "canvas").mkdir(parents=True)
    (run / "canvas" / "canvas-state.json").write_text(
        json.dumps(
            {
                "elements": [
                    {
                        "id": "image-1",
                        "type": "image",
                        "assetId": "D1",
                        "assetPath": "artifacts/generated-images/D1.png",
                    },
                    {"id": "text-1", "type": "text", "text": "User note"},
                ]
            }
        ),
        encoding="utf-8",
    )

    result = build_canvas_asset_index(runs, outputs, "run-1")

    assert len(result["assets"]) == 1
    assert result["assets"][0]["assetPath"] == "artifacts/edits/D1.png"
    assert result["assets"][0]["description"] == "Edited"
    assert result["canvasState"]["elements"][0]["src"].startswith(
        "/run-assets/run-1/"
    )
    assert result["canvasState"]["elements"][0]["assetPath"] == "artifacts/edits/D1.png"
    assert result["canvasState"]["elements"][1]["text"] == "User note"


def test_canvas_asset_index_falls_back_to_final_output(tmp_path: Path) -> None:
    runs = tmp_path / "missing-runs"
    outputs = tmp_path / "outputs"
    final = outputs / "runs" / "run-1" / "final"
    _write_asset(final, "artifacts/generated-images/D1.png", "D1", "Final")

    result = build_canvas_asset_index(runs, outputs, "run-1")

    assert result["source"] == "final"
    assert result["assets"][0]["url"].startswith("/outputs/runs/run-1/final/")

    image = final / "artifacts" / "generated-images" / "D1.png"
    image.unlink()
    after_delete = build_canvas_asset_index(runs, outputs, "run-1")
    assert after_delete["assets"] == []
    assert after_delete["revision"] != result["revision"]


def test_canvas_asset_index_respects_soft_deleted_assets(tmp_path: Path) -> None:
    runs = tmp_path / ".design-harness" / "runs"
    outputs = tmp_path / "outputs"
    run = runs / "run-1"
    _write_asset(run, "artifacts/generated-images/D1.png", "D1", "Hidden")
    (run / "canvas").mkdir(parents=True)
    (run / "canvas" / "canvas-state.json").write_text(
        json.dumps({"elements": [], "excludedAssetIds": ["D1"]}), encoding="utf-8"
    )

    result = build_canvas_asset_index(runs, outputs, "run-1")

    assert result["assets"] == []


@pytest.mark.asyncio
async def test_run_binding_propagates_from_child_to_parent() -> None:
    store = MemorySessionStore()
    await store.save("parent", [], metadata={"persona": "design-primary"})
    await store.save(
        "child", [], metadata={"parent_session_id": "parent", "spawn_depth": 1}
    )

    await _bind_run_to_session_tree(store, {}, "child", "run-1")

    child = await store.load("child")
    parent = await store.load("parent")
    assert child is not None and child.metadata["active_run_id"] == "run-1"
    assert parent is not None and parent.metadata["active_run_id"] == "run-1"


@pytest.mark.asyncio
async def test_explicit_canvas_run_binding_persists_session_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = tmp_path / ".design-harness" / "runs"
    outputs = tmp_path / "outputs"
    run = runs / "run-1"
    _write_asset(run, "artifacts/generated-images/D1.png", "D1", "Bound")
    store = MemorySessionStore()
    await store.save("session-1", [], metadata={"persona": "design-primary"})
    monkeypatch.setattr(rest_api, "_session_store", store)
    monkeypatch.setattr(rest_api, "_engine_meta", {})
    monkeypatch.setattr(rest_api, "_engines", {})
    monkeypatch.setattr(rest_api, "RUNS_DIR", runs)
    monkeypatch.setattr(rest_api, "OUTPUTS_DIR", outputs)

    result = await rest_api.bind_canvas_run(
        "session-1", rest_api.CanvasRunBindingRequest(run_id="run-1")
    )

    record = await store.load("session-1")
    assert result["asset_count"] == 1
    assert record is not None and record.metadata["active_run_id"] == "run-1"
