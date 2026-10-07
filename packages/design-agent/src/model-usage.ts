import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { serializeJsonWrite } from "./performance.js";
import { physicalRunFile } from "./design-contract.js";

export interface ModelRecord { model: string; provider: string; role?: string; method?: string; deliverableId?: string; source?: string }
export interface ModelUsage { schemaVersion: 1; reasoning: ModelRecord[]; generation: ModelRecord[] }
const empty = (): ModelUsage => ({ schemaVersion: 1, reasoning: [], generation: [] });
const key = (record: ModelRecord) => JSON.stringify(record);
export async function recordReasoningModel(runDir: string, role: string, model: string, provider: string): Promise<void> {
  if (!model) return;
  const path = join(runDir, ".performance/model-usage.json");
  await serializeJsonWrite(path, async () => {
    const usage: ModelUsage = await readFile(path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return empty(); throw error; });
    const record = { model, provider, role, source: "assistant_response" };
    if (!usage.reasoning.some(item => key(item) === key(record))) usage.reasoning.push(record);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(usage, null, 2));
  });
}
/** Actual response receipts and completed output sidecars, never current settings. */
export async function collectModelUsage(runDir: string, artifacts: Array<{ path: string; deliverableId: unknown }>): Promise<ModelUsage> {
  const usage: ModelUsage = await readFile(join(runDir, ".performance/model-usage.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return empty(); throw error; });
  const generation: ModelRecord[] = [];
  for (const artifact of artifacts) {
    const sidecar = await physicalRunFile(runDir, `${artifact.path}.json`).then(path => readFile(path, "utf8")).then(JSON.parse).catch(() => undefined);
    const record = sidecar?.generationModel;
    if (record && typeof record.model === "string" && record.model) generation.push({ model: record.model, provider: typeof record.provider === "string" ? record.provider : "", method: String(sidecar.tool ?? ""), deliverableId: String(artifact.deliverableId), source: record.source ?? "request" });
  }
  return { schemaVersion: 1, reasoning: usage.reasoning, generation };
}
const escape = (text: string) => text.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function modelCreditHtml(usage: ModelUsage): string {
  const names = (items: ModelRecord[]) => [...new Set(items.map(item => item.model))].join(" · ") || "Not recorded / 未记录";
  return `<aside data-dreamatic-models style="font:12px/1.6 system-ui,sans-serif;color:inherit;opacity:.7;padding:16px 24px;overflow-wrap:anywhere">Reasoning / 推理：${escape(names(usage.reasoning))}<br>Generation / 生成：${escape(names(usage.generation))}</aside>`;
}
export function annotateModelUsage(html: string, usage: ModelUsage): string {
  const stripped = html.replace(/<aside\b[^>]*data-dreamatic-models[^>]*>[\s\S]*?<\/aside>/giu, "");
  const credit = modelCreditHtml(usage);
  return /<\/body>/iu.test(stripped) ? stripped.replace(/<\/body>/iu, `${credit}</body>`) : `${stripped}\n${credit}`;
}

/** A wrapper keeps approved interactive sources byte-for-byte unchanged. */
export async function writeModelPreview(runDir: string, entry: string, usage: ModelUsage): Promise<string> {
  const target = relative(join(runDir, "artifacts"), join(runDir, entry)).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
  const path = "artifacts/00-model-preview.html";
  if (entry === path) throw new Error("Preview entry conflicts with runtime model wrapper");
  await writeFile(join(runDir, path), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DreamaticArt Preview</title><style>body{margin:0;display:flex;flex-direction:column;height:100dvh;background:#fafaf8;color:#343434}iframe{flex:1;width:100%;border:0;min-height:0}</style></head><body><iframe title="Design preview" src="${escape(target)}" sandbox="allow-scripts allow-downloads allow-popups"></iframe>${modelCreditHtml(usage)}</body></html>`);
  return path;
}
