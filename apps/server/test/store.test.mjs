import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCanvasState, writeCanvasState } from "../dist/canvas-store.js";
import { assetInventory, deleteRun, renameRun, runAgentSessions, runInventory } from "../dist/run-store.js";
import { workflowInventory } from "../dist/workflow-store.js";

test("canvas state and run assets share one durable Run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-store-"));
  try {
    const runDir = join(workspace, "runs", "sample-run");
    await mkdir(join(runDir, "research", "assets"), { recursive: true });
    await mkdir(join(runDir, "artifacts", "generated-images"), { recursive: true });
    await mkdir(join(runDir, "final", "artifacts", "generated-images"), { recursive: true });
    await mkdir(join(runDir, "sessions", "design-research"), { recursive: true });
    await mkdir(join(runDir, "sessions", "visual-historian"), { recursive: true });
    await mkdir(join(workspace, "sessions", "cli"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", brief: "Sample product" }));
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "active", updatedAt: "2026-01-01T00:00:01.000Z", stages: { research: "completed", design: "in_progress" } }));
    await writeFile(join(runDir, "bus.jsonl"), [
      { type: "agent_started", invocationId: "spawn-research", agent: "design-research", task: "Research the audience and references", status: "running", at: "2026-01-01T00:00:00.500Z" },
      { type: "tool_started", invocationId: "spawn-research", agent: "design-research", toolCallId: "tool-1", toolName: "web_search", input: "product reference", status: "running", at: "2026-01-01T00:00:02.000Z" },
      { type: "tool_finished", invocationId: "spawn-research", agent: "design-research", toolCallId: "tool-1", toolName: "web_search", output: "Three references found", status: "completed", at: "2026-01-01T00:00:03.000Z" },
      { id: "evt-1", type: "research_done", phase: "research", summary: "References ready", artifactRefs: ["runs/sample-run/research/assets/ref.png"], at: "2026-01-01T00:00:01.000Z" },
      { type: "agent_finished", invocationId: "spawn-research", agent: "design-research", output: "Research complete with traceable references.", status: "completed", at: "2026-01-01T00:00:05.000Z" },
      { type: "agent_started", invocationId: "spawn-custom", agent: "visual-historian", task: "Check the visual lineage", status: "running", at: "2026-01-01T00:00:06.000Z" },
      { type: "tool_started", invocationId: "spawn-custom", agent: "visual-historian", toolCallId: "custom-tool", toolName: "view_image", input: "{}", status: "running", at: "2026-01-01T00:00:06.200Z" },
      { type: "tool_finished", invocationId: "spawn-custom", agent: "visual-historian", toolCallId: "custom-tool", toolName: "view_image", output: "inspected", status: "completed", at: "2026-01-01T00:00:06.800Z" },
      { type: "agent_finished", invocationId: "spawn-custom", agent: "visual-historian", output: "Visual lineage checked live.", status: "completed", at: "2026-01-01T00:00:07.000Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
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
    await writeFile(join(runDir, "sessions", "visual-historian", "custom.jsonl"), [
      { type: "session", id: "custom-session", timestamp: "2026-01-01T00:00:06.000Z" },
      { type: "message", timestamp: "2026-01-01T00:00:06.100Z", message: { role: "user", content: [{ type: "text", text: "Check the visual lineage" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "Visual lineage checked." }], stopReason: "stop" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    await writeFile(join(workspace, "sessions", "cli", "primary.jsonl"), [
      { type: "session", id: "primary-session", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", timestamp: "2026-01-01T00:00:00.100Z", message: { role: "user", content: [{ type: "text", text: "Run sample-run" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:00.500Z", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn-research", name: "spawn_agent", arguments: { agent: "design-research", runId: "sample-run", task: "Research the audience and references" } }], stopReason: "toolUse" } },
      { type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolCallId: "spawn-research", toolName: "spawn_agent", content: [{ type: "text", text: "Research complete" }], isError: false } },
      { type: "message", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn-custom", name: "spawn_agent", arguments: { agent: "visual-historian", runId: "sample-run", task: "Check the visual lineage" } }], stopReason: "toolUse" } },
      { type: "message", timestamp: "2026-01-01T00:00:07.100Z", message: { role: "toolResult", toolCallId: "spawn-custom", toolName: "spawn_agent", content: [{ type: "text", text: "Visual lineage checked" }], isError: false } },
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
    assert.equal(runs[0]?.activity.some((item) => item.label === "References ready"), true);
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
    const workflow = await workflowInventory(workspace, "sample-run");
    const agentCards = workflow.filter((event) => event.kind === "agent");
    assert.deepEqual(agentCards.map((event) => event.agent), ["design-research", "visual-historian"]);
    assert.equal(agentCards[0]?.children?.some((event) => event.kind === "references"), true);
    assert.match(agentCards[1]?.output ?? "", /Visual lineage checked live/);
    assert.equal(agentCards[1]?.children?.filter((event) => event.id === "custom-tool").length, 1);
    assert.equal(agentCards[1]?.children?.find((event) => event.id === "custom-tool")?.status, "completed");
    await renameRun(workspace, "sample-run", "Renamed design project");
    assert.equal((await runInventory(workspace))[0]?.title, "Renamed design project");
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "complete", updatedAt: "2026-01-01T00:00:08.000Z", stages: { research: "completed", design: "completed" } }));
    const deleted = await deleteRun(workspace, "sample-run");
    assert.match(deleted.trashedPath, /^\.trash\/runs\/sample-run-/);
    assert.equal(await stat(join(workspace, "runs", "sample-run")).then(() => true).catch(() => false), false);
    assert.equal(await stat(join(workspace, deleted.trashedPath)).then(() => true).catch(() => false), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
