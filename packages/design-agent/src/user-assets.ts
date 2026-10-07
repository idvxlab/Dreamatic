import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveInside, safeRunId } from "./paths.js";
import { serializeJsonWrite } from "./performance.js";

export const USER_ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".md", ".csv"]);
export interface UserAsset { source: string; origin: string; sourcePageUrl?: string; embeddedFile?: string; sha256: string; size: number }
export interface Inventory { sources: string[]; assets: UserAsset[]; linkedSources?: Record<string, string[]> }
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
export async function downloadUserMaterial(value: string, signal: AbortSignal, fetcher: typeof fetch): Promise<{ bytes: Buffer; url: string; type: string }> {
  let url = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    await checkedUrl(url);
    const response = await fetcher(url, { signal, redirect: "manual", headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "DreamaticArt" } });
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
    const contentType = response.headers.get("content-type") ?? "";
    const rawGithubText = new URL(url).hostname === "api.github.com" && /application\/vnd\.github\.raw/iu.test(contentType) && /\.(?:md|txt|csv)$/iu.test(new URL(url).pathname);
    return { bytes: Buffer.concat(chunks), url, type: rawGithubText ? "text/plain; charset=utf-8" : contentType };
  }
  throw new Error("Too many user material redirects");
}
/** GitHub tree URLs identify a repository/directory; blob/raw URLs identify a file.
 * Use the contents API's raw media representation, not a GitHub HTML viewer. */
export function githubMaterial(value: string) {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "github.com" && parts.length >= 4 && ["tree", "blob"].includes(parts[2]!)) {
    return { owner: parts[0]!, repo: parts[1]!, ref: parts[3]!, path: parts.slice(4).join("/"), directory: parts[2] === "tree" };
  }
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) return { owner: parts[0]!, repo: parts[1]!, ref: parts[2]!, path: parts.slice(3).join("/"), directory: false };
  return undefined;
}
function githubDownloadUrl(value: string): string {
  const repo = githubMaterial(value);
  if (!repo) return value;
  const path = repo.directory ? [repo.path, "README.md"].filter(Boolean).join("/") : repo.path;
  return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repo.ref)}`;
}
function repositoryContains(page: string, source: string): boolean {
  const root = githubMaterial(page), file = githubMaterial(source);
  return Boolean(root?.directory && file && !file.directory && root.owner === file.owner && root.repo === file.repo && root.ref === file.ref && (!root.path || file.path.startsWith(root.path + "/")) && !file.path.split("/").some(part => part === ".." || part === "."));
}
export function materialLinks(text: string, base: string): string[] {
  const html = [...text.matchAll(/(?:src|href|poster|data-src|data-original)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"\s]+)|srcset\s*=\s*["']([^"']+)["']/giu)].flatMap(match => match[3] ? match[3].split(",").map(part => part.trim().split(/\s/u)[0]!) : [match[1] ?? match[2]!]);
  const markdown = [...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*)?\)/gu)].map(match => match[1]!);
  const repo = githubMaterial(base);
  const urlBase = repo ? `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.ref}/${repo.directory ? [repo.path, "README.md"].filter(Boolean).join("/") : repo.path}` : base;
  return [...new Set([...html, ...markdown].flatMap(link => { try { const url = new URL(link.replaceAll("&amp;", "&"), urlBase); return ["https:", "http:"].includes(url.protocol) ? [url.href] : []; } catch { return []; } }))];
}
/** Tool-owned link evidence lets later imports reuse the acquired source snapshot. */
export async function recordMaterialLinks(workspaceDir: string, runId: string, source: string, links: string[], sourcePageUrl?: string) {
  const runDir = resolveInside(workspaceDir, join("runs", safeRunId(runId)));
  await serializeJsonWrite(resolveInside(runDir, registry), async () => {
    const previous = await userMaterialInventory(runDir);
    const root = previous.sources.includes(source) ? source : sourcePageUrl;
    if (!root || !previous.sources.includes(root)) return;
    if (root !== source && !repositoryContains(root, source) && !previous.linkedSources?.[root]?.includes(source)) throw new Error("Cannot attach content links without verified user-source provenance");
    await writeFile(resolveInside(runDir, registry), JSON.stringify({ ...previous, linkedSources: { ...previous.linkedSources, [root]: [...new Set([...(previous.linkedSources?.[root] ?? []), ...links])].slice(0, 4096) } }, null, 2));
  });
}

/** Read only user URLs/uploads or a file within a user-specified repository tree.
 * General websites grant access only to a concretely linked child, never a host. */
export async function readUserMaterial(workspaceDir: string, params: { runId: string; source: string; sourcePageUrl?: string }, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const inventory = await userMaterialInventory(resolveInside(workspaceDir, join("runs", safeRunId(params.runId))));
  if (params.sourcePageUrl && !inventory.sources.includes(params.sourcePageUrl)) throw new Error("sourcePageUrl must be explicitly user-provided");
  if (!inventory.sources.includes(params.source)) {
    if (!params.sourcePageUrl) throw new Error("Material is not explicitly user-provided");
    if (!repositoryContains(params.sourcePageUrl, params.source)) {
      let links = inventory.linkedSources?.[params.sourcePageUrl];
      if (!links) {
        const page = await downloadUserMaterial(githubDownloadUrl(params.sourcePageUrl), signal, fetcher);
        if (!/text\/(?:html|plain|markdown)/iu.test(page.type)) throw new Error("sourcePageUrl must identify readable user content");
        links = materialLinks(page.bytes.toString("utf8"), githubMaterial(params.sourcePageUrl) ? params.sourcePageUrl : page.url);
        await recordMaterialLinks(workspaceDir, params.runId, params.sourcePageUrl, links);
      }
      if (!links.includes(new URL(params.source).href)) throw new Error("Material URL is not linked by the user-provided page");
    }
  }
  if (/^https?:\/\//iu.test(params.source)) return downloadUserMaterial(githubDownloadUrl(params.source), signal, fetcher);
  if (!params.source.startsWith("references/") || !inventory.sources.includes(params.source)) throw new Error("Local user material must be a persisted upload under references/");
  const path = resolveInside(workspaceDir, params.source);
  resolveInside(await realpath(resolveInside(workspaceDir, "references")), await realpath(path));
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("User upload is not a file or exceeds 128 MB");
  return { bytes: await readFile(path), url: params.source, type: "" };
}

/** Persist exact bytes before design approval. A page URL authorizes only an asset actually linked on that page. */
export async function importUserAsset(workspaceDir: string, params: { runId: string; source: string; sourcePageUrl?: string }, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<UserAsset> {
  const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
  const inventory = await userMaterialInventory(runDir);
  if (!inventory.sources.includes(params.source) && (!params.sourcePageUrl || !inventory.sources.includes(params.sourcePageUrl))) throw new Error("Material is not explicitly user-provided. Use a user URL/upload or generate the designed asset; research sources cannot authorize copying.");
  if (params.sourcePageUrl && !inventory.sources.includes(params.sourcePageUrl)) throw new Error("sourcePageUrl must be explicitly user-provided");
  const cached = inventory.assets.find((asset) => !asset.embeddedFile && asset.origin === params.source && asset.sourcePageUrl === params.sourcePageUrl);
  if (cached) { await validateUserAsset(runDir, cached.source); return cached; }
  const timeout = AbortSignal.timeout(60_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const result = await readUserMaterial(workspaceDir, params, bounded, fetcher);
  if (/text\/html/iu.test(result.type) || /^\s*(?:<!doctype html|<html)/iu.test(result.bytes.subarray(0, 512).toString())) throw new Error("Material URL returned an HTML page, not an image/video/document. Use user_material_extract for page content.");
  const bytes = result.bytes;
  const mime = result.type.split(";")[0]!.trim().toLowerCase();
  let extension = extname(new URL(params.source, "https://upload.invalid").pathname).toLowerCase();
  if (!USER_ASSET_EXTENSIONS.has(extension)) extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx" } as Record<string, string>)[mime] ?? extension;
  if (!USER_ASSET_EXTENSIONS.has(extension)) throw new Error("User material needs a supported image/video/document filename extension");
  if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error("User material is empty or exceeds 128 MB");
  return saveImportedUserAsset(workspaceDir, params, bytes, extension);
}
/** Internal persistence after readUserMaterial has verified document/page provenance. */
export async function saveImportedUserAsset(workspaceDir: string, params: {runId: string;source: string;sourcePageUrl?: string;embeddedFile?: string}, bytes: Buffer, extension: string): Promise<UserAsset> {
  const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
  if (!USER_ASSET_EXTENSIONS.has(extension) || !bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error("Unsupported or oversized extracted material");
  const sha256 = digest(bytes), source = `inputs/user-assets/${sha256}${extension}`;
  const directory = resolveInside(runDir, "inputs/user-assets");
  await mkdir(directory, { recursive: true });
  resolveInside(await realpath(runDir), await realpath(directory));
  const target = resolveInside(runDir, source);
  try { await writeFile(target, bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; resolveInside(await realpath(runDir), await realpath(target)); if (digest(await readFile(target)) !== sha256) throw new Error("User material content-addressed path is corrupt"); }
  const asset = { source, origin: params.source, ...(params.sourcePageUrl ? { sourcePageUrl: params.sourcePageUrl } : {}), ...(params.embeddedFile ? { embeddedFile: params.embeddedFile } : {}), sha256, size: bytes.length };
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
