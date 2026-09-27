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
}

interface ManagedSession {
  id: string;
  title: string;
  createdAt: string;
  session: AgentSession;
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
          });
        } catch {
          // One damaged session must not prevent the local workspace from loading.
        }
      }
    }
  }

  async create(title = "Untitled design"): Promise<SessionView> {
    await mkdir(join(this.#workspaceDir, "sessions"), { recursive: true });
    const { session } = await createDreamaticSession({
      repoRoot: this.#repoRoot,
      workspaceDir: this.#workspaceDir,
      sessionDir: join(this.#workspaceDir, "sessions"),
    });
    const managed: ManagedSession = {
      id: session.sessionId,
      title,
      createdAt: new Date().toISOString(),
      session,
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
    return {
      id: managed.id,
      title: managed.title,
      createdAt: managed.createdAt,
      running: managed.session.isStreaming,
      messages: includeMessages ? managed.session.messages : [],
    };
  }

  subscribe(id: string, listener: (event: AgentSessionEvent) => void): () => void {
    return this.get(id).session.subscribe(listener);
  }

  async prompt(
    id: string,
    text: string,
    images: DreamaticPromptImage[],
  ): Promise<void> {
    const managed = this.get(id);
    if (managed.title === "Untitled design" && text.trim()) managed.title = text.trim().slice(0, 54);
    const prepared = await prepareDreamaticPrompt({
      workspaceDir: this.#workspaceDir,
      scopeId: `web-${id}`,
      text,
      images,
    });
    await withRetry(async (attempt) => {
      await managed.session.prompt(
        attempt === 1 ? prepared.text : "The previous provider call failed transiently. Resume from completed tool results and durable Run files. Do not repeat completed work or create a new Run.",
        attempt === 1 ? { images: prepared.images } : undefined,
      );
      const failure = dreamaticSessionFailure(managed.session.messages);
      if (failure) throw new Error(failure);
    }, { attempts: Math.max(1, Number(process.env.DREAMATIC_AGENT_RETRY_ATTEMPTS ?? 3)) });
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
