import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateResearchAssets } from "../dist/index.js";

test("research asset validation creates a durable health report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-research-"));
  try {
    const directory = join(workspace, "runs", "test-run", "research", "assets");
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.alloc(9_000, 7);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "reference.png"), bytes);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ assets: [{
      id: "reference",
      file: "reference.png",
      mime_type: "image/png",
      bytes: bytes.length,
      sha256,
      source_url: "https://example.com/reference.png",
      kind: "peer",
      description: "Reference",
      do_not_replace: false,
      allowed_for_edit: true,
      fetched_at: new Date().toISOString(),
    }] }));
    const result = await validateResearchAssets(workspace, { runId: "test-run", minUsableAssets: 1 });
    assert.equal(result.validation.ready, true);
    assert.equal(result.validation.summary.usable_assets, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
