import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { HTML_PREVIEW_CSP, HTML_CONTENT_TYPES, physicalRunFile } from "@dreamatic/design-agent";

interface PreviewGrant { runDir: string; manifestHash: string; files: Map<string, string>; entry: string }
/** Dedicated origin: this server has no session/config/assets API and only serves committed files. */
export class PreviewService {
  #server: Server | undefined;
  #starting: Promise<number> | undefined;
  #grants = new Map<string, PreviewGrant>();
  constructor(readonly workspaceDir: string) {}

  async open(runId: string, requestedEntry?: string): Promise<{ url: string; entries: Array<{ path: string; url: string }> }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new Error("Invalid run id");
    const runDir = join(this.workspaceDir, "runs", runId);
    const source = await readFile(join(runDir, "artifacts/artifact-manifest.json"), "utf8");
    const manifest = JSON.parse(source);
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.previewFiles)) throw new Error("This project has no interactive HTML presentation");
    const state = JSON.parse(await readFile(join(runDir, "run-state.json"), "utf8"));
    if (state.stages?.build !== "completed") throw new Error("Preview requires a completed approved build");
    const bus = (await readFile(join(runDir, "bus.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const build = bus.findLast((event) => event.type === "build_done");
    const receipt = build?.commitReceipt?.files;
    if (!receipt || receipt["artifacts/artifact-manifest.json"] !== createHash("sha256").update(source).digest("hex")) throw new Error("Preview manifest differs from committed build");
    const files = new Map<string, string>();
    for (const path of manifest.previewFiles ?? []) {
      if (typeof path !== "string" || !path.startsWith("artifacts/") || path.split("/").includes("..") || typeof receipt[path] !== "string") throw new Error("Invalid preview file receipt");
      files.set(path, receipt[path]);
    }
    const htmlEntries: string[] = Array.isArray(manifest.htmlEntries) ? manifest.htmlEntries : manifest.presentation?.mode === "html" ? [manifest.presentation.entry] : [];
    const entry = requestedEntry ?? (manifest.presentation?.mode === "html" ? manifest.presentation.entry : htmlEntries[0]);
    if (typeof entry !== "string" || !entry.endsWith(".html") || !htmlEntries.includes(entry)) throw new Error("Unknown approved HTML page");
    if (!files.has(entry)) throw new Error("Preview entry is not a committed HTML output");
    const manifestHash = createHash("sha256").update(source).digest("hex");
    let token = [...this.#grants].find(([, grant]) => grant.runDir === runDir && grant.manifestHash === manifestHash)?.[0];
    if (!token) {
      token = randomBytes(24).toString("hex");
      this.#grants.set(token, { runDir, manifestHash, files, entry });
      while (this.#grants.size > 128) this.#grants.delete(this.#grants.keys().next().value!);
    }
    const port = await this.#start();
    return { url: `http://127.0.0.1:${port}/${token}/${entry}`, entries: htmlEntries.filter((path) => files.has(path)).map((path) => ({ path, url: `http://127.0.0.1:${port}/${token}/${path}` })) };
  }

  #start(): Promise<number> {
    if (this.#starting) return this.#starting;
    this.#server = createServer(async (request, response) => {
      try {
        if (request.method !== "GET" && request.method !== "HEAD") throw new Error("Read-only preview");
        const segments = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1)).split("/");
        const grant = this.#grants.get(segments.shift()!);
        const path = segments.join("/");
        if (!grant || !grant.files.has(path)) throw new Error("Unknown preview resource");
        const state = JSON.parse(await readFile(join(grant.runDir, "run-state.json"), "utf8"));
        if (state.stages?.build !== "completed") throw new Error("Build approval invalidated");
        const manifest = await readFile(join(grant.runDir, "artifacts/artifact-manifest.json"));
        if (createHash("sha256").update(manifest).digest("hex") !== grant.manifestHash) throw new Error("Build changed");
        const bytes = await readFile(await physicalRunFile(grant.runDir, path));
        if (createHash("sha256").update(bytes).digest("hex") !== grant.files.get(path)) throw new Error("Output changed after build");
        response.writeHead(200, { "Content-Type": HTML_CONTENT_TYPES[extname(path)] ?? "application/octet-stream", "Content-Length": bytes.length, "Content-Security-Policy": HTML_PREVIEW_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch { response.writeHead(404); response.end("Preview resource unavailable"); }
    });
    this.#starting = new Promise<number>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        if (!address || typeof address === "string") { reject(new Error("Preview origin unavailable")); return; }
        resolve(address.port);
      });
    }).catch((error) => { this.#starting = undefined; throw error; });
    return this.#starting;
  }
  async close(): Promise<void> {
    this.#grants.clear();
    this.#server?.closeAllConnections();
    if (this.#server) await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
    this.#server = undefined; this.#starting = undefined;
  }
}
