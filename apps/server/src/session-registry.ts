import { runDesign, atomic } from './design-pipeline.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
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

// Application sessions retain historical Pi transcripts and coordinate current design runs.
export class SessionRegistry {
  readonly #sessions = new Map<string, SessionView>();
  readonly #repoRoot: string;
  readonly #workspaceDir: string;
  readonly #running = new Map<string, { controller: AbortController; session?: AgentSession }>();
  get busy(): boolean { return this.#running.size > 0; }
  async execute(id: string, projectId: string, text: string, emit: (event: unknown) => void, images: Array<{ data: string; mimeType: string }> = []): Promise<void> {
    const view = this.#sessions.get(id);
    if (!view || view.projectId !== projectId) throw new Error('Session does not belong to this project');
    if (this.#running.has(id) || [...this.#running.keys()].some(key => this.#sessions.get(key)?.projectId === projectId)) throw new Error('Project is already running');
    const active: { controller: AbortController; session?: AgentSession } = { controller: new AbortController() };
    this.#running.set(id, active); this.onBusyChanged?.(this.busy); view.running = true; delete view.pendingClarification;
    view.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    try {
      await rm(join(this.#workspaceDir, 'runs', projectId, 'pending-clarification.json'), { force: true });
      await runDesign({ repoRoot: this.#repoRoot, workspaceDir: this.#workspaceDir, runId: projectId, text, images, signal: active.controller.signal, emit,
        onSession: session => { if (session) active.session = session; else delete active.session; },
        onQuestion: request => { view.pendingClarification = request; }
      });
    } finally {
      this.#running.delete(id); this.onBusyChanged?.(this.busy); view.running = false;
      await atomic(join(this.#workspaceDir, 'sessions/registry.json'), [...this.#sessions.values()]);
      emit({ type: 'snapshot', session: this.view(id) });
    }
  }
  constructor(repoRoot: string, workspaceDir: string, private readonly onBusyChanged?: (busy: boolean) => void) { this.#repoRoot = repoRoot; this.#workspaceDir = workspaceDir; }
  async initialize(): Promise<void> {
    const directory = join(this.#workspaceDir, "sessions");
    await mkdir(directory, { recursive: true });
    const saved: SessionView[] = await readFile(join(directory, "registry.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const session of saved) {
      this.#sessions.set(session.id, { ...session, running: false });
      if (session.projectId) {
        const path = join(this.#workspaceDir, 'runs', session.projectId, 'run-state.json');
        const state = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined);
        const pending = await readFile(join(this.#workspaceDir, 'runs', session.projectId, 'pending-clarification.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (pending) { this.#sessions.get(session.id)!.pendingClarification = pending; }
        if (state?.status === 'active' && pending) { state.status = 'waiting_for_user'; await atomic(path, state); }
        else if (state?.status === 'active') { state.status = 'interrupted'; await atomic(path, state); }
      }
    }
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
  async abort(id: string): Promise<{ id: string; interrupted: boolean }> { this.view(id); const active = this.#running.get(id); active?.controller.abort(); await active?.session?.abort(); return { id, interrupted: Boolean(active) }; }
  async reloadConfiguration(): Promise<void> { /* Configuration is consumed by application services directly. */ }
  async dispose(): Promise<void> { for (const id of this.#running.keys()) await this.abort(id); this.#sessions.clear(); }
}
