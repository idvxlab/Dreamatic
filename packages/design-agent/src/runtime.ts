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
import { createDreamaticExtension, dreamaticPersonaTools, dreamaticPersonaPromptBlock, validateDreamaticPersonaContracts } from "./extension.js";
import { safeRunId } from "./paths.js";
import { dreamaticProviderFromEnv, dreamaticThinkingLevel } from "./provider.js";
export { dreamaticSessionFailure } from "./session-status.js";

export const DREAMATIC_ACTIVE_TOOLS = [
  "read",
  "write",
  "write_json",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "todo_write",
  "ask_user",
  "list_skills",
  "use_skill",
  "run_init",
  "run_revision",
  "design_bus_post",
  "design_bus_read",
  "design_context_read",
  "spawn_agent",
  "websearch",
  "websearch_batch",
  "research_fetch",
  "research_fetch_batch",
  "research_asset_discover",
  "research_asset_fetch",
  "research_asset_fetch_batch",
  "research_asset_validate",
  "view_image",
  "image_generate",
  "image_generate_batch",
  "image_edit",
  "image_edit_batch",
  "compare_images",
  "select_artifact",
  "build_finalize",
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
  projectId?: string;
}

export async function createDreamaticSession(options: CreateDreamaticSessionOptions) {
  await validateDreamaticPersonaContracts(options.repoRoot);
  try {
    loadEnvFile(join(options.repoRoot, ".env"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const persona = safeRunId(options.persona ?? "orchestrator");
  const profile = dreamaticProviderFromEnv();
  const personaPath = join(options.repoRoot, ".pi", "agents", `${persona}.md`);
  const personaSource = await readFile(personaPath, "utf8");
  const { frontmatter, body: personaPrompt } = parseFrontmatter<{ allowed_tools?: unknown }>(personaSource);
  const tools = dreamaticPersonaTools(persona, frontmatter.allowed_tools);
  const sessionDir = options.sessionDir ?? join(options.workspaceDir, "sessions");
  await mkdir(sessionDir, { recursive: true });

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.repoRoot,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      dreamaticPersonaPromptBlock(`# Active Dreamatic persona: ${persona}\n\n${personaPrompt}`),
    ],
    extensionFactories: [createDreamaticExtension({ workspaceDir: options.workspaceDir, personaPath, ...(options.projectId ? { projectId: options.projectId } : {}) })],
  });
  await resourceLoader.reload();
  const thinkingLevel = dreamaticThinkingLevel(persona);

  return createAgentSession({
    cwd: options.repoRoot,
    resourceLoader,
    sessionManager: options.sessionFile
      ? SessionManager.open(options.sessionFile, sessionDir, options.repoRoot)
      : options.inMemory
      ? SessionManager.inMemory(options.repoRoot)
      : SessionManager.create(options.repoRoot, sessionDir),
    tools,
    ...(profile ? { model: profile.modelForPersona(persona) } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
}
