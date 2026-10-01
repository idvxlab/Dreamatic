import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCanvasState, writeCanvasState } from "../dist/canvas-store.js";
import { assetInventory, attachSessionToRun, createDraftRun, deleteRun, primeDraftRun, renameRun, runAgentSessions, runInventory } from "../dist/run-store.js";
import { workflowInventory } from "../dist/workflow-store.js";

test("new projects have an isolated draft Run before the agent starts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-draft-"));
  try {
    const first = await createDraftRun(workspace, "session-one");
    const second = await createDraftRun(workspace, "session-two");
    assert.notEqual(first.id, second.id);
    await primeDraftRun(workspace, first.id, "session-one", "设计一款 AI 玩偶");
    const runs = await runInventory(workspace);
    const firstRun = runs.find((run) => run.id === first.id);
    const secondRun = runs.find((run) => run.id === second.id);
    assert.equal(firstRun?.title, "设计一款 AI 玩偶");
    assert.equal(firstRun?.status, "draft");
    assert.equal(firstRun?.sessionId, "session-one");
    assert.equal(secondRun?.title, "Untitled design");
    assert.equal(secondRun?.sessionId, "session-two");
    const firstBriefPath = join(workspace, "runs", first.id, "brief.json");
    const firstBrief = JSON.parse(await readFile(firstBriefPath, "utf8"));
    firstBrief.title = "Mori｜桌面陪伴玩偶";
    firstBrief.titleStatus = "canonical";
    firstBrief.resolvedScope = { human_title: "Mori｜桌面陪伴玩偶" };
    await writeFile(firstBriefPath, JSON.stringify(firstBrief));
    assert.equal((await runInventory(workspace)).find((run) => run.id === first.id)?.title, "Mori｜桌面陪伴玩偶");
    await attachSessionToRun(workspace, second.id, "replacement-session");
    assert.equal((await runInventory(workspace)).find((run) => run.id === second.id)?.sessionId, "replacement-session");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canvas state and run assets share one durable Run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-store-"));
  try {
    const runDir = join(workspace, "runs", "sample-run");
    await mkdir(join(runDir, "research", "assets"), { recursive: true });
    await mkdir(join(runDir, "artifacts", "generated-images"), { recursive: true });
    await mkdir(join(runDir, "final", "artifacts", "generated-images"), { recursive: true });
    await mkdir(join(runDir, "sessions", "researcher"), { recursive: true });
    await mkdir(join(runDir, "sessions", "reviewer"), { recursive: true });
    await mkdir(join(workspace, "sessions", "cli"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", brief: "Sample product" }));
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "active", updatedAt: "2026-01-01T00:00:01.000Z", stages: { research: "completed", design: "in_progress" } }));
    await writeFile(join(runDir, "bus.jsonl"), [
      { type: "agent_started", invocationId: "spawn-research", agent: "researcher", task: "Research the audience and references", status: "running", at: "2026-01-01T00:00:00.500Z" },
      { type: "tool_started", invocationId: "spawn-research", agent: "researcher", toolCallId: "tool-1", toolName: "websearch", input: "product reference", status: "running", at: "2026-01-01T00:00:02.000Z" },
      { type: "tool_finished", invocationId: "spawn-research", agent: "researcher", toolCallId: "tool-1", toolName: "websearch", output: "Three references found", status: "completed", at: "2026-01-01T00:00:03.000Z" },
      { id: "evt-1", type: "research_done", phase: "research", from_agent: "researcher", to: "orchestrator", summary: "References ready", artifactRefs: ["runs/sample-run/research/assets/ref.png"], at: "2026-01-01T00:00:04.000Z" },
      { type: "agent_finished", invocationId: "spawn-research", agent: "researcher", output: "Research complete with traceable references.", status: "completed", at: "2026-01-01T00:00:05.000Z" },
      { type: "agent_started", invocationId: "spawn-design", agent: "designer", task: "Create the executable Design Context", status: "running", at: "2026-01-01T00:00:05.200Z" },
      { id: "evt-design", type: "design_spec_ready", phase: "design", from_agent: "designer", to: "orchestrator", summary: "Design Context ready for challenge", artifactRefs: ["runs/sample-run/plan/design_plan.json"], at: "2026-01-01T00:00:05.800Z" },
      { type: "agent_finished", invocationId: "spawn-design", agent: "designer", output: "Design Context committed.", status: "completed", at: "2026-01-01T00:00:06.000Z" },
      { type: "agent_started", invocationId: "spawn-review", agent: "reviewer", task: "Challenge the design context", status: "running", at: "2026-01-01T00:00:06.100Z" },
      { type: "tool_started", invocationId: "spawn-review", agent: "reviewer", toolCallId: "review-tool", toolName: "read", input: "{}", status: "running", at: "2026-01-01T00:00:06.200Z" },
      { type: "tool_finished", invocationId: "spawn-review", agent: "reviewer", toolCallId: "review-tool", toolName: "read", output: "inspected", status: "completed", at: "2026-01-01T00:00:06.800Z" },
      { id: "evt-review", type: "design_review_pass", phase: "review", from_agent: "reviewer", to: "orchestrator", summary: "Design Context approved", artifactRefs: ["runs/sample-run/review/design-review.json"], at: "2026-01-01T00:00:07.000Z" },
      { type: "agent_finished", invocationId: "spawn-review", agent: "reviewer", output: "Design context challenged.", status: "completed", at: "2026-01-01T00:00:07.100Z" },
      { type: "agent_started", invocationId: "spawn-build", agent: "builder", task: "Implement the approved design context", status: "running", at: "2026-01-01T00:00:08.000Z" },
      { id: "evt-build", type: "build_done", phase: "build", from_agent: "builder", to: "orchestrator", summary: "Implementation committed to durable artifacts", artifactRefs: ["runs/sample-run/artifacts/00-gallery.html"], at: "2026-01-01T00:00:09.000Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    await writeFile(join(runDir, "research", "assets", "ref.png"), Buffer.from("reference"));
    await writeFile(join(runDir, "research", "research.md"), "# Findings\n\n- Visible design evidence");
    await writeFile(join(runDir, "artifacts", "generated-images", "hero.png"), Buffer.from("hero"));
    await writeFile(join(runDir, "artifacts", "00-gallery.html"), "<!doctype html><title>Gallery</title>");
    await writeFile(join(runDir, "final", "artifacts", "generated-images", "hero.png"), Buffer.from("hero"));
    await writeFile(join(runDir, "final", "artifacts", "00-gallery.html"), "<!doctype html><title>Gallery copy</title>");
    await writeFile(join(runDir, "final", "00-index.html"), "<!doctype html><title>Final</title>");
    await writeFile(join(runDir, "sessions", "researcher", "research.jsonl"), [
      { type: "session", id: "research-session", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Research the audience and references" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "websearch", arguments: { query: "product reference" } }], stopReason: "toolUse" } },
      { type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tool-1", toolName: "websearch", content: [{ type: "text", text: "Three references found" }], isError: false } },
      { type: "message", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Research complete with traceable references." }], stopReason: "stop" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    await writeFile(join(runDir, "sessions", "reviewer", "review.jsonl"), [
      { type: "session", id: "review-session", timestamp: "2026-01-01T00:00:06.000Z" },
      { type: "message", timestamp: "2026-01-01T00:00:06.100Z", message: { role: "user", content: [{ type: "text", text: "Challenge the design context" }] } },
      { type: "message", timestamp: "2026-01-01T00:00:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "Design context challenged." }], stopReason: "stop" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    await writeFile(join(workspace, "sessions", "cli", "primary.jsonl"), [
      { type: "session", id: "primary-session", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", timestamp: "2026-01-01T00:00:00.100Z", message: { role: "user", content: [{ type: "text", text: "Run sample-run\n\n[DREAMATIC PROJECT OWNERSHIP]\nThis conversation belongs only to project sample-run. Never reuse another Run." }] } },
      { type: "message", timestamp: "2026-01-01T00:00:00.500Z", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn-research", name: "spawn_agent", arguments: { agent: "researcher", runId: "sample-run", task: "Research the audience and references" } }], stopReason: "toolUse" } },
      { type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolCallId: "spawn-research", toolName: "spawn_agent", content: [{ type: "text", text: "Research complete" }], isError: false } },
      { type: "message", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn-review", name: "spawn_agent", arguments: { agent: "reviewer", runId: "sample-run", task: "Challenge the design context" } }], stopReason: "toolUse" } },
      { type: "message", timestamp: "2026-01-01T00:00:07.100Z", message: { role: "toolResult", toolCallId: "spawn-review", toolName: "spawn_agent", content: [{ type: "text", text: "Design context challenged" }], isError: false } },
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
    assert.equal(runs[0]?.agentSessions[0]?.title, "Researcher");
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
    assert.equal(workflow.find((event) => event.kind === "message" && event.actor === "User / CLI")?.detail, "Run sample-run");
    const agentCards = workflow.filter((event) => event.kind === "agent");
    assert.deepEqual(agentCards.map((event) => event.agent), ["researcher", "designer", "reviewer", "builder"]);
    assert.equal(agentCards[0]?.children?.some((event) => event.kind === "references"), true);
    assert.match(agentCards[2]?.output ?? "", /Design context challenged/);
    assert.equal(agentCards[2]?.children?.filter((event) => event.id === "review-tool").length, 1);
    assert.equal(agentCards[2]?.children?.find((event) => event.id === "review-tool")?.status, "completed");
    assert.equal(agentCards[3]?.status, "completed");
    assert.equal(agentCards[3]?.endedAt, "2026-01-01T00:00:09.000Z");
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

test("a Reviewer fail verdict is a revision milestone rather than a transport error", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-review-loop-"));
  try {
    const runDir = join(workspace, "runs", "review-loop");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", brief: "Review this design" }));
    await writeFile(join(runDir, "bus.jsonl"), `${JSON.stringify({
      id: "review-fail",
      type: "design_review_fail",
      from_agent: "reviewer",
      to: "orchestrator",
      summary: "Two blocking issues require Designer revision",
      requestedAction: "Resolve R-001 and R-002",
      at: "2026-01-01T00:00:01.000Z",
    })}\n`);
    const workflow = await workflowInventory(workspace, "review-loop");
    const verdict = workflow.find((event) => event.id === "review-fail");
    assert.equal(verdict?.kind, "milestone");
    assert.equal(verdict?.status, "completed");
    assert.match(verdict?.detail ?? "", /R-001/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
