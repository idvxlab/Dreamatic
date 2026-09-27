import type { Asset, CanvasState, RunView, SessionView } from "./types";

async function parse<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T | { error: string };
  if (!response.ok) throw new Error("error" in (value as object) ? (value as { error: string }).error : response.statusText);
  return value as T;
}

export async function listSessions(): Promise<SessionView[]> {
  return parse(await fetch("/api/sessions"));
}

export async function createSession(): Promise<SessionView> {
  return parse(await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
}

export async function listAssets(): Promise<Asset[]> {
  return parse(await fetch("/api/assets"));
}

export async function listRunAssets(runId: string): Promise<Asset[]> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/assets`));
}

export async function getCanvasState(runId: string): Promise<CanvasState | null> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/canvas`));
}

export async function saveCanvasState(runId: string, state: CanvasState): Promise<CanvasState> {
  return parse(await fetch(`/api/runs/${encodeURIComponent(runId)}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }));
}

export async function listRuns(): Promise<RunView[]> {
  return parse(await fetch("/api/runs"));
}

export interface HealthView {
  ok: boolean;
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

export interface RuntimeConfig {
  activeProfile: string;
  providerName: string;
  providerType: string;
  baseUrl: string;
  model: string;
  imageBaseUrl: string;
  imageModel: string;
  imageGenerationEndpoint: string;
  imageEditEndpoint: string;
  imageDefaultSize: string;
  imageResponseFormat: string;
  textApiKeyConfigured: boolean;
  imageApiKeyConfigured: boolean;
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  return parse(await fetch("/api/config"));
}

export async function saveRuntimeConfig(config: RuntimeConfig & { textApiKey?: string; imageApiKey?: string }): Promise<RuntimeConfig> {
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
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, images }),
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
