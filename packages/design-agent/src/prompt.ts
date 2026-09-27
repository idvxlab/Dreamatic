import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { resolveInside, safeRunId } from "./paths.js";

export interface DreamaticPromptImage {
  type: "image";
  data: string;
  mimeType: string;
  name?: string;
}

export interface PersistedReference {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

export async function prepareDreamaticPrompt(options: {
  workspaceDir: string;
  scopeId: string;
  text: string;
  images: DreamaticPromptImage[];
}): Promise<{ text: string; images: DreamaticPromptImage[]; references: PersistedReference[] }> {
  if (options.images.length === 0) return { text: options.text, images: [], references: [] };
  if (options.images.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`A Dreamatic prompt accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
  }

  const scopeId = safeRunId(options.scopeId);
  const directory = resolveInside(options.workspaceDir, join("references", scopeId));
  await mkdir(directory, { recursive: true });
  let totalBytes = 0;
  const references: PersistedReference[] = [];

  for (const [index, image] of options.images.entries()) {
    const extension = IMAGE_EXTENSIONS.get(image.mimeType);
    if (!extension) throw new Error(`Unsupported reference image type: ${image.mimeType}`);
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length === 0) throw new Error(`Reference image ${index + 1} is empty`);
    if (bytes.length > MAX_REFERENCE_BYTES) throw new Error(`Reference image ${index + 1} exceeds 12 MB`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) throw new Error("Reference images exceed the 32 MB prompt limit");
    const fileName = `${Date.now()}-${index + 1}-${randomUUID().slice(0, 8)}${extension}`;
    const absolutePath = join(directory, fileName);
    await writeFile(absolutePath, bytes);
    references.push({
      name: image.name?.trim() || `reference-${index + 1}${extension}`,
      path: relative(options.workspaceDir, absolutePath).replaceAll("\\", "/"),
      mimeType: image.mimeType,
      size: bytes.length,
    });
  }

  const referenceBlock = [
    "[Dreamatic reference images]",
    ...references.map((reference, index) => `${index + 1}. ${reference.name}: ${reference.path}`),
    "These files persist in the shared workspace. Use view_image with the path when a reference is no longer visually expanded in active context.",
  ].join("\n");
  return {
    text: `${options.text.trim()}\n\n${referenceBlock}`.trim(),
    images: options.images,
    references,
  };
}
