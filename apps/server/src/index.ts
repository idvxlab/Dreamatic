import { createHash, randomUUID } from "node:crypto";
import { createReadStream, watch } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { validateDreamaticPersonaContracts } from "@dreamatic/design-agent";
import { readCanvasState, writeCanvasState } from "./canvas-store.js";
import { assetInventory, attachSessionToRun, createDraftRun, deleteRun, newProjectId, primeDraftRun, renameRun, runAgentSessions, runInventory } from "./run-store.js";
import { workflowInventory } from "./workflow-store.js";
import { recordRequest, serverPerformance } from "./performance-store.js";
import { compactPromptEvent, streamWriter } from "./stream-writer.js";
import { SessionRegistry } from "./session-registry.js";
import { PreviewService } from "./preview-service.js";
import { readRuntimeConfig, saveRuntimeConfig } from "./config-store.js";
import { prepareProjectExport } from "./project-export.js";
import { DEFAULT_SITE_URL, publicationStatus, publicationInProgress, publishProject } from "./project-publish.js";
import { pipeline } from "node:stream/promises";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const configRoot = resolve(process.env.DREAMATIC_CONFIG_DIR || repoRoot);
const desktop = process.env.DREAMATIC_DESKTOP === "1";
try { loadEnvFile(join(configRoot, ".env")); } catch { /* The diagnostics endpoint reports missing configuration. */ }
const configuredWorkspace = process.env.DREAMATIC_WORKSPACE?.trim();
// Relative workspace paths are project settings, not process-working-directory settings.
// npm workspaces launch this package from apps/server, so resolve them from the repo root.
let workspaceDir = configuredWorkspace
  ? resolve(configRoot, configuredWorkspace)
  : join(configRoot, "workspace");
const webDist = join(repoRoot, "apps", "web", "dist");
const port = desktop ? 0 : Number(process.env.PORT ?? 4310);
await validateDreamaticPersonaContracts(repoRoot);
await mkdir(workspaceDir, { recursive: true });

let registry = new SessionRegistry(repoRoot, workspaceDir);
let previews = new PreviewService(workspaceDir);
await registry.initialize();

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function conditionalJson(request: IncomingMessage, response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "private, no-cache");
  if (request.headers["if-none-match"] === etag) { response.writeHead(304); response.end(); return; }
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(body);
}

async function streamWorkflow(request: IncomingMessage, response: ServerResponse, unsafeRunId: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(unsafeRunId)) throw new Error("Invalid run id");
  const runId = unsafeRunId;
  const runDir = join(workspaceDir, "runs", runId);
  const expectedRunsRoot = `${resolve(workspaceDir, "runs")}${sep}`;
  if (!resolve(runDir).startsWith(expectedRunsRoot)) throw new Error("Invalid run path");
  const info = await stat(runDir);
  if (!info.isDirectory()) throw new Error("Run not found");
  const busPath = join(runDir, "bus.jsonl");
  let readOffset = await stat(busPath).then((value) => value.size).catch(() => 0);
  let pendingLine = "";
  let closed = false;
  let flushing = false;
  let flushAgain = false;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const writer = streamWriter(response);
  const send = (value: unknown) => {
    if (!closed) writer.send(`data: ${JSON.stringify(value)}\n\n`);
  };
  send({ type: "snapshot", workflow: await workflowInventory(workspaceDir, runId) });

  const flush = async (): Promise<void> => {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    do {
      flushAgain = false;
      const size = await stat(busPath).then((value) => value.size).catch(() => 0);
      if (size < readOffset) {
        readOffset = 0;
        pendingLine = "";
      }
      if (size > readOffset) {
        const handle = await open(busPath, "r");
        try {
          const buffer = Buffer.alloc(size - readOffset);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
          readOffset += bytesRead;
          const lines = `${pendingLine}${buffer.subarray(0, bytesRead).toString("utf8")}`.split(/\r?\n/);
          pendingLine = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            try { send({ type: "workflow_event", event: JSON.parse(line) as unknown }); } catch { /* Ignore malformed completed records. */ }
          }
        } finally {
          await handle.close();
        }
      }
    } while (flushAgain && !closed);
    flushing = false;
  };
  await flush();
  const watcher = watch(runDir, { persistent: false }, (_eventType, filename) => {
    if (!filename || filename.toString() === "bus.jsonl") void flush();
  });
  const heartbeat = setInterval(() => {
    if (!closed) writer.send(": heartbeat\n\n");
  }, 15_000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    writer.end();
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 220 * 1024 * 1024) throw new Error("Request exceeds the 220 MB upload limit");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function resolveAsset(path: string): string {
  const candidate = resolve(workspaceDir, path);
  if (candidate !== workspaceDir && !candidate.startsWith(`${workspaceDir}${sep}`)) throw new Error("Invalid asset path");
  return candidate;
}

let applyingConfiguration = false;
async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const requestAt = performance.now();
  response.once("finish", () => { recordRequest(request.method ?? "GET", (request.url ?? "/").split("?")[0]!, response.statusCode, performance.now() - requestAt); });
  if (desktop) {
    const expectedHost = `127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)) {
      json(response, 403, { error: "Untrusted desktop request origin" }); return;
    }
  } else response.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (applyingConfiguration) { json(response, 503, { error: "Configuration is being applied. Please wait." }); return; }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/performance") {
      json(response, 200, serverPerformance()); return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const runCount = (await readdir(join(workspaceDir, "runs"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory()).length;
      const cliSessionCount = (await readdir(join(workspaceDir, "sessions", "cli"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length;
      json(response, 200, {
        ok: true,
        processId: process.pid,
        workspaceDir,
        profile: process.env.DREAMATIC_ACTIVE_PROFILE ?? "default",
        provider: process.env.DREAMATIC_PROVIDER_NAME ?? "Not configured",
        model: process.env.DREAMATIC_MODEL ?? "Not configured",
        imageModel: process.env.DREAMATIC_IMAGE_MODEL ?? "Not configured",
        textApiReady: Boolean(process.env.DREAMATIC_API_KEY),
        imageApiReady: Boolean(process.env.DREAMATIC_IMAGE_API_KEY || process.env.DREAMATIC_API_KEY),
        runCount,
        cliSessionCount,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      json(response, 200, await readRuntimeConfig(configRoot));
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/config") {
      if (registry.busy || publicationInProgress()) { json(response, 409, { error: "Wait for the current task or publication to finish before saving configuration." }); return; }
      applyingConfiguration = true;
      let replacement: ReturnType<typeof createServer> | undefined;
      const envPath = join(configRoot, ".env");
      const previousEnv = { ...process.env };
      let previousText: string | undefined;
      let previousMode = 0o600;
      let savedConfiguration = false;
      let applied = false;
      try {
        previousText = await readFile(envPath, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        previousMode = await stat(envPath).then(value => value.mode & 0o777).catch(() => 0o600);
        const saved = await saveRuntimeConfig(configRoot, record(await body(request)));
        savedConfiguration = true;
        const nextWorkspace = resolve(configRoot, process.env.DREAMATIC_WORKSPACE?.trim() || "workspace");
        const workspaceChanged = nextWorkspace !== workspaceDir;
        const previousAddress = server.address();
        const previousPort = typeof previousAddress === "object" && previousAddress ? previousAddress.port : port;
        const configuredPort = Number(process.env.PORT ?? 4310);
        const nextPort = desktop || configuredPort === 0 ? previousPort : configuredPort;
        if (nextPort !== previousPort) {
          replacement = createServer(handleRequest);
          await new Promise<void>((resolveListen, rejectListen) => {
            replacement!.once("error", rejectListen);
            replacement!.listen(nextPort, () => { replacement!.off("error", rejectListen); resolveListen(); });
          });
        }
        await mkdir(nextWorkspace, { recursive: true });
        if (workspaceChanged) {
          const nextRegistry = new SessionRegistry(repoRoot, nextWorkspace);
          await nextRegistry.initialize();
          await previews.close();
          const previousRegistry = registry;
          registry = nextRegistry; previews = new PreviewService(nextWorkspace); workspaceDir = nextWorkspace;
          await previousRegistry.dispose();
        } else { await registry.reloadConfiguration(); }
        if (replacement) {
          const previousServer = server; server = replacement; replacement = undefined;
          response.once("finish", () => { previousServer.close(); previousServer.closeIdleConnections(); setTimeout(() => previousServer.closeAllConnections(), 1000).unref(); });
        }
        applied = true;
        json(response, 200, { ...saved, applied: { workspaceChanged, portChanged: nextPort !== previousPort, port: nextPort } });
      } catch (error) {
        if (savedConfiguration && !applied) {
          if (previousText === undefined) await rm(envPath, { force: true });
          else {
            const rollbackPath = `${envPath}.${randomUUID()}.tmp`;
            try { await writeFile(rollbackPath, previousText, { mode: previousMode }); await rename(rollbackPath, envPath); }
            finally { await rm(rollbackPath, { force: true }); }
          }
          for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
          Object.assign(process.env, previousEnv);
        }
        throw error;
      } finally { applyingConfiguration = false; replacement?.close(); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      conditionalJson(request, response, await registry.list());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const input = record(await body(request));
      const projectId = typeof input.projectId === "string" ? input.projectId : newProjectId();
      const session = await registry.create(typeof input.title === "string" ? input.title : undefined, projectId);
      const project = typeof input.projectId === "string"
        ? await attachSessionToRun(workspaceDir, input.projectId, session.id)
        : await createDraftRun(workspaceDir, session.id, session.title, projectId);
      json(response, 201, { ...session, projectId: project.id });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionMatch?.[1]) {
      json(response, 200, registry.view(sessionMatch[1]));
      return;
    }
    const promptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (request.method === "POST" && promptMatch?.[1]) {
      const input = record(await body(request));
      if (typeof input.text !== "string") throw new Error("text is required");
      const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
      if (!projectId || !(await runInventory(workspaceDir, { summary: true })).some(run => run.id === projectId)) {
        json(response, 409, { error: "Create or select a project before sending a message" });
        return;
      }
      await primeDraftRun(workspaceDir, projectId, promptMatch[1], input.text);
      const images = Array.isArray(input.images)
        ? input.images.flatMap((value) => {
            const item = record(value);
            return typeof item.data === "string" && typeof item.mimeType === "string"
              ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType, ...(typeof item.name === "string" ? { name: item.name } : {}) }]
              : [];
          })
        : [];
      if (applyingConfiguration) { json(response, 503, { error: "Configuration is being applied. Please wait." }); return; }
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const writer = streamWriter(response);
      const send = (value: unknown) => writer.send(`${JSON.stringify(value)}\n`);
      const unsubscribe = registry.subscribe(promptMatch[1], (event) => {
        const value = input.compactEvents ? compactPromptEvent(event as unknown as Record<string, unknown>) : event;
        if (value) send({ type: "agent_event", event: value });
      });
      try {
        await registry.prompt(promptMatch[1], input.text, images, projectId);
        send({ type: "snapshot", session: registry.view(promptMatch[1], !input.compactEvents) });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        unsubscribe();
        writer.end();
      }
      return;
    }
    const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
    if (request.method === "POST" && abortMatch?.[1]) {
      json(response, 200, await registry.abort(decodeURIComponent(abortMatch[1])));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/assets") {
      conditionalJson(request, response, await assetInventory(workspaceDir));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      conditionalJson(request, response, await runInventory(workspaceDir, { summary: url.searchParams.get("summary") === "1" }));
      return;
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    const publishMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/publish$/);
    if (request.method === "GET" && publishMatch?.[1]) {
      json(response, 200, await publicationStatus(workspaceDir, decodeURIComponent(publishMatch[1]), process.env.DREAMATIC_SITE_URL ?? DEFAULT_SITE_URL));
      return;
    }
    if (request.method === "POST" && publishMatch?.[1]) {
      json(response, 201, await publishProject(workspaceDir, decodeURIComponent(publishMatch[1]), await body(request), process.env.DREAMATIC_SITE_URL ?? DEFAULT_SITE_URL, (await readRuntimeConfig(configRoot)).values));
      return;
    }
    const exportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/export$/);
    if (request.method === "GET" && exportMatch?.[1]) {
      const archive = await prepareProjectExport(workspaceDir, decodeURIComponent(exportMatch[1]));
      try {
        const info = await stat(archive.path);
        response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": info.size, "Content-Disposition": `attachment; filename="${archive.filename}"`, "Cache-Control": "no-store" });
        await pipeline(createReadStream(archive.path), response);
      } finally { await archive.cleanup(); }
      return;
    }
    const previewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/preview$/);
    if (request.method === "POST" && previewMatch?.[1]) {
      const input = await body(request);
      json(response, 200, await previews.open(decodeURIComponent(previewMatch[1]), input && typeof input === "object" && "entry" in input && typeof input.entry === "string" ? input.entry : undefined));
      return;
    }
    if (request.method === "PATCH" && runMatch?.[1]) {
      const input = await body(request) as { title?: unknown };
      if (typeof input.title !== "string") throw new Error("Project title is required");
      json(response, 200, await renameRun(workspaceDir, decodeURIComponent(runMatch[1]), input.title));
      return;
    }
    if (request.method === "DELETE" && runMatch?.[1]) {
      json(response, 200, await deleteRun(workspaceDir, decodeURIComponent(runMatch[1])));
      return;
    }
    const runDetailMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && runDetailMatch?.[1]) {
      const runId = decodeURIComponent(runDetailMatch[1]);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new Error("Invalid run id");
      const run = (await runInventory(workspaceDir, { runId }))[0];
      if (run) conditionalJson(request, response, run); else json(response, 404, { error: "Run not found" });
      return;
    }
    const runAssetsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/assets$/);
    if (request.method === "GET" && runAssetsMatch?.[1]) {
      conditionalJson(request, response, await assetInventory(workspaceDir, decodeURIComponent(runAssetsMatch[1])));
      return;
    }
    const agentSessionsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/agent-sessions$/);
    if (request.method === "GET" && agentSessionsMatch?.[1]) {
      json(response, 200, await runAgentSessions(workspaceDir, decodeURIComponent(agentSessionsMatch[1])));
      return;
    }
    const workflowMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/workflow$/);
    if (request.method === "GET" && workflowMatch?.[1]) {
      json(response, 200, await workflowInventory(workspaceDir, decodeURIComponent(workflowMatch[1])));
      return;
    }
    const workflowStreamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/workflow\/stream$/);
    if (request.method === "GET" && workflowStreamMatch?.[1]) {
      await streamWorkflow(request, response, decodeURIComponent(workflowStreamMatch[1]));
      return;
    }
    const canvasMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/canvas$/);
    if (request.method === "GET" && canvasMatch?.[1]) {
      json(response, 200, await readCanvasState(workspaceDir, decodeURIComponent(canvasMatch[1])));
      return;
    }
    if (request.method === "PUT" && canvasMatch?.[1]) {
      json(response, 200, await writeCanvasState(workspaceDir, decodeURIComponent(canvasMatch[1]), await body(request)));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      const assetPath = decodeURIComponent(url.pathname.slice("/assets/".length));
      const path = resolveAsset(assetPath);
      const page = assetPath.match(/^runs\/([^/]+)\/(?:final\/)?(artifacts\/.+\.html)$/u);
      if (page) {
        const preview = await previews.open(page[1]!, page[2]!).catch(() => undefined);
        if (preview) { response.writeHead(302, { Location: preview.url }); response.end(); return; }
      }
      const info = await stat(path);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
        "Content-Length": info.size,
        ...([".html", ".svg"].includes(extname(path).toLowerCase()) ? { "Content-Security-Policy": "script-src 'none'; object-src 'none'; form-action 'none'" } : {}),
      });
      createReadStream(path).pipe(response);
      return;
    }

    // An unavailable API must never become a successful HTML download via SPA fallback.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "Unknown API endpoint. Restart the DreamaticArt server if it was recently updated." });
      return;
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let staticPath = resolve(webDist, requested);
    if (!staticPath.startsWith(`${webDist}${sep}`) && staticPath !== join(webDist, "index.html")) throw new Error("Invalid path");
    const exists = await stat(staticPath).then(() => true).catch(() => false);
    if (!exists) staticPath = join(webDist, "index.html");
    const content = await readFile(staticPath);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES.get(extname(staticPath)) ?? "application/octet-stream" });
    response.end(content);
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
let server = createServer(handleRequest);

server.once("error", async (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") console.error(`DreamaticArt cannot start because port ${port} is already in use. Stop the previous DreamaticArt dev process, then try again.`);
  else console.error(error);
  await registry.dispose().catch(() => undefined);
  process.exit(1);
});

server.listen(port, desktop ? "127.0.0.1" : undefined, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (desktop && process.send) process.send({ type: "dreamatic-ready", port: actualPort });
  console.log(`DreamaticArt server: http://localhost:${actualPort}`);
  console.log(`Workspace: ${workspaceDir}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await registry.dispose().catch(() => undefined);
  await previews.close();
  server.close();
  server.closeAllConnections();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// A desktop child must not outlive its parent application.
if (desktop && process.connected) process.once("disconnect", () => {
  setTimeout(() => process.exit(0), 5000).unref();
  void shutdown();
});
