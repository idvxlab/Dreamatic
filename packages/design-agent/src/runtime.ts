import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
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
  "user_material_extract",
  "user_asset_import",
  "research_asset_fetch",
  "research_asset_fetch_batch",
  "research_asset_validate",
  "view_image",
  "image_generate",
  "image_generate_batch",
  "image_edit",
  "image_edit_batch",
  "execute_image_plan",
  "execute_design_plan",
  "html_generate",
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
  sessionManager?: SessionManager;
  inMemory?: boolean;
  projectId?: string;
  getProjectId?: () => string | undefined;
}

let addedToolPaths = new Set<string>();

/** Keep Pi's tools; explicitly expose installed local binaries to its normal resolver. */
export function configureToolSearchPath(): void {
  const configured = [process.env.DREAMATIC_DESKTOP_TOOL_PATH, ...(process.env.DREAMATIC_TOOL_PATH?.split(delimiter) ?? [])].filter((path): path is string => Boolean(path));
  if (configured.some((path) => !isAbsolute(path))) throw new Error("DREAMATIC_TOOL_PATH entries must be absolute directories");
  const current = process.env.PATH?.split(delimiter).filter(path => Boolean(path) && !addedToolPaths.has(path)) ?? [];
  addedToolPaths = new Set(configured.filter(path => !current.includes(path)));
  process.env.PATH = [...new Set([...configured, ...current])].join(delimiter);
}

export async function createDreamaticSession(options: CreateDreamaticSessionOptions) {
  await validateDreamaticPersonaContracts(options.repoRoot);
  try {
    loadEnvFile(join(process.env.DREAMATIC_CONFIG_DIR || options.repoRoot, ".env"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  configureToolSearchPath();
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
      dreamaticPersonaPromptBlock(`# Active DreamaticArt persona: ${persona}\n\n${personaPrompt}`),
    ],
    extensionFactories: [createDreamaticExtension({ workspaceDir: options.workspaceDir, personaPath, get projectId() { return options.getProjectId?.() ?? options.projectId; } })],
  });
  await resourceLoader.reload();
  const thinkingLevel = dreamaticThinkingLevel(persona);

  const result = await createAgentSession({
    cwd: options.repoRoot,
    resourceLoader,
    sessionManager: options.sessionManager ?? (options.sessionFile
      ? SessionManager.open(options.sessionFile, sessionDir, options.repoRoot)
      : options.inMemory
      ? SessionManager.inMemory(options.repoRoot)
      : SessionManager.create(options.repoRoot, sessionDir)),
    tools,
    ...(profile ? { model: profile.modelForPersona(persona) } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  if (options.sessionManager) result.session.setThinkingLevel(thinkingLevel ?? result.session.settingsManager.getDefaultThinkingLevel() ?? "medium");
  return result;
}
