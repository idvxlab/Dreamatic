import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { compactVisualSession, createModelImagePreview } from "../dist/index.js";

test("model image preview enforces a design-stage image budget", () => {
  const source = new PhotonImage(new Uint8Array(1600 * 900 * 4).fill(180), 1600, 900);
  let bytes;
  try {
    bytes = source.get_bytes();
  } finally {
    source.free();
  }
  const preview = createModelImagePreview(bytes, "image/png");
  assert.equal(preview.mimeType, "image/jpeg");
  assert.equal(preview.width, 1400);
  assert.equal(preview.height, 788);
  assert.ok(preview.bytes <= 1_200_000);
});

test("visual session compaction keeps a recoverable full backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dreamatic-visual-session-"));
  try {
    const sessionFile = join(directory, "session.jsonl");
    const payload = "a".repeat(250_000);
    const original = `${JSON.stringify({ type: "message", message: { role: "toolResult", content: [
      { type: "text", text: "Visual inspection target: sample.png" },
      { type: "image", mimeType: "image/png", data: payload },
    ] } })}\n`;
    await writeFile(sessionFile, original, "utf8");

    const result = await compactVisualSession(sessionFile);
    const compacted = await readFile(sessionFile, "utf8");
    assert.ok(result.backupPath);
    const backup = await readFile(result.backupPath, "utf8");

    assert.equal(result.omitted, 1);
    assert.ok(result.afterBytes < result.beforeBytes / 20);
    assert.match(compacted, /Visual payload omitted from resumable session/);
    assert.doesNotMatch(compacted, new RegExp("a{1000}"));
    assert.equal(backup, original);
    assert.equal((await stat(result.backupPath)).size, Buffer.byteLength(original));
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".bak")).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visual session compaction skips backup when there are no images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dreamatic-text-session-"));
  try {
    const sessionFile = join(directory, "session.jsonl");
    const original = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`;
    await writeFile(sessionFile, original, "utf8");
    const result = await compactVisualSession(sessionFile);
    assert.equal(result.omitted, 0);
    assert.equal(result.backupPath, undefined);
    assert.equal(await readFile(sessionFile, "utf8"), original);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".bak")).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
