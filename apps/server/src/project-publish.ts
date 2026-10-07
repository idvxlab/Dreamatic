import type { ModelUsage } from "@dreamatic/design-agent";
import { randomBytes, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { prepareProjectExport } from "./project-export.js";

export interface Creator { name: string; affiliation: string; website: string }
export const DEFAULT_SITE_URL = "https://www.dreamatic.art/";
export const PUBLISH_MAX_BYTES = 128 * 1024 * 1024;
export function normalizeCreator(input: unknown): Creator {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const record = input as Record<string, unknown>;
  const field = (key: string, limit: number) => {
    if (record[key] !== undefined && typeof record[key] !== "string") throw new Error(`Creator ${key} must be text`);
    const value = String(record[key] ?? "").trim();
    if (value.length > limit) throw new Error(`Creator ${key} is too long`);
    return value;
  };
  const creator = { name: field("name", 80), affiliation: field("affiliation", 160), website: field("website", 500) };
  if (creator.website) {
    const url = new URL(creator.website);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Creator website must be an HTTP(S) URL without credentials");
  }
  return creator;
}
export function publicationEndpoint(site: string): URL {
  if (!site.trim()) throw new Error("Set the DreamaticSite URL in Settings → System parameters before publishing");
  const url = new URL(site);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("DreamaticSite must be an HTTPS origin (HTTP is allowed only for localhost development)");
  return new URL("/api/gallery/publish", url);
}
export interface PublicationReceipt { projectId: string; previewUrl: string; galleryUrl: string }
export interface PublishProgress { phase: "packaging" | "uploading" | "deploying" | "completed" | "failed"; uploadedBytes: number; totalBytes: number; error?: string }
interface SavedPublication { deliveryAttempted?: boolean; publicationId: string; updateToken: string; creator?: Creator; receipt?: PublicationReceipt; publishedAt?: string }
const active = new Map<string, PublishProgress>();
async function publicationFile(workspaceDir: string, runId: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new Error("Invalid run id");
  const root = await realpath(join(workspaceDir, "runs"));
  const run = await realpath(join(root, runId));
  if (!run.startsWith(root + sep)) throw new Error("Invalid run path");
  const privateDir = join(run, ".performance");
  await mkdir(privateDir, { recursive: true });
  if (!(await realpath(privateDir)).startsWith(run + sep)) throw new Error("Invalid publication storage path");
  const path = join(privateDir, "publications.json");
  if (await lstat(path).then(info => info.isSymbolicLink()).catch(error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Publication storage must not be a symbolic link");
  return path;
}
async function records(path: string): Promise<Record<string, SavedPublication>> {
  return readFile(path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return {}; throw error; });
}
async function saveRecords(path: string, value: Record<string, SavedPublication>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
export function publicationInProgress(): boolean {
  return [...active.values()].some(progress => !["completed", "failed"].includes(progress.phase));
}
export async function publicationStatus(workspaceDir: string, runId: string, site: string) {
  const endpoint = publicationEndpoint(site), path = await publicationFile(workspaceDir, runId);
  const ledger = await records(path);
  const saved = ledger[endpoint.origin];
  // Reconcile saved attempts with the website, including manual Gallery deletion.
  if (saved && (saved.receipt || saved.deliveryAttempted !== false) && (!active.get(path) || ["completed", "failed"].includes(active.get(path)!.phase))) {
    try {
      const response = await fetch(new URL("/api/gallery", endpoint.origin), { redirect: "error", signal: AbortSignal.timeout(5000) });
      const value = response.ok ? await response.json() : undefined;
      if (Array.isArray(value?.projects) && value.projects.every((item: { id?: unknown }) => typeof item?.id === "string")) {
        saved.deliveryAttempted = value.projects.some((item: { id: string }) => item.id === `published-${saved.publicationId.toLowerCase()}`);
        if (!saved.deliveryAttempted) { delete saved.receipt; delete saved.publishedAt; }
        await saveRecords(path, ledger);
      }
    } catch { /* Keep unknown attempts conservative when the site is unavailable. */ }
  }
  const progress = active.get(path);
  return { site: endpoint.origin, published: Boolean(saved?.receipt), mayExist: Boolean(saved && (saved.receipt || saved.deliveryAttempted !== false)), creator: saved?.creator, receipt: saved?.receipt, publishedAt: saved?.publishedAt, inProgress: Boolean(progress && !["completed", "failed"].includes(progress.phase)), ...(progress ? { progress } : {}) };
}
export async function publishProject(workspaceDir: string, runId: string, input: unknown, site: string, modelConfig: NodeJS.ProcessEnv = process.env): Promise<PublicationReceipt> {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (args.confirmed !== true) throw new Error("Confirm public publication before uploading");
  const endpoint = publicationEndpoint(site), path = await publicationFile(workspaceDir, runId);
  const previousProgress = active.get(path);
  if (previousProgress && !["completed", "failed"].includes(previousProgress.phase)) throw new Error("This project is already being published; wait for completion");
  const progress: PublishProgress = { phase: "packaging", uploadedBytes: 0, totalBytes: 0 };
  active.set(path, progress);
  let uploadStream: Readable | undefined;
  let archive: Awaited<ReturnType<typeof prepareProjectExport>> | undefined;
  try {
    const manifest = JSON.parse(await readFile(join(dirname(dirname(path)), "artifacts/artifact-manifest.json"), "utf8"));
    const imageDeliverables = Array.isArray(manifest.artifacts) ? manifest.artifacts.filter((item: { method?: string; path?: string }) => ["image_generate", "image_edit"].includes(item.method ?? "") && typeof item.path === "string" && /^artifacts\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.(png|jpe?g|webp|gif)$/i.test(item.path)) : [];
    const hasImages = (await Promise.all(imageDeliverables.map((item: { path: string }) => stat(join(dirname(dirname(path)), item.path)).then(info => info.isFile() && info.size > 0).catch(() => false)))).some(Boolean);
    if (!hasImages && (manifest.presentation?.mode === "html" || manifest.htmlEntries?.length || manifest.artifacts?.some((item: { method?: string }) => item.method === "html_generate"))) {
      throw new Error("HTML UX/UI projects cannot currently be published to the official Gallery");
    }
    const saved = await records(path);
    const previous = saved[endpoint.origin];
    if (previous && (previous.receipt || previous.deliveryAttempted !== false) && args.overwriteConfirmed !== true) throw new Error("This project may already be published. Reopen Publish and confirm replacement.");
    const creator = normalizeCreator(args.creator);
    // Allocate independently of user input, names, locations, clocks and run ids.
    // Persist this cryptographic UUID so legitimate replacements keep their identity.
    const publicationId = previous?.publicationId ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicationId)) throw new Error("Invalid publication id");
    const current: SavedPublication = { deliveryAttempted: false, ...previous, publicationId, updateToken: previous?.updateToken ?? randomBytes(32).toString("hex"), creator };
    // Save the stable private capability before network I/O: lost responses can be retried.
    saved[endpoint.origin] = current;
    await saveRecords(path, saved);
    const reasoning = ["orchestrator", "researcher", "designer", "reviewer", "builder"].flatMap(role => {
      const model = (modelConfig[`DREAMATIC_MODEL_${role.toUpperCase()}`] || modelConfig.DREAMATIC_MODEL || "").trim();
      return model ? [{ model, provider: modelConfig.DREAMATIC_PROVIDER_NAME || "", role, source: "publication_config_fallback" }] : [];
    });
    const modelFallback: ModelUsage = { schemaVersion: 1, reasoning, generation: [{ model: modelConfig.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1", provider: "", source: "publication_config_fallback" }] };
    archive = await prepareProjectExport(workspaceDir, runId, { publication: { schemaVersion: 1, publicationId, creator, overwrite: args.overwriteConfirmed === true }, modelFallback });
    const size = (await stat(archive.path)).size;
    if (size > PUBLISH_MAX_BYTES) throw new Error("Publication ZIP exceeds the 128 MB upload limit");
    progress.totalBytes = size; progress.phase = "uploading";
    const blob = await openAsBlob(archive.path, { type: "application/zip" });
    async function* upload() {
      for await (const chunk of Readable.fromWeb(blob.stream() as import("node:stream/web").ReadableStream)) {
        progress.uploadedBytes += chunk.length;
        yield chunk;
      }
      if (progress.phase === "uploading") progress.phase = "deploying";
    }
    uploadStream = Readable.from(upload());
    const init = { method: "POST", redirect: "error", headers: { "Content-Type": "application/zip", "Content-Length": String(size), "X-Dreamatic-Publish-Token": current.updateToken }, body: Readable.toWeb(uploadStream) as unknown as ReadableStream<Uint8Array>, duplex: "half", signal: AbortSignal.timeout(300_000) } as RequestInit & { duplex: "half" };
    current.deliveryAttempted = true;
    await saveRecords(path, saved);
    const response = await fetch(endpoint, init);
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
      // A rejected request did not deploy. Preserve known previous publications,
      // but do not turn a new 429/validation rejection into an overwrite warning.
      if (!current.receipt && [400, 413, 415, 422, 429].includes(response.status)) {
        current.deliveryAttempted = false;
        await saveRecords(path, saved);
      }
      throw new Error(value?.error || `DreamaticSite upload failed (${response.status})`);
    }
    if (!value || typeof value.projectId !== "string" || typeof value.previewUrl !== "string" || !value.previewUrl.startsWith("/gallery-assets/") || typeof value.galleryUrl !== "string" || !value.galleryUrl.startsWith("/#gallery")) throw new Error("DreamaticSite returned an invalid publication receipt");
    const receipt = { projectId: value.projectId, previewUrl: new URL(value.previewUrl, endpoint.origin).href, galleryUrl: new URL(value.galleryUrl, endpoint.origin).href };
    saved[endpoint.origin] = { ...current, receipt, publishedAt: new Date().toISOString() };
    await saveRecords(path, saved);
    progress.uploadedBytes = size; progress.phase = "completed";
    return receipt;
  } catch (error) {
    progress.phase = "failed"; progress.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    uploadStream?.destroy();
    await archive?.cleanup();
    setTimeout(() => { if (active.get(path) === progress) active.delete(path); }, 600_000).unref();
  }
}
