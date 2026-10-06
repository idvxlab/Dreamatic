import type { AgentSession, Asset, CanvasState, RunView, SessionView, WorkflowEvent } from "./types";

async function parse<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T | { error: string };
  if (!response.ok) throw new Error("error" in (value as object) ? (value as { error: string }).error : response.statusText);
  return value as T;
}

const getCache = new Map<string, { etag: string; value: unknown }>();
const getInFlight = new Map<string, Promise<unknown>>();
async function conditionalGet<T>(url: string): Promise<T> {
  const pending = getInFlight.get(url);
  if (pending) return pending as Promise<T>;
  const request = fetchConditional<T>(url); getInFlight.set(url, request);
  try { return await request; } finally { if (getInFlight.get(url) === request) getInFlight.delete(url); }
}
async function fetchConditional<T>(url: string): Promise<T> {
  const cached = getCache.get(url);
  const response = await fetch(url, cached ? { headers: { "If-None-Match": cached.etag } } : {});
  if (response.status === 304 && cached) return cached.value as T;
  const value = await parse<T>(response);
  const etag = response.headers.get("etag");
  if (etag) {
    getCache.delete(url); getCache.set(url, { etag, value });
    while (getCache.size > 128) getCache.delete(getCache.keys().next().value!);
  }
  return value;
}

export async function listSessions(): Promise<SessionView[]> {
  return conditionalGet("/api/sessions");
}

export async function createSession(projectId?: string, title?: string): Promise<SessionView> {
  return parse(await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, title }) }));
}

export async function abortSession(sessionId: string): Promise<{ id: string; interrupted: boolean }> {
  return parse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }));
}

export async function listAssets(): Promise<Asset[]> {
  return conditionalGet("/api/assets");
}

export async function listRunAssets(runId: string): Promise<Asset[]> {
  return conditionalGet(`/api/runs/${encodeURIComponent(runId)}/assets`);
}

export async function getCanvasState(runId: string): Promise<CanvasState | null> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/canvas`));
}

export async function getHtmlPreview(runId: string, entry?: string): Promise<{ url: string; entries: Array<{ path: string; url: string }> }> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry ? { entry } : {}) }));
}

export async function saveCanvasState(runId: string, state: CanvasState): Promise<CanvasState> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }));
}

export async function listRuns(): Promise<RunView[]> {
  return conditionalGet("/api/runs?summary=1");
}

export async function getRun(runId: string): Promise<RunView> {
  return conditionalGet(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function renameRun(runId: string, title: string): Promise<{ id: string; title: string }> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }));
}

export async function deleteRun(runId: string): Promise<{ id: string; trashedPath: string }> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }));
}

export async function listAgentSessions(runId: string): Promise<AgentSession[]> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/agent-sessions`));
}

export async function getWorkflow(runId: string): Promise<WorkflowEvent[]> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/workflow`));
}

export type WorkflowStreamMessage =
  | { type: "snapshot"; workflow: WorkflowEvent[] }
  | { type: "workflow_event"; event: Record<string, unknown> };

export function streamWorkflow(runId: string, onEvent: (event: WorkflowStreamMessage) => void): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/workflow/stream`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as WorkflowStreamMessage);
  return () => source.close();
}

export interface HealthView {
  ok: boolean;
  processId: number;
  workspaceDir: string;
  profile: string;
  provider: string;
  model: string;
  imageModel: string;
  textApiReady: boolean;
  imageApiReady: boolean;
  runCount: number;
  cliSessionCount: number;
}

export async function getHealth(): Promise<HealthView> {
  return parse(await fetch("/api/health"));
}

export interface ConfigField { key: string; label: string; module: string; example: string; description: string; type: string; defaultValue: string; options?: string[]; min?: number; max?: number; restartRequired?: boolean }
export interface RuntimeConfig {
  envPath: string;
  modules: Array<{ id: string; title: string; description: string }>;
  fields: ConfigField[];
  values: Record<string, string>;
  secretConfigured: Record<string, boolean>;
  secrets?: Record<string, string>;
  activeProfile: string;
  providerName: string;
  providerType: string;
  baseUrl: string;
  model: string;
  searchProvider: string;
  imageBaseUrl: string;
  imageModel: string;
  imageGenerationEndpoint: string;
  imageEditEndpoint: string;
  imageDefaultSize: string;
  imageResponseFormat: string;
  textApiKeyConfigured: boolean;
  searchApiKeyConfigured: boolean;
  imageApiKeyConfigured: boolean;
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  return parse(await fetch("/api/config"));
}

export async function saveRuntimeConfig(config: RuntimeConfig & { textApiKey?: string; searchApiKey?: string; imageApiKey?: string }): Promise<RuntimeConfig> {
  return parse(await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }));
}

export interface PromptEvent {
  type: "agent_event" | "snapshot" | "error";
  event?: Record<string, unknown>;
  session?: SessionView;
  message?: string;
}

export async function streamPrompt(
  sessionId: string,
  text: string,
  images: Array<{ name?: string; data: string; mimeType: string }>,
  onEvent: (event: PromptEvent) => void,
  projectId?: string,
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, images, projectId, compactEvents: true }),
  });
  if (!response.ok || !response.body) throw new Error(`Request failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as PromptEvent);
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as PromptEvent);
}

/** Download the package without asking an agent to regenerate or export it. */
export async function downloadProject(runId: string): Promise<void> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/export`);
  if (!response.ok) {
    const value = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(value.error ?? "Project export failed");
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/zip") {
    throw new Error("Export did not return a ZIP file. Restart the DreamaticArt server to load the export API, then try again.");
  }
  const blob = await response.blob();
  const expectedLength = response.headers.get("content-length");
  if (expectedLength && !response.headers.get("content-encoding") && Number(expectedLength) !== blob.size) {
    throw new Error("Project ZIP download is incomplete. Please retry Export.");
  }
  const header = new DataView(await blob.slice(0, 4).arrayBuffer());
  const tailBytes = await blob.slice(Math.max(0, blob.size - 65_557)).arrayBuffer();
  const tail = new DataView(tailBytes);
  let complete = false;
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (tail.getUint32(offset, true) !== 0x06054b50 || offset + 22 + tail.getUint16(offset + 20, true) !== tail.byteLength) continue;
    const directorySize = tail.getUint32(offset + 12, true);
    const directoryOffset = tail.getUint32(offset + 16, true);
    const endOffset = blob.size - tail.byteLength + offset;
    // ZIP64 carries its sizes in the preceding ZIP64 directory records.
    complete = directoryOffset + directorySize === endOffset || (directoryOffset === 0xffffffff && directorySize === 0xffffffff);
    break;
  }
  if (header.byteLength !== 4 || ![0x04034b50, 0x06054b50].includes(header.getUint32(0, true)) || !complete) {
    throw new Error("Project ZIP is invalid or incomplete. Please retry Export.");
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `${runId}.zip`; link.hidden = true;
  document.body.appendChild(link); link.click(); link.remove();
  // Allow the browser to consume the blob before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
