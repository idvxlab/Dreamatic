import assert from "node:assert/strict";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDreamaticExtension, dreamaticPersonaTools, dreamaticPersonaPromptBlock, validateDreamaticPersonaContracts, DREAMATIC_PERSONA_TOOL_POLICY, specialistCompletionEvent, specialistRunAssignment, workflowReferencePaths, modelResponseTimeoutReason, normalizeWriteJsonArguments, normalizeDesignBusArguments } from "../dist/extension.js";
import { prepareDreamaticPrompt } from "../dist/prompt.js";
import { dreamaticSessionFailure } from "../dist/runtime.js";
import { RetryableHttpError, withRetry } from "../dist/retry.js";
import { createIdleSleepGuard } from "../dist/idle-sleep.js";

test("idle-sleep protection is macOS-only, scoped, idempotent and optional", () => {
  let starts = 0;
  let stops = 0;
  const launch = () => { starts += 1; return () => { stops += 1; }; };
  const guard = createIdleSleepGuard({ platform: "darwin", enabled: true, launch });
  guard.start();
  guard.start();
  assert.equal(starts, 1);
  guard.stop();
  guard.stop();
  assert.equal(stops, 1);
  guard.start();
  guard.stop();
  assert.equal(starts, 2);
  assert.equal(stops, 2);
  createIdleSleepGuard({ platform: "linux", enabled: true, launch }).start();
  createIdleSleepGuard({ platform: "darwin", enabled: false, launch }).start();
  assert.equal(starts, 2);
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("write_json repairs only unambiguous envelopes and rejects conflicting Run identity", () => {
  const evidence = { runId: "demo", target: "Subject", official_sources: [] };
  assert.deepEqual(normalizeWriteJsonArguments({ data: evidence }, "demo"), { runId: "demo", path: "research/evidence.json", data: evidence });
  const plan = { runId: "demo", path: "plan/design_plan.json", design_intent: "Concept", design_system_ref: "plan/design_system.json" };
  assert.equal(normalizeWriteJsonArguments({ data: plan }, "demo").path, "plan/design_plan.json");
  assert.throws(() => normalizeWriteJsonArguments({ data: { runId: "demo", arbitrary: true } }), /unambiguous/);
  assert.throws(() => normalizeWriteJsonArguments({ runId: "other", path: "research/evidence.json", data: evidence }), /must agree/);
  assert.throws(() => normalizeWriteJsonArguments({ data: { ...evidence, deliverables: [], design_system_ref: "plan/design_system.json" } }), /unambiguous/);
});

test("write_json accepts absolute paths only within its explicit Run", () => {
  const workspace = join(tmpdir(), "dreamatic-path-contract");
  const args = { runId: "demo", path: join(workspace, "runs/demo/plan/design_system.json"), data: { system_thesis: "Concept" } };
  assert.equal(normalizeWriteJsonArguments(args, "demo", workspace).path, "plan/design_system.json");
  assert.throws(() => normalizeWriteJsonArguments({ ...args, path: join(workspace, "runs/other/plan/design_system.json") }, "demo", workspace), /escapes/);
  assert.throws(() => normalizeWriteJsonArguments({ ...args, path: join(workspace, "runs/demo/../other/plan/design_system.json") }, "demo", workspace), /escapes/);
});

test("completion envelopes restore assigned identity but never invent a verdict or summary", () => {
  const result = normalizeDesignBusArguments({ type: "design_spec_ready", summary: "Ready", artifactRefs: ["plan/design_plan.json"] }, "demo", "designer");
  assert.equal(result.runId, "demo");
  assert.equal(result.from_agent, "designer");
  assert.equal(result.to, "orchestrator");
  assert.throws(() => normalizeDesignBusArguments({ artifactRefs: [], payload: "{}" }, "demo", "designer"), /missing root fields: type, summary/);
  assert.throws(() => normalizeDesignBusArguments({ type: "design_review_pass" }, "demo", "reviewer"), /summary/);
  assert.equal(normalizeDesignBusArguments({ runId: "other", type: "custom" }, "demo").runId, "other");
});

test("clarification gracefully terminates and blocks repeated calls until the next turn", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-graceful-stop-"));
  try {
    const { tools, handlers } = await registeredTools(workspaceDir);
    const args = { questions: [{ header: "Users", question: "Who uses it?" }] };
    const result = await tools.get("ask_user").execute("clarify", args);
    assert.equal(result.terminate, true);
    assert.equal(JSON.parse(result.content[0].text).status, "waiting_for_user");
    const blocked = await handlers.get("tool_call")({ toolName: "ask_user", input: args });
    assert.equal(blocked.block, true);
    assert.equal(blocked.terminate, true);
    await handlers.get("agent_start")({ type: "agent_start" });
    assert.equal(await handlers.get("tool_call")({ toolName: "ask_user", input: args }), undefined);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Designer JSON save repairs misplaced plan sections and warns about missing output paths", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-json-contract-recovery-"));
  try {
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "demo" } });
    const writer = tools.get("write_json");
    const args = writer.prepareArguments({ data: { runId: "demo", design_intent: "Concept", design_system_ref: "plan/design_system.json", concept_evaluation: { selection: "concept", image_generation_plan: [{ id: "hero", size: "512x512" }], decisions: [{ id: "decision" }] } } });
    await writer.execute("plan", args);
    const plan = JSON.parse(await readFile(join(workspaceDir, "runs/demo/plan/design_plan.json"), "utf8"));
    assert.equal(plan.image_generation_plan[0].id, "hero");
    assert.equal(plan.decisions[0].id, "decision");
    assert.equal(plan.concept_evaluation.selection, "concept");
    assert.equal(plan.concept_evaluation.image_generation_plan, undefined);
    const saved = JSON.parse((await writer.execute("manifest", { runId: "demo", path: "plan/deliverable_manifest.json", data: { deliverables: [{ id: "hero", method: "image_generate" }] } })).content[0].text);
    assert.ok(saved.warnings.some((warning) => warning.includes("explicit file")));
    const manifest = JSON.parse(await readFile(join(workspaceDir, "runs/demo/plan/deliverable_manifest.json"), "utf8"));
    assert.equal(manifest.deliverables[0].file, undefined);
    await writer.execute("alias", { runId: "demo", path: "plan/deliverable_manifest.json", data: { deliverables: [{ id: "hero", output_file: "artifacts/hero.png" }] } });
    assert.equal(JSON.parse(await readFile(join(workspaceDir, "runs/demo/plan/deliverable_manifest.json"), "utf8")).deliverables[0].file, "artifacts/hero.png");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("model watchdog allows bounded first-output waiting but detects stalled streams", () => {
  assert.equal(modelResponseTimeoutReason(120007, 120007, false, 300000, 120000), undefined);
  assert.equal(modelResponseTimeoutReason(120007, 120007, true, 300000, 120000), "stream stalled");
  assert.equal(modelResponseTimeoutReason(300000, 300000, false, 300000, 120000), "model turn deadline");
  assert.equal(modelResponseTimeoutReason(300000, 1000, true, 300000, 120000), "model turn deadline");
  assert.equal(modelResponseTimeoutReason(180000, 1000, true, 300000, 120000), undefined);
});

test("specialists receive authoritative Run identity and reject cross-project context and images", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-specialist-assignment-"));
  try {
    const runDir = join(workspaceDir, "runs", "current");
    const otherDir = join(workspaceDir, "runs", "previous");
    await mkdir(join(runDir, "research"), { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ runId: "current", brief: "Current task" }));
    await writeFile(join(otherDir, "brief.json"), JSON.stringify({ runId: "previous", brief: "Other task" }));
    await writeFile(join(otherDir, "reference.png"), PNG_1X1);
    await symlink(otherDir, join(runDir, "research", "escaped"));
    const { tools, handlers } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "current" } });
    const assignment = specialistRunAssignment(workspaceDir, "current", "designer");
    assert.match(assignment, /"runId":"current"/);
    assert.ok(assignment.includes(runDir));
    const starting = await handlers.get("before_agent_start")({ prompt: "Design a concept without ids", systemPrompt: "Base prompt" });
    assert.ok(starting.systemPrompt.includes(assignment));
    assert.equal(await handlers.get("before_agent_start")({ prompt: "Resume", systemPrompt: starting.systemPrompt }), undefined);
    for (const toolName of ["design_context_read", "design_bus_read", "write_json"]) {
      await assert.rejects(tools.get(toolName).execute("wrong", { runId: "invented", audience: "designer", path: "plan/design_system.json", data: {} }), /Assigned runId: current/);
      const blocked = await handlers.get("tool_call")({ toolName, input: { runId: "previous" } });
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /current/);
    }
    const context = JSON.parse((await tools.get("design_context_read").execute("correct", { runId: "current", audience: "designer" })).content[0].text);
    assert.equal(context.runId, "current");
    assert.ok(context.missingFiles.includes("plan/design_plan.json"));
    for (const [toolName, input] of [
      ["ls", { path: join(workspaceDir, "runs") }],
      ["read", { path: join(otherDir, "brief.json") }],
      ["read", { path: join(runDir, "research/escaped/brief.json") }],
      ["view_image", { paths: [join(otherDir, "reference.png")] }],
    ]) {
      const blocked = await handlers.get("tool_call")({ toolName, input });
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /current/);
    }
    await assert.rejects(tools.get("view_image").execute("image", { path: join(otherDir, "reference.png") }), /assigned Run current/);
    assert.equal(await handlers.get("tool_call")({ toolName: "read", input: { path: join(runDir, "brief.json") } }), undefined);
    assert.equal(await handlers.get("tool_call")({ toolName: "read", input: { path: join(workspaceDir, ".pi/skills/example/SKILL.md") } }), undefined);
    await tools.get("write_json").execute("correct-write", { runId: "current", path: "plan/design_system.json", data: { runId: "current" } });
    await assert.rejects(tools.get("design_bus_post").execute("wrong-post", { runId: "previous", from_agent: "designer", to: "orchestrator", type: "design_spec_ready", summary: "Wrong assignment" }), /Assigned runId: current/);
    assert.equal(JSON.parse(await readFile(join(otherDir, "brief.json"), "utf8")).brief, "Other task");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Designer recovery exposes existing checkpoints and missing outputs without failed reads", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-designer-recovery-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    const system = { runId: "demo", system_thesis: "Existing design decision" };
    await writeFile(join(runDir, "plan/design_system.json"), JSON.stringify(system));
    const { tools } = await registeredTools(workspaceDir);
    const result = JSON.parse((await tools.get("design_context_read").execute("recover", { runId: "demo", audience: "designer" })).content[0].text);
    assert.deepEqual(JSON.parse(result.files.find((file) => file.path === "plan/design_system.json").content), system);
    assert.equal(result.missingFiles.includes("plan/design_system.json"), false);
    for (const path of ["plan/design_plan.json", "plan/deliverable_manifest.json", "plan/task_breakdown.md", "plan/acceptance_criteria.md"]) assert.equal(result.missingFiles.includes(path), true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("discoverable Skills have matching names and role-specific audiences", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const skillsRoot = join(repoRoot, ".pi", "skills");
  const expected = [
    "architecture-space",
    "brand-identity",
    "design-system",
    "digital-product-design",
    "editorial-design",
    "exhibition-wayfinding",
    "fashion-textile-design",
    "game-experience-design",
    "image-prompting",
    "industrial-design",
    "information-design",
    "illustration-art-direction",
    "media-motion-design",
    "packaging-design",
    "poster-advertising",
    "product-design",
    "service-design",
    "showcase-layout",
    "ui-web-design",
    "ux-design",
    "visual-composition",
  ];
  const discovered = [];

  for (const folder of await readdir(skillsRoot)) {
    const source = await readFile(join(skillsRoot, folder, "SKILL.md"), "utf8").catch(() => undefined);
    if (!source) continue;
    const { frontmatter } = parseFrontmatter(source);
    assert.equal(frontmatter.name, folder);
    assert.equal(frontmatter.metadata?.audience, folder === "showcase-layout" ? "builder" : "designer");
    assert.ok(String(frontmatter.description ?? "").trim());
    discovered.push(folder);
  }

  assert.deepEqual(discovered.sort(), expected.sort());
});

async function registeredTools(workspaceDir, options = {}) {
  const tools = new Map();
  const handlers = new Map();
  const factory = createDreamaticExtension({ workspaceDir, ...options });
  factory({
    on(event, handler) { handlers.set(event, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
  });
  return { tools, handlers };
}

test("Builder can load its Showcase guide without mixing Designer Skills or requiring one to exist", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-builder-skill-"));
  try {
    const context = { cwd: fileURLToPath(new URL("../../..", import.meta.url)) };
    const builder = await registeredTools(workspaceDir, { parentInvocation: { id: "builder", agent: "builder", runId: "demo" } });
    const catalog = JSON.parse((await builder.tools.get("list_skills").execute("catalog", {}, undefined, undefined, context)).content[0].text);
    assert.ok(catalog.skills.some((skill) => skill.name === "showcase-layout" && skill.audience === "builder"));
    assert.equal(catalog.skills.some((skill) => skill.audience === "designer"), false);
    const loaded = await builder.tools.get("use_skill").execute("guide", { name: "showcase-layout", role: "supporting" }, undefined, undefined, context);
    assert.equal(loaded.details.name, "showcase-layout");
    assert.match(loaded.details.instruction, /do not modify Designer-owned specifications/);
    const wrong = JSON.parse((await builder.tools.get("use_skill").execute("wrong", { name: "industrial-design" }, undefined, undefined, context)).content[0].text);
    assert.equal(wrong.ok, false);
    const designer = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "demo" } });
    const designerCatalog = JSON.parse((await designer.tools.get("list_skills").execute("designer-catalog", {}, undefined, undefined, context)).content[0].text);
    assert.equal(designerCatalog.skills.some((skill) => skill.name === "showcase-layout"), false);
    const wrongRole = JSON.parse((await designer.tools.get("use_skill").execute("wrong-role", { name: "showcase-layout" }, undefined, undefined, context)).content[0].text);
    assert.equal(wrongRole.ok, false);
    const unavailable = JSON.parse((await builder.tools.get("use_skill").execute("removed", { name: "showcase-layout" }, undefined, undefined, { cwd: workspaceDir })).content[0].text);
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.instruction, /continue.*do not.*block/su);
    assert.equal(builder.tools.has("build_finalize"), true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("run initialization preserves actual user wording separately from titles and resolved briefs", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-request-provenance-"));
  try {
    const { tools, handlers } = await registeredTools(workspaceDir);
    const original = "帮我为人形机器人设计肌肉晶格结构";
    await handlers.get("before_agent_start")({ prompt: `${original}\n\n[DREAMATIC PROJECT OWNERSHIP]\nRuntime instruction` });
    await handlers.get("before_agent_start")({ prompt: "视觉表达；自由探索" });
    await tools.get("run_init").execute("init", { runIdOverride: "first", brief: "A resolved visual concept", projectTitle: "筋织人形晶格" });
    const brief = JSON.parse(await readFile(join(workspaceDir, "runs/first/brief.json"), "utf8"));
    assert.equal(brief.originalRequest, original);
    assert.equal(brief.originalRequestSource, "pi_user_prompt");
    assert.equal(brief.title, "筋织人形晶格");
    assert.equal(brief.brief, "A resolved visual concept");
    const context = JSON.parse((await tools.get("design_context_read").execute("context", { runId: "first", audience: "researcher" })).content[0].text);
    assert.equal(JSON.parse(context.files.find((file) => file.path === "brief.json").content).originalRequest, original);
    await tools.get("run_init").execute("second", { runIdOverride: "second", brief: "Another task summary", projectTitle: "Another project" });
    const second = JSON.parse(await readFile(join(workspaceDir, "runs/second/brief.json"), "utf8"));
    assert.equal(second.originalRequest, null);
    assert.equal(second.originalRequestSource, "unavailable");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("persisted server input takes precedence over clarification or recovery prompts", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-persisted-request-"));
  try {
    const runDir = join(workspaceDir, "runs", "draft");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ originalRequest: "为地方传统工艺设计展览", originalRequestSource: "server_user_input", title: "织忆", brief: "Changed summary" }));
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "draft" }));
    const { tools, handlers } = await registeredTools(workspaceDir);
    await handlers.get("before_agent_start")({ prompt: "Resume after transient failure" });
    await tools.get("run_init").execute("init", { runIdOverride: "draft", brief: "Resolved exhibition brief", projectTitle: "织忆新展" });
    const brief = JSON.parse(await readFile(join(runDir, "brief.json"), "utf8"));
    assert.equal(brief.originalRequest, "为地方传统工艺设计展览");
    assert.equal(brief.originalRequestSource, "server_user_input");
    const { tools: unknownTools } = await registeredTools(workspaceDir);
    await unknownTools.get("run_init").execute("unknown", { runIdOverride: "unknown", brief: "An agent summary", projectTitle: "艺术标题" });
    assert.equal(JSON.parse(await readFile(join(workspaceDir, "runs/unknown/brief.json"), "utf8")).originalRequest, null);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("long-lived sessions refresh persona instructions without replacing other system context", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-persona-refresh-"));
  try {
    const personaPath = join(workspaceDir, "orchestrator.md");
    await writeFile(personaPath, "---\nname: Orchestrator\n---\nAsk about missing use habits and style before designing.");
    const { handlers } = await registeredTools(workspaceDir, { personaPath });
    const refresh = handlers.get("before_agent_start");
    assert.ok(refresh);
    const original = `Base instructions\n${dreamaticPersonaPromptBlock("Stale persona instructions")}\nRuntime limits`;
    const first = await refresh({ systemPrompt: original });
    assert.match(first.systemPrompt, /Ask about missing use habits/);
    assert.doesNotMatch(first.systemPrompt, /Stale persona/);
    assert.ok(first.systemPrompt.startsWith("Base instructions"));
    assert.ok(first.systemPrompt.endsWith("Runtime limits"));
    await writeFile(personaPath, "---\nname: Orchestrator\n---\nNew clarification policy.");
    const next = await refresh({ systemPrompt: first.systemPrompt });
    assert.match(next.systemPrompt, /New clarification policy/);
    assert.doesNotMatch(next.systemPrompt, /Ask about missing use habits/);
    assert.equal(next.systemPrompt.match(/<!-- DREAMATIC_ACTIVE_PERSONA -->/g).length, 1);
    assert.match((await refresh({ systemPrompt: "Unmarked base" })).systemPrompt, /Unmarked base[\s\S]*New clarification policy/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Pi discovers and loads the new Designer domain modules through compatibility tools", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-skill-loading-"));
  try {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const { tools } = await registeredTools(workspaceDir);
    const context = { cwd: repoRoot };
    const listed = await tools.get("list_skills").execute("discover", {}, undefined, undefined, context);
    const catalog = JSON.parse(listed.content[0].text).skills;
    for (const name of ["industrial-design", "digital-product-design", "ux-design", "media-motion-design"]) {
      assert.ok(catalog.some((skill) => skill.name === name));
      const loaded = await tools.get("use_skill").execute(`load-${name}`, { name }, undefined, undefined, context);
      assert.equal(loaded.details.name, name);
      assert.match(loaded.content[0].text, /canonical Design Spec/);
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Designer can switch primary disciplines, deactivate support and reuse or reload Skill bodies", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-skill-switch-"));
  try {
    const context = { cwd: fileURLToPath(new URL("../../..", import.meta.url)) };
    const { tools } = await registeredTools(workspaceDir);
    const use = tools.get("use_skill");
    const first = await use.execute("brand", { name: "brand-identity", role: "primary" }, undefined, undefined, context);
    assert.equal(first.details.reused, false);
    await use.execute("craft", { name: "visual-composition", role: "supporting" }, undefined, undefined, context);
    const switched = await use.execute("product", { name: "industrial-design", role: "primary", deactivate: ["visual-composition"] }, undefined, undefined, context);
    assert.deepEqual(switched.details.activeSkills, [{ name: "industrial-design", role: "primary" }]);
    assert.deepEqual(switched.details.deactivated.sort(), ["brand-identity", "visual-composition"]);
    const reused = await use.execute("repeat", { name: "industrial-design", role: "primary" }, undefined, undefined, context);
    assert.equal(reused.details.reused, true);
    assert.doesNotMatch(reused.content[0].text, /## Form, material and production/);
    const reloaded = await use.execute("reload", { name: "industrial-design", reload: true }, undefined, undefined, context);
    assert.equal(reloaded.details.reused, false);
    assert.match(reloaded.content[0].text, /## Form, material and production/);
    const missing = JSON.parse((await use.execute("missing", { name: "not-a-real-domain-module", role: "primary" }, undefined, undefined, context)).content[0].text);
    assert.equal(missing.ok, false);
    const catalog = JSON.parse((await tools.get("list_skills").execute("list", {}, undefined, undefined, context)).content[0].text);
    assert.deepEqual(catalog.activeSkills, [{ name: "industrial-design", role: "primary" }]);
    assert.equal(catalog.skills.find((skill) => skill.name === "industrial-design").domainType, "industrial_design");
    const fresh = await registeredTools(workspaceDir);
    const newInvocation = await fresh.tools.get("use_skill").execute("new-stage", { name: "industrial-design", role: "primary" }, undefined, undefined, context);
    assert.equal(newInvocation.details.reused, false);
    assert.match(newInvocation.content[0].text, /## Form, material and production/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Skill catalog refresh discovers new modules and changed bodies are not incorrectly reused", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-skill-refresh-"));
  try {
    const context = { cwd: workspaceDir };
    const { tools } = await registeredTools(workspaceDir);
    await tools.get("list_skills").execute("before", {}, undefined, undefined, context);
    const directory = join(workspaceDir, ".pi", "skills", "local-design-test");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    await writeFile(file, "---\nname: local-design-test\ndescription: Test local design module.\n---\n# Local Design\nVersion one\n");
    const use = tools.get("use_skill");
    const discovered = await use.execute("new", { name: "local-design-test", role: "primary" }, undefined, undefined, context);
    assert.match(discovered.content[0].text, /Version one/);
    await writeFile(file, "---\nname: local-design-test\ndescription: Test local design module.\n---\n# Local Design\nVersion two\n");
    const changed = await use.execute("changed", { name: "local-design-test" }, undefined, undefined, context);
    assert.equal(changed.details.reused, false);
    assert.match(changed.content[0].text, /Version two/);
    const listing = JSON.parse((await tools.get("list_skills").execute("refresh", { refresh: true, query: "local-design-test" }, undefined, undefined, context)).content[0].text);
    assert.equal(listing.count, 1);
    await rm(file);
    const removed = JSON.parse((await use.execute("removed", { name: "local-design-test" }, undefined, undefined, context)).content[0].text);
    assert.equal(removed.ok, false);
    assert.match(removed.instruction, /unavailable/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("compare_images can reload a candidate set after context compaction", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-compare-"));
  try {
    const artifactDir = join(workspaceDir, "runs", "demo", "artifacts", "generated-images");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "a.png"), PNG_1X1);
    await writeFile(join(artifactDir, "b.png"), PNG_1X1);
    const { tools } = await registeredTools(workspaceDir);
    const compare = tools.get("compare_images");
    assert.ok(compare);
    const result = await compare.execute("test", {
      candidates: [
        { id: "a", path: "runs/demo/artifacts/generated-images/a.png" },
        { id: "b", path: "runs/demo/artifacts/generated-images/b.png" },
      ],
      criteria: ["hierarchy"],
    });
    assert.equal(result.content.filter((block) => block.type === "image").length, 2);
    assert.match(result.content[0].text, /hierarchy/);
    const repeated = await compare.execute("test-repeat", {
      candidates: [
        { id: "b", path: "runs/demo/artifacts/generated-images/b.png" },
        { id: "a", path: "runs/demo/artifacts/generated-images/a.png" },
      ],
      criteria: ["typography"],
    });
    assert.equal(repeated.content.filter((block) => block.type === "image").length, 2);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("view_image can reload visual evidence within one stage invocation", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-view-budget-"));
  try {
    const path = "runs/demo/artifacts/generated-images/a.png";
    await mkdir(join(workspaceDir, "runs", "demo", "artifacts", "generated-images"), { recursive: true });
    await writeFile(join(workspaceDir, path), PNG_1X1);
    const { tools } = await registeredTools(workspaceDir);
    const view = tools.get("view_image");
    const result = await view.execute("view-1", { path });
    assert.equal(result.content.filter((block) => block.type === "image").length, 1);
    const repeated = await view.execute("view-2", { path });
    assert.equal(repeated.content.filter((block) => block.type === "image").length, 1);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Designer screens labelled reference batches without a stage quota or all-or-nothing failure", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-view-reference-batch-"));
  try {
    const root = join(workspaceDir, "runs", "demo", "research", "assets");
    await mkdir(root, { recursive: true });
    const paths = Array.from({ length: 9 }, (_, index) => join(root, `reference-${index}.png`));
    for (const path of paths) await writeFile(path, PNG_1X1);
    const { tools, handlers } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "demo" } });
    const result = await tools.get("view_image").execute("batch", { paths: [...paths, paths[0], join(root, "missing.png")] });
    const summary = JSON.parse(result.content[0].text);
    assert.equal(summary.succeeded, 9);
    assert.equal(summary.failed, 1);
    assert.equal(summary.partial, true);
    assert.equal(result.content.filter((block) => block.type === "image").length, 9);
    assert.equal(summary.results[8].label, "9: reference-8.png");
    const messages = [{ role: "assistant", content: [] }, { role: "toolResult", toolName: "view_image", content: result.content }];
    const current = handlers.get("context")({ messages }).messages;
    assert.equal(current[1].content.filter((block) => block.type === "image").length, 9);
    const again = await tools.get("view_image").execute("reload", { paths });
    assert.equal(again.content.filter((block) => block.type === "image").length, 9);
    await assert.rejects(() => tools.get("view_image").execute("ambiguous", { path: paths[0], paths }), /either path or paths/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("reference inventory exposes legacy paths and flags missing or unreviewed design adoption", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-reference-handoff-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "research", "assets"), { recursive: true });
    const assets = [{ id: "legacy", local_path: "research/assets/legacy.png" }, { id: "modern", file: "modern.png" }];
    await writeFile(join(runDir, "research/assets/manifest.json"), JSON.stringify({ assets }));
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "demo" } });
    const initial = JSON.parse((await tools.get("design_context_read").execute("context", { runId: "demo", audience: "designer" })).content[0].text);
    assert.deepEqual(initial.referenceInventory.map((asset) => asset.viewPath), [join(runDir, "research/assets/legacy.png"), join(runDir, "research/assets/modern.png")]);
    assert.deepEqual(initial.referenceReview.missingAssetIds, ["legacy", "modern"]);
    const warning = JSON.parse((await tools.get("write_json").execute("plan", { runId: "demo", path: "plan/design_plan.json", data: { image_generation_plan: [], reference_use_decisions: [{ asset_id: "legacy", decision: "transform", review_status: "metadata_only" }] } })).content[0].text);
    assert.equal(warning.warnings.length, 2);
    const reviewer = JSON.parse((await tools.get("design_context_read").execute("review", { runId: "demo", audience: "reviewer" })).content[0].text);
    assert.equal(reviewer.files.some((file) => file.path === "research/assets/manifest.json"), true);
    assert.deepEqual(reviewer.referenceReview.missingAssetIds, ["modern"]);
    assert.deepEqual(reviewer.referenceReview.unreviewedAdoptions, ["legacy"]);
    assert.match(reviewer.referenceReview.evidenceScope, /not proof/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("select_artifact persists a run-scoped decision", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-select-"));
  try {
    const artifactDir = join(workspaceDir, "runs", "demo", "artifacts", "generated-images");
    await mkdir(artifactDir, { recursive: true });
    const selectedPath = "artifacts/generated-images/a.png";
    await writeFile(join(workspaceDir, "runs", "demo", selectedPath), PNG_1X1);
    const { tools } = await registeredTools(workspaceDir);
    const select = tools.get("select_artifact");
    assert.ok(select);
    await select.execute("test", {
      runId: "demo",
      selectedPath,
      reason: ["Clearer focal hierarchy"],
    });
    const selection = JSON.parse(await readFile(join(workspaceDir, "runs", "demo", "artifacts", "selection.json"), "utf8"));
    assert.equal(selection.selectedPath, `runs/demo/${selectedPath}`);
    assert.deepEqual(selection.reason, ["Clearer focal hierarchy"]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("export_package promotes the reviewed gallery as the showcase entry", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-export-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "artifacts", "generated-images"), { recursive: true });
    await writeFile(join(runDir, "artifacts", "generated-images", "hero.png"), PNG_1X1);
    await writeFile(join(runDir, "artifacts", "00-gallery.html"), '<!doctype html><html><head><title>Reviewed gallery</title></head><body><section><h1>Design story</h1><img src="generated-images/hero.png"></section></body></html>');
    await mkdir(join(runDir, "plan"), { recursive: true });
    await writeFile(join(runDir, "plan", "progress.json"), JSON.stringify({
      runId: "demo",
      items: [
        { id: "build", text: "Build", status: "in_progress" },
        { id: "package", text: "Package", status: "pending" },
      ],
    }));
    await writeFile(join(runDir, "bus.jsonl"), [
      { type: "design_review_pass", from_agent: "reviewer" },
      { type: "build_done", from_agent: "builder" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const { tools } = await registeredTools(workspaceDir);
    const artifactLint = tools.get("artifact_lint");
    const exportPackage = tools.get("export_package");
    assert.ok(artifactLint);
    assert.ok(exportPackage);
    const lintResult = await artifactLint.execute("lint", { runId: "demo", runDir, requireGallery: true });
    assert.equal(JSON.parse(lintResult.content[0].text).ok, true);
    assert.equal(JSON.parse(await readFile(join(runDir, "artifacts", "lint-report.json"), "utf8")).ok, true);
    const repeatedLint = await artifactLint.execute("lint-repeat", { runId: "demo", runDir, requireGallery: true });
    assert.equal(JSON.parse(repeatedLint.content[0].text).reused, true);
    const exported = await exportPackage.execute("test", { runId: "demo", runDir });
    assert.equal(exported.terminate, true);
    const index = await readFile(join(runDir, "final", "00-index.html"), "utf8");
    assert.match(index, /<base href="artifacts\/">/);
    assert.match(index, /Design story/);
    assert.match(index, /generated-images\/hero\.png/);
    assert.doesNotMatch(index, /Design delivery/);
    const progress = JSON.parse(await readFile(join(runDir, "plan", "progress.json"), "utf8"));
    assert.deepEqual(progress.items.map((item) => item.status), ["completed", "completed"]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("orchestrator cannot inspect images or reopen work after build_done", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-finalization-guard-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({
      runId: "demo",
      status: "active",
      stages: { research: "completed", design: "completed", review: "completed", build: "completed", export: "in_progress" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastEvent: "build_done",
    }));
    const { handlers } = await registeredTools(workspaceDir);
    const guard = handlers.get("tool_call");
    assert.ok(guard);
    const imageRead = await guard({ type: "tool_call", toolCallId: "read-image", toolName: "read", input: { path: join(runDir, "artifacts", "hero.png") } });
    assert.equal(imageRead?.block, true);
    assert.match(imageRead?.reason, /must not load binary images/);
    const textRead = await guard({ type: "tool_call", toolCallId: "read-manifest", toolName: "read", input: { path: join(runDir, "artifacts", "artifact-manifest.json") } });
    assert.equal(textRead?.block, true);
    assert.match(textRead?.reason, /committed build_done/);
    const exportCall = await guard({ type: "tool_call", toolCallId: "export", toolName: "export_package", input: { runId: "demo", runDir } });
    assert.equal(exportCall, undefined);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("export_package rejects unapproved or unimplemented design context", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-export-gate-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    const { tools } = await registeredTools(workspaceDir);
    const exportPackage = tools.get("export_package");
    assert.ok(exportPackage);

    await writeFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ type: "design_review_fail", from_agent: "reviewer" })}\n`);
    await assert.rejects(
      () => exportPackage.execute("test-unapproved", { runId: "demo", runDir }),
      /approved Design Context is implemented/,
    );

    await writeFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ type: "design_review_pass", from_agent: "reviewer" })}\n`);
    await assert.rejects(
      () => exportPackage.execute("test-unimplemented", { runId: "demo", runDir }),
      /approved Design Context is implemented/,
    );

    await writeFile(join(runDir, "bus.jsonl"), [
      { type: "design_review_pass", from_agent: "reviewer" },
      { type: "build_done", from_agent: "builder" },
      { type: "design_revision_ready", from_agent: "designer" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    await assert.rejects(
      () => exportPackage.execute("test-stale-build", { runId: "demo", runDir }),
      /approved Design Context is implemented/,
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("persona tool policies keep reasoning separate from execution", () => {
  const researcher = dreamaticPersonaTools("researcher", ["read", "write", "write_json", "patch_json", "design_bus_post", "design_bus_read", "design_context_read", "websearch_batch", "research_fetch_batch", "research_asset_discover", "research_asset_fetch", "research_asset_fetch_batch"]);
  const designer = dreamaticPersonaTools("designer", ["read", "write", "write_json", "patch_json", "ls", "list_skills", "use_skill", "design_bus_post", "design_bus_read", "design_context_read", "view_image"]);
  const reviewer = dreamaticPersonaTools("reviewer", ["read", "write", "write_json", "patch_json", "ls", "design_bus_post", "design_bus_read", "design_context_read"]);
  const builder = dreamaticPersonaTools("builder", ["read", "write", "write_json", "patch_json", "edit", "ls", "list_skills", "use_skill", "design_bus_read", "design_context_read", "image_generate", "image_generate_batch", "image_edit", "image_edit_batch", "execute_image_plan", "showcase_template", "build_finalize"]);
  assert.equal(researcher.includes("view_image"), false);
  assert.equal(researcher.includes("research_asset_validate"), false);
  assert.equal(researcher.includes("bash"), false);
  assert.equal(researcher.includes("research_asset_discover"), true);
  assert.equal(researcher.includes("research_asset_fetch_batch"), true);
  assert.equal(designer.includes("image_generate"), false);
  assert.equal(designer.includes("view_image"), true);
  assert.equal(designer.includes("use_skill"), true);
  assert.equal(reviewer.includes("view_image"), false);
  assert.equal(builder.includes("image_generate"), true);
  assert.equal(builder.includes("image_generate_batch"), true);
  assert.equal(builder.includes("image_edit"), true);
  assert.equal(builder.includes("image_edit_batch"), true);
  assert.equal(builder.includes("use_skill"), true);
  assert.equal(builder.includes("view_image"), false);
  assert.equal(builder.includes("design_bus_post"), false);
  assert.equal(builder.includes("artifact_lint"), false);
  assert.throws(
    () => dreamaticPersonaTools("designer", [...designer, "image_generate"]),
    /disallowed: image_generate/,
  );
});

test("all persona contracts are checked before dispatch and configuration failures stop retries", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "dreamatic-contract-preflight-"));
  try {
    const agentsDir = join(repoRoot, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    for (const [persona, tools] of Object.entries(DREAMATIC_PERSONA_TOOL_POLICY)) {
      await writeFile(join(agentsDir, `${persona}.md`), `---\nallowed_tools: ${JSON.stringify(tools)}\n---\nPersona instructions`);
    }
    await validateDreamaticPersonaContracts(repoRoot);
    const workspaceDir = join(repoRoot, "workspace");
    const { handlers } = await registeredTools(workspaceDir);
    const guard = handlers.get("tool_call");
    const context = { cwd: repoRoot };
    assert.equal(await guard({ toolName: "run_init", input: {} }, context), undefined);
    await writeFile(join(agentsDir, "builder.md"), `---\nallowed_tools: ${JSON.stringify([...DREAMATIC_PERSONA_TOOL_POLICY.builder, "bash"])}\n---\nIncompatible builder`);
    await assert.rejects(() => validateDreamaticPersonaContracts(repoRoot), /not retryable[\s\S]*Rebuild and restart/);
    const blocked = await guard({ toolName: "spawn_agent", input: { agent: "builder" } }, context);
    assert.equal(blocked.block, true);
    assert.equal(blocked.terminate, true);
    assert.match(blocked.reason, /builder[\s\S]*disallowed: bash/);
    const repeated = await guard({ toolName: "spawn_agent", input: { agent: "builder" } }, context);
    assert.equal(repeated.terminate, true);
    assert.match(repeated.reason, /already committed/);
    await writeFile(join(agentsDir, "builder.md"), `---\nallowed_tools: ${JSON.stringify(DREAMATIC_PERSONA_TOOL_POLICY.builder)}\n---\nFixed builder`);
    await handlers.get("agent_start")({ type: "agent_start" });
    assert.equal(await guard({ toolName: "spawn_agent", input: { agent: "builder" } }, context), undefined);
    await rm(join(agentsDir, "reviewer.md"));
    await assert.rejects(() => validateDreamaticPersonaContracts(repoRoot), /reviewer\.md[\s\S]*ENOENT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("Builder contract errors terminate before loading a child session", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "dreamatic-builder-contract-"));
  try {
    await mkdir(join(repoRoot, ".pi", "agents"), { recursive: true });
    await writeFile(join(repoRoot, ".pi", "agents", "builder.md"), "---\nallowed_tools: [read]\n---\nBuilder");
    const { tools } = await registeredTools(join(repoRoot, "workspace"));
    const result = await tools.get("spawn_agent").execute("builder-config", { agent: "builder", task: "Build" }, undefined, undefined, { cwd: repoRoot, model: {} });
    assert.equal(result.terminate, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.retryable, false);
    assert.match(payload.error, /tool contract mismatch/);
    assert.match(payload.instruction, /resume this Run/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("write_json preserves nested data, atomically replaces files and enforces the assigned Run", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-write-json-"));
  try {
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } });
    const writer = tools.get("write_json");
    const data = { runId: "demo", identity: { mark: { description: 'line "one"\nline two' } }, image_generation_plan: [{ id: "hero", prompt_seed: "月球基地" }] };
    const receipt = JSON.parse((await writer.execute("write-data", { runId: "demo", path: "plan/design_plan.json", data })).content[0].text);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.sha256.length, 64);
    assert.deepEqual(JSON.parse(await readFile(join(workspaceDir, receipt.path), "utf8")), data);
    await writer.execute("replace-data", { runId: "demo", path: "plan/design_plan.json", data: { ...data, design_intent: "updated" } });
    assert.deepEqual(await readdir(join(workspaceDir, "runs", "demo", "plan")), ["design_plan.json"]);
    for (const path of ["plan/../run-state.json", "/plan/escape.json", "plan/spec.md"]) {
      await assert.rejects(() => writer.execute("bad-path", { runId: "demo", path, data }), /Run-relative/);
    }
    await assert.rejects(() => writer.execute("wrong-run", { runId: "other", path: "plan/design_plan.json", data }), /assigned Run/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => writer.execute("cancelled", { runId: "demo", path: "plan/design_plan.json", data: {} }, controller.signal), /abort/i);
    assert.equal(JSON.parse(await readFile(join(workspaceDir, receipt.path), "utf8")).design_intent, "updated");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("compact Design Context marks omitted JSON details and supports full targeted reads", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-context-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    const plan = { runId: "demo", image_generation_plan: [{ id: "hero", prompt_seed: "original creative specification ".repeat(1500), size: "1024x768" }] };
    await writeFile(join(runDir, "plan/design_plan.json"), JSON.stringify(plan, null, 2));
    await writeFile(join(runDir, "bus.jsonl"), [
      { type: "design_review_pass", summary: "Approved", artifactRefs: ["review/design-review.json"], commitReceipt: { enormous: "x".repeat(10000) } },
      ...Array.from({ length: 40 }, () => ({ type: "agent_progress", output: "waiting" })),
      { type: "orchestrator_tool_finished", output: "unneeded execution log" },
    ].map((event) => JSON.stringify(event)).join("\n"));
    const { tools } = await registeredTools(workspaceDir);
    const context = JSON.parse((await tools.get("design_context_read").execute("context", { runId: "demo", audience: "builder" })).content[0].text);
    assert.equal(context.files[0].truncated, true);
    assert.equal(JSON.parse(context.files[0].content).image_generation_plan[0].id, "hero");
    assert.ok(context.files[0].omittedPointers.includes("/image_generation_plan/0/prompt_seed"));
    const full = JSON.parse((await tools.get("design_context_read").execute("full", { runId: "demo", audience: "builder", paths: ["plan/design_plan.json"], full: true })).content[0].text);
    assert.equal(full.files[0].truncated, false);
    assert.deepEqual(JSON.parse(full.files[0].content), plan);
    assert.equal(context.recentEvents.length, 1);
    assert.equal(context.recentEvents[0].type, "design_review_pass");
    assert.equal(context.recentEvents[0].commitReceipt, undefined);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("runtime-owned state rejects structured overwrite without triggering a fallback write", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-owned-state-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    const original = JSON.stringify({ status: "research", sections: { tokens: "plan/design_system.json" } });
    await writeFile(join(runDir, "design-context.json"), original);
    const { tools, handlers } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } });
    for (const path of ["design-context.json", "run-state.json"]) {
      const result = JSON.parse((await tools.get("write_json").execute("owned", { runId: "demo", path, data: { status: "approved" } })).content[0].text);
      assert.equal(result.writePerformed, false);
      assert.equal(result.runtimeManaged, true);
      assert.equal(result.ok, false);
      for (const toolName of ["write", "edit"]) {
        const blocked = await handlers.get("tool_call")({ toolName, input: { path: join(runDir, path), content: "{}" } });
        assert.equal(blocked.block, true);
        assert.match(blocked.reason, /runtime-managed/);
      }
    }
    assert.equal(await readFile(join(runDir, "design-context.json"), "utf8"), original);
    assert.equal((await handlers.get("tool_call")({ toolName: "write", input: { path: join(runDir, "plan", "notes.md"), content: "Notes" } })), undefined);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("write_json reports image-plan id mismatches early without guessing or rejecting saved work", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-link-warning-"));
  try {
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } });
    const write = tools.get("write_json");
    const plan = { image_generation_plan: [{ id: "IMG-01", method: "image_generate" }] };
    await write.execute("plan", { runId: "demo", path: "plan/design_plan.json", data: plan });
    const manifest = { deliverables: [{ id: "DEL-01", method: "image_generate", file: "artifacts/hero.png" }, { id: "notes", method: "manual", file: "artifacts/notes.md" }] };
    const mismatch = JSON.parse((await write.execute("manifest", { runId: "demo", path: "plan/deliverable_manifest.json", data: manifest })).content[0].text);
    assert.equal(mismatch.ok, true);
    assert.equal(mismatch.warnings.length, 1);
    assert.match(mismatch.warnings[0], /DEL-01.*IMG-01/);
    assert.equal(JSON.parse(await readFile(join(workspaceDir, "runs", "demo", "plan", "deliverable_manifest.json"), "utf8")).deliverables[0].id, "DEL-01");
    manifest.deliverables[0].id = "IMG-01";
    const fixed = JSON.parse((await write.execute("fix", { runId: "demo", path: "plan/deliverable_manifest.json", data: manifest })).content[0].text);
    assert.equal(fixed.warnings, undefined);
    plan.image_generation_plan[0].id = "different";
    const reverse = JSON.parse((await write.execute("revised-plan", { runId: "demo", path: "plan/design_plan.json", data: plan })).content[0].text);
    assert.match(reverse.warnings[0], /IMG-01.*different/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("role ownership blocks cross-role, cross-run and symlink writes", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-role-ownership-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    await mkdir(join(runDir, "review"), { recursive: true });
    for (const [agent, owned, forbidden] of [
      ["researcher", "research/evidence.json", "plan/design_plan.json"],
      ["designer", "plan/design_plan.json", "review/design-review.json"],
      ["reviewer", "review/design-review.json", "plan/design_plan.json"],
      ["builder", "artifacts/implementation.json", "plan/design_system.json"],
    ]) {
      const { tools, handlers } = await registeredTools(workspaceDir, { parentInvocation: { id: agent, agent, runId: "demo" } });
      await tools.get("write_json").execute("own", { runId: "demo", path: owned, data: {} });
      await assert.rejects(() => tools.get("write_json").execute("other", { runId: "demo", path: forbidden, data: {} }), /cannot write/);
      for (const toolName of ["write", "edit"]) {
        assert.equal((await handlers.get("tool_call")({ toolName, input: { path: join(runDir, forbidden) } })).block, true);
        assert.equal((await handlers.get("tool_call")({ toolName, input: { path: join(workspaceDir, "runs", "other", owned) } })).block, true);
      }
    }
    await symlink(join(runDir, "review"), join(runDir, "plan", "escape"));
    const designer = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "demo" } });
    await assert.rejects(() => designer.tools.get("write_json").execute("escape", { runId: "demo", path: "plan/escape/spec.json", data: {} }), /cannot write|escape/);
    const primary = await registeredTools(workspaceDir);
    await assert.rejects(() => primary.tools.get("write_json").execute("impersonate", { runId: "demo", path: "plan/design_plan.json", data: {} }), /cannot write/);
    await primary.tools.get("write_json").execute("handoff", { runId: "demo", path: "plan/handoff/feedback.json", data: { feedback: "preserve the concept" } });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("completed-project revisions archive delivery and invalidate previous gates", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-user-revision-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await mkdir(join(runDir, "final"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ runId: "demo", brief: "Original requirements" }));
    await writeFile(join(runDir, "design-context.json"), JSON.stringify({ status: "complete", latestVerdict: "pass" }));
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "complete", stages: {}, lastEvent: "export_done" }));
    await writeFile(join(runDir, "artifacts", "hero.png"), PNG_1X1);
    await writeFile(join(runDir, "final", "old-only.txt"), "Previous package");
    await writeFile(join(runDir, "bus.jsonl"), [{ type: "design_review_pass" }, { type: "build_done" }].map(JSON.stringify).join("\n") + "\n");
    const { tools, handlers } = await registeredTools(workspaceDir, { projectId: "demo" });
    await assert.rejects(() => tools.get("run_revision").execute("wrong-project", { runId: "other", feedback: "Change" }), /project/);
    const result = JSON.parse((await tools.get("run_revision").execute("revision", { runId: "demo", feedback: "Make the controls tactile", preserve: ["overall silhouette"] })).content[0].text);
    assert.equal(result.ok, true);
    assert.equal(await readFile(join(runDir, result.revisionRequest.baseSnapshot, "final", "old-only.txt"), "utf8"), "Previous package");
    assert.deepEqual(await readFile(join(runDir, "artifacts", "hero.png")), PNG_1X1);
    assert.equal(JSON.parse(await readFile(join(runDir, "design-context.json"), "utf8")).latestVerdict, null);
    assert.equal(JSON.parse(await readFile(join(runDir, "run-state.json"), "utf8")).stages.build, "pending");
    await assert.rejects(() => tools.get("export_package").execute("old-gates", { runId: "demo", runDir }), /approved Design Context/);
    await assert.rejects(() => tools.get("run_revision").execute("overlap", { runId: "demo", feedback: "Again" }), /completed Run/);
    const clarification = JSON.parse((await tools.get("ask_user").execute("choose", { title: "Choose a direction", questions: [{ header: "Concept", question: "Which concept should we refine?" }] })).content[0].text);
    assert.equal(clarification.status, "waiting_for_user");
    await handlers.get("agent_start")({ type: "agent_start" });
    await writeFile(join(runDir, "run-state.json"), JSON.stringify({ status: "complete", lastEvent: "export_done" }));
    assert.equal((await handlers.get("tool_call")({ toolName: "spawn_agent", input: { runId: "demo" } })).block, true);
    assert.equal(await handlers.get("tool_call")({ toolName: "ask_user", input: {} }), undefined);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Designer publishes three JSON files while runtime derives execution companions", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-design-docs-"));
  try {
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer", agent: "designer", runId: "demo" } });
    const writer = tools.get("write_json");
    await writer.execute("system", { runId: "demo", path: "plan/design_system.json", data: { system_thesis: "A tactile family", palette: {}, typography: {} } });
    const subjectUnderstanding = [{ term: "Tactile feedback", meaning: "A perceivable response to a user action", defining_properties: ["Action and response are connected"], evidence_refs: [], visual_refs: [], status: "partial", design_implications: ["Show the control and feedback relationship"], uncertainties: ["Response characteristics need validation"] }];
    await writer.execute("plan", { runId: "demo", path: "plan/design_plan.json", data: { design_intent: "A tactile design", subject_understanding: subjectUnderstanding, image_generation_plan: [{ id: "hero", method: "image_generate", size: { width: 512, height: 512 }, prompt_seed: "Tactile controls", negative_prompt_seed: "No extra controls", size_rationale: "A compact overview" }] } });
    await writer.execute("manifest", { runId: "demo", path: "plan/deliverable_manifest.json", data: { deliverables: [{ id: "hero", method: "image_generate", file: "artifacts/hero.png", required: true, kind: "overview", purpose: "Show the tactile controls", acceptance_test: "Controls remain identifiable" }] } });
    const publish = { runId: "demo", type: "design_spec_ready", from_agent: "designer", to: "orchestrator", summary: "Ready", artifactRefs: ["plan/design_plan.json"] };
    await tools.get("design_bus_post").execute("publish", publish);
    const runDir = join(workspaceDir, "runs", "demo");
    const acceptance = await readFile(join(runDir, "plan/acceptance_criteria.md"), "utf8");
    const context = JSON.parse((await tools.get("design_context_read").execute("context", { runId: "demo", audience: "builder" })).content[0].text);
    assert.deepEqual(JSON.parse(context.files.find((file) => file.path === "plan/design_plan.json").content).subject_understanding, subjectUnderstanding);
    assert.match(acceptance, /Controls remain identifiable/);
    assert.match(acceptance, /512x512/);
    assert.match(await readFile(join(runDir, "plan/task_breakdown.md"), "utf8"), /artifacts\/hero.png/);
    await writeFile(join(runDir, "plan/acceptance_criteria.md"), "Custom acceptance criteria");
    await tools.get("design_bus_post").execute("revision", { ...publish, type: "design_revision_ready" });
    assert.equal(await readFile(join(runDir, "plan/acceptance_criteria.md"), "utf8"), "Custom acceptance criteria");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("specialists stop only after their durable completion tool succeeds", () => {
  assert.equal(specialistCompletionEvent("researcher", "design_bus_post", false, { type: "research_done" }), "research_done");
  assert.equal(specialistCompletionEvent("designer", "design_bus_post", false, { type: "design_spec_ready" }), "design_spec_ready");
  assert.equal(specialistCompletionEvent("reviewer", "design_bus_post", false, { type: "design_review_pass" }), "design_review_pass");
  assert.equal(specialistCompletionEvent("builder", "build_finalize", false, { runId: "demo" }), "build_done");
  assert.equal(specialistCompletionEvent("builder", "build_finalize", true, { runId: "demo" }), undefined);
  assert.equal(specialistCompletionEvent("designer", "design_bus_post", false, { type: "research_done" }), undefined);
});

test("build_finalize creates deterministic delivery metadata and commits build_done", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-build-finalize-"));
  try {
    const runId = "demo";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(join(runDir, "plan"), { recursive: true });
    await mkdir(join(runDir, "artifacts", "generated-images"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ runId, projectTitle: "Fast Build" }));
    await writeFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ type: "design_review_pass" })}\n`);
    await writeFile(join(runDir, "plan", "design_plan.json"), JSON.stringify({
      runId,
      showcase: { overview: "面向创作者的语音交互设备。", captions: { hero: "主视图展示旋钮与快捷键的布局。" }, summary: "作品将核心交互集中在清晰可读的控制区域。" },
      image_generation_plan: [{
        id: "hero",
        method: "image_generate",
        output_file: "artifacts/generated-images/hero.png",
        size: "1024x768",
        prompt_seed: "PRIVATE GENERATION PROMPT",
        reference_ids_or_paths: [],
        preservation_rules: [],
      }],
    }));
    await writeFile(join(runDir, "plan", "deliverable_manifest.json"), JSON.stringify({
      runId,
      deliverables: [
        { id: "hero", file: "artifacts/generated-images/hero.png", purpose: "Primary visual", required: true, method: "image_generate", size: "1024x768" },
        { id: "gallery", file: "artifacts/00-gallery.html", purpose: "Showcase", required: true, method: "manual" },
      ],
    }));
    await writeFile(join(runDir, "artifacts", "generated-images", "hero.png"), PNG_1X1);
    await mkdir(join(runDir, "research/assets"), { recursive: true });
    await writeFile(join(runDir, "research/assets/reference.png"), PNG_1X1);
    await writeFile(join(runDir, "research/assets/manifest.json"), JSON.stringify({ assets: [{ id: "reference", file: "reference.png", description: "交互设备参考", source_page_url: "https://example.com/reference" }] }));
    await writeFile(join(runDir, "research/evidence.json"), JSON.stringify({ sources: [{ title: "输入设备研究", url: "https://example.com/study" }] }));
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "builder-1", agent: "builder", runId } });
    await assert.rejects(() => tools.get("build_finalize").execute("missing-showcase", { runId }), /Builder must author artifacts\/00-gallery.html/);
    await writeFile(join(runDir, "artifacts/00-gallery.html"), "   ");
    await assert.rejects(() => tools.get("build_finalize").execute("empty-showcase", { runId }), /Showcase|empty/);
    assert.equal((await readFile(join(runDir, "bus.jsonl"), "utf8")).includes("build_done"), false);
    const authoredGallery = '<!doctype html><html><head><title>Fast Build</title></head><body><h1>Fast Build</h1><p>面向创作者的语音交互设备。</p><figure><img src="generated-images/hero.png"><figcaption>主视图展示旋钮与快捷键的布局。</figcaption></figure><section><h2>作品总结</h2><p>作品将核心交互集中在清晰可读的控制区域。</p></section></body></html>';
    await writeFile(join(runDir, "artifacts/00-gallery.html"), authoredGallery);
    const result = await tools.get("build_finalize").execute("finalize", { runId });
    assert.equal(result.terminate, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.event.type, "build_done");
    assert.equal(JSON.parse(await readFile(join(runDir, "artifacts", "lint-report.json"), "utf8")).ok, true);
    const gallery = await readFile(join(runDir, "artifacts", "00-gallery.html"), "utf8");
    assert.ok(gallery.replace(/ title="设计方案 Prompt\nPRIVATE GENERATION PROMPT"/u, "").startsWith(authoredGallery.split("</body>")[0]));
    assert.match(gallery, /generated-images\/hero\.png/);
    assert.match(gallery, /<h1>Fast Build<\/h1><p>面向创作者/);
    assert.match(gallery, /<figcaption>主视图展示旋钮与快捷键的布局。<\/figcaption>/);
    assert.match(gallery, /作品总结[\s\S]*作品将核心交互[\s\S]*参考图片汇总[\s\S]*文献与来源/);
    assert.match(gallery, /\.\.\/research\/assets\/reference\.png/);
    assert.match(gallery, /href="https:\/\/example.com\/study"/);
    assert.match(gallery, /title="设计方案 Prompt\nPRIVATE GENERATION PROMPT"/);
    assert.doesNotMatch(gallery, /<figcaption>[^<]*PRIVATE GENERATION PROMPT/);
    const events = (await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.at(-1).type, "build_done");
    assert.equal(typeof events.at(-1).commitReceipt.files["artifacts/artifact-manifest.json"], "string");
    const { tools: exportTools } = await registeredTools(workspaceDir);
    await rm(join(runDir, "artifacts/00-gallery.html"));
    await assert.rejects(() => exportTools.get("export_package").execute("missing-page", { runId, runDir, brief: "DO NOT GENERATE A PAGE" }), /Export cannot create a substitute page/);
    assert.equal(JSON.parse(await readFile(join(runDir, "run-state.json"), "utf8")).lastEvent, "build_done");
    await writeFile(join(runDir, "artifacts/00-gallery.html"), gallery);
    await exportTools.get("export_package").execute("export", { runId, runDir });
    assert.ok((await readFile(join(runDir, "final/research/assets/reference.png"))).equals(PNG_1X1));
    const index = await readFile(join(runDir, "final/00-index.html"), "utf8");
    assert.match(index, /<base href="artifacts\/">/);
    assert.match(index, /\.\.\/research\/assets\/reference\.png/);
    assert.equal(index, gallery.replace("<head>", '<head><base href="artifacts/">'));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Builder preserves authored layouts, rejects broken links and reports quality honestly", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-builder-gallery-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ runId: "demo" }));
    await writeFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ type: "design_review_pass" })}\n`);
    await writeFile(join(runDir, "plan/design_plan.json"), JSON.stringify({ image_generation_plan: [] }));
    await writeFile(join(runDir, "plan/deliverable_manifest.json"), JSON.stringify({ deliverables: [{ id: "poster", method: "manual", file: "artifacts/poster.svg", purpose: "An exact typographic composition", required: true }] }));
    await writeFile(join(runDir, "artifacts/poster.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><text x="20" y="40">确定的品牌文字</text></svg>');
    const gallery = '<!doctype html><html><head><title>Designed narrative</title></head><body><h1>品牌故事</h1><img src="poster.svg"><p>精确排版与设计解释</p></body></html>';
    await writeFile(join(runDir, "artifacts/00-gallery.html"), gallery.replace("poster.svg", "missing.svg"));
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "builder", agent: "builder", runId: "demo" } });
    const finalize = tools.get("build_finalize");
    await assert.rejects(() => finalize.execute("broken", { runId: "demo" }), /missing local reference/);
    assert.equal((await readFile(join(runDir, "bus.jsonl"), "utf8")).includes("build_done"), false);
    await writeFile(join(runDir, "artifacts/00-gallery.html"), gallery);
    await finalize.execute("finalize", { runId: "demo" });
    const finalizedGallery = await readFile(join(runDir, "artifacts/00-gallery.html"), "utf8");
    assert.ok(finalizedGallery.startsWith(gallery.split("</body>")[0]));
    assert.match(finalizedGallery, /参考图片汇总/);
    const manifest = JSON.parse(await readFile(join(runDir, "artifacts/artifact-manifest.json"), "utf8"));
    assert.deepEqual(manifest.qualityEvidence, { designSpec: "reviewed", fileIntegrity: "passed", visualFidelity: "not_assessed", engineeringFeasibility: "not_validated", userAcceptance: "pending" });
    await assert.rejects(() => finalize.execute("again", { runId: "demo" }), /only commit|commit only once/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("mechanical HTML lint permits source links but rejects external embedded resources", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-source-links-"));
  try {
    const { tools } = await registeredTools(workspaceDir);
    const cases = [
      ['<a href="https://example.com/paper?first=1&amp;second=2">Paper</a>', true],
      ['<img src="https://example.com/image.png">', false],
      ['<img srcset="https://example.com/image.png 2x">', false],
      ['<link href="https://example.com/style.css" rel="stylesheet">', false],
      ['<style>body{background:url(https://example.com/background.png)}</style>', false],
      ['<a href="javascript:alert(1)">Unsafe</a>', false],
      ['<script src="https://example.com/script.js"></script>', false],
    ];
    for (const [index, [html, expected]] of cases.entries()) {
      const runId = `link-case-${index}`;
      const runDir = join(workspaceDir, "runs", runId);
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      await writeFile(join(runDir, "artifacts/00-gallery.html"), `<html><body>${html}</body></html>`);
      const report = JSON.parse((await tools.get("artifact_lint").execute("lint", { runId, minPngs: 0, requireGallery: true })).content[0].text);
      assert.equal(report.ok, expected, html);
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("all five Agent files match the runtime tool policy", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  for (const persona of ["orchestrator", "researcher", "designer", "reviewer", "builder"]) {
    const source = await readFile(join(repoRoot, ".pi", "agents", `${persona}.md`), "utf8");
    const { frontmatter } = parseFrontmatter(source);
    const tools = dreamaticPersonaTools(persona, frontmatter.allowed_tools);
    assert.equal(tools.includes("use_skill"), ["designer", "builder"].includes(persona));
    assert.equal(tools.includes("list_skills"), ["designer", "builder"].includes(persona));
  }
});

test("specialist completion events enforce identity and durable output contracts", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-stage-contract-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "bus.jsonl"), "");
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } });
    const post = tools.get("design_bus_post");
    assert.ok(post);
    await assert.rejects(() => post.execute("wrong-role", {
      runId: "demo",
      type: "design_spec_ready",
      from_agent: "reviewer",
      to: "orchestrator",
      summary: "Ready",
      artifactRefs: ["runs/demo/plan/design_plan.json"],
    }), /from_agent must be designer/);
    await assert.rejects(() => post.execute("missing-files", {
      runId: "demo",
      type: "design_spec_ready",
      from_agent: "designer",
      to: "orchestrator",
      summary: "Ready",
      artifactRefs: ["runs/demo/plan/design_plan.json"],
    }), /ENOENT/);
    assert.equal(await readFile(join(runDir, "bus.jsonl"), "utf8"), "");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("review contract admits scoped creative hypotheses while retaining factual-risk blockers", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-review-calibration-"));
  try {
    const runId = "review-calibration";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(join(runDir, "review"), { recursive: true });
    await writeFile(join(runDir, "review/design-review.md"), "Concept review: speculative architecture, not validated life-support hardware.");
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "reviewer", agent: "reviewer", runId } });
    const review = { review_stage: "design_context", verdict: "pass", round: 1, summary: "Coherent speculative concept", scores: { concept_coherence: 4, requirement_fit: 4 }, issues: [], resolved_issue_ids: [], remaining_risks: ["Engineering feasibility requires future tests"], claim_review: [{ type: "design_hypothesis", statement: "A proposed folding lunar habitat", evidence_required: false, basis: "Explicitly non-operational concept" }] };
    await tools.get("write_json").execute("write-review", { runId, path: "review/design-review.json", data: review });
    await tools.get("design_bus_post").execute("pass", { runId, type: "design_review_pass", from_agent: "reviewer", to: "orchestrator", summary: review.summary, artifactRefs: ["review/design-review.json", "review/design-review.md"] });
    assert.equal(JSON.parse(await readFile(join(runDir, "design-context.json"), "utf8")).status, "approved");
    assert.deepEqual(JSON.parse(await readFile(join(runDir, "review/design-review.json"), "utf8")).claim_review, review.claim_review);
    const blocked = { ...review, issues: [{ id: "unsafe-claim", severity: "blocking", status: "open", evidence: "Unverified claim of certified operational safety" }] };
    await tools.get("write_json").execute("blocking-review", { runId, path: "review/design-review.json", data: blocked });
    await assert.rejects(() => tools.get("design_bus_post").execute("invalid-pass", { runId, type: "design_review_pass", from_agent: "reviewer", to: "orchestrator", summary: "Cannot approve the operational claim", artifactRefs: ["review/design-review.json"] }), /open blocking issue/);
    await tools.get("write_json").execute("fail-review", { runId, path: "review/design-review.json", data: { ...blocked, verdict: "fail" } });
    await tools.get("design_bus_post").execute("fail", { runId, type: "design_review_fail", from_agent: "reviewer", to: "orchestrator", summary: "Correct the unsupported safety claim without prohibiting the concept", artifactRefs: ["review/design-review.json", "review/design-review.md"] });
    assert.equal(JSON.parse(await readFile(join(runDir, "design-context.json"), "utf8")).status, "needs_revision");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Run JSON writes are rejected before invalid content overwrites existing files", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-json-write-guard-"));
  try {
    const path = join(workspaceDir, "runs", "demo", "plan", "design_plan.json");
    await mkdir(join(workspaceDir, "runs", "demo", "plan"), { recursive: true });
    const valid = JSON.stringify({ runId: "demo", identity: {}, image_generation_plan: [] });
    await writeFile(path, valid);
    for (const options of [{ parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } }]) {
      const { handlers } = await registeredTools(workspaceDir, options);
      const guard = handlers.get("tool_call");
      const rejected = await guard({ type: "tool_call", toolCallId: "invalid-write", toolName: "write", input: { path, content: '{"identity":{"mark":{},"image_generation_plan":[]}' } });
      assert.equal(rejected?.block, true);
      assert.ok(rejected.reason.includes(path));
      assert.match(rejected.reason, /field hierarchy/);
      assert.equal(await readFile(path, "utf8"), valid);
      const accepted = await guard({ type: "tool_call", toolCallId: "valid-write", toolName: "write", input: { path, content: valid } });
      assert.equal(accepted, undefined);
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("design publication identifies the malformed file without committing completion", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-json-publish-error-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    await writeFile(join(runDir, "bus.jsonl"), "");
    await writeFile(join(runDir, "plan", "design_system.json"), JSON.stringify({ runId: "demo", system_thesis: "A system", palette: {}, typography: {} }));
    await writeFile(join(runDir, "plan", "design_plan.json"), '{"identity":{"mark":{},"image_generation_plan":[]}');
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } });
    await assert.rejects(() => tools.get("design_bus_post").execute("publish", {
      runId: "demo", type: "design_spec_ready", from_agent: "designer", to: "orchestrator", summary: "Ready", artifactRefs: ["plan/design_plan.json"],
    }), /Invalid JSON in plan\/design_plan.json/);
    assert.equal(await readFile(join(runDir, "bus.jsonl"), "utf8"), "");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("design completion normalizes common manifest aliases before validation", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-design-normalize-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    await writeFile(join(runDir, "bus.jsonl"), "");
    await writeFile(join(runDir, "plan", "design_system.json"), JSON.stringify({
      run_id: "demo",
      systemThesis: "A coherent system",
      colors: { primary: "#000000" },
      fonts: { body: "sans-serif" },
    }));
    await writeFile(join(runDir, "plan", "design_plan.json"), JSON.stringify({
      run_id: "demo",
      designSystemRef: "plan/design_system.json",
      designIntent: "Communicate the concept",
      imageGenerationPlan: [{
        id: "gallery",
        method: "generate",
        output_file: "artifacts/00-gallery.png",
        prompt: "A coherent gallery image",
        negative_prompt: "No text",
        resolution: "768 × 768 PNG",
        sizeRationale: "Compact supporting image",
      }],
    }));
    await writeFile(join(runDir, "plan", "deliverable_manifest.json"), JSON.stringify({
      run_id: "demo",
      designSystemRef: "plan/design_system.json",
      outputs: [{
        id: "gallery",
        path: "artifacts/00-gallery.html",
        kind: "showcase",
        purpose: "Present the result",
        acceptanceCriteria: "Contains the complete narrative",
        required: true,
        method: "generate",
        size: { width: 768, height: 768 },
      }],
    }));
    await writeFile(join(runDir, "plan", "acceptance_criteria.md"), "# Acceptance\n");
    await writeFile(join(runDir, "plan", "task_breakdown.md"), "# Tasks\n");
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-1", agent: "designer", runId: "demo" } });
    const post = tools.get("design_bus_post");
    await post.execute("design-ready", {
      runId: "demo",
      type: "design_spec_ready",
      from_agent: "designer",
      to: "orchestrator",
      summary: "Design ready",
      artifactRefs: ["runs/demo/plan/deliverable_manifest.json"],
    });
    const manifest = JSON.parse(await readFile(join(runDir, "plan", "deliverable_manifest.json"), "utf8"));
    const [event] = (await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(manifest.runId, "demo");
    assert.equal(manifest.deliverables[0].file, "artifacts/00-gallery.html");
    assert.equal(manifest.deliverables[0].acceptance_test, "Contains the complete narrative");
    assert.equal(manifest.deliverables[0].size, "768x768");
    assert.equal(typeof event.commitReceipt.files["plan/design_plan.json"], "string");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("Designer may define more visual deliverables than the former profile caps", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-design-coverage-"));
  try {
    const runId = "coverage-test";
    const runDir = join(workspaceDir, "runs", runId);
    const imagePlans = Array.from({ length: 25 }, (_, index) => ({
      id: `view-${index + 1}`,
      method: "image_generate",
      output_file: `artifacts/generated-images/view-${index + 1}.png`,
      prompt_seed: `Distinct design view ${index + 1}`,
      negative_prompt_seed: "No text",
      size: "512x512",
      size_rationale: "Focused supporting view",
    }));
    await mkdir(join(runDir, "plan"), { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ runId, workflowProfile: "compact" }));
    await writeFile(join(runDir, "bus.jsonl"), "");
    await writeFile(join(runDir, "plan", "design_system.json"), JSON.stringify({
      runId,
      system_thesis: "A coherent multi-view design system",
      palette: { primary: "#111111" },
      typography: { body: "sans-serif" },
    }));
    await writeFile(join(runDir, "plan", "design_plan.json"), JSON.stringify({
      runId,
      design_system_ref: "plan/design_system.json",
      design_intent: "Communicate all relevant dimensions without a fixed image count",
      image_generation_plan: imagePlans,
    }));
    await writeFile(join(runDir, "plan", "deliverable_manifest.json"), JSON.stringify({
      runId,
      design_system_ref: "plan/design_system.json",
      deliverables: imagePlans.map((plan) => ({
        id: plan.id,
        file: plan.output_file,
        kind: "design-view",
        purpose: `Communicate ${plan.id}`,
        acceptance_test: `${plan.id} is present and distinct`,
        required: true,
        method: plan.method,
        size: plan.size,
      })),
    }));
    await writeFile(join(runDir, "plan", "acceptance_criteria.md"), "# Acceptance\n");
    await writeFile(join(runDir, "plan", "task_breakdown.md"), "# Tasks\n");
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "designer-coverage", agent: "designer", runId } });
    await tools.get("design_bus_post").execute("design-ready", {
      runId,
      type: "design_spec_ready",
      from_agent: "designer",
      to: "orchestrator",
      summary: "Comprehensive 25-view Design Spec ready",
      artifactRefs: ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"],
    });
    const events = (await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.at(-1).type, "design_spec_ready");
    assert.equal(JSON.parse(await readFile(join(runDir, "plan/deliverable_manifest.json"), "utf8")).deliverables.length, 25);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research_fetch returns an actionable soft failure for inaccessible sources", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-fetch-soft-failure-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "fetch-soft-failure-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
    const { tools } = await registeredTools(workspaceDir);
    const result = await tools.get("research_fetch").execute("fetch", {
      runId,
      id: "blocked-source",
      url: "[Blocked](https://example.com/blocked)",
      cacheText: true,
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /HTTP 403/);
    assert.match(payload.instruction, /Do not retry/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research completion generates compatibility acquisition status", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-research-contract-"));
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(join(runDir, "research", "assets"), { recursive: true });
    await writeFile(join(runDir, "bus.jsonl"), "");
    await writeFile(join(runDir, "research", "evidence.json"), JSON.stringify({
      runId: "demo",
      target: "demo",
      summary: "Targeted evidence",
      official_sources: [],
      existing_brand_assets: [],
      do_not_duplicate: [],
      safe_design_directions: [],
      competitor_or_peer_references: [],
      open_questions: [],
    }));
    await writeFile(join(runDir, "research", "research.md"), "# Research\n");
    await writeFile(join(runDir, "research", "brand_lock.md"), "# Brand lock\n");
    await writeFile(join(runDir, "research", "assets", "manifest.json"), JSON.stringify({ runId: "demo", assets: [] }));
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "researcher-1", agent: "researcher", runId: "demo" } });
    const post = tools.get("design_bus_post");
    await post.execute("research-done", {
      runId: "demo",
      type: "research_done",
      from_agent: "researcher",
      to: "orchestrator",
      summary: "Research complete",
      artifactRefs: [
        "runs/demo/research/evidence.json",
        "runs/demo/research/research.md",
        "runs/demo/research/brand_lock.md",
        "runs/demo/research/assets/manifest.json",
        "runs/demo/research/assets/validation.json",
      ],
    });
    const status = JSON.parse(await readFile(join(runDir, "research", "assets", "validation.json"), "utf8"));
    assert.equal(await readFile(join(runDir, "research/research-findings.md"), "utf8"), "# Research\n");
    const committed = JSON.parse((await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split("\n").at(-1));
    assert.ok(committed.artifactRefs.includes("runs/demo/research/research-findings.md"));
    assert.equal(typeof committed.commitReceipt.files["research/research-findings.md"], "string");
    assert.equal(status.ready, true);
    assert.equal(status.mode, "acquisition_status");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("context keeps only the newest generated visual observation", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-context-"));
  try {
    const { handlers } = await registeredTools(workspaceDir);
    const context = handlers.get("context");
    assert.ok(context);
    const image = { type: "image", data: PNG_1X1.toString("base64"), mimeType: "image/png" };
    const oldResult = { role: "toolResult", toolCallId: "1", toolName: "image_generate", content: [{ type: "text", text: '{"path":"old.png"}' }, image], isError: false, timestamp: 1 };
    const newResult = { role: "toolResult", toolCallId: "2", toolName: "image_edit", content: [{ type: "text", text: '{"path":"new.png"}' }, image], isError: false, timestamp: 2 };
    const result = await context({ type: "context", messages: [oldResult, newResult] });
    assert.equal(result.messages[0].content.filter((block) => block.type === "image").length, 0);
    assert.equal(result.messages[1].content.filter((block) => block.type === "image").length, 1);
    assert.match(result.messages[0].content.at(-1).text, /omitted from active context/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("context keeps every visual result from the current tool batch", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-current-visual-batch-"));
  try {
    const { handlers } = await registeredTools(workspaceDir);
    const context = handlers.get("context");
    assert.ok(context);
    const image = { type: "image", data: PNG_1X1.toString("base64"), mimeType: "image/png" };
    const toolCall = { role: "assistant", content: [
      { type: "toolCall", id: "1", name: "view_image", arguments: { path: "a.png" } },
      { type: "toolCall", id: "2", name: "view_image", arguments: { path: "b.png" } },
    ], timestamp: 1 };
    const first = { role: "toolResult", toolCallId: "1", toolName: "view_image", content: [{ type: "text", text: "a.png" }, image], isError: false, timestamp: 2 };
    const second = { role: "toolResult", toolCallId: "2", toolName: "view_image", content: [{ type: "text", text: "b.png" }, image], isError: false, timestamp: 3 };
    const result = await context({ type: "context", messages: [toolCall, first, second] });
    assert.equal(result.messages[1].content.filter((block) => block.type === "image").length, 1);
    assert.equal(result.messages[2].content.filter((block) => block.type === "image").length, 1);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image generation uses bounded concurrency within one Builder invocation", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-image-queue-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DREAMATIC_IMAGE_API_KEY;
  const originalConcurrency = process.env.DREAMATIC_IMAGE_CONCURRENCY;
  let active = 0;
  let maxActive = 0;
  try {
    process.env.DREAMATIC_IMAGE_API_KEY = "test-key";
    process.env.DREAMATIC_IMAGE_CONCURRENCY = "2";
    globalThis.fetch = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const { tools } = await registeredTools(workspaceDir);
    const generate = tools.get("image_generate");
    assert.ok(generate);
    await Promise.all(["a", "b", "c"].map((id) => generate.execute(`generate-${id}`, {
      runId: "demo",
      id,
      intent: `Generate ${id}`,
      prompt: `A simple ${id}`,
      acceptanceCriteria: ["Exists"],
    })));
    assert.equal(maxActive, 2);
    const finished = (await readFile(join(workspaceDir, "runs", "demo", "bus.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((event) => event.type === "operation_finished");
    assert.equal(finished.length, 3);
    assert.ok(finished.every((event) => event.status === "completed"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    if (originalConcurrency === undefined) delete process.env.DREAMATIC_IMAGE_CONCURRENCY;
    else process.env.DREAMATIC_IMAGE_CONCURRENCY = originalConcurrency;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image response body failures consume the shared retry budget across tool calls", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-image-body-failure-"));
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(["DREAMATIC_IMAGE_API_KEY", "DREAMATIC_IMAGE_RETRY_ATTEMPTS", "DREAMATIC_OPERATION_ATTEMPT_BUDGET"].map((key) => [key, process.env[key]]));
  let requests = 0;
  try {
    await mkdir(join(workspaceDir, "runs", "body-failure-test"), { recursive: true });
    process.env.DREAMATIC_IMAGE_API_KEY = "test-key";
    process.env.DREAMATIC_IMAGE_RETRY_ATTEMPTS = "2";
    process.env.DREAMATIC_OPERATION_ATTEMPT_BUDGET = "2";
    globalThis.fetch = async () => {
      requests += 1;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("Response body timed out")); } }), { headers: { "content-type": "application/json" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const params = { runId: "body-failure-test", id: "hero", intent: "A hero image", prompt: "A product", acceptanceCriteria: ["Image exists"] };
    await assert.rejects(() => tools.get("image_generate").execute("first", params), /timed out/);
    assert.equal(requests, 2);
    await assert.rejects(() => tools.get("image_generate").execute("second", params), /retry budget exhausted/);
    assert.equal(requests, 2);
    const events = (await readFile(join(workspaceDir, "runs", "body-failure-test", "bus.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "operation_finished" && event.status === "error").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("reference events collect all nested image paths without truncation or duplicates", () => {
  const first = "runs/demo/research/assets/first.jpg";
  const second = "runs/demo/research/assets/second.png";
  const result = { content: [{ type: "text", text: JSON.stringify({ padding: "x".repeat(15000), results: [{ savedLeadImage: { file: first, sidecar: `${first}.json` } }, { savedReferenceImages: [{ file: second }, { file: first }] }] }) }] };
  assert.deepEqual(workflowReferencePaths(result, "demo"), [first, second]);
  assert.deepEqual(workflowReferencePaths(result, "other"), []);
});

test("research_fetch_batch saves relevant candidates without downloading page utilities", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-multiple-references-"));
  const originalFetch = globalThis.fetch;
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "full" }));
    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.equal(/\/(?:wx|logo|print|unrelated)\.(?:jpg|png)$/.test(url), false);
      if (url.endsWith(".png")) return new Response(url.endsWith("material.png") ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") : PNG_1X1, { headers: { "content-type": "image/png" } });
      return new Response('<html><title>Place</title><body>Context references<img src="/wx.jpg"><img src="/logo.png"><img src="/print.png"><img src="/unrelated.png" alt="Unrelated event"><img src="/street.png" alt="Street context"><img src="/material.png" alt="Material detail"></body></html>', { headers: { "content-type": "text/html" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const result = JSON.parse((await tools.get("research_fetch_batch").execute("refs", { runId: "demo", sources: [{ id: "place", url: "https://example.test/place", saveLeadImageAs: "place-ref", referenceImageCount: 2, referenceFocusTerms: ["street", "material"] }] })).content[0].text);
    assert.equal(result.results[0].savedReferenceImages.length, 2);
    assert.equal(result.results[0].savedLeadImage.path, result.results[0].savedReferenceImages[0].path);
    const manifest = JSON.parse(await readFile(join(runDir, "research/assets/manifest.json"), "utf8"));
    assert.equal(manifest.assets.length, 2);
    assert.equal(manifest.assets.find((asset) => asset.id === "place-ref").description, "Street context");
    assert.equal(manifest.assets[0].visual_review_status, "unreviewed");
    assert.equal(result.results[0].excludedImageCandidates.length, 4);
    assert.ok(result.results[0].excludedImageCandidates.some((candidate) => candidate.reason === "task_relevance_not_established"));
    assert.equal(workflowReferencePaths(result, "demo").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("reference batches exclude described logos and icons before download even with a protected asset label", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-reference-metadata-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "full" }));
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith(".png")) {
        assert.equal(url, "https://example.test/structure.png");
        return new Response(PNG_1X1, { headers: { "content-type": "image/png" } });
      }
      return new Response('<title>Research paper</title><img src="/brandLogo2.png"><img src="/opaque.png" data-description="Navigation icon"><img src="/structure.png" data-description="Structure cross-section">', { headers: { "content-type": "text/html" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const result = JSON.parse((await tools.get("research_fetch_batch").execute("refs", {
      runId: "demo", sources: [{ url: "https://example.test/paper", saveLeadImageAs: "reference", referenceImageCount: 3, referenceFocusTerms: ["structure"], assetKind: "protected_reference" }],
    })).content[0].text);
    assert.equal(result.results[0].excludedImageCandidates.length, 2);
    assert.equal(requests.filter((url) => url.endsWith(".png")).length, 1);
    const manifest = JSON.parse(await readFile(join(runDir, "research/assets/manifest.json"), "utf8"));
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0].description, "Structure cross-section");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research_fetch_batch reports screened gaps and supports explicit identity research", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-reference-screening-"));
  const originalFetch = globalThis.fetch;
  const downloads = [];
  try {
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "full" }));
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(".png")) {
        downloads.push(url);
        return new Response(PNG_1X1, { headers: { "content-type": "image/png" } });
      }
      return new Response('<html><title>Identity</title><body>Identity context<img src="/print.png"><img src="/logo.png"></body></html>');
    };
    const { tools } = await registeredTools(workspaceDir);
    const result = JSON.parse((await tools.get("research_fetch_batch").execute("refs", { runId: "demo", sources: [
      { url: "https://example.test/place", saveLeadImageAs: "scene" },
      { url: "https://example.test/identity", saveLeadImageAs: "mark", includeIdentityAssets: true, assetAllowedForEdit: false },
    ] })).content[0].text);
    assert.match(result.results[0].leadImageError, /No reference candidates/);
    assert.equal(result.results[0].savedReferenceImages, undefined);
    assert.deepEqual(downloads, ["https://example.test/logo.png"]);
    assert.equal(result.results[1].savedLeadImage.asset.allowed_for_edit, false);
    assert.equal(result.results[1].savedLeadImage.asset.visual_review_status, "unreviewed");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research_fetch_batch isolates inaccessible sources and does not refetch them for images", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-fetch-batch-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    const runId = "fetch-batch-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return String(input).includes("blocked")
      ? new Response("Forbidden", { status: 403 })
      : new Response("<html><title>Available</title><body>Useful evidence</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const batch = tools.get("research_fetch_batch");
    const result = await batch.execute("fetch", {
      runId,
      sources: [
        { id: "available", url: "[Available](https://example.com/available)", cacheText: true },
        { id: "blocked", url: "https://example.com/blocked", cacheText: true, saveLeadImageAs: "blocked-reference" },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.partial, true);
    assert.equal(payload.succeeded, 1);
    assert.equal(payload.failed, 1);
    assert.equal(payload.results[0].ok, true);
    assert.equal(payload.results[1].ok, false);
    assert.match(payload.results[1].error, /403/);
    assert.match(payload.results[1].leadImageError, /discovery skipped/);
    assert.equal(requests.filter((url) => url.includes("blocked")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research_fetch_batch bounds model excerpts while caching the full sources", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-research-context-budget-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "context-budget-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "full" }));
    const sourceText = "Useful source evidence. ".repeat(2000) + "Important ending.";
    globalThis.fetch = async () => new Response(sourceText, { headers: { "content-type": "text/plain" } });
    const { tools } = await registeredTools(workspaceDir);
    const result = await tools.get("research_fetch_batch").execute("sources", {
      runId,
      sources: Array.from({ length: 8 }, (_, index) => ({ id: `source-${index}`, url: `https://example.com/source-${index}` })),
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.succeeded, 8);
    assert.ok(payload.results.reduce((total, source) => total + source.text.length, 0) <= 12_000);
    for (const source of payload.results) {
      assert.equal(source.truncated, true);
      assert.equal(source.textChars, sourceText.length);
      assert.ok((await readFile(join(workspaceDir, source.cachedPath), "utf8")).includes(sourceText));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research gaps support changed-keyword search and focused figure acquisition without repeating the failed topic", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-research-refinement-"));
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.DREAMATIC_SEARCH_PROVIDER;
  const originalKey = process.env.DREAMATIC_SEARCH_API_KEY;
  const queries = [];
  const requests = [];
  try {
    const runId = "refinement-test";
    await mkdir(join(workspaceDir, "runs", runId), { recursive: true });
    await writeFile(join(workspaceDir, "runs", runId, "brief.json"), JSON.stringify({ workflowProfile: "full" }));
    process.env.DREAMATIC_SEARCH_PROVIDER = "serper";
    process.env.DREAMATIC_SEARCH_API_KEY = "test-key";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("google.serper.dev")) {
        const query = JSON.parse(init.body).q;
        queries.push(query);
        return new Response(JSON.stringify({ organic: [{ title: query === "dynamic shell" ? "Vehicle exterior" : "Programmable cellular actuation", link: query === "dynamic shell" ? "https://example.test/wrong" : "https://example.test/paper", snippet: "Research lead" }] }));
      }
      if (url.endsWith("/diagram.png")) return new Response(PNG_1X1, { headers: { "content-type": "image/png" } });
      if (url.endsWith("/wrong")) return new Response('<main><article>Vehicles<img src="/car.png" alt="Vehicle exterior"></article></main>', { headers: { "content-type": "text/html" } });
      if (url.endsWith("/paper")) return new Response(`<nav><img src="/car.png" alt="Actuator navigation"></nav><main><article>${"Background. ".repeat(1000)}<p>Programmable cellular actuation changes topology under pressure.</p><figure><img src="/diagram.png"><figcaption>Cellular actuator mechanism and deformation states.</figcaption></figure></article></main>`, { headers: { "content-type": "text/html" } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const { tools } = await registeredTools(workspaceDir);
    await tools.get("websearch_batch").execute("discovery", { runId, queries: ["dynamic shell"] });
    const initial = JSON.parse((await tools.get("research_fetch_batch").execute("initial", { runId, sources: [{ url: "https://example.test/wrong", researchTerms: ["actuator"], referenceFocusTerms: ["actuator"], saveLeadImageAs: "wrong", referenceImageCount: 3 }] })).content[0].text);
    assert.ok(initial.researchGaps.some((gap) => gap.kind === "core_terms_not_located"));
    assert.ok(initial.researchGaps.some((gap) => gap.kind === "usable_images_missing"));
    assert.match(initial.nextAction, /changed-keyword/);
    await tools.get("websearch_batch").execute("refine", { runId, queries: ["programmable cellular actuator"] });
    const refined = JSON.parse((await tools.get("research_fetch_batch").execute("refined", { runId, sources: [{ url: "https://example.test/paper", researchTerms: ["cellular", "topology"], referenceFocusTerms: ["cellular", "actuator"], saveLeadImageAs: "mechanism", referenceImageCount: 3, assetDescription: "This source discusses actuation research." }] })).content[0].text);
    assert.match(refined.results[0].text, /changes topology under pressure/);
    assert.equal(refined.results[0].extractionMethod, "topic_passages");
    assert.equal(refined.results[0].savedReferenceImages.length, 1);
    assert.equal(refined.researchGaps.length, 0);
    assert.deepEqual(queries, ["dynamic shell", "programmable cellular actuator"]);
    assert.equal(requests.filter((url) => url === "https://example.test/paper").length, 1);
    assert.equal(requests.filter((url) => url.endsWith("/car.png")).length, 0);
    const manifest = JSON.parse(await readFile(join(workspaceDir, "runs", runId, "research/assets/manifest.json"), "utf8"));
    assert.equal(manifest.assets.length, 1);
    assert.match(manifest.assets[0].description, /mechanism and deformation/);
    assert.doesNotMatch(manifest.assets[0].description, /This source discusses/);
    assert.equal(manifest.assets[0].source_context, "This source discusses actuation research.");
    assert.equal(manifest.assets[0].relevance_basis, "image_metadata");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.DREAMATIC_SEARCH_PROVIDER;
    else process.env.DREAMATIC_SEARCH_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.DREAMATIC_SEARCH_API_KEY;
    else process.env.DREAMATIC_SEARCH_API_KEY = originalKey;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("websearch_batch preserves successful queries when another query fails", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-search-batch-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "search-batch-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => String(input).includes("blocked")
      ? new Response("Forbidden", { status: 403 })
      : new Response(`<div class="result results_links_deep"><a class="result__a" href="https://example.com/reference">Reference</a><a class="result__snippet">Useful</a></div>`, { status: 200, headers: { "content-type": "text/html" } });
    const { tools } = await registeredTools(workspaceDir);
    const result = await tools.get("websearch_batch").execute("search", { runId, queries: ["available", "blocked"] });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.partial, true);
    assert.equal(payload.succeeded, 1);
    assert.equal(payload.failed, 1);
    assert.equal(payload.results[1].query, "blocked");
    assert.deepEqual(payload.budget, { profile: "compact", field: "searchQueries", used: 2, limit: 3, remaining: 1 });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("category diagnostics distinguish direct product leads from definitions and generic keyboards", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-category-leads-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "category-leads-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    const leads = [
      { title: "Vibe Coding 小键盘怎么选", url: "https://example.com/product", snippet: "Voice and approve controls" },
      { title: "What is vibe coding?", url: "https://example.com/definition", snippet: "AI-assisted programming" },
      { title: "Mechanical keyboard structure", url: "https://example.com/vibe-coding-keyboard", snippet: "PCB and plate" },
    ];
    globalThis.fetch = async () => new Response(leads.map((lead) => `<div class="result results_links_deep"><a class="result__a" href="${lead.url}">${lead.title}</a><a class="result__snippet">${lead.snippet}</a></div>`).join(""));
    const { tools } = await registeredTools(workspaceDir);
    const params = { runId, queries: ["vibe coding 键盘"], topicGroups: [["vibe coding", "vibecoding"], ["keyboard", "keypad", "键盘"]] };
    const first = JSON.parse((await tools.get("websearch_batch").execute("leads", params)).content[0].text);
    assert.deepEqual(first.results[0].categoryLeads.matchedResultIndices, [0]);
    assert.equal(first.results[0].results.length, 3);
    assert.match(first.results[0].categoryLeads.nextAction, /before replacing them with generic/);
    const missing = JSON.parse((await tools.get("websearch_batch").execute("gap", { ...params, queries: ["absent subject keyboard"], topicGroups: [["absent subject"], ["keyboard"]] })).content[0].text);
    assert.equal(missing.results[0].categoryLeads.count, 0);
    assert.match(missing.results[0].categoryLeads.nextAction, /Simplify the combined-category query/);
    const legacy = JSON.parse((await tools.get("websearch_batch").execute("legacy", { runId, queries: ["background"] })).content[0].text);
    assert.equal(legacy.results[0].categoryLeads, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("mixed research queries use their own subject groups instead of a host-product filter", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-query-topics-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "query-topics-test";
    await mkdir(join(workspaceDir, "runs", runId), { recursive: true });
    await writeFile(join(workspaceDir, "runs", runId, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => {
      const query = new URL(input).searchParams.get("q");
      const title = query.includes("muscle") ? "Artificial muscle lattice actuator" : "WALK-MAN disaster response robot";
      return new Response(`<div class="result results_links_deep"><a class="result__a" href="https://example.com/paper">${title}</a><a class="result__snippet">Research details</a></div>`);
    };
    const { tools } = await registeredTools(workspaceDir);
    const result = JSON.parse((await tools.get("websearch_batch").execute("search", {
      runId, queries: ["muscle lattice actuators", "WALK-MAN rescue robot"], topicGroups: [["WALK-MAN"], ["robot"]],
      queryTopics: [{ query: "muscle lattice actuators", topicGroups: [["muscle", "actuator"], ["lattice", "cellular"]] }],
    })).content[0].text);
    assert.equal(result.results[0].categoryLeads.count, 1);
    assert.deepEqual(result.results[0].categoryLeads.topicGroups, [["muscle", "actuator"], ["lattice", "cellular"]]);
    assert.equal(result.results[1].categoryLeads.count, 1);
    assert.equal(result.budget.remaining, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research batch treats access verification as a failed source and skips its image fetch", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-batch-challenge-"));
  const originalFetch = globalThis.fetch;
  let blockedRequests = 0;
  try {
    const runId = "batch-challenge-test";
    await mkdir(join(workspaceDir, "runs", runId), { recursive: true });
    await writeFile(join(workspaceDir, "runs", runId, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => {
      if (String(input).includes("blocked")) {
        blockedRequests += 1;
        return new Response('<html><title>Checking your browser - reCAPTCHA</title><body>Checking your browser before accessing the paper</body></html>', { headers: { "content-type": "text/html" } });
      }
      return new Response('<html><title>Muscle structure</title><body>Readable structural evidence</body></html>', { headers: { "content-type": "text/html" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const payload = JSON.parse((await tools.get("research_fetch_batch").execute("fetch", { runId, sources: [
      { id: "blocked", url: "https://example.com/blocked", saveLeadImageAs: "unavailable" },
      { id: "readable", url: "https://example.com/readable" },
    ] })).content[0].text);
    assert.equal(payload.partial, true);
    assert.equal(payload.failed, 1);
    assert.equal(payload.results[0].ok, false);
    assert.match(payload.results[0].error, /access-verification page/);
    assert.equal(payload.results[1].ok, true);
    assert.equal(blockedRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("clarification preserves task-specific single, multiple and free-text questions", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-clarification-"));
  try {
    const { tools } = await registeredTools(workspaceDir);
    const questions = [
      {
        id: "priority", header: "核心目标", question: "这款设备最优先改善什么？", multiple: false,
        options: [{ label: "更方便地发起语音指令", description: "优先考虑提示输入的操作体验。" }, { label: "更清楚地审核 AI 操作", description: "优先考虑确认、拒绝和状态反馈。" }],
      },
      {
        id: "scenarios", header: "使用场景", question: "需要支持哪些使用环境？", multiple: true, required: false,
        options: [{ label: "固定桌面", description: "与现有电脑和输入设备配合。" }, { label: "离开桌面的远程操作", description: "考虑移动使用和远程反馈。" }],
      },
      { id: "limits", header: "已有约束", question: "是否有必须遵循的尺寸或平台要求？", required: false, placeholder: "例如使用平台、尺寸；未确定可留空。" },
    ];
    const payload = JSON.parse((await tools.get("ask_user").execute("intake", {
      title: "确认两项关键需求", context: "已理解：为 AI 辅助编程设计输入设备；产品形态尚未确定。", questions,
    })).content[0].text);
    assert.equal(payload.status, "waiting_for_user");
    assert.equal(payload.questions.length, 3);
    assert.deepEqual(payload.questions, questions.map((question) => ({ ...question, required: question.required !== false, custom: true })));
    assert.equal(payload.questions[0].multiple, false);
    assert.equal(payload.questions[1].multiple, true);
    assert.equal(payload.questions[2].options, undefined);
    assert.match(payload.instruction, /End this turn now/);
    const clearIntent = JSON.parse((await tools.get("ask_user").execute("one-gap", { questions: [questions[0]] })).content[0].text);
    assert.equal(clearIntent.questions.length, 1);
    const tool = tools.get("ask_user");
    assert.equal(tool.parameters.properties.questions.maxItems, undefined);
    const expandedQuestions = Array.from({ length: 20 }, (_, index) => ({ ...questions[2], id: `question-${index}` }));
    const expanded = JSON.parse((await tool.execute("expanded", { questions: expandedQuestions })).content[0].text);
    assert.equal(expanded.questions.length, 20);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("category discovery can refine within the remaining compact search budget", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-category-search-"));
  const originalFetch = globalThis.fetch;
  const submittedQueries = [];
  try {
    const runId = "category-search-refinement-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input, init) => {
      submittedQueries.push(init?.body ? JSON.parse(init.body).q : new URL(input).searchParams.get("q"));
      return new Response('<div class="result results_links_deep"><a class="result__a" href="https://example.com/keypad">Vibe coding keypad</a><a class="result__snippet">Voice and accept controls</a></div>');
    };
    const { tools } = await registeredTools(workspaceDir);
    const search = tools.get("websearch_batch");
    const initial = JSON.parse((await search.execute("discovery", { runId, queries: ["vibe coding 键盘"] })).content[0].text);
    assert.equal(initial.budget.remaining, 2);
    const refined = JSON.parse((await search.execute("refinement", { runId, queries: ['"vibe coding" keyboard', "AI coding keypad voice controls"] })).content[0].text);
    assert.equal(refined.budget.used, 3);
    assert.equal(refined.budget.remaining, 0);
    assert.deepEqual(submittedQueries, ["vibe coding 键盘", '"vibe coding" keyboard', "AI coding keypad voice controls"]);
    await assert.rejects(search.execute("exhausted", { runId, queries: ["unnecessary repeat"] }), /searchQueries budget exceeded/);
    assert.equal(submittedQueries.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("reference acquisition has no legacy Run, batch or page quantity ceiling", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-unlimited-references-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "unlimited-reference-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "full", budgets: { referenceAssets: 8 } }));
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(".png")) return new Response(Buffer.concat([PNG_1X1, Buffer.from(url)]), { headers: { "content-type": "image/png" } });
      return new Response(`<html><title>Waterfront</title>${Array.from({ length: 30 }, (_, index) => `<img src="/${url.split("/").at(-1)}-${index}.png" alt="Waterfront reference ${index}">`).join("")}</html>`, { headers: { "content-type": "text/html" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const fetchBatch = tools.get("research_fetch_batch");
    assert.equal(fetchBatch.parameters.properties.sources.items.properties.referenceImageCount.maximum, undefined);
    const result = JSON.parse((await fetchBatch.execute("original-overflow", { runId, sources: [4, 4, 3].map((count, index) => ({ id: `source-${index}`, url: `https://example.test/page-${index}`, saveLeadImageAs: `reference-${index}`, referenceImageCount: count })) })).content[0].text);
    assert.equal(result.ok, true);
    assert.equal(result.results.reduce((total, item) => total + item.savedReferenceImages.length, 0), 11);
    const page = JSON.parse((await fetchBatch.execute("large-page", { runId, sources: [{ id: "large-page", url: "https://example.test/large", saveLeadImageAs: "large", referenceImageCount: 30 }] })).content[0].text);
    assert.equal(page.results[0].savedReferenceImages.length, 30);
    assert.equal(page.results[0].savedReferenceImages.every((image) => image.ok === true), true);
    const assetBatch = tools.get("research_asset_fetch_batch");
    assert.equal(assetBatch.parameters.properties.assets.maxItems, undefined);
    const assets = JSON.parse((await assetBatch.execute("large-asset-batch", { runId, assets: Array.from({ length: 11 }, (_, index) => ({ id: `extra-${index}`, url: `https://example.test/extra-${index}.png` })) })).content[0].text);
    assert.equal(assets.succeeded, 11);
    await tools.get("research_asset_fetch").execute("single-after-batch", { runId, id: "last", url: "https://example.test/last.png" });
    assert.equal(JSON.parse(await readFile(join(runDir, "research/assets/manifest.json"), "utf8")).assets.length, 53);
    const newRun = JSON.parse((await tools.get("run_init").execute("new-run", { brief: "Reference coverage", projectTitle: "Reference test", runIdOverride: "no-reference-budget" })).content[0].text);
    assert.equal(JSON.parse(await readFile(join(newRun.runDir, "brief.json"), "utf8")).budgets.referenceAssets, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research refinement reserves expand once, reject unchanged requests and remain bounded", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-research-reserve-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    const runId = "reserve";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => {
      requests += 1;
      return String(input).includes("blocked") ? new Response("Forbidden", { status: 403 }) : new Response("<article>Primary evidence</article>");
    };
    const { tools } = await registeredTools(workspaceDir);
    const search = tools.get("websearch_batch");
    await search.execute("initial", { runId, queries: ["core", "structure", "applications"] });
    await assert.rejects(search.execute("without-gap", { runId, queries: ["new evidence"] }), /budget exceeded/);
    await assert.rejects(search.execute("duplicate", { runId, queries: [" CORE "], refinementReason: "Core figure was unavailable" }), /already attempted/);
    const refined = JSON.parse((await search.execute("refine", { runId, queries: ["author figures", "translated structure", "supplemental project"], refinementReason: "Core structure figures were unavailable" })).content[0].text);
    assert.equal(refined.budget.baseLimit, 3);
    assert.equal(refined.budget.limit, 6);
    assert.equal(refined.budget.remaining, 0);
    await assert.rejects(search.execute("second-reserve", { runId, queries: ["more figures"], refinementReason: "Another missing figure dimension" }), /budget exceeded/);
    const sources = tools.get("research_fetch_batch");
    const initial = JSON.parse((await sources.execute("sources", { runId, sources: ["blocked", "paper", "context", "review"].map((id) => ({ url: `https://example.test/${id}` })) })).content[0].text);
    assert.equal(initial.failed, 1);
    assert.equal(initial.budget.remaining, 0);
    await assert.rejects(sources.execute("same-blocked", { runId, sources: [{ url: "https://example.test/blocked" }], refinementReason: "Replace the blocked core source" }), /already attempted/);
    const replacement = JSON.parse((await sources.execute("replacement", { runId, sources: [{ url: "https://example.test/author" }], refinementReason: "Replace blocked publication with author repository" })).content[0].text);
    assert.equal(replacement.budget.limit, 8);
    assert.equal(replacement.budget.used, 5);
    assert.equal(requests, 11);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("reference acquisition defaults to discovered coverage and supports cached targeted additions", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-targeted-references-"));
  const originalFetch = globalThis.fetch;
  let pageRequests = 0;
  try {
    const runId = "targeted";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(".png")) return new Response(Buffer.concat([PNG_1X1, Buffer.from(url)]), { headers: { "content-type": "image/png" } });
      pageRequests += 1;
      return new Response(`<article><p>Actuator assembly and materials.</p>
        <figure><img src="/deformation.png"><figcaption>Actuator deformation</figcaption></figure>
        <figure><img src="/cell.png"><figcaption>单元构造</figcaption></figure>
        <figure><img src="/connection.png"><figcaption>PAM connection</figcaption></figure>
        <figure><img src="/exploded.png"><figcaption>Assembly overview</figcaption></figure></article>`);
    };
    const { tools } = await registeredTools(workspaceDir);
    const result = JSON.parse((await tools.get("research_fetch_batch").execute("coverage", { runId, sources: [{ url: "https://example.test/paper", saveLeadImageAs: "reference", referenceFocusTerms: ["actuator"] }] })).content[0].text);
    assert.equal(result.results[0].savedReferenceImages.length, 4);
    const manifest = JSON.parse(await readFile(join(runDir, "research/assets/manifest.json"), "utf8"));
    assert.equal(manifest.assets.filter((asset) => asset.relevance_status === "uncertain").length, 3);
    const discover = tools.get("research_asset_discover");
    const targeted = JSON.parse((await discover.execute("target", { runId, pageUrl: "https://example.test/paper", referenceFocusTerms: ["assembly"] })).content[0].text);
    assert.ok(targeted.candidates.some((candidate) => candidate.url.endsWith("exploded.png") && candidate.relevance_status === "likely"));
    assert.equal(pageRequests, 1);
    await discover.execute("first-page", { runId, pageUrl: "https://example.test/new-page" });
    await discover.execute("reselect", { runId, pageUrl: "https://example.test/new-page", referenceFocusTerms: ["assembly"] });
    assert.equal(pageRequests, 2);
    await tools.get("research_asset_fetch_batch").execute("targeted-download", { runId, assets: [{ id: "additional", url: "https://example.test/additional.png", sourcePageUrl: "https://example.test/paper", description: "Additional assembly reference" }] });
    assert.equal(JSON.parse(await readFile(join(runDir, "research/assets/manifest.json"), "utf8")).assets.length, 5);
    assert.equal(pageRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("concurrent image downloads are bounded and serialize manifest commits and duplicate checks", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-concurrent-references-"));
  const originalFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, url.includes("slow") ? 30 : 10));
      active -= 1;
      return new Response(Buffer.concat([PNG_1X1, Buffer.from(url.includes("duplicate") ? "identical" : url)]), { headers: { "content-type": "image/png" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const assets = [{ id: "slow", url: "https://example.test/slow.png" }, ...Array.from({ length: 5 }, (_, index) => ({ id: `figure-${index}`, url: `https://example.test/figure-${index}.png` })), { id: "duplicate-a", url: "https://example.test/duplicate-a.png" }, { id: "duplicate-b", url: "https://example.test/duplicate-b.png" }];
    const result = JSON.parse((await tools.get("research_asset_fetch_batch").execute("parallel", { runId: "parallel", assets })).content[0].text);
    assert.equal(peak, 3);
    assert.equal(result.succeeded, 7);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.results.map((entry) => entry.asset?.id ?? entry.id), assets.map((asset) => asset.id));
    assert.match(result.results.find((entry) => entry.ok === false).error, /duplicates existing/);
    const manifest = JSON.parse(await readFile(join(workspaceDir, "runs/parallel/research/assets/manifest.json"), "utf8"));
    assert.equal(manifest.assets.length, 7);
    assert.equal(new Set(manifest.assets.map((asset) => asset.sha256)).size, 7);
    for (const asset of manifest.assets) assert.equal(JSON.parse(await readFile(join(workspaceDir, "runs/parallel/research/assets", `${asset.file}.json`), "utf8")).id, asset.id);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research_asset_fetch_batch keeps saved assets when another download fails", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-asset-batch-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "asset-batch-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => String(input).includes("blocked")
      ? new Response("Forbidden", { status: 403 })
      : new Response(PNG_1X1, { status: 200, headers: { "content-type": "image/png" } });
    const { tools } = await registeredTools(workspaceDir);
    const result = await tools.get("research_asset_fetch_batch").execute("assets", {
      runId,
      assets: [
        { id: "available", url: "[Image](https://example.com/available.png)" },
        { id: "blocked", url: "https://example.com/blocked.png" },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.partial, true);
    assert.equal(payload.succeeded, 1);
    assert.equal(payload.failed, 1);
    const manifest = JSON.parse(await readFile(join(runDir, "research", "assets", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.assets.map((asset) => asset.id), ["available"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image_edit_batch parallelizes ready siblings, isolates failures and rejects internal dependencies", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-edit-batch-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DREAMATIC_IMAGE_API_KEY;
  const originalConcurrency = process.env.DREAMATIC_IMAGE_CONCURRENCY;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  try {
    process.env.DREAMATIC_IMAGE_API_KEY = "test-key";
    process.env.DREAMATIC_IMAGE_CONCURRENCY = "2";
    await writeFile(join(workspaceDir, "source.png"), PNG_1X1);
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (init.body.get("prompt") === "fail") return new Response("Rejected", { status: 400 });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString("base64") }] }), { headers: { "Content-Type": "application/json" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const batch = tools.get("image_edit_batch");
    const task = (id) => ({ id, intent: "Adapt approved identity", diagnosis: ["New application"], changes: ["Change context"], preserve: ["Identity"], prompt: id, referenceImagePaths: ["source.png"], acceptanceCriteria: ["Exists"] });
    const progress = [];
    const result = JSON.parse((await batch.execute("siblings", { runId: "demo", tasks: [task("first"), task("fail"), task("last")] }, undefined, (update) => progress.push(update.details))).content[0].text);
    assert.equal(maxActive, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.partial, true);
    assert.equal(result.results[0].path, "runs/demo/artifacts/edits/first.png");
    assert.equal(progress.filter((update) => update.completed).length, 3);
    const events = (await readFile(join(workspaceDir, "runs/demo/bus.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "agent_progress" && event.imageId).length, 3);
    const callsBefore = calls;
    await assert.rejects(() => batch.execute("chain", { runId: "demo", tasks: [task("source"), { ...task("child"), referenceImagePaths: ["runs/demo/artifacts/edits/source.png"] }] }), /later batch/);
    await assert.rejects(() => batch.execute("same-id", { runId: "demo", tasks: [task("same_id"), task("same-id")] }), /unique/);
    await assert.rejects(() => batch.execute("same-output", { runId: "demo", tasks: [{ ...task("one"), outputPath: "artifacts/shared.png" }, { ...task("two"), outputPath: "artifacts/shared.png" }] }), /unique/);
    assert.equal(calls, callsBefore);
    assert.equal(batch.parameters.properties.tasks.maxItems, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    if (originalConcurrency === undefined) delete process.env.DREAMATIC_IMAGE_CONCURRENCY;
    else process.env.DREAMATIC_IMAGE_CONCURRENCY = originalConcurrency;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image_generate_batch builds the anchor first and parallelizes the remainder", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-image-batch-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DREAMATIC_IMAGE_API_KEY;
  const originalConcurrency = process.env.DREAMATIC_IMAGE_CONCURRENCY;
  const started = [];
  let active = 0;
  let maxActive = 0;
  try {
    process.env.DREAMATIC_IMAGE_API_KEY = "test-key";
    process.env.DREAMATIC_IMAGE_CONCURRENCY = "2";
    const runDir = join(workspaceDir, "runs", "demo");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (_url, init) => {
      const prompt = JSON.parse(init.body).prompt;
      started.push(prompt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      if (prompt.includes("fail")) return new Response("Rejected", { status: 400 });
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString("base64") }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const { tools } = await registeredTools(workspaceDir);
    const batch = tools.get("image_generate_batch");
    const progress = [];
    const independent = JSON.parse((await batch.execute("independent", {
      runId: "demo",
      tasks: ["independent-fail", "independent-ok", "independent-other"].map((id) => ({ id, intent: id, prompt: id, acceptanceCriteria: ["Exists"] })),
    }, undefined, (update) => progress.push(update.details))).content[0].text);
    assert.equal(independent.succeeded, 2);
    assert.equal(independent.failed, 1);
    assert.equal(independent.results.some((result) => result.skipped), false);
    assert.equal(progress.filter((update) => update.completed).length, 3);
    assert.equal(maxActive, 2);
    const events = (await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "agent_progress" && event.imageId).length, 3);
    started.length = 0;
    const result = await batch.execute("batch", {
      runId: "demo",
      anchorId: "anchor",
      tasks: ["support-a", "anchor", "support-b"].map((id) => ({ id, intent: id, prompt: id, acceptanceCriteria: ["Exists"] })),
    });
    assert.equal(started[0], "anchor");
    assert.equal(maxActive, 2);
    assert.equal(JSON.parse(result.content[0].text).count, 3);
    const partial = JSON.parse((await batch.execute("partial", {
      runId: "demo",
      anchorId: "anchor-2",
      tasks: ["anchor-2", "support-ok", "support-fail"].map((id) => ({ id, intent: id, prompt: id, acceptanceCriteria: ["Exists"] })),
    })).content[0].text);
    assert.equal(partial.ok, false);
    assert.equal(partial.partial, true);
    assert.equal(partial.succeeded, 2);
    assert.equal(partial.failed, 1);
    const anchorFailure = JSON.parse((await batch.execute("anchor-failure", {
      runId: "demo",
      anchorId: "anchor-fail",
      tasks: ["anchor-fail", "dependent"].map((id) => ({ id, intent: id, prompt: id, acceptanceCriteria: ["Exists"] })),
    })).content[0].text);
    assert.equal(anchorFailure.succeeded, 0);
    assert.equal(anchorFailure.results[1].skipped, true);
    await assert.rejects(() => batch.execute("bad-anchor", {
      runId: "demo",
      anchorId: "missing",
      tasks: [{ id: "anchor", intent: "anchor", prompt: "anchor", acceptanceCriteria: ["Exists"] }],
    }), /Unknown anchorId/);
    process.env.DREAMATIC_IMAGE_CONCURRENCY = "4";
    const fasterTools = (await registeredTools(workspaceDir)).tools;
    maxActive = 0;
    const faster = JSON.parse((await fasterTools.get("image_generate_batch").execute("four-way", {
      runId: "demo",
      tasks: ["parallel-a", "parallel-b", "parallel-c", "parallel-d"].map((id) => ({ id, intent: id, prompt: id, acceptanceCriteria: ["Exists"] })),
    })).content[0].text);
    assert.equal(faster.succeeded, 4);
    assert.equal(maxActive, 4);
    assert.equal(batch.parameters.properties.tasks.maxItems, undefined);
    const extensive = JSON.parse((await batch.execute("extensive", {
      runId: "demo",
      tasks: Array.from({ length: 25 }, (_, index) => ({ id: `coverage-${index}`, intent: `Distinct scenario ${index}`, prompt: `coverage-${index}`, acceptanceCriteria: ["Exists"] })),
    })).content[0].text);
    assert.equal(extensive.count, 25);
    assert.equal(extensive.succeeded, 25);
    await assert.rejects(() => batch.execute("duplicate-ids", {
      runId: "demo",
      tasks: ["duplicate", "duplicate"].map((id) => ({ id, intent: id, prompt: id, acceptanceCriteria: ["Exists"] })),
    }), /unique/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    if (originalConcurrency === undefined) delete process.env.DREAMATIC_IMAGE_CONCURRENCY;
    else process.env.DREAMATIC_IMAGE_CONCURRENCY = originalConcurrency;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image generation, batch generation and editing preserve approved multilingual copy", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-image-copy-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DREAMATIC_IMAGE_API_KEY;
  try {
    process.env.DREAMATIC_IMAGE_API_KEY = "test-key";
    const prompts = [];
    globalThis.fetch = async (_input, init) => {
      prompts.push(init.body instanceof FormData ? init.body.get("prompt") : JSON.parse(init.body).prompt);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString("base64") }] }), { headers: { "content-type": "application/json" } });
    };
    const prompt = 'Create a finished poster. Headline exactly "朱家角·桥影慢游"; subheading exactly "沿水而行，遇见江南"; secondary label "Slow Travel". Render these words in the image, headline above the bridge, with readable contrast and generous spacing.';
    const { tools } = await registeredTools(workspaceDir);
    const task = { intent: "Complete poster with designed copy", prompt, size: "512x512", acceptanceCriteria: ["Approved Chinese headline and English label are part of the poster"] };
    await tools.get("image_generate").execute("single", { runId: "copy-prompt-test", id: "poster", ...task });
    await tools.get("image_generate_batch").execute("batch", { runId: "copy-prompt-test", tasks: [{ id: "poster-adaptation", ...task }] });
    await writeFile(join(workspaceDir, "reference.png"), PNG_1X1);
    await tools.get("image_edit").execute("edit", { runId: "copy-prompt-test", id: "poster-edit", ...task, diagnosis: ["User requested a headline update"], changes: ["Integrate the approved headline"], preserve: ["Bridge scene and composition"], referenceImagePaths: ["reference.png"] });
    assert.deepEqual(prompts, [prompt, prompt, prompt]);
    assert.match(tools.get("image_generate").description, /copy and typography/);
    assert.match(tools.get("image_edit").description, /approved copy/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("image generation enforces the configured size ceiling and returns no audit preview", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-image-size-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DREAMATIC_IMAGE_API_KEY;
  const originalSize = process.env.DREAMATIC_IMAGE_DEFAULT_SIZE;
  try {
    process.env.DREAMATIC_IMAGE_API_KEY = "test-key";
    process.env.DREAMATIC_IMAGE_DEFAULT_SIZE = "1024x1024";
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const { tools } = await registeredTools(workspaceDir);
    const generate = tools.get("image_generate");
    await assert.rejects(() => generate.execute("too-large", {
      runId: "demo",
      id: "hero",
      intent: "Hero",
      prompt: "Hero",
      acceptanceCriteria: ["Exists"],
      size: "1536x1024",
    }), /exceeds DREAMATIC_IMAGE_DEFAULT_SIZE/);
    const result = await generate.execute("within-limit", {
      runId: "demo",
      id: "supporting",
      intent: "Supporting view",
      prompt: "Supporting view",
      acceptanceCriteria: ["Exists"],
      size: "768x768",
    });
    assert.equal(result.content.some((block) => block.type === "image"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    if (originalSize === undefined) delete process.env.DREAMATIC_IMAGE_DEFAULT_SIZE;
    else process.env.DREAMATIC_IMAGE_DEFAULT_SIZE = originalSize;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("context removes an uploaded image after its first model pass", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-upload-context-"));
  try {
    const { handlers } = await registeredTools(workspaceDir);
    const context = handlers.get("context");
    assert.ok(context);
    const image = { type: "image", data: PNG_1X1.toString("base64"), mimeType: "image/png" };
    const user = { role: "user", content: [{ type: "text", text: "Reference: references/demo/ref.png" }, image], timestamp: 1 };
    const firstPass = await context({ type: "context", messages: [user] });
    assert.equal(firstPass.messages[0].content.filter((block) => block.type === "image").length, 1);
    const laterPass = await context({ type: "context", messages: [user, { role: "assistant", content: [{ type: "text", text: "Seen" }], timestamp: 2 }] });
    assert.equal(laterPass.messages[0].content.filter((block) => block.type === "image").length, 0);
    assert.match(laterPass.messages[0].content.at(-1).text, /first visual pass/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("context progressively compacts a long Skill read without changing durable content", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-skill-context-"));
  try {
    const { handlers } = await registeredTools(workspaceDir);
    const context = handlers.get("context");
    assert.ok(context);
    const fullSkill = `---\nname: large-skill\n---\n# Large Skill\n${"contract detail\n".repeat(1800)}## Completion\nKeep this ending.`;
    const toolResult = { role: "toolResult", toolCallId: "skill-1", toolName: "read", content: [{ type: "text", text: fullSkill }], isError: false, timestamp: 1 };
    const result = await context({ type: "context", messages: [toolResult] });
    const activeText = result.messages[0].content[0].text;
    assert.ok(activeText.length < fullSkill.length);
    assert.match(activeText, /progressive Skill loading omitted/);
    assert.match(activeText, /Keep this ending/);
    assert.equal(toolResult.content[0].text, fullSkill);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("prepareDreamaticPrompt persists references and appends reloadable paths", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-upload-store-"));
  try {
    const prepared = await prepareDreamaticPrompt({
      workspaceDir,
      scopeId: "cli-demo",
      text: "Design from this reference",
      images: [{ type: "image", data: PNG_1X1.toString("base64"), mimeType: "image/png", name: "source.png" }],
    });
    assert.equal(prepared.images.length, 1);
    assert.equal(prepared.references.length, 1);
    assert.match(prepared.references[0].path, /^references\/cli-demo\/.+\.png$/);
    assert.match(prepared.text, new RegExp(prepared.references[0].path.replaceAll("/", "\\/")));
    assert.deepEqual(await readFile(join(workspaceDir, prepared.references[0].path)), PNG_1X1);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("todo_write persists a run-scoped operational plan", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-plan-"));
  try {
    const { tools } = await registeredTools(workspaceDir);
    const todoWrite = tools.get("todo_write");
    assert.ok(todoWrite);
    const items = [
      { id: "research", text: "Confirm audience and context", status: "completed" },
      { id: "direction", text: "Choose a visual direction", status: "in_progress" },
    ];
    const result = await todoWrite.execute("test", { runId: "demo", items });
    const progress = JSON.parse(await readFile(join(workspaceDir, "runs", "demo", "plan", "progress.json"), "utf8"));
    const response = JSON.parse(result.content[0].text);
    assert.deepEqual(progress.items, items);
    assert.equal(response.persistedPath, "runs/demo/plan/progress.json");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("dreamaticSessionFailure exposes provider failures to CLI and web", () => {
  assert.equal(dreamaticSessionFailure([
    { role: "assistant", stopReason: "error", errorMessage: "Provider rejected credentials" },
  ]), "Provider rejected credentials");
  assert.equal(dreamaticSessionFailure([
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] },
  ]), undefined);
});

test("withRetry recovers transient failures without retrying permanent failures", async () => {
  let attempts = 0;
  const notices = [];
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("Connection error");
    return "ok";
  }, { attempts: 3, sleep: async () => undefined, onRetry: (notice) => notices.push(notice) });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.equal(notices.length, 2);

  let permanentAttempts = 0;
  await assert.rejects(() => withRetry(async () => {
    permanentAttempts += 1;
    throw new Error("Invalid API key");
  }, { attempts: 3, sleep: async () => undefined }), /Invalid API key/);
  assert.equal(permanentAttempts, 1);
});

test("withRetry respects retryable HTTP failures and Retry-After", async () => {
  const delays = [];
  let attempts = 0;
  await withRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new RetryableHttpError(429, "rate limited", 2_500);
    return true;
  }, { attempts: 2, baseDelayMs: 10, maxDelayMs: 5_000, sleep: async (delay) => { delays.push(delay); } });
  assert.deepEqual(delays, [2_500]);
});

test("approved plan executes by id, reuses verified images and rejects a stale gate", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-plan-execution-"));
  const fetchOriginal = globalThis.fetch;
  const keyOriginal = process.env.DREAMATIC_IMAGE_API_KEY;
  let requests = 0;
  try {
    const runDir = join(workspaceDir, "runs/demo");
    await mkdir(join(runDir, "plan"), { recursive: true });
    await mkdir(join(runDir, "review"), { recursive: true });
    const files = {};
    for (const [path, source] of [["review/design-review.md", "Approved"], ["review/design-review.json", JSON.stringify({ verdict: "pass" })]]) {
      await writeFile(join(runDir, path), source);
      files[path] = (await import('node:crypto')).createHash('sha256').update(source).digest('hex');
    }
    const event = { type: "design_review_pass", from_agent: "reviewer", to: "orchestrator", commitReceipt: { files } };
    await writeFile(join(runDir, "bus.jsonl"), JSON.stringify(event) + '\n');
    await writeFile(join(runDir, "plan/design_plan.json"), JSON.stringify({ image_generation_plan: [{ id: "hero", method: "image_generate", prompt_seed: "Approved concept", negative_prompt_seed: "Watermark", acceptance_test: "Readable", size: "512x512" }] }));
    await writeFile(join(runDir, "plan/deliverable_manifest.json"), JSON.stringify({ deliverables: [{ id: "hero", method: "image_generate", file: "artifacts/hero.png", required: true }] }));
    const designFiles = {};
    for (const path of ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"]) {
      if (!["plan/design_plan.json", "plan/deliverable_manifest.json"].includes(path)) await writeFile(join(runDir, path), path.endsWith('.json') ? '{}' : 'Approved');
      designFiles[path] = (await import('node:crypto')).createHash('sha256').update(await readFile(join(runDir, path))).digest('hex');
    }
    await writeFile(join(runDir, 'bus.jsonl'), [JSON.stringify({ type: 'design_spec_ready', from_agent: 'designer', to: 'orchestrator', commitReceipt: { files: designFiles } }), JSON.stringify(event)].join('\n') + '\n');
    process.env.DREAMATIC_IMAGE_API_KEY = "test";
    globalThis.fetch = async (_url, init) => { requests++; assert.equal(JSON.parse(init.body).prompt, 'Approved concept\n\nAvoid: Watermark'); return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1.toString('base64') }] })); };
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "builder", agent: "builder", runId: "demo" } });
    const execute = () => tools.get('execute_image_plan').execute('execute', { runId: 'demo', ids: ['hero'] });
    assert.equal(JSON.parse((await execute()).content[0].text).succeeded, 1);
    const reused = JSON.parse((await execute()).content[0].text);
    assert.equal(reused.results[0].reused, true);
    assert.equal(requests, 1);
    await writeFile(join(runDir, 'artifacts/hero.png'), 'modified');
    await execute(); assert.equal(requests, 2);
    await tools.get('showcase_template').execute('showcase', { runId: 'demo', title: '<Concept>', sections: [{ title: 'Concept', items: [{ id: 'hero', caption: 'Approved intent' }] }] });
    assert.match(await readFile(join(runDir, 'artifacts/00-gallery.html'), 'utf8'), /&lt;Concept&gt;/);
    await assert.rejects(tools.get('showcase_template').execute('missing', { runId: 'demo', title: 'Concept', sections: [{ title: 'Concept', items: [] }] }), /omits required/);
    await writeFile(join(runDir, 'bus.jsonl'), JSON.stringify({ type: 'design_revision_ready' }) + '\n', { flag: 'a' });
    await assert.rejects(execute(), /approved specification/);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY; else process.env.DREAMATIC_IMAGE_API_KEY = keyOriginal;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("JSON patches preserve unrelated data and reject stale file hashes", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dreamatic-patch-'));
  try {
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: 'designer', agent: 'designer', runId: 'demo' } });
    const saved = JSON.parse((await tools.get('write_json').execute('write', { runId: 'demo', path: 'plan/design_system.json', data: { unchanged: 'keep', nested: { value: 1 } } })).content[0].text);
    const params = { runId: 'demo', path: 'plan/design_system.json', sha256: saved.sha256, updates: [{ pointer: '/nested/value', value: 2 }] };
    await tools.get('patch_json').execute('patch', params);
    const data = JSON.parse(await readFile(join(workspaceDir, 'runs/demo/plan/design_system.json'), 'utf8'));
    assert.equal(data.unchanged, 'keep'); assert.equal(data.nested.value, 2);
    await assert.rejects(tools.get('patch_json').execute('stale', params), /changed since/);
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});

test('research acquisition survives new invocations and cached sources do not consume acquisition twice', async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dreamatic-acquisition-recovery-'));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  try {
    const runDir = join(workspaceDir, 'runs/demo'); await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'brief.json'), JSON.stringify({ workflowProfile: 'compact' }));
    globalThis.fetch = async () => { requests++; return new Response('<article>Cellular actuator material.</article>', { headers: { 'content-type': 'text/html' } }); };
    const params = { runId: 'demo', sources: [{ url: 'https://example.com/paper' }] };
    const first = (await registeredTools(workspaceDir)).tools;
    await first.get('research_fetch_batch').execute('fetch', params);
    const recovered = (await registeredTools(workspaceDir)).tools;
    await recovered.get('research_fetch_batch').execute('cached', params);
    assert.equal(requests, 1);
    const ledger = JSON.parse(await readFile(join(runDir, '.performance/acquisition-budget.json'), 'utf8'));
    assert.equal(ledger.fields.sourceFetches.used, 1);
    assert.deepEqual(ledger.fields.sourceFetches.requests, ['https://example.com/paper']);
  } finally { globalThis.fetch = previousFetch; await rm(workspaceDir, { recursive: true, force: true }); }
});

test('concurrent patches with the same version cannot both overwrite a JSON file', async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dreamatic-patch-race-'));
  try {
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: 'designer', agent: 'designer', runId: 'demo' } });
    const saved = JSON.parse((await tools.get('write_json').execute('write', { runId: 'demo', path: 'plan/design_system.json', data: { nested: { value: 0 } } })).content[0].text);
    const attempts = await Promise.allSettled([1, 2].map((value) => tools.get('patch_json').execute(`patch-${value}`, { runId: 'demo', path: 'plan/design_system.json', sha256: saved.sha256, updates: [{ pointer: '/nested/value', value }] })));
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});
