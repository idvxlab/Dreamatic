import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clarificationFromToolResult } from "@dreamatic/project-data";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export interface SessionView {
  id: string;
  title: string;
  createdAt: string;
  running: boolean;
  messages: unknown[];
  pendingClarification?: ClarificationRequest;
  projectId?: string;
}

export interface ClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiple: boolean;
  custom: boolean;
  placeholder?: string;
  required: boolean;
}

export interface ClarificationRequest {
  id: string;
  title: string;
  context?: string;
  questions: ClarificationQuestion[];
}

export function clarificationFromMessages(messages: readonly unknown[]): ClarificationRequest | undefined {
  let pending: ClarificationRequest | undefined;
  const calls = new Set<string>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const message = raw as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown };
    if (message.role === "user") {
      pending = undefined;
      calls.clear();
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && block.name === "ask_user" && typeof block.id === "string") calls.add(block.id);
      }
    } else if (message.role === "toolResult" && message.toolName === "ask_user" && typeof message.toolCallId === "string" && calls.has(message.toolCallId)) {
      calls.delete(message.toolCallId);
      const request = clarificationFromToolResult(message, message.toolCallId);
      if (request && !pending) pending = request;
    }
  }
  return pending;
}

// Application session records and read-only Pi history; no agent sessions are created.
export class SessionRegistry {
  readonly #sessions = new Map<string, SessionView>();
  readonly #repoRoot: string;
  readonly #workspaceDir: string;
  get busy(): boolean { return false; }
  constructor(repoRoot: string, workspaceDir: string) { this.#repoRoot = repoRoot; this.#workspaceDir = workspaceDir; }
  async initialize(): Promise<void> {
    const directory = join(this.#workspaceDir, "sessions");
    await mkdir(directory, { recursive: true });
    const saved: SessionView[] = await readFile(join(directory, "registry.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const session of saved) this.#sessions.set(session.id, { ...session, running: false });
    for (const sessionDir of [directory, join(directory, "cli")]) {
      for (const info of await SessionManager.list(this.#repoRoot, sessionDir)) {
        if (this.#sessions.has(info.id)) continue;
        try {
          const messages = SessionManager.open(info.path).buildSessionContext().messages;
          const pendingClarification = clarificationFromMessages(messages);
          this.#sessions.set(info.id, { id: info.id, title: info.name?.trim() || info.firstMessage.trim().slice(0, 72) || "Untitled design", createdAt: info.created.toISOString(), running: false, messages, ...(pendingClarification ? { pendingClarification } : {}) });
        } catch { /* A damaged historical file must not block other projects. */ }
      }
    }
  }
  async create(title = "Untitled design", projectId?: string): Promise<SessionView> {
    const session: SessionView = { id: randomUUID(), title, createdAt: new Date().toISOString(), running: false, messages: [], ...(projectId ? { projectId } : {}) };
    this.#sessions.set(session.id, session);
    const path = join(this.#workspaceDir, "sessions/registry.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify([...this.#sessions.values()], null, 2)); await rename(temporary, path); }
    catch (error) { this.#sessions.delete(session.id); throw error; }
    finally { await rm(temporary, { force: true }); }
    return this.view(session.id);
  }
  async list(): Promise<SessionView[]> { return [...this.#sessions.keys()].map(id => this.view(id, false)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  view(id: string, includeMessages = true): SessionView {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return { ...session, messages: includeMessages ? session.messages : [] };
  }
  async abort(id: string): Promise<{ id: string; interrupted: boolean }> { this.view(id); return { id, interrupted: false }; }
  async reloadConfiguration(): Promise<void> { /* Configuration is consumed by application services directly. */ }
  async dispose(): Promise<void> { this.#sessions.clear(); }
}
