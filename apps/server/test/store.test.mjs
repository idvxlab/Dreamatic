import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { readCanvasState, writeCanvasState } from "../dist/canvas-store.js";
import { assetInventory, attachSessionToRun, createDraftRun, deleteRun, primeDraftRun, renameRun, runAgentSessions, runInventory } from "../dist/run-store.js";
import { workflowInventory } from "../dist/workflow-store.js";

test("Showcase preview permits external source tabs without enabling embedded scripts or top navigation", async () => {
  const source = await readFile(new URL("../../web/src/components/Canvas.tsx", import.meta.url), "utf8");
  const sandbox = /<iframe\b[^>]*sandbox="([^"]+)"/u.exec(source)?.[1].split(/\s+/u) ?? [];
  assert.ok(sandbox.includes("allow-popups"));
  assert.ok(sandbox.includes("allow-popups-to-escape-sandbox"));
  assert.equal(sandbox.includes("allow-scripts"), false);
  assert.equal(sandbox.some((permission) => permission.startsWith("allow-top-navigation")), false);
});

test("draft requests retain user text through clarification and artistic project renaming", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-original-request-"));
  try {
    const run = await createDraftRun(workspace, "session-request");
    const original = "  为地方传统工艺设计展览  ";
    await primeDraftRun(workspace, run.id, "session-request", original);
    await primeDraftRun(workspace, run.id, "session-request", "偏好传统雅致风格");
    await renameRun(workspace, run.id, "织忆新展");
    const brief = JSON.parse(await readFile(join(workspace, "runs", run.id, "brief.json"), "utf8"));
    assert.equal(brief.originalRequest, original);
    assert.equal(brief.originalRequestSource, "server_user_input");
    assert.equal(brief.title, "织忆新展");
    assert.equal(brief.brief, original.trim());
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("persisted and streamed retries settle on success, failure and legacy completion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-retry-status-"));
  try {
    const runDir = join(workspace, "runs", "retry-test");
    await mkdir(runDir, { recursive: true });
    const source = await readFile(new URL("../../web/src/workflow-live.ts", import.meta.url), "utf8");
    const helperUrl = new URL("../../../packages/design-agent/dist/workflow-retries.js", import.meta.url).href;
    const compiled = ts.transpileModule(source.replace('"../../../packages/design-agent/src/workflow-retries"', JSON.stringify(helperUrl)), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const { applyWorkflowStreamEvent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const events = [
      { type: "agent_started", invocationId: "builder-1", agent: "builder", at: "2026-01-01T00:00:00Z" },
      { type: "operation_retry", operation: "image_generate", scope: "exploded", nextAttempt: 2, error: "Timed out", at: "2026-01-01T00:00:01Z" },
      { type: "operation_retry", operation: "image_generate", scope: "hero", nextAttempt: 2, at: "2026-01-01T00:00:02Z" },
      { type: "operation_finished", operation: "image_generate", scope: "exploded", status: "completed", at: "2026-01-01T00:00:03Z" },
      { type: "operation_finished", operation: "image_generate", scope: "hero", status: "error", at: "2026-01-01T00:00:04Z" },
      { type: "operation_retry", operation: "image_generate", scope: "hero", nextAttempt: 2, at: "2026-01-01T00:00:05Z" },
      { type: "agent_retry", invocationId: "builder-1", agent: "builder", nextAttempt: 2, at: "2026-01-01T00:00:06Z" },
      { type: "build_done", from_agent: "builder", summary: "Built", at: "2026-01-01T00:00:07Z" },
      { type: "agent_finished", invocationId: "builder-1", agent: "builder", at: "2026-01-01T00:00:08Z" },
      { type: "export_done", at: "2026-01-01T00:00:09Z" },
    ];
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    let live = [];
    for (const [index, event] of events.entries()) {
      live = applyWorkflowStreamEvent(live, event);
      await writeFile(join(runDir, "bus.jsonl"), events.slice(0, index + 1).map(JSON.stringify).join("\n") + "\n");
      const persisted = await workflowInventory(workspace, "retry-test");
      for (const workflow of [live, persisted]) {
        const nodes = flatten(workflow);
        const exploded = nodes.find((node) => node.id === "retry-image_generate-exploded");
        const hero = nodes.find((node) => node.id === "retry-image_generate-hero");
        if (index === 3) { assert.equal(exploded?.status, "completed"); assert.equal(hero?.status, "running"); }
        if (index === 4) assert.equal(hero?.status, "error");
        if (index === 5) assert.equal(hero?.status, "running");
        if (index >= 7) {
          assert.equal(nodes.filter((node) => node.kind === "retry" && node.status === "running").length, 0);
          assert.equal(hero?.status, "completed");
          assert.match(hero?.label ?? "", /^Retry resolved/);
        }
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workflow retains model progress while a specialist is synthesizing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-model-progress-"));
  try {
    const runDir = join(workspace, "runs", "progress-test");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "bus.jsonl"), [
      { type: "agent_started", invocationId: "research-1", agent: "researcher", task: "Collect evidence", at: "2026-01-01T00:00:00Z" },
      { type: "agent_progress", invocationId: "research-1", agent: "researcher", output: "Generating research report · 30s · 500 streamed characters", at: "2026-01-01T00:00:30Z" },
    ].map(JSON.stringify).join("\n") + "\n");
    const workflow = await workflowInventory(workspace, "progress-test");
    const agent = workflow.find((event) => event.id === "research-1");
    assert.equal(agent?.status, "running");
    assert.match(agent?.output ?? "", /500 streamed characters/);
    assert.equal(agent?.detail, "Collect evidence");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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
    assert.equal(runs[0]?.notes[0]?.path, "research/research.md");
    await writeFile(join(runDir, "research/research-findings.md"), "# Findings\n\nCanonical design evidence");
    const updatedRuns = await runInventory(workspace);
    assert.equal(updatedRuns[0]?.notes[0]?.path, "research/research-findings.md");
    assert.match(updatedRuns[0]?.notes[0]?.text ?? "", /Canonical design evidence/);
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

test("revision snapshots stay out of current project inventories while SVG delivery remains visible", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-revision-inventory-"));
  try {
    await createDraftRun(workspace, "session-revision", "Revision project", "revision-project");
    const runDir = join(workspace, "runs", "revision-project");
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await mkdir(join(runDir, "history", "previous", "artifacts"), { recursive: true });
    await mkdir(join(runDir, "history", "previous", "plan"), { recursive: true });
    await writeFile(join(runDir, "artifacts", "poster.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await writeFile(join(runDir, "history", "previous", "artifacts", "old.png"), "old image");
    await writeFile(join(runDir, "history", "previous", "plan", "design_plan.json"), "{}");
    await writeFile(join(runDir, "bus.jsonl"), JSON.stringify({ id: "revision-1", type: "run_revision_started", summary: "User-requested refinement", from_agent: "orchestrator", at: "2026-10-03T00:00:00Z" }) + "\n");
    for (const assets of [await assetInventory(workspace), await assetInventory(workspace, "revision-project")]) {
      assert.equal(assets.length, 1);
      assert.equal(assets[0].kind, "svg");
    }
    const project = (await runInventory(workspace)).find((run) => run.id === "revision-project");
    assert.equal(project.assetCount, 1);
    assert.equal(project.documents.some((path) => path.startsWith("history/")), false);
    const workflow = await workflowInventory(workspace, "revision-project");
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    const revision = flatten(workflow).find((event) => event.id === "revision-1");
    assert.equal(revision.label, "User-requested refinement");
    assert.equal(revision.at, "2026-10-03T00:00:00Z");
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


test("actual classification appears as a top-level conversation message in live and restored workflows", async () => {
  const { createDreamaticExtension } = await import('@dreamatic/design-agent');
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-classification-message-'));
  try {
    const tools = new Map();
    createDreamaticExtension({ workspaceDir: workspace })({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
    await tools.get('run_init').execute('init', { runIdOverride: 'classified', projectTitle: 'Connected product', brief: 'Design a device, UI and campaign', designScopes: [
      { id: 'hardware', category: 'industrial', task: 'Device shape and ergonomics', rationale: 'Physical hardware was requested' },
      { id: 'control', category: 'ux', task: 'Responsive control page', rationale: 'Interactive UI was requested' },
      { id: 'campaign', category: 'media_communication', task: 'Campaign poster', rationale: 'An advertising poster was requested' },
    ] });
    const runDir = join(workspace, 'runs/classified');
    const event = JSON.parse((await readFile(join(runDir, 'bus.jsonl'), 'utf8')).trim());
    assert.equal(event.type, 'design_categories_identified');
    const persisted = await workflowInventory(workspace, 'classified');
    const message = persisted.find((node) => node.id === event.id);
    assert.equal(message.kind, 'message');
    assert.equal(message.actor, 'Orchestrator');
    assert.match(message.detail, /工业设计.*UX 设计.*媒体传达设计/s);
    assert.match(message.detail, /判断依据：Physical hardware was requested/);
    const source = await readFile(new URL('../../web/src/workflow-live.ts', import.meta.url), 'utf8');
    const helperUrl = new URL('../../../packages/design-agent/dist/workflow-retries.js', import.meta.url).href;
    const compiled = ts.transpileModule(source.replace('"../../../packages/design-agent/src/workflow-retries"', JSON.stringify(helperUrl)), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const { applyWorkflowStreamEvent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
    let live = applyWorkflowStreamEvent([], { type: 'agent_started', invocationId: 'designer', agent: 'designer', at: event.at });
    live = applyWorkflowStreamEvent(live, event);
    live = applyWorkflowStreamEvent(live, event);
    assert.equal(live.filter((node) => node.id === event.id).length, 1);
    assert.equal(live.find((node) => node.id === event.id).detail, message.detail);
    const state = JSON.parse(await readFile(join(runDir, 'run-state.json'), 'utf8'));
    state.status = 'complete';
    await writeFile(join(runDir, 'run-state.json'), JSON.stringify(state));
    await tools.get('run_revision').execute('revision', { runId: 'classified', feedback: 'Only improve the interface', designScopes: [{ id: 'control', category: 'ux', task: 'Improve the control page', rationale: 'User narrowed the requested scope' }] });
    const revised = await workflowInventory(workspace, 'classified');
    assert.equal(revised.filter((node) => node.kind === 'message' && node.actor === 'Orchestrator').length, 2);
    assert.match(revised.find((node) => node.label.startsWith('设计类型已更新')).detail, /UX 设计.*Improve the control page/s);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("historical classification display is read-only and does not invent unknown design types", async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-classification-history-'));
  try {
    const runDir = join(workspace, 'runs/old'); await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'bus.jsonl'), '');
    const brief = { runId: 'old', brief: 'Existing page', createdAt: '2026-01-01T00:00:00Z', resolvedScope: { designScopes: [{ id: 'page', category: 'ux', task: 'Academic page' }] } };
    await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief));
    assert.ok((await workflowInventory(workspace, 'old')).some((node) => node.actor === 'Orchestrator' && node.detail.includes('UX 设计')));
    assert.equal(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), '');
    brief.resolvedScope = {};
    await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief));
    assert.equal((await workflowInventory(workspace, 'old')).some((node) => node.actor === 'Orchestrator'), false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('running image progress is visible inside its tool in server snapshots and live updates, while finished output is retained', async () => {
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-image-progress-view-'));
  try {
    const helperUrl=new URL('../../../packages/design-agent/dist/workflow-retries.js',import.meta.url).href;
    const source=await readFile(new URL('../../web/src/workflow-live.ts',import.meta.url),'utf8');
    const compiled=ts.transpileModule(source.replace('"../../../packages/design-agent/src/workflow-retries"',JSON.stringify(helperUrl)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const live=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
    const runDir=join(workspace,'runs/image-progress');await mkdir(runDir,{recursive:true});
    const base={invocationId:'builder-1',agent:'builder'};
    const records=[
      {...base,type:'agent_started',at:'2026-10-05T13:00:00Z'},
      {...base,type:'tool_started',toolCallId:'batch',toolName:'image_generate_batch',at:'2026-10-05T13:00:01Z'},
      {...base,type:'agent_progress',toolCallId:'batch',output:'Image IMG-02: receiving response · attempt 1 · 30s · 123 KiB',at:'2026-10-05T13:00:30Z'},
    ];
    await writeFile(join(runDir,'bus.jsonl'),records.map(JSON.stringify).join('\n')+'\n');
    const snapshot=await workflowInventory(workspace,'image-progress');
    const fromBus=snapshot.find(e=>e.id==='builder-1').children.find(e=>e.id==='batch');
    assert.equal(fromBus.status,'running');assert.match(fromBus.output,/IMG-02.*123 KiB/);
    let workflow=[];for(const event of records)workflow=live.applyWorkflowStreamEvent(workflow,event);
    const tool=()=>workflow.find(e=>e.id==='builder-1').children.find(e=>e.id==='batch');
    assert.equal(tool().output,fromBus.output);
    workflow=live.applyWorkflowStreamEvent(workflow,{...base,type:'tool_finished',toolCallId:'batch',output:'Batch completed',at:'2026-10-05T13:01:00Z'});
    workflow=live.applyWorkflowStreamEvent(workflow,{...base,type:'agent_progress',toolCallId:'batch',output:'Late progress',at:'2026-10-05T13:01:01Z'});
    assert.equal(tool().output,'Batch completed');assert.equal(tool().status,'completed');
  } finally {await rm(workspace,{recursive:true,force:true});}
});
