import assert from "node:assert/strict";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDreamaticExtension, dreamaticPersonaTools, specialistCompletionEvent } from "../dist/extension.js";
import { prepareDreamaticPrompt } from "../dist/prompt.js";
import { dreamaticSessionFailure } from "../dist/runtime.js";
import { RetryableHttpError, withRetry } from "../dist/retry.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("discoverable Skills are optional Designer knowledge modules with matching names", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const skillsRoot = join(repoRoot, ".pi", "skills");
  const expected = [
    "architecture-space",
    "brand-identity",
    "design-system",
    "image-prompting",
    "poster-advertising",
    "product-design",
    "visual-composition",
  ];
  const discovered = [];

  for (const folder of await readdir(skillsRoot)) {
    const source = await readFile(join(skillsRoot, folder, "SKILL.md"), "utf8").catch(() => undefined);
    if (!source) continue;
    const { frontmatter } = parseFrontmatter(source);
    assert.equal(frontmatter.name, folder);
    assert.equal(frontmatter.metadata?.audience, "designer");
    assert.ok(String(frontmatter.description ?? "").trim());
    discovered.push(folder);
  }

  assert.deepEqual(discovered.sort(), expected);
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
    await exportPackage.execute("test", { runId: "demo", runDir });
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
  const researcher = dreamaticPersonaTools("researcher", ["read", "write", "design_bus_post", "design_bus_read", "design_context_read", "websearch_batch", "research_fetch_batch"]);
  const designer = dreamaticPersonaTools("designer", ["read", "write", "ls", "list_skills", "use_skill", "design_bus_post", "design_bus_read", "design_context_read", "view_image"]);
  const reviewer = dreamaticPersonaTools("reviewer", ["read", "write", "ls", "design_bus_post", "design_bus_read", "design_context_read"]);
  const builder = dreamaticPersonaTools("builder", ["read", "write", "edit", "ls", "design_bus_read", "design_context_read", "image_generate", "image_generate_batch", "image_edit", "build_finalize"]);
  assert.equal(researcher.includes("view_image"), false);
  assert.equal(researcher.includes("research_asset_validate"), false);
  assert.equal(researcher.includes("bash"), false);
  assert.equal(designer.includes("image_generate"), false);
  assert.equal(designer.includes("view_image"), true);
  assert.equal(designer.includes("use_skill"), true);
  assert.equal(reviewer.includes("view_image"), false);
  assert.equal(builder.includes("image_generate"), true);
  assert.equal(builder.includes("image_generate_batch"), true);
  assert.equal(builder.includes("image_edit"), true);
  assert.equal(builder.includes("view_image"), false);
  assert.equal(builder.includes("design_bus_post"), false);
  assert.equal(builder.includes("artifact_lint"), false);
  assert.throws(
    () => dreamaticPersonaTools("designer", [...designer, "image_generate"]),
    /disallowed: image_generate/,
  );
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
    await writeFile(join(runDir, "bus.jsonl"), "");
    await writeFile(join(runDir, "plan", "design_plan.json"), JSON.stringify({
      runId,
      image_generation_plan: [{
        id: "hero",
        method: "image_generate",
        output_file: "artifacts/generated-images/hero.png",
        size: "1024x768",
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
    const { tools } = await registeredTools(workspaceDir, { parentInvocation: { id: "builder-1", agent: "builder", runId } });
    const result = await tools.get("build_finalize").execute("finalize", { runId });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.event.type, "build_done");
    assert.equal(JSON.parse(await readFile(join(runDir, "artifacts", "lint-report.json"), "utf8")).ok, true);
    assert.match(await readFile(join(runDir, "artifacts", "00-gallery.html"), "utf8"), /generated-images\/hero\.png/);
    const events = (await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.at(-1).type, "build_done");
    assert.equal(typeof events.at(-1).commitReceipt.files["artifacts/artifact-manifest.json"], "string");
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
    assert.equal(tools.includes("use_skill"), persona === "designer");
    assert.equal(tools.includes("list_skills"), persona === "designer");
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
    const imagePlans = Array.from({ length: 9 }, (_, index) => ({
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
      summary: "Comprehensive nine-view Design Spec ready",
      artifactRefs: ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"],
    });
    const events = (await readFile(join(runDir, "bus.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.at(-1).type, "design_spec_ready");
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
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    if (originalConcurrency === undefined) delete process.env.DREAMATIC_IMAGE_CONCURRENCY;
    else process.env.DREAMATIC_IMAGE_CONCURRENCY = originalConcurrency;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("research_fetch_batch isolates inaccessible sources instead of failing the batch", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-fetch-batch-"));
  const originalFetch = globalThis.fetch;
  try {
    const runId = "fetch-batch-test";
    const runDir = join(workspaceDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "brief.json"), JSON.stringify({ workflowProfile: "compact" }));
    globalThis.fetch = async (input) => String(input).includes("blocked")
      ? new Response("Forbidden", { status: 403 })
      : new Response("<html><title>Available</title><body>Useful evidence</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const { tools } = await registeredTools(workspaceDir);
    const batch = tools.get("research_fetch_batch");
    const result = await batch.execute("fetch", {
      runId,
      sources: [
        { id: "available", url: "[Available](https://example.com/available)", cacheText: true },
        { id: "blocked", url: "https://example.com/blocked", cacheText: true },
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
  } finally {
    globalThis.fetch = originalFetch;
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
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY;
    else process.env.DREAMATIC_IMAGE_API_KEY = originalKey;
    if (originalConcurrency === undefined) delete process.env.DREAMATIC_IMAGE_CONCURRENCY;
    else process.env.DREAMATIC_IMAGE_CONCURRENCY = originalConcurrency;
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
