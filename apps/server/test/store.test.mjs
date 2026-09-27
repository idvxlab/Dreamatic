import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCanvasState, writeCanvasState } from "../dist/canvas-store.js";
import { assetInventory, runAgentSessions, runInventory } from "../dist/run-store.js";

test("canvas state and run assets share one durable Run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-store-"));
  try {
    const runDir = join(workspace, "runs", "sample-run");
    await mkdir(join(runDir, "research", "assets"), { recursive: true });
    await mkdir(join(runDir, "artifacts", "generated-images"), { recursive: true });
    await mkdir(join(runDir, "final", "artifacts", "generated-images"), { recursive: true });
    await mkdir(join(runDir, "sessions", "design-research"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", brief: "Sample product" }));
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "active", updatedAt: "2026-01-01T00:00:01.000Z", stages: { research: "completed", design: "in_progress" } }));
    await writeFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ id: "evt-1", type: "research_done", phase: "research", summary: "References ready", artifactRefs: ["runs/sample-run/research/assets/ref.png"], at: "2026-01-01T00:00:01.000Z" })}\n`);
    await writeFile(join(runDir, "research", "assets", "ref.png"), Buffer.from("reference"));
    await writeFile(join(runDir, "research", "research.md"), "# Findings\n\n- Visible design evidence");
    await writeFile(join(runDir, "artifacts", "generated-images", "hero.png"), Buffer.from("hero"));
    await writeFile(join(runDir, "artifacts", "00-gallery.html"), "<!doctype html><title>Gallery</title>");
    await writeFile(join(runDir, "final", "artifacts", "generated-images", "hero.png"), Buffer.from("hero"));
    await writeFile(join(runDir, "final", "artifacts", "00-gallery.html"), "<!doctype html><title>Gallery copy</title>");
    await writeFile(join(runDir, "final", "00-index.html"), "<!doctype html><title>Final</title>");
    await writeFile(join(runDir, "sessions", "design-research", "research.jsonl"), [
      { type: "session", id: "research-session", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Research the audience and references" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "web_search", arguments: { query: "product reference" } }], stopReason: "toolUse" } },
      { type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tool-1", toolName: "web_search", content: [{ type: "text", text: "Three references found" }], isError: false } },
      { type: "message", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Research complete with traceable references." }], stopReason: "stop" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));

    const state = await writeCanvasState(workspace, "sample-run", { camera: { x: 12, y: 24, zoom: .9 }, elements: [{ id: "hero", kind: "image", x: 10, y: 20, width: 300, height: 220, assetPath: "runs/sample-run/artifacts/generated-images/hero.png" }] });
    assert.equal(state.camera.zoom, .9);
    assert.deepEqual(await readCanvasState(workspace, "sample-run"), state);
    assert.ok(JSON.parse(await readFile(join(runDir, "canvas", "canvas-state.json"), "utf8")));

    const assets = await assetInventory(workspace, "sample-run");
    assert.equal(assets.find((asset) => asset.label === "ref.png")?.role, "reference");
    assert.equal(assets.find((asset) => asset.label === "hero.png")?.role, "generated");
    assert.equal(assets.filter((asset) => asset.label === "hero.png").length, 1);
    assert.equal(assets.filter((asset) => asset.path.endsWith("final/00-index.html")).length, 1);
    const runs = await runInventory(workspace);
    assert.equal(runs[0]?.showcasePath, "runs/sample-run/final/00-index.html");
    assert.equal(runs[0]?.activity[0]?.label, "References ready");
    assert.deepEqual(runs[0]?.notes.map((note) => note.id), ["research"]);
    assert.match(runs[0]?.notes[0]?.text ?? "", /Visible design evidence/);
    assert.equal(runs[0]?.agentSessions[0]?.title, "Research agent");
    assert.equal(runs[0]?.agentSessions[0]?.status, "completed");
    assert.equal(runs[0]?.agentSessions[0]?.actionCount, 1);
    assert.equal(runs[0]?.agentSessions[0]?.actions.length, 0);
    assert.equal(runs[0]?.agentSessions[0]?.task, undefined);
    assert.equal(runs[0]?.agentSessions[0]?.actions[0]?.output, undefined);
    const childSessions = await runAgentSessions(workspace, "sample-run");
    assert.equal(childSessions[0]?.actionCount, 1);
    assert.match(childSessions[0]?.task ?? "", /Research the audience/);
    assert.match(childSessions[0]?.actions[0]?.output ?? "", /Three references/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
