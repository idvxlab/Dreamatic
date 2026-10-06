import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveInside, safeRunId } from "./paths.js";
import { serializeJsonWrite } from "./performance.js";

export const USER_ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".md", ".csv"]);
export interface UserAsset { source: string; origin: string; sourcePageUrl?: string; sha256: string; size: number }
interface Inventory { sources: string[]; assets: UserAsset[] }
const registry = ".performance/user-materials.json";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function userMaterialInventory(runDir: string): Promise<Inventory> {
  return readFile(resolveInside(runDir, registry), "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return { sources: [], assets: [] };
    throw error;
  });
}
/** Called only for root user prompts; specialist summaries cannot grant material permission. */
export async function recordUserMaterialSources(runDir: string, prompts: string[]): Promise<void> {
  const sources = prompts.flatMap((prompt) => [
    ...[...prompt.matchAll(/https?:\/\/[^\s<>"')]+/giu)].map((match) => match[0].replace(/[。，,;]+$/u, "")),
    ...[...prompt.matchAll(/references\/[a-z0-9-]+\/[^\s]+/giu)].map((match) => match[0]),
  ]);
  await mkdir(join(runDir, ".performance"), { recursive: true });
  await serializeJsonWrite(resolveInside(runDir, registry), async () => {
    const previous = await userMaterialInventory(runDir);
    await writeFile(resolveInside(runDir, registry), JSON.stringify({ ...previous, sources: [...new Set([...previous.sources, ...sources])] }, null, 2));
  });
}
function publicAddress(address: string): boolean {
  if (address.includes(":")) return !/^(?:::|fc|fd|fe[89ab]|ff|::ffff:)/iu.test(address);
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127 || a! >= 224);
}
async function checkedUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("User material requires an HTTP(S) public URL");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ""), { all: true });
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) throw new Error("User material URL may not target a private/local address");
  return url;
}
async function download(value: string, signal: AbortSignal, fetcher: typeof fetch): Promise<{ bytes: Buffer; url: string; type: string }> {
  let url = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    await checkedUrl(url);
    const response = await fetcher(url, { signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel(); url = new URL(response.headers.get("location")!, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`User material download failed (${response.status})`); }
    const limit = 128 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("User material exceeds 128 MB"); }
    const chunks: Buffer[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) { throw new Error("User material exceeds 128 MB"); }
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), url, type: response.headers.get("content-type") ?? "" };
  }
  throw new Error("Too many user material redirects");
}
/** Persist exact bytes before design approval. A page URL authorizes only an asset actually linked on that page. */
export async function importUserAsset(workspaceDir: string, params: { runId: string; source: string; sourcePageUrl?: string }, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<UserAsset> {
  const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
  const inventory = await userMaterialInventory(runDir);
  if (!inventory.sources.includes(params.source) && (!params.sourcePageUrl || !inventory.sources.includes(params.sourcePageUrl))) throw new Error("Material is not explicitly user-provided. Use a user URL/upload or generate the designed asset; research sources cannot authorize copying.");
  if (params.sourcePageUrl && !inventory.sources.includes(params.sourcePageUrl)) throw new Error("sourcePageUrl must be explicitly user-provided");
  const cached = inventory.assets.find((asset) => asset.origin === params.source && asset.sourcePageUrl === params.sourcePageUrl);
  if (cached) { await validateUserAsset(runDir, cached.source); return cached; }
  const timeout = AbortSignal.timeout(60_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let bytes: Buffer;
  let extension: string;
  if (/^https?:\/\//iu.test(params.source)) {
    if (!inventory.sources.includes(params.source)) {
      const page = await download(params.sourcePageUrl!, bounded, fetcher);
      if (!/text\/html/iu.test(page.type)) throw new Error("sourcePageUrl must identify the user's HTML page");
      const html = page.bytes.toString("utf8");
      const links = [...html.matchAll(/(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"\s]+)|srcset\s*=\s*["']([^"']+)["']/giu)].flatMap((match) => match[3] ? match[3].split(",").map((part) => part.trim().split(/\s/u)[0]!) : [match[1] ?? match[2]!]);
      if (!links.some((link) => { try { return new URL(link.replaceAll("&amp;", "&"), page.url).href === new URL(params.source).href; } catch { return false; } })) throw new Error("Material URL is not linked by the user-provided page");
    }
    const result = await download(params.source, bounded, fetcher);
    if (/text\/html/iu.test(result.type) || /^\s*(?:<!doctype html|<html)/iu.test(result.bytes.subarray(0, 512).toString())) throw new Error("Material URL returned an HTML page, not an image/video/document");
    bytes = result.bytes;
    const mime = result.type.split(";")[0]!.trim().toLowerCase();
    extension = extname(new URL(params.source).pathname).toLowerCase();
    if (!USER_ASSET_EXTENSIONS.has(extension)) extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx" } as Record<string, string>)[mime] ?? extension;
  } else {
    if (!params.source.startsWith("references/")) throw new Error("Local user material must be a persisted upload under references/");
    const path = resolveInside(workspaceDir, params.source);
    resolveInside(await realpath(resolveInside(workspaceDir, "references")), await realpath(path));
    const info = await stat(path);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("User upload is not a file or exceeds 128 MB");
    bytes = await readFile(path); extension = extname(path).toLowerCase();
  }
  if (!USER_ASSET_EXTENSIONS.has(extension)) throw new Error("User material needs a supported image/video/document filename extension");
  if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error("User material is empty or exceeds 128 MB");
  const sha256 = digest(bytes), source = `inputs/user-assets/${sha256}${extension}`;
  const directory = resolveInside(runDir, "inputs/user-assets");
  await mkdir(directory, { recursive: true });
  resolveInside(await realpath(runDir), await realpath(directory));
  const target = resolveInside(runDir, source);
  try { await writeFile(target, bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; resolveInside(await realpath(runDir), await realpath(target)); if (digest(await readFile(target)) !== sha256) throw new Error("User material content-addressed path is corrupt"); }
  const asset = { source, origin: params.source, ...(params.sourcePageUrl ? { sourcePageUrl: params.sourcePageUrl } : {}), sha256, size: bytes.length };
  await serializeJsonWrite(resolveInside(runDir, registry), async () => {
    const previous = await userMaterialInventory(runDir);
    await writeFile(resolveInside(runDir, registry), JSON.stringify({ ...previous, assets: [...previous.assets.filter((item) => item.source !== source), asset] }, null, 2));
  });
  return asset;
}
export async function validateUserAsset(runDir: string, source: string): Promise<void> {
  const inventory = await userMaterialInventory(runDir);
  const asset = inventory.assets.find((item) => item.source === source);
  if (!asset || !inventory.sources.includes(asset.sourcePageUrl ?? asset.origin)) throw new Error(`User material ${source} has no trusted import receipt`);
  const path = resolveInside(runDir, source);
  resolveInside(await realpath(runDir), await realpath(path));
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error(`User material ${source} is missing, empty or changed`);
}
