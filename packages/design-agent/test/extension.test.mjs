import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDreamaticExtension } from "../dist/extension.js";
import { prepareDreamaticPrompt } from "../dist/prompt.js";
import { dreamaticSessionFailure } from "../dist/runtime.js";
import { RetryableHttpError, withRetry } from "../dist/retry.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function registeredTools(workspaceDir) {
  const tools = new Map();
  const handlers = new Map();
  const factory = createDreamaticExtension({ workspaceDir });
  factory({
    on(event, handler) { handlers.set(event, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
  });
  return { tools, handlers };
}

test("compare_images returns labeled image observations", async () => {
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
    await assert.rejects(() => compare.execute("test-repeat", {
      candidates: [
        { id: "b", path: "runs/demo/artifacts/generated-images/b.png" },
        { id: "a", path: "runs/demo/artifacts/generated-images/a.png" },
      ],
      criteria: ["typography"],
    }), /already in the current stage's visual context/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("view_image prevents duplicate visual payloads within one stage invocation", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-view-budget-"));
  try {
    const path = "runs/demo/artifacts/generated-images/a.png";
    await mkdir(join(workspaceDir, "runs", "demo", "artifacts", "generated-images"), { recursive: true });
    await writeFile(join(workspaceDir, path), PNG_1X1);
    const { tools } = await registeredTools(workspaceDir);
    const view = tools.get("view_image");
    const result = await view.execute("view-1", { path });
    assert.equal(result.content.filter((block) => block.type === "image").length, 1);
    await assert.rejects(() => view.execute("view-2", { path }), /already loaded in this stage invocation/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("select_artifact persists a run-scoped decision", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "dreamatic-select-"));
  try {
    const artifactDir = join(workspaceDir, "runs", "demo", "artifacts", "generated-images");
    await mkdir(artifactDir, { recursive: true });
    const selectedPath = "runs/demo/artifacts/generated-images/a.png";
    await writeFile(join(workspaceDir, selectedPath), PNG_1X1);
    const { tools } = await registeredTools(workspaceDir);
    const select = tools.get("select_artifact");
    assert.ok(select);
    await select.execute("test", {
      runId: "demo",
      selectedPath,
      reason: ["Clearer focal hierarchy"],
    });
    const selection = JSON.parse(await readFile(join(workspaceDir, "runs", "demo", "artifacts", "selection.json"), "utf8"));
    assert.equal(selection.selectedPath, selectedPath);
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
    const { tools } = await registeredTools(workspaceDir);
    const exportPackage = tools.get("export_package");
    assert.ok(exportPackage);
    await exportPackage.execute("test", { runId: "demo", runDir });
    const index = await readFile(join(runDir, "final", "00-index.html"), "utf8");
    assert.match(index, /<base href="artifacts\/">/);
    assert.match(index, /Design story/);
    assert.match(index, /generated-images\/hero\.png/);
    assert.doesNotMatch(index, /Design delivery/);
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
