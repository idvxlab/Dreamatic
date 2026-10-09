import { hasUnifiedContext, CONTEXT_PROJECTIONS, annotateModelUsage, collectModelUsage, type ModelUsage } from "@dreamatic/design-agent";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Download-only snapshot. Never alter a Run or start an agent/export workflow. */
export async function prepareProjectExport(workspaceDir: string, runId: string, options: { publication?: Record<string, unknown>; modelFallback?: ModelUsage } = {}): Promise<{ path: string; filename: string; cleanup: () => Promise<void> }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new Error("Invalid run id");
  const runsRoot = await realpath(join(workspaceDir, "runs"));
  const runDir = await realpath(join(runsRoot, runId));
  if (!runDir.startsWith(`${runsRoot}${sep}`)) throw new Error("Invalid run path");
  const state = JSON.parse(await readFile(join(runDir, "run-state.json"), "utf8"));
  if (state.stages?.build !== "completed") throw new Error("Export requires a completed build");
  const events = (await readFile(join(runDir, "bus.jsonl"), "utf8").catch(() => "")).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const receipt = events.findLast((event) => event.type === "build_done")?.commitReceipt?.files;
  const temp = await mkdtemp(join(tmpdir(), "dreamatic-export-"));
  const cleanup = () => rm(temp, { recursive: true, force: true });
  const packageDir = join(temp, runId);
  const files: string[] = [];
  const retired = await hasUnifiedContext(runDir) ? new Set<string>(Object.values(CONTEXT_PROJECTIONS).flat()) : new Set<string>();
  try {
    await mkdir(packageDir);
    async function copy(path: string): Promise<void> {
      if (retired.has(path)) return;
      const source = join(runDir, path);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Cannot export symbolic link: ${path}`);
      if (info.isDirectory()) {
        await mkdir(join(packageDir, path), { recursive: true });
        for (const name of (await readdir(source)).sort()) {
          // Finder metadata, caches and private dotfiles are not deliverables.
          if (name.startsWith(".") || name === "__MACOSX") continue;
          await copy(`${path}/${name}`);
        }
      } else if (info.isFile()) {
        await copyFile(source, join(packageDir, path));
        if (path.startsWith("artifacts/") && typeof receipt?.[path] === "string") {
          const bytes = await readFile(join(packageDir, path));
          if (createHash("sha256").update(bytes).digest("hex") !== receipt[path]) throw new Error(`Build output changed after approval: ${path}`);
        }
        files.push(path);
      } else throw new Error(`Unsupported project file: ${path}`);
    }
    // Keep relative asset links intact, without sessions, caches or duplicate historical Runs.
    for (const path of ["artifacts", "plan", "research", "review", "context", "references", "inputs", "brief.json", "run-state.json"]) {
      const exists = await lstat(join(runDir, path)).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) await copy(path);
    }
    for (const path of Object.keys(receipt ?? {})) {
      if (path.startsWith("artifacts/") && !files.includes(path)) throw new Error(`Committed build output is missing: ${path}`);
    }
    const manifest = JSON.parse(await readFile(join(packageDir, "artifacts/artifact-manifest.json"), "utf8").catch(() => "{}"));
    const entry = manifest.presentation?.entry ?? "artifacts/00-gallery.html";
    if (typeof entry !== "string" || !files.includes(entry) || !entry.endsWith(".html")) throw new Error("Completed project presentation is missing");
    if (receipt && typeof receipt["artifacts/artifact-manifest.json"] !== "string") throw new Error("Build manifest has no approval receipt");
    if (options.modelFallback) {
      const actual = await collectModelUsage(runDir, Array.isArray(manifest.artifacts) ? manifest.artifacts : []);
      const valid = (items: unknown): ModelUsage["reasoning"] => Array.isArray(items) ? items.filter(item => item && typeof item.model === "string" && item.model.trim()) : [];
      const usage: ModelUsage = { schemaVersion: 1, reasoning: [], generation: [] };
      for (const group of ["reasoning", "generation"] as const) {
        const existing = valid(manifest.modelUsage?.[group]);
        usage[group] = existing.length ? existing : valid(actual[group]);
        if (!usage[group].length) usage[group] = options.modelFallback[group];
      }
      manifest.modelUsage = usage;
      await writeFile(join(packageDir, "artifacts/artifact-manifest.json"), JSON.stringify(manifest, null, 2));
      for (const file of ["artifacts/model-usage.json", "plan/model-usage.json"]) {
        await mkdir(join(packageDir, file.split("/")[0]!), { recursive: true });
        await writeFile(join(packageDir, file), JSON.stringify(usage, null, 2));
        if (!files.includes(file)) files.push(file);
      }
      // Publication metadata is applied after checking approved source integrity.
      // Only the export snapshot changes, never the committed Run.
      await writeFile(join(packageDir, entry), annotateModelUsage(await readFile(join(packageDir, entry), "utf8"), usage).replace("</aside>", [...usage.reasoning, ...usage.generation].some(item => item.source === "publication_config_fallback") ? "<br><small>Missing historical records supplemented from settings at publication / 缺失的历史模型记录按发布时配置补录</small></aside>" : "</aside>"));
    }
    const previewEntry = typeof manifest.modelPreviewEntry === "string" && files.includes(manifest.modelPreviewEntry) ? manifest.modelPreviewEntry : entry;
    const entryUrl = previewEntry.split("/").map(encodeURIComponent).join("/");
    // A portable launcher; the approved page itself is copied byte-for-byte.
    await writeFile(join(packageDir, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${entryUrl}"><title>DreamaticArt Preview</title><a href="${entryUrl}">Open preview</a>\n`);
    await writeFile(join(packageDir, "package-manifest.json"), JSON.stringify({ runId, exportedAt: new Date().toISOString(), entry, files: [...files, "index.html", "package-manifest.json"] }, null, 2));
    if (options.publication) await writeFile(join(packageDir, "publication.json"), JSON.stringify(options.publication, null, 2));
    const archive = join(temp, `${runId}.zip`);
    // Argument array (no shell); work on the snapshot so concurrent Run updates cannot enter the archive.
    await exec("zip", ["-q", "-r", archive, runId], { cwd: temp, timeout: 120_000 });
    return { path: archive, filename: `${runId}.zip`, cleanup };
  } catch (error) {
    await cleanup();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && (error as NodeJS.ErrnoException).syscall?.startsWith("spawn")) throw new Error("ZIP export requires the zip utility on the server");
    throw error;
  }
}
