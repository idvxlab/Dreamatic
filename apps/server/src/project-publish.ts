import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
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
export async function publishProject(workspaceDir: string, runId: string, input: unknown, site: string) {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (args.confirmed !== true) throw new Error("Confirm public publication before uploading");
  const endpoint = publicationEndpoint(site);
  const creator = normalizeCreator(args.creator);
  const publicationId = typeof args.publicationId === "string" ? args.publicationId : randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicationId)) throw new Error("Invalid publication id");
  const archive = await prepareProjectExport(workspaceDir, runId, { publication: { schemaVersion: 1, publicationId, creator } });
  try {
    if ((await stat(archive.path)).size > PUBLISH_MAX_BYTES) throw new Error("Publication ZIP exceeds the 128 MB upload limit");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "Content-Type": "application/zip" }, body: await openAsBlob(archive.path, { type: "application/zip" }), signal: AbortSignal.timeout(300_000) });
    const value = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(value?.error || `DreamaticSite upload failed (${response.status})`);
    if (!value || typeof value.projectId !== "string" || typeof value.previewUrl !== "string" || !value.previewUrl.startsWith("/gallery-assets/") || typeof value.galleryUrl !== "string" || !value.galleryUrl.startsWith("/#gallery")) throw new Error("DreamaticSite returned an invalid publication receipt");
    return { projectId: value.projectId, previewUrl: new URL(value.previewUrl, endpoint.origin).href, galleryUrl: new URL(value.galleryUrl, endpoint.origin).href };
  } finally { await archive.cleanup(); }
}
