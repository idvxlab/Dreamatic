import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { createDreamaticExtension } from "./extension.js";
import { safeRunId } from "./paths.js";
import { dreamaticProviderFromEnv } from "./provider.js";
export { dreamaticSessionFailure } from "./session-status.js";

export const DREAMATIC_ACTIVE_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "use_skill",
  "list_skills",
  "todo_write",
  "run_init",
  "design_bus_post",
  "design_bus_read",
  "spawn_agent",
  "websearch",
  "research_fetch",
  "research_asset_discover",
  "research_asset_fetch",
  "research_asset_validate",
  "view_image",
  "image_generate",
  "image_edit",
  "compare_images",
  "select_artifact",
  "artifact_lint",
  "export_package",
] as const;

export interface CreateDreamaticSessionOptions {
  repoRoot: string;
  workspaceDir: string;
  persona?: string;
  sessionDir?: string;
  sessionFile?: string;
  inMemory?: boolean;
}

export async function createDreamaticSession(options: CreateDreamaticSessionOptions) {
  try {
    loadEnvFile(join(options.repoRoot, ".env"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const persona = safeRunId(options.persona ?? "design-primary");
  const profile = dreamaticProviderFromEnv();
  const personaPath = join(options.repoRoot, ".pi", "agents", `${persona}.md`);
  const personaSource = await readFile(personaPath, "utf8");
  const { body: personaPrompt } = parseFrontmatter<Record<string, unknown>>(personaSource);
  const sessionDir = options.sessionDir ?? join(options.workspaceDir, "sessions");
  await mkdir(sessionDir, { recursive: true });

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.repoRoot,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      `# Active Dreamatic persona: ${persona}\n\n${personaPrompt}`,
    ],
    extensionFactories: [createDreamaticExtension({ workspaceDir: options.workspaceDir })],
  });
  await resourceLoader.reload();

  return createAgentSession({
    cwd: options.repoRoot,
    resourceLoader,
    sessionManager: options.sessionFile
      ? SessionManager.open(options.sessionFile, sessionDir, options.repoRoot)
      : options.inMemory
      ? SessionManager.inMemory(options.repoRoot)
      : SessionManager.create(options.repoRoot, sessionDir),
    tools: [...DREAMATIC_ACTIVE_TOOLS],
    ...(profile ? { model: profile.model } : {}),
  });
}
