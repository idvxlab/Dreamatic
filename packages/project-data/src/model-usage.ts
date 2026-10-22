import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { physicalRunFile } from "./preview.js";

export interface ModelRecord { model: string; provider: string; role?: string; method?: string; deliverableId?: string; source?: string }
export interface ModelUsage { schemaVersion: 1; reasoning: ModelRecord[]; generation: ModelRecord[] }
const empty = (): ModelUsage => ({ schemaVersion: 1, reasoning: [], generation: [] });
const key = (record: ModelRecord) => JSON.stringify(record);
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

