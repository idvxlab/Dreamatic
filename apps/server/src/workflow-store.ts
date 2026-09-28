import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { createInterface } from "node:readline";

export type WorkflowKind = "message" | "tool" | "agent" | "references" | "milestone" | "retry" | "error";
export type WorkflowStatus = "running" | "completed" | "interrupted" | "error" | "info";

export interface WorkflowAssetView {
  path: string;
  label: string;
}

export interface WorkflowEventView {
  id: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  actor: string;
  label: string;
  detail?: string;
  at?: string;
  endedAt?: string;
  stage?: string;
  tool?: string;
  input?: string;
  output?: string;
  artifactRefs?: string[];
  assets?: WorkflowAssetView[];
  children?: WorkflowEventView[];
  actionCount?: number;
  agent?: string;
}

interface SessionInvocation extends WorkflowEventView {
  kind: "agent";
  agent: string;
  children: WorkflowEventView[];
}

const LIFECYCLE_TYPES = new Set([
  "agent_started",
  "agent_retry",
  "agent_finished",
  "agent_interrupted",
  "tool_started",
  "tool_finished",
  "reference_added",
  "primary_tool_started",
  "primary_tool_finished",
]);

const AGENT_TITLES: Record<string, string> = {
  "design-research": "Research agent",
  "design-planner": "Planning agent",
  "design-designer": "Design agent",
  "design-critic": "Critic agent",
};

const COMPLETION_EVENT_AGENTS: Record<string, string> = {
  research_done: "design-research",
  plan_done: "design-planner",
  design_done: "design-designer",
  evaluator_pass: "design-critic",
  evaluator_fail: "design-critic",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: string, limit = 900): string {
  const text = value.replace(/data:[^;]+;base64,[a-zA-Z0-9+/=]+/gu, "[image payload omitted]").trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function contentText(value: unknown, limit = 900): string {
  if (typeof value === "string") return compact(value, limit);
  if (!Array.isArray(value)) return "";
  return compact(value.map(record).flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n"), limit);
}

function userFacingPrompt(value: string): string {
  return value.replace(/\n\n\[DREAMATIC PROJECT OWNERSHIP\][\s\S]*$/u, "").trim();
}

function compactJson(value: unknown, limit = 700): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value, (key, item) => {
      if (["data", "imageData", "base64", "b64_json"].includes(key) && typeof item === "string") return `[payload omitted · ${item.length} chars]`;
      return item;
    }, 2);
    return text ? compact(text, limit) : undefined;
  } catch {
    return compact(String(value), limit);
  }
}

function normalizeRunPath(value: string, runId: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^file:\/\//, "").replace(/["'`,)\]}]+$/u, "");
  const marker = `/runs/${runId}/`;
  const markerIndex = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex >= 0) return `runs/${runId}/${normalized.slice(markerIndex + marker.length)}`;
  if (normalized.startsWith(`runs/${runId}/`)) return normalized;
  if (/^(research|plan|artifacts|review|final)\//u.test(normalized)) return `runs/${runId}/${normalized}`;
  return undefined;
}

function collectPaths(value: unknown, runId: string, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const direct = normalizeRunPath(value, runId);
    if (direct && /\.(png|jpe?g|webp|gif|html|md|json)$/iu.test(direct)) result.add(direct);
    for (const match of value.matchAll(/(?:[a-zA-Z]:)?[^\s"']*(?:runs[\\/][a-zA-Z0-9._-]+[\\/])?(?:research|plan|artifacts|review|final)[\\/][^\s"']+?\.(?:png|jpe?g|webp|gif|html|md|json)/giu)) {
      const path = normalizeRunPath(match[0], runId);
      if (path) result.add(path);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, runId, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectPaths(item, runId, result);
  }
  return result;
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    ask_user: "Clarifying the brief",
    run_init: "Created design Run",
    use_skill: "Loaded design knowledge",
    spawn_agent: "Called specialist agent",
    web_search: "Searched the web",
    research_fetch: "Read research source",
    research_asset_discover: "Discovered reference images",
    research_asset_fetch: "Saved reference image",
    research_asset_validate: "Validated reference library",
    image_generate: "Generated design image",
    image_edit: "Edited design image",
    view_image: "Inspected image",
    compare_images: "Compared design images",
    artifact_lint: "Checked deliverables",
    export_package: "Exported design package",
    todo_write: "Updated workflow plan",
    read: "Read project file",
    write: "Wrote project file",
    edit: "Edited project file",
    ls: "Inspected project files",
  };
  return labels[tool] ?? tool.replaceAll("_", " ");
}

function eventTime(event: WorkflowEventView): number {
  const value = Date.parse(event.at ?? "");
  return Number.isFinite(value) ? value : 0;
}

function sortEvents(events: WorkflowEventView[]): WorkflowEventView[] {
  return events.sort((a, b) => eventTime(a) - eventTime(b));
}

async function sessionLines(path: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      const safeLine = line.length > 500_000
        ? line.replace(/"(?:data|b64_json|imageData|base64)"\s*:\s*"[^"]*"/gu, '"data":"[image payload omitted]"')
        : line;
      result.push(record(JSON.parse(safeLine) as unknown));
    } catch {
      // A session may end with a partial line after interruption.
    }
  }
  return result;
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  const input = createReadStream(path, { encoding: "utf8" });
  let tail = "";
  for await (const chunk of input) {
    const text = tail + String(chunk);
    if (text.includes(needle)) return true;
    tail = text.slice(-Math.max(needle.length - 1, 0));
  }
  return false;
}

async function childInvocations(path: string, agent: string, runId: string): Promise<SessionInvocation[]> {
  const lines = await sessionLines(path);
  const invocations: SessionInvocation[] = [];
  let current: SessionInvocation | undefined;
  let sessionId = basename(path, extname(path));
  let invocationIndex = 0;
  const pending = new Map<string, WorkflowEventView>();

  const finish = (status: SessionInvocation["status"], at?: string) => {
    if (!current) return;
    current.status = status;
    if (at) current.endedAt = at;
    current.actionCount = current.children.filter((event) => event.kind === "tool").length;
  };

  for (const envelope of lines) {
    const at = typeof envelope.timestamp === "string" ? envelope.timestamp : undefined;
    if (envelope.type === "session" && typeof envelope.id === "string") sessionId = envelope.id;
    if (envelope.type !== "message") continue;
    const message = record(envelope.message);
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "user") {
      if (current?.status === "running") finish("interrupted", at);
      invocationIndex += 1;
      current = {
        id: `${sessionId}-invocation-${invocationIndex}`,
        kind: "agent",
        status: "running",
        actor: "Primary agent",
        agent,
        label: AGENT_TITLES[agent] ?? agent.replaceAll("-", " "),
        detail: contentText(message.content, 1_200),
        ...(at ? { at } : {}),
        children: [],
        actionCount: 0,
      };
      invocations.push(current);
      pending.clear();
      continue;
    }
    if (!current) continue;
    if (role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = contentText(parts, 1_200);
      if (text) current.output = text;
      for (const [index, rawPart] of parts.entries()) {
        const part = record(rawPart);
        if (part.type !== "toolCall" || typeof part.name !== "string") continue;
        if (part.name === "design_bus_post") continue;
        const id = typeof part.id === "string" ? part.id : `${current.id}-tool-${index}`;
        const refs = [...collectPaths(part.arguments, runId)];
        const input = compactJson(part.arguments);
        const toolEvent: WorkflowEventView = {
          id,
          kind: "tool",
          status: "running",
          actor: current.label,
          label: toolLabel(part.name),
          tool: part.name,
          ...(at ? { at } : {}),
          ...(input ? { input } : {}),
          ...(refs.length ? { artifactRefs: refs } : {}),
        };
        current.children.push(toolEvent);
        pending.set(id, toolEvent);
      }
      if (message.stopReason === "error") {
        const error = typeof message.errorMessage === "string" ? message.errorMessage : "Agent execution was interrupted";
        current.children.push({ id: `${current.id}-error-${current.children.length}`, kind: "error", status: "error", actor: current.label, label: "Agent interrupted", detail: compact(error, 900), ...(at ? { at } : {}) });
        finish("interrupted", at);
      } else if (message.stopReason === "stop") {
        finish("completed", at);
      }
      continue;
    }
    if (role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const toolEvent = pending.get(id);
      if (!toolEvent) continue;
      const isError = message.isError === true;
      const refs = [...collectPaths(message.content, runId)];
      toolEvent.status = isError ? "error" : "completed";
      toolEvent.output = contentText(message.content, 900);
      if (at) toolEvent.endedAt = at;
      if (refs.length) toolEvent.artifactRefs = [...new Set([...(toolEvent.artifactRefs ?? []), ...refs])];
    }
  }
  if (current?.status === "running") finish("running");
  for (const invocation of invocations) sortEvents(invocation.children);
  return invocations;
}

async function primaryEvents(path: string, runId: string): Promise<WorkflowEventView[]> {
  const lines = await sessionLines(path);
  const result: WorkflowEventView[] = [];
  const pending = new Map<string, WorkflowEventView>();
  let sessionId = basename(path, extname(path));
  for (const envelope of lines) {
    const at = typeof envelope.timestamp === "string" ? envelope.timestamp : undefined;
    if (envelope.type === "session" && typeof envelope.id === "string") sessionId = envelope.id;
    if (envelope.type !== "message") continue;
    const message = record(envelope.message);
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "user") {
      const detail = userFacingPrompt(contentText(message.content, 1_200));
      if (detail) result.push({ id: `${sessionId}-user-${result.length}`, kind: "message", status: "completed", actor: "User / CLI", label: "You", detail, ...(at ? { at } : {}) });
      continue;
    }
    if (role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = contentText(parts, 1_200);
      if (text) result.push({ id: `${sessionId}-assistant-${result.length}`, kind: "message", status: "completed", actor: "Primary agent", label: "Primary agent", detail: text, ...(at ? { at } : {}) });
      for (const [index, rawPart] of parts.entries()) {
        const part = record(rawPart);
        if (part.type !== "toolCall" || typeof part.name !== "string") continue;
        const id = typeof part.id === "string" ? part.id : `${sessionId}-tool-${index}-${result.length}`;
        const args = record(part.arguments);
        const agent = part.name === "spawn_agent" && typeof args.agent === "string" ? args.agent : undefined;
        const refs = [...collectPaths(part.arguments, runId)];
        const input = compactJson(part.arguments);
        const event: WorkflowEventView = agent ? {
          id,
          kind: "agent",
          status: "running",
          actor: "Primary agent",
          agent,
          label: AGENT_TITLES[agent] ?? agent.replaceAll("-", " "),
          ...(typeof args.task === "string" ? { detail: compact(args.task, 1_200) } : {}),
          ...(at ? { at } : {}),
          children: [],
          actionCount: 0,
        } : {
          id,
          kind: "tool",
          status: "running",
          actor: "Primary agent",
          label: toolLabel(part.name),
          tool: part.name,
          ...(at ? { at } : {}),
          ...(input ? { input } : {}),
          ...(refs.length ? { artifactRefs: refs } : {}),
        };
        result.push(event);
        pending.set(id, event);
      }
      if (message.stopReason === "error") result.push({ id: `${sessionId}-error-${result.length}`, kind: "error", status: "error", actor: "Primary agent", label: "Primary agent interrupted", detail: typeof message.errorMessage === "string" ? compact(message.errorMessage) : "Agent execution was interrupted", ...(at ? { at } : {}) });
      continue;
    }
    if (role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const event = pending.get(id);
      if (!event) continue;
      const isError = message.isError === true;
      event.status = isError ? "error" : "completed";
      event.output = contentText(message.content, 900);
      if (at) event.endedAt = at;
      const refs = [...collectPaths(message.content, runId)];
      if (refs.length) event.artifactRefs = [...new Set([...(event.artifactRefs ?? []), ...refs])];
    }
  }
  return sortEvents(result);
}

async function readBusRecords(runDir: string): Promise<Record<string, unknown>[]> {
  const lines = await readFile(join(runDir, "bus.jsonl"), "utf8").catch(() => "");
  return lines.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [record(JSON.parse(line) as unknown)]; } catch { return []; }
  });
}

function lifecycleInvocations(records: Record<string, unknown>[], runId: string): SessionInvocation[] {
  const invocations = new Map<string, SessionInvocation>();
  const tools = new Map<string, WorkflowEventView>();
  const references = new Map<string, WorkflowEventView>();
  for (const [index, event] of records.entries()) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!LIFECYCLE_TYPES.has(type) || typeof event.invocationId !== "string") continue;
    const invocationId = event.invocationId;
    const agent = typeof event.agent === "string" ? event.agent : "design-specialist";
    const at = typeof event.at === "string" ? event.at : undefined;
    let invocation = invocations.get(invocationId);
    if (!invocation) {
      invocation = {
        id: invocationId,
        kind: "agent",
        status: "running",
        actor: "Primary agent",
        agent,
        label: AGENT_TITLES[agent] ?? agent.replaceAll("-", " "),
        ...(typeof event.task === "string" ? { detail: compact(event.task, 1_200) } : {}),
        ...(at ? { at } : {}),
        children: [],
        actionCount: 0,
      };
      invocations.set(invocationId, invocation);
    }
    if (type === "agent_started") {
      if (typeof event.task === "string") invocation.detail = compact(event.task, 1_200);
      if (at) invocation.at = at;
      continue;
    }
    if (type === "tool_started") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `${invocationId}-tool-${index}`;
      const tool: WorkflowEventView = {
        id: toolCallId,
        kind: "tool",
        status: "running",
        actor: invocation.label,
        label: toolLabel(toolName),
        tool: toolName,
        ...(typeof event.input === "string" ? { input: compact(event.input, 900) } : {}),
        ...(at ? { at } : {}),
      };
      invocation.children.push(tool);
      tools.set(`${invocationId}:${toolCallId}`, tool);
      invocation.actionCount = (invocation.actionCount ?? 0) + 1;
      continue;
    }
    if (type === "tool_finished") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      let tool = tools.get(`${invocationId}:${toolCallId}`);
      if (!tool) {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        tool = { id: toolCallId || `${invocationId}-tool-${index}`, kind: "tool", status: "running", actor: invocation.label, label: toolLabel(toolName), tool: toolName, ...(at ? { at } : {}) };
        invocation.children.push(tool);
        tools.set(`${invocationId}:${tool.id}`, tool);
        invocation.actionCount = (invocation.actionCount ?? 0) + 1;
      }
      tool.status = event.isError === true ? "error" : "completed";
      if (typeof event.output === "string") tool.output = compact(event.output, 1_200);
      if (at) tool.endedAt = at;
      tool.artifactRefs = [...collectPaths(event.output, runId)];
      continue;
    }
    if (type === "reference_added" && typeof event.path === "string") {
      let reference = references.get(invocationId);
      if (!reference) {
        reference = { id: `${invocationId}-references`, kind: "references", status: "completed", actor: invocation.label, label: "Reference library", detail: "Visual references collected during this research step.", ...(at ? { at } : {}), assets: [] };
        references.set(invocationId, reference);
        invocation.children.push(reference);
      }
      const path = normalizeRunPath(event.path, runId) ?? event.path.replaceAll("\\", "/");
      if (!reference.assets?.some((asset) => asset.path === path)) reference.assets?.push({ path, label: path.split("/").at(-1) ?? "Reference" });
      reference.detail = `${reference.assets?.length ?? 0} visual reference${reference.assets?.length === 1 ? "" : "s"} collected during this research step.`;
      if (at) reference.endedAt = at;
      continue;
    }
    if (type === "agent_retry") {
      invocation.children.push({ id: `${invocationId}-retry-${index}`, kind: "retry", status: "running", actor: invocation.label, label: `Reconnecting · attempt ${String(event.nextAttempt ?? "")}`.trim(), ...(typeof event.error === "string" ? { detail: compact(event.error) } : {}), ...(at ? { at } : {}) });
      continue;
    }
    if (type === "agent_finished") {
      invocation.status = "completed";
      if (typeof event.output === "string") invocation.output = compact(event.output, 1_200);
      if (at) invocation.endedAt = at;
      continue;
    }
    if (type === "agent_interrupted") {
      invocation.status = event.status === "interrupted" ? "interrupted" : "error";
      invocation.children.push({ id: `${invocationId}-error-${index}`, kind: "error", status: "error", actor: invocation.label, label: invocation.status === "interrupted" ? "Agent interrupted" : "Agent failed", ...(typeof event.error === "string" ? { detail: compact(event.error) } : {}), ...(at ? { at } : {}) });
      if (at) invocation.endedAt = at;
    }
  }
  // A specialist can commit its durable domain result immediately before its
  // provider/session transport ends. That canonical result is stronger
  // completion evidence than a missing agent_finished event.
  for (const event of records) {
    const type = typeof event.type === "string" ? event.type : "";
    const agent = COMPLETION_EVENT_AGENTS[type];
    const at = typeof event.at === "string" ? event.at : undefined;
    if (!agent || !at) continue;
    const time = Date.parse(at);
    const invocation = [...invocations.values()]
      .filter((candidate) => candidate.agent === agent && candidate.status === "running" && eventTime(candidate) <= time)
      .sort((left, right) => eventTime(right) - eventTime(left))[0];
    if (!invocation) continue;
    invocation.status = "completed";
    invocation.endedAt = at;
    if (typeof event.summary === "string") invocation.output = compact(event.summary, 1_200);
  }
  for (const invocation of invocations.values()) sortEvents(invocation.children);
  return [...invocations.values()];
}

function primaryLifecycleEvents(records: Record<string, unknown>[], runId: string): WorkflowEventView[] {
  const events: WorkflowEventView[] = [];
  const tools = new Map<string, WorkflowEventView>();
  for (const [index, event] of records.entries()) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!["primary_tool_started", "primary_tool_finished"].includes(type)) continue;
    const id = typeof event.toolCallId === "string" ? event.toolCallId : `primary-tool-${index}`;
    if (type === "primary_tool_started") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const node: WorkflowEventView = { id, kind: "tool", status: "running", actor: "Primary agent", label: toolLabel(toolName), tool: toolName, ...(typeof event.input === "string" ? { input: compact(event.input, 900) } : {}), ...(typeof event.at === "string" ? { at: event.at } : {}) };
      events.push(node);
      tools.set(id, node);
      continue;
    }
    let node = tools.get(id);
    if (!node) {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      node = { id, kind: "tool", status: "running", actor: "Primary agent", label: toolLabel(toolName), tool: toolName, ...(typeof event.at === "string" ? { at: event.at } : {}) };
      events.push(node);
      tools.set(id, node);
    }
    node.status = event.isError === true ? "error" : "completed";
    if (typeof event.output === "string") node.output = compact(event.output, 1_200);
    if (typeof event.at === "string") node.endedAt = event.at;
    node.artifactRefs = [...collectPaths(event.output, runId)];
  }
  return events;
}

function busEvents(records: Record<string, unknown>[], runId: string): WorkflowEventView[] {
  const result = records.flatMap((event, index) => {
    try {
      const type = typeof event.type === "string" ? event.type : "workflow_update";
      if (LIFECYCLE_TYPES.has(type)) return [];
      const failed = type.includes("fail") || type.includes("interrupted") || event.severity === "error";
      const retry = type === "operation_retry";
      const refs = [...collectPaths(event.artifactRefs, runId)];
      const operation = typeof event.operation === "string" ? event.operation : "operation";
      const scope = typeof event.scope === "string" ? event.scope : "default";
      const attempt = typeof event.nextAttempt === "number" ? event.nextAttempt : undefined;
      return [{
        id: retry ? `retry-${operation}-${scope}` : typeof event.id === "string" ? event.id : `bus-${index}`,
        kind: retry ? "retry" as const : failed ? "error" as const : "milestone" as const,
        status: retry ? "running" as const : failed ? "error" as const : "completed" as const,
        actor: typeof event.from_agent === "string" ? event.from_agent : typeof event.from === "string" ? event.from : "Workflow",
        label: retry ? `Retrying ${toolLabel(operation)}${scope === "default" ? "" : ` · ${scope}`}${attempt ? ` · attempt ${attempt}` : ""}` : typeof event.summary === "string" ? event.summary : type.replaceAll("_", " "),
        ...(typeof event.requestedAction === "string" ? { detail: event.requestedAction } : typeof event.error === "string" ? { detail: compact(event.error) } : {}),
        ...(typeof event.at === "string" ? { at: event.at } : {}),
        ...(typeof event.phase === "string" ? { stage: event.phase } : {}),
        ...(refs.length ? { artifactRefs: refs } : {}),
      }];
    } catch { return []; }
  });
  const deduplicated = new Map<string, WorkflowEventView>();
  for (const event of result) deduplicated.set(event.id, event);
  return [...deduplicated.values()];
}

async function referenceAssets(workspaceDir: string, runId: string): Promise<Array<WorkflowAssetView & { at: string }>> {
  const directory = join(workspaceDir, "runs", runId, "research", "assets");
  const result: Array<WorkflowAssetView & { at: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.(png|jpe?g|webp|gif)$/iu.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const info = await stat(path);
    result.push({ path: relative(workspaceDir, path).replaceAll("\\", "/"), label: entry.name, at: info.mtime.toISOString() });
  }
  return result.sort((a, b) => a.at.localeCompare(b.at));
}

async function rootSessionFiles(workspaceDir: string, runId: string): Promise<string[]> {
  const result: string[] = [];
  for (const directory of [join(workspaceDir, "sessions"), join(workspaceDir, "sessions", "cli")]) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(directory, entry.name);
      if (await fileContains(path, runId).catch(() => false)) result.push(path);
    }
  }
  return result;
}

async function runBriefEvent(runDir: string, runId: string): Promise<WorkflowEventView | undefined> {
  const brief: Record<string, unknown> = await readFile(join(runDir, "brief.json"), "utf8").then((source) => record(JSON.parse(source) as unknown)).catch(() => ({}));
  if (typeof brief.brief !== "string" || !brief.brief.trim()) return undefined;
  return {
    id: `${runId}-brief`,
    kind: "message",
    status: "completed",
    actor: "User / CLI",
    label: "You",
    detail: compact(brief.brief, 1_200),
    ...(typeof brief.createdAt === "string" ? { at: brief.createdAt } : {}),
  };
}

export async function workflowInventory(workspaceDir: string, runId: string): Promise<WorkflowEventView[]> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid run id");
  const runDir = join(workspaceDir, "runs", runId);
  const busRecords = await readBusRecords(runDir);
  const liveInvocations = lifecycleInvocations(busRecords, runId);
  const hasLifecycleHistory = liveInvocations.length > 0;
  const invocations: SessionInvocation[] = [];
  const sessionsRoot = join(runDir, "sessions");
  if (!hasLifecycleHistory) {
    for (const agentEntry of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!agentEntry.isDirectory()) continue;
      const directory = join(sessionsRoot, agentEntry.name);
      for (const file of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (file.isFile() && file.name.endsWith(".jsonl")) invocations.push(...await childInvocations(join(directory, file.name), agentEntry.name, runId));
      }
    }
  }
  sortEvents(invocations);

  const sessionHistory = (await Promise.all((await rootSessionFiles(workspaceDir, runId)).map((path) => primaryEvents(path, runId)))).flat();
  const conversation = sessionHistory.filter((event) => event.kind === "message");
  const briefFallback = conversation.length ? [] : [await runBriefEvent(runDir, runId)].filter((event): event is WorkflowEventView => Boolean(event));
  const primary = hasLifecycleHistory
    ? [...briefFallback, ...conversation, ...primaryLifecycleEvents(busRecords, runId)]
    : sessionHistory;
  sortEvents(primary);
  for (const liveTool of hasLifecycleHistory ? [] : primaryLifecycleEvents(busRecords, runId)) {
    const persisted = primary.find((event) => event.id === liveTool.id);
    if (persisted) Object.assign(persisted, liveTool);
    else primary.push(liveTool);
  }
  sortEvents(primary);
  const unused = new Set(invocations.map((invocation) => invocation.id));
  const spawnEvents = primary.filter((event) => event.kind === "agent" && Boolean(event.agent));
  for (const [spawnIndex, event] of spawnEvents.entries()) {
    if (!event.agent) continue;
    const start = eventTime(event);
    const explicitEnd = Date.parse(event.endedAt ?? "");
    const nextStart = eventTime(spawnEvents[spawnIndex + 1] ?? { id: "end", kind: "message", status: "info", actor: "", label: "" });
    const windowEnd = Number.isFinite(explicitEnd) ? explicitEnd + 2_000 : nextStart > start ? nextStart : Number.MAX_SAFE_INTEGER;
    let matches = invocations.filter((invocation) => unused.has(invocation.id) && invocation.agent === event.agent && eventTime(invocation) >= start - 2_000 && eventTime(invocation) <= windowEnd);
    if (!matches.length) {
      const fallback = invocations.find((invocation) => unused.has(invocation.id) && invocation.agent === event.agent);
      if (fallback) matches = [fallback];
    }
    if (!matches.length) continue;
    for (const match of matches) unused.delete(match.id);
    const last = matches.at(-1)!;
    if (event.status === "running") event.status = last.status;
    if (matches[0]?.detail) event.detail = matches[0].detail;
    if (last.output) event.output = last.output;
    if (!event.endedAt && last.endedAt) event.endedAt = last.endedAt;
    event.children = sortEvents(matches.flatMap((match) => match.children));
    event.actionCount = matches.reduce((total, match) => total + (match.actionCount ?? 0), 0);
  }

  for (const live of liveInvocations) {
    const persisted = primary.find((event) => event.kind === "agent" && event.id === live.id);
    if (persisted) {
      persisted.status = live.status;
      if (live.detail) persisted.detail = live.detail;
      if (live.output) persisted.output = live.output;
      if (live.at) persisted.at = live.at;
      if (live.endedAt) persisted.endedAt = live.endedAt;
      persisted.children = live.children;
      if (live.actionCount !== undefined) persisted.actionCount = live.actionCount;
    } else {
      primary.push(live);
    }
    const start = eventTime(live);
    const end = Date.parse(live.endedAt ?? "");
    for (const candidate of invocations) {
      if (unused.has(candidate.id) && candidate.agent === live.agent && eventTime(candidate) >= start - 2_000 && (!Number.isFinite(end) || eventTime(candidate) <= end + 2_000)) unused.delete(candidate.id);
    }
  }
  sortEvents(primary);

  const milestones = busEvents(busRecords, runId);
  const allInvocations = primary.filter((event): event is SessionInvocation => event.kind === "agent" && Boolean(event.agent)) as SessionInvocation[];
  allInvocations.push(...invocations.filter((invocation) => unused.has(invocation.id)));
  const unplacedMilestones: WorkflowEventView[] = [];
  for (const milestone of milestones) {
    const time = eventTime(milestone);
    const owner = allInvocations.find((invocation) => {
      const start = eventTime(invocation);
      const end = invocation.status === "running" ? Number.MAX_SAFE_INTEGER : Date.parse(invocation.endedAt ?? invocation.at ?? "");
      return time >= start && time <= (Number.isFinite(end) ? end + 2_000 : Number.MAX_SAFE_INTEGER);
    });
    if (owner) owner.children.push(milestone);
    else unplacedMilestones.push(milestone);
  }

  const references = await referenceAssets(workspaceDir, runId);
  if (references.length) {
    const research = allInvocations.find((invocation) => invocation.agent === "design-research");
    const existing = research?.children.find((event) => event.kind === "references");
    if (existing) {
      const assets = [...(existing.assets ?? [])];
      for (const { path, label } of references) if (!assets.some((asset) => asset.path === path)) assets.push({ path, label });
      existing.assets = assets;
      existing.detail = `${assets.length} visual references collected and preserved for this Run.`;
    } else {
      const referenceEvent: WorkflowEventView = {
        id: `${runId}-reference-library`,
        kind: "references",
        status: "completed",
        actor: research?.label ?? "Research agent",
        label: "Reference library",
        detail: `${references.length} visual references collected and preserved for this Run.`,
        ...(references.at(-1)?.at ? { at: references.at(-1)!.at } : {}),
        assets: references.map(({ path, label }) => ({ path, label })),
      };
      if (research) research.children.push(referenceEvent);
      else unplacedMilestones.push(referenceEvent);
    }
  }

  for (const invocation of allInvocations) sortEvents(invocation.children);
  const unmatchedInvocations = invocations.filter((invocation) => unused.has(invocation.id));
  return sortEvents([...primary, ...unmatchedInvocations, ...unplacedMilestones]);
}
