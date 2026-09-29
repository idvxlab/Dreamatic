import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createDreamaticSession, dreamaticSessionFailure, prepareDreamaticPrompt, withRetry, type DreamaticPromptImage } from "@dreamatic/design-agent";
import { mkdir } from "node:fs/promises";
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

interface ManagedSession {
  id: string;
  title: string;
  createdAt: string;
  session: AgentSession;
  abortRequested: boolean;
  projectId?: string;
}

export function clarificationFromMessages(messages: readonly unknown[]): ClarificationRequest | undefined {
  let pending: ClarificationRequest | undefined;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const message = raw as { role?: unknown; content?: unknown };
    if (message.role === "user") {
      pending = undefined;
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const rawBlock of message.content) {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) continue;
      const block = rawBlock as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (block.type !== "toolCall" || block.name !== "ask_user" || !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) continue;
      const args = block.arguments as Record<string, unknown>;
      if (!Array.isArray(args.questions)) continue;
      const questions = args.questions.flatMap((rawQuestion, index): ClarificationQuestion[] => {
        if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return [];
        const question = rawQuestion as Record<string, unknown>;
        const prompt = typeof question.question === "string" ? question.question : typeof question.prompt === "string" ? question.prompt : undefined;
        if (!prompt) return [];
        const options = Array.isArray(question.options) ? question.options.flatMap((rawOption): Array<{ label: string; description: string }> => {
          if (typeof rawOption === "string") return [{ label: rawOption, description: rawOption }];
          if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
          const option = rawOption as Record<string, unknown>;
          return typeof option.label === "string" ? [{ label: option.label, description: typeof option.description === "string" ? option.description : option.label }] : [];
        }) : undefined;
        return [{
          id: typeof question.id === "string" ? question.id : `question-${index + 1}`,
          header: typeof question.header === "string" ? question.header : `Question ${index + 1}`,
          question: prompt,
          ...(options?.length ? { options } : {}),
          multiple: question.multiple === true,
          custom: question.custom !== false,
          ...(typeof question.placeholder === "string" ? { placeholder: question.placeholder } : {}),
          required: question.required !== false,
        }];
      });
      if (questions.length) pending = {
        id: typeof block.id === "string" ? block.id : `clarification-${questions.map((question) => question.id).join("-")}`,
        title: typeof args.title === "string" ? args.title : "A few details before we begin",
        ...(typeof args.context === "string" ? { context: args.context } : {}),
        questions,
      };
    }
  }
  return pending;
}

export class SessionRegistry {
  readonly #repoRoot: string;
  readonly #workspaceDir: string;
  readonly #sessions = new Map<string, ManagedSession>();

  constructor(repoRoot: string, workspaceDir: string) {
    this.#repoRoot = repoRoot;
    this.#workspaceDir = workspaceDir;
  }

  async initialize(): Promise<void> {
    await this.#syncSavedSessions();
  }

  async #syncSavedSessions(): Promise<void> {
    const root = join(this.#workspaceDir, "sessions");
    const sessionDirs = [root, join(root, "cli")];
    await Promise.all(sessionDirs.map((directory) => mkdir(directory, { recursive: true })));
    for (const sessionDir of sessionDirs) {
      const saved = await SessionManager.list(this.#repoRoot, sessionDir);
      for (const info of saved) {
        if (this.#sessions.has(info.id)) continue;
        try {
          const { session } = await createDreamaticSession({
            repoRoot: this.#repoRoot,
            workspaceDir: this.#workspaceDir,
            sessionDir,
            sessionFile: info.path,
          });
          this.#sessions.set(info.id, {
            id: info.id,
            title: info.name?.trim() || info.firstMessage.trim().slice(0, 72) || "Untitled design",
            createdAt: info.created.toISOString(),
            session,
            abortRequested: false,
          });
        } catch {
          // One damaged session must not prevent the local workspace from loading.
        }
      }
    }
  }

  async create(title = "Untitled design", projectId?: string): Promise<SessionView> {
    await mkdir(join(this.#workspaceDir, "sessions"), { recursive: true });
    const { session } = await createDreamaticSession({
      repoRoot: this.#repoRoot,
      workspaceDir: this.#workspaceDir,
      sessionDir: join(this.#workspaceDir, "sessions"),
      ...(projectId ? { projectId } : {}),
    });
    const managed: ManagedSession = {
      id: session.sessionId,
      title,
      createdAt: new Date().toISOString(),
      session,
      abortRequested: false,
      ...(projectId ? { projectId } : {}),
    };
    this.#sessions.set(managed.id, managed);
    return this.view(managed.id);
  }

  async list(): Promise<SessionView[]> {
    // CLI tasks may be created while the web server is already running. Pi's
    // session directory remains the source of truth for both entry points.
    await this.#syncSavedSessions();
    return [...this.#sessions.keys()]
      .map((id) => this.view(id, false))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  view(id: string, includeMessages = true): SessionView {
    const managed = this.get(id);
    const pendingClarification = clarificationFromMessages(managed.session.messages);
    return {
      id: managed.id,
      title: managed.title,
      createdAt: managed.createdAt,
      running: managed.session.isStreaming,
      messages: includeMessages ? managed.session.messages : [],
      ...(pendingClarification ? { pendingClarification } : {}),
      ...(managed.projectId ? { projectId: managed.projectId } : {}),
    };
  }

  subscribe(id: string, listener: (event: AgentSessionEvent) => void): () => void {
    return this.get(id).session.subscribe(listener);
  }

  async prompt(
    id: string,
    text: string,
    images: DreamaticPromptImage[],
    projectId?: string,
  ): Promise<void> {
    const managed = this.get(id);
    if (managed.projectId && projectId && managed.projectId !== projectId) throw new Error("This session belongs to a different project");
    const ownedProjectId = managed.projectId ?? projectId;
    if (ownedProjectId && !managed.projectId) managed.projectId = ownedProjectId;
    managed.abortRequested = false;
    if (managed.title === "Untitled design" && text.trim()) managed.title = text.trim().slice(0, 54);
    const prepared = await prepareDreamaticPrompt({
      workspaceDir: this.#workspaceDir,
      scopeId: `web-${id}`,
      text,
      images,
    });
    const projectInstruction = ownedProjectId
      ? `\n\n[DREAMATIC PROJECT OWNERSHIP]\nThis conversation belongs only to project ${ownedProjectId}. If starting its full design workflow, call run_init with runIdOverride exactly \"${ownedProjectId}\". Never create, select, or reuse another Run, even if its title or brief is similar.`
      : "";
    try {
      await withRetry(async (attempt) => {
        await managed.session.prompt(
          attempt === 1 ? `${prepared.text}${projectInstruction}` : "The previous provider call failed transiently. Resume from completed tool results and durable Run files. Do not repeat completed work or create a new Run.",
          attempt === 1 ? { images: prepared.images } : undefined,
        );
        if (managed.abortRequested) throw new Error("Run interrupted by user");
        const failure = dreamaticSessionFailure(managed.session.messages);
        if (failure) throw new Error(failure);
      }, { attempts: Math.max(1, Number(process.env.DREAMATIC_AGENT_RETRY_ATTEMPTS ?? 3)) });
    } finally {
      managed.abortRequested = false;
    }
  }

  async abort(id: string): Promise<{ id: string; interrupted: boolean }> {
    const managed = this.get(id);
    if (!managed.session.isStreaming) return { id, interrupted: false };
    managed.abortRequested = true;
    await managed.session.abort();
    return { id, interrupted: true };
  }

  async dispose(): Promise<void> {
    for (const managed of this.#sessions.values()) managed.session.dispose();
    this.#sessions.clear();
  }

  private get(id: string): ManagedSession {
    const managed = this.#sessions.get(id);
    if (!managed) throw new Error(`Unknown session: ${id}`);
    return managed;
  }
}
