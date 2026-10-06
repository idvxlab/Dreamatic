#!/usr/bin/env node
import { createDreamaticSession, dreamaticSessionFailure, prepareDreamaticPrompt, withRetry, type DreamaticPromptImage } from "@dreamatic/design-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { fileURLToPath } from "node:url";

interface CliOptions {
  task: string;
  images: string[];
  persona: string;
  json: boolean;
  interactive: boolean;
  help: boolean;
  workspace?: string;
  resumeRunId?: string;
}

const MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function parseArgs(args: string[]): CliOptions {
  const task: string[] = [];
  const images: string[] = [];
  let persona = "orchestrator";
  let json = false;
  let interactive = false;
  let help = false;
  let workspace: string | undefined;
  let resumeRunId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--image" || value === "-i") {
      const path = args[++index];
      if (!path) throw new Error(`${value} requires a file path`);
      images.push(path);
    } else if (value === "--persona" || value === "-p") {
      const name = args[++index];
      if (!name) throw new Error(`${value} requires a persona name`);
      persona = name;
    } else if (value === "--workspace") {
      const path = args[++index];
      if (!path) throw new Error("--workspace requires a directory");
      workspace = path;
    } else if (value === "--resume") {
      const runId = args[++index];
      if (!runId) throw new Error("--resume requires a Run id");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid Run id");
      resumeRunId = runId;
    } else if (value === "--json") {
      json = true;
    } else if (value === "--interactive") {
      interactive = true;
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else if (value === "--") {
      task.push(...args.slice(index + 1));
      break;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      task.push(value);
    }
  }

  return { task: task.join(" ").trim(), images, persona, json, interactive, help, ...(workspace ? { workspace } : {}), ...(resumeRunId ? { resumeRunId } : {}) };
}

function printHelp(): void {
  stdout.write(`DreamaticArt CLI — run the same design agent used by the React workspace\n\n`);
  stdout.write(`Usage:\n`);
  stdout.write(`  dreamatic "设计一个展览主视觉和海报系统"\n`);
  stdout.write(`  dreamatic --image reference.png "基于参考图设计品牌海报"\n`);
  stdout.write(`  dreamatic --resume <runId>        Resume an interrupted Run\n`);
  stdout.write(`  dreamatic                         Start an interactive session\n`);
  stdout.write(`  Get-Content brief.md | dreamatic  Read a task from stdin\n\n`);
  stdout.write(`Options:\n`);
  stdout.write(`  -i, --image <path>       Attach a reference image; repeatable\n`);
  stdout.write(`  -p, --persona <name>     Persona to run; default orchestrator\n`);
  stdout.write(`      --workspace <path>   Override the runtime workspace directory\n`);
  stdout.write(`      --resume <runId>     Reopen the latest CLI session for an interrupted Run\n`);
  stdout.write(`      --interactive        Continue interactively after the first task\n`);
  stdout.write(`      --json               Emit newline-delimited Pi events\n`);
  stdout.write(`  -h, --help               Show this help\n`);
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let tail = "";
  for await (const chunk of stream) {
    const value = tail + String(chunk);
    if (value.includes(needle)) return true;
    tail = value.slice(-Math.max(needle.length - 1, 0));
  }
  return false;
}

async function resumableSessionFile(workspaceDir: string, runId: string): Promise<string> {
  const directory = join(workspaceDir, "sessions", "cli");
  const matches: Array<{ path: string; modifiedAt: number }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(directory, entry.name);
    if (!await fileContains(path, runId).catch(() => false)) continue;
    matches.push({ path, modifiedAt: (await stat(path)).mtimeMs });
  }
  matches.sort((a, b) => b.modifiedAt - a.modifiedAt);
  if (!matches[0]) throw new Error(`No persisted CLI session found for Run ${runId}`);
  return matches[0].path;
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function loadImages(paths: string[]) {
  return Promise.all(paths.map(async (input) => {
    const path = resolve(input);
    const mimeType = MIME_TYPES.get(extname(path).toLowerCase());
    if (!mimeType) throw new Error(`Unsupported image format: ${input}`);
    return { type: "image" as const, data: (await readFile(path)).toString("base64"), mimeType, name: basename(path) };
  }));
}

function eventRenderer(json: boolean): (event: AgentSessionEvent) => void {
  if (json) return (event) => stdout.write(`${JSON.stringify(event)}\n`);
  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      stderr.write(`\n  → ${event.toolName}\n`);
    } else if (event.type === "tool_execution_end") {
      stderr.write(`  ✓ ${event.toolName}\n`);
    }
  };
}

async function runPrompt(
  session: AgentSession,
  task: string,
  images: DreamaticPromptImage[],
  json: boolean,
  workspaceDir: string,
  scopeId: string,
): Promise<void> {
  if (!task.trim()) return;
  const prepared = await prepareDreamaticPrompt({ workspaceDir, scopeId, text: task, images });
  await withRetry(async (attempt) => {
    await session.prompt(
      attempt === 1 ? prepared.text : "The previous provider call failed transiently. Resume from completed tool results and durable Run files. Do not repeat completed work or create a new Run.",
      attempt === 1 ? { images: prepared.images } : undefined,
    );
    const failure = dreamaticSessionFailure(session.messages);
    if (failure) throw new Error(failure);
  }, {
    attempts: Math.max(1, Number(process.env.DREAMATIC_AGENT_RETRY_ATTEMPTS ?? 3)),
    onRetry: (notice) => { if (!json) stderr.write(`\n  ↻ reconnecting (${notice.nextAttempt}/${Number(process.env.DREAMATIC_AGENT_RETRY_ATTEMPTS ?? 3)}): ${notice.error}\n`); },
  });
  if (!json) stdout.write("\n");
}

async function interactiveLoop(session: AgentSession, json: boolean, workspaceDir: string, scopeId: string): Promise<void> {
  if (json) throw new Error("--json cannot be combined with interactive mode");
  const readline = createInterface({ input: stdin, output: stdout });
  stdout.write("DreamaticArt interactive session. Use /exit to finish.\n");
  try {
    while (true) {
      const input = (await readline.question("dreamatic › ")).trim();
      if (["/exit", "/quit", "exit", "quit"].includes(input.toLowerCase())) break;
      if (input) await runPrompt(session, input, [], false, workspaceDir, scopeId);
    }
  } finally {
    readline.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const configuredWorkspace = options.workspace ?? process.env.DREAMATIC_WORKSPACE ?? join(repoRoot, "workspace");
  const workspaceDir = isAbsolute(configuredWorkspace) ? configuredWorkspace : resolve(repoRoot, configuredWorkspace);
  let task = options.task;
  if (options.resumeRunId && !task) {
    task = `Resume the existing DreamaticArt Run ${options.resumeRunId}. Do not call run_init and do not create a new Run. Read run-state.json, bus.jsonl, the current todo, and durable Design Context; continue from the first incomplete responsibility. Reuse completed work and existing child sessions. Complete the Researcher-Designer-Reviewer loop, invoke Builder only after design_review_pass, then export unless the Run is already complete.`;
  }
  if (!task && !stdin.isTTY) task = await stdinText();
  const shouldInteract = options.interactive || (!task && stdin.isTTY);

  const { session } = await createDreamaticSession({
    repoRoot,
    workspaceDir,
    persona: options.persona,
    sessionDir: join(workspaceDir, "sessions", "cli"),
    ...(options.resumeRunId ? { sessionFile: await resumableSessionFile(workspaceDir, options.resumeRunId) } : {}),
  });
  const unsubscribe = session.subscribe(eventRenderer(options.json));
  const abort = () => void session.abort();
  process.once("SIGINT", abort);
  const promptScopeId = `cli-${Date.now().toString(36)}`;
  try {
    if (task) await runPrompt(session, task, await loadImages(options.images), options.json, workspaceDir, promptScopeId);
    if (shouldInteract) await interactiveLoop(session, options.json, workspaceDir, promptScopeId);
  } finally {
    process.removeListener("SIGINT", abort);
    unsubscribe();
    session.dispose();
  }
}

main().catch((error: unknown) => {
  stderr.write(`DreamaticArt CLI error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
