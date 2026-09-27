import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { readCanvasState, writeCanvasState } from "./canvas-store.js";
import { assetInventory, runInventory } from "./run-store.js";
import { SessionRegistry } from "./session-registry.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
try { loadEnvFile(join(repoRoot, ".env")); } catch { /* The diagnostics endpoint reports missing configuration. */ }
const configuredWorkspace = process.env.DREAMATIC_WORKSPACE?.trim();
// Relative workspace paths are project settings, not process-working-directory settings.
// npm workspaces launch this package from apps/server, so resolve them from the repo root.
const workspaceDir = configuredWorkspace
  ? resolve(repoRoot, configuredWorkspace)
  : join(repoRoot, "workspace");
const webDist = join(repoRoot, "apps", "web", "dist");
const port = Number(process.env.PORT ?? 4310);
await mkdir(workspaceDir, { recursive: true });

const registry = new SessionRegistry(repoRoot, workspaceDir);
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

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

const CONFIG_KEYS = {
  activeProfile: "DREAMATIC_ACTIVE_PROFILE",
  providerName: "DREAMATIC_PROVIDER_NAME",
  providerType: "DREAMATIC_PROVIDER_TYPE",
  baseUrl: "DREAMATIC_BASE_URL",
  model: "DREAMATIC_MODEL",
  imageBaseUrl: "DREAMATIC_IMAGE_BASE_URL",
  imageModel: "DREAMATIC_IMAGE_MODEL",
  imageGenerationEndpoint: "DREAMATIC_IMAGE_GENERATION_ENDPOINT",
  imageEditEndpoint: "DREAMATIC_IMAGE_EDIT_ENDPOINT",
  imageDefaultSize: "DREAMATIC_IMAGE_DEFAULT_SIZE",
  imageResponseFormat: "DREAMATIC_IMAGE_RESPONSE_FORMAT",
} as const;

function configView() {
  return {
    ...Object.fromEntries(Object.entries(CONFIG_KEYS).map(([field, key]) => [field, process.env[key] ?? ""])),
    textApiKeyConfigured: Boolean(process.env.DREAMATIC_API_KEY),
    imageApiKeyConfigured: Boolean(process.env.DREAMATIC_IMAGE_API_KEY || process.env.DREAMATIC_API_KEY),
  };
}

async function saveConfig(input: Record<string, unknown>): Promise<void> {
  const envPath = join(repoRoot, ".env");
  const source = await readFile(envPath, "utf8").catch(() => "");
  const updates = new Map<string, string>();
  for (const [field, key] of Object.entries(CONFIG_KEYS)) {
    const value = input[field];
    if (typeof value === "string") updates.set(key, value.trim());
  }
  if (typeof input.textApiKey === "string" && input.textApiKey.trim()) updates.set("DREAMATIC_API_KEY", input.textApiKey.trim());
  if (typeof input.imageApiKey === "string" && input.imageApiKey.trim()) updates.set("DREAMATIC_IMAGE_API_KEY", input.imageApiKey.trim());
  for (const [key, value] of updates) {
    if (key.includes("URL") || key.includes("ENDPOINT")) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${key} must use http or https`);
    }
    process.env[key] = value;
  }
  const remaining = new Map(updates);
  const lines = source.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=/);
    if (!match || !remaining.has(match[1]!)) return line;
    const key = match[1]!;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  await writeFile(envPath, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function resolveAsset(path: string): string {
  const candidate = resolve(workspaceDir, path);
  if (candidate !== workspaceDir && !candidate.startsWith(`${workspaceDir}${sep}`)) throw new Error("Invalid asset path");
  return candidate;
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const runCount = (await readdir(join(workspaceDir, "runs"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory()).length;
      const cliSessionCount = (await readdir(join(workspaceDir, "sessions", "cli"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length;
      json(response, 200, {
        ok: true,
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
      json(response, 200, configView());
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/config") {
      await saveConfig(record(await body(request)));
      json(response, 200, configView());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      json(response, 200, await registry.list());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const input = record(await body(request));
      json(response, 201, await registry.create(typeof input.title === "string" ? input.title : undefined));
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
      const images = Array.isArray(input.images)
        ? input.images.flatMap((value) => {
            const item = record(value);
            return typeof item.data === "string" && typeof item.mimeType === "string"
              ? [{ type: "image" as const, data: item.data, mimeType: item.mimeType, ...(typeof item.name === "string" ? { name: item.name } : {}) }]
              : [];
          })
        : [];
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (value: unknown) => response.write(`${JSON.stringify(value)}\n`);
      const unsubscribe = registry.subscribe(promptMatch[1], (event) => send({ type: "agent_event", event }));
      try {
        await registry.prompt(promptMatch[1], input.text, images);
        send({ type: "snapshot", session: registry.view(promptMatch[1]) });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        unsubscribe();
        response.end();
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/assets") {
      json(response, 200, await assetInventory(workspaceDir));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      json(response, 200, await runInventory(workspaceDir));
      return;
    }
    const runAssetsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/assets$/);
    if (request.method === "GET" && runAssetsMatch?.[1]) {
      json(response, 200, await assetInventory(workspaceDir, decodeURIComponent(runAssetsMatch[1])));
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
      const path = resolveAsset(decodeURIComponent(url.pathname.slice("/assets/".length)));
      const info = await stat(path);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
        "Content-Length": info.size,
      });
      createReadStream(path).pipe(response);
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
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`Dreamatic server: http://localhost:${port}`);
  console.log(`Workspace: ${workspaceDir}`);
});

async function shutdown(): Promise<void> {
  await registry.dispose();
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
