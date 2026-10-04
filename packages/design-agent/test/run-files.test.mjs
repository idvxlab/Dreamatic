import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RUN_FILES, RUN_CONTEXT_SECTIONS, canonicalRunDocument, findRunDocument } from "../dist/run-files.js";
import { createDreamaticExtension, normalizeWriteJsonArguments } from "../dist/extension.js";

test("canonical Run document names are fixed, shared and compatible with known legacy names", () => {
  assert.equal(RUN_FILES.researchFindings, "research/research-findings.md");
  assert.ok(RUN_CONTEXT_SECTIONS.research.includes(RUN_FILES.researchFindings));
  assert.equal(canonicalRunDocument("research/research.md"), RUN_FILES.researchFindings);
  assert.equal(canonicalRunDocument("review/review.md"), RUN_FILES.reviewReport);
  assert.equal(normalizeWriteJsonArguments({ runId: "demo", path: "review/review.json", data: {} }).path, RUN_FILES.reviewData);
  assert.equal(canonicalRunDocument("plan/design-spec.md"), "plan/design-spec.md");
});

test("legacy document reads resolve safely, prefer canonical content and never fabricate files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dreamatic-run-files-"));
  const runDir = join(root, "runs/demo");
  try {
    await mkdir(join(runDir, "research"), { recursive: true });
    assert.equal(await findRunDocument(runDir, RUN_FILES.researchFindings), undefined);
    await writeFile(join(runDir, "research/research.md"), "Legacy report");
    assert.equal((await findRunDocument(runDir, RUN_FILES.researchFindings)).path, "research/research.md");
    const tools = new Map();
    const handlers = new Map();
    createDreamaticExtension({ workspaceDir: root, parentInvocation: { id: "research", agent: "researcher", runId: "demo" } })({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: (definition) => tools.set(definition.name, definition),
    });
    const read = { path: join(runDir, RUN_FILES.researchFindings) };
    assert.equal(await handlers.get("tool_call")({ toolName: "read", input: read }), undefined);
    assert.equal(read.path, join(runDir, "research/research.md"));
    const write = { path: join(runDir, "research/research.md"), content: "New report" };
    assert.equal(await handlers.get("tool_call")({ toolName: "write", input: write }), undefined);
    assert.equal(write.path, join(runDir, RUN_FILES.researchFindings));
    await writeFile(join(runDir, RUN_FILES.researchFindings), "Canonical report");
    assert.equal((await findRunDocument(runDir, "research/research.md")).path, RUN_FILES.researchFindings);
    const context = JSON.parse((await tools.get("design_context_read").execute("context", { runId: "demo", audience: "designer" })).content[0].text);
    assert.equal(context.files.find((file) => file.path === RUN_FILES.researchFindings).content, "Canonical report");
    assert.equal(context.missingFiles.includes(RUN_FILES.researchFindings), false);
    assert.equal(await readFile(join(runDir, "research/research.md"), "utf8"), "Legacy report");
    await assert.rejects(() => findRunDocument(runDir, "../private.md"), /escapes/);
    await rm(join(runDir, RUN_FILES.researchFindings));
    await writeFile(join(root, "private.md"), "Private");
    await symlink(join(root, "private.md"), join(runDir, RUN_FILES.researchFindings));
    await assert.rejects(() => findRunDocument(runDir, RUN_FILES.researchFindings), /escapes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
