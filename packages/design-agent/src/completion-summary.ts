import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readRunContext } from "./context-model.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const clean = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/gu, " ").slice(0, 140) : "";
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
async function json(path: string): Promise<Record<string, unknown>> {
  return readFile(path, "utf8").then(source => object(JSON.parse(source))).catch(error => { if (error.code === "ENOENT") return {}; throw error; });
}
async function context(runDir: string, path: string): Promise<Record<string, unknown>> {
  return readRunContext(runDir, path).then(source => object(JSON.parse(source))).catch(error => { if (error.code === "ENOENT") return {}; throw error; });
}
async function jsonl(path: string) {
  const source = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return source.split(/\r?\n/gu).flatMap(line => { try { return [object(JSON.parse(line))]; } catch { return []; } });
}

/** One source for usage; stage metrics duplicate these responses and must not be added. */
export function completionUsage(events: Record<string, unknown>[]) {
  const requests = new Map<string, Record<string, unknown>>();
  for (const [index, event] of events.entries()) {
    if (!["provider_request", "provider_response_complete"].includes(String(event.type))) continue;
    const key = typeof event.requestId === "string" ? event.requestId : `unidentified-${index}`;
    if (!requests.has(key) || event.type === "provider_response_complete") requests.set(key, event);
  }
  let tokens = 0, input = 0, output = 0, reported = 0;
  for (const event of requests.values()) {
    const usage = object(event.usage);
    const total = number(usage.totalTokens);
    if (event.type !== "provider_response_complete" || total === undefined || total === 0) continue;
    tokens += total; input += number(usage.input) ?? 0; output += number(usage.output) ?? 0; reported++;
  }
  return { totalTokens: reported ? tokens : null, inputTokens: reported ? input : null, outputTokens: reported ? output : null,
    reportedRequests: reported, observedRequests: requests.size, complete: requests.size > 0 && reported === requests.size };
}

/** Extract only recorded follow-up actions, not creative synthesis or issue diagnoses. */
function nextDirections(strategy: Record<string, unknown>, review: Record<string, unknown>) {
  const readiness = object(strategy.implementation_readiness);
  const candidates: unknown[] = [strategy.future_directions, readiness.next_steps, readiness.future_tests, readiness.validation_plan, review.remaining_risks];
  return [...new Set(candidates.flatMap(value => (Array.isArray(value) ? value : [value]).map(item => {
    if (typeof item === "string") return clean(item);
    const record = object(item);
    return clean(record.next_step ?? record.recommendation ?? record.mitigation ?? record.required_validation);
  })).filter(Boolean))].slice(0, 3);
}

export async function writeCompletionSummary(runDir: string, runId: string, finalDir: string, completedAt = new Date().toISOString()) {
  const [brief, built, bus, requests, plan, manifest, review] = await Promise.all([
    json(join(runDir, "brief.json")), json(join(runDir, "artifacts/artifact-manifest.json")), jsonl(join(runDir, "bus.jsonl")),
    jsonl(join(runDir, ".performance/model-requests.jsonl")),
    context(runDir, "plan/design_plan.json"),
    context(runDir, "plan/deliverable_manifest.json"),
    context(runDir, "review/design-review.json"),
  ]);
  const revision = bus.findLast(event => event.type === "run_revision_started");
  const id = `${runId}-completion-${revision?.id ?? "initial"}`;
  const existing = bus.find(event => event.type === "project_completed" && event.id === id);
  if (existing) return { summary: object(existing.completion), event: existing, fresh: false };
  const startedAt = revision?.at ?? bus.find(event => event.type === "design_categories_identified" || event.type === "agent_started")?.at ?? brief.createdAt;
  const started = time(startedAt), ended = time(completedAt);
  const inRound = (event: Record<string, unknown>) => !revision || time(event.at) >= started;
  const usage = completionUsage(requests.filter(inRound));
  const cumulativeUsage = completionUsage(requests);
  const artifacts = records(built.artifacts);
  const delivered = records(manifest.deliverables).filter(item => artifacts.some(artifact => artifact.deliverableId === item.id && artifact.path === item.file && (number(artifact.bytes) ?? 0) > 0));
  const missingOptional = records(manifest.deliverables).filter(item => item.required !== true && !delivered.some(done => done.id === item.id));
  const required = records(manifest.deliverables).filter(item => item.required === true);
  const directions = nextDirections(plan, review);
  const presentation = object(built.presentation ?? manifest.presentation);
  const entry = typeof presentation.entry === "string" ? presentation.entry : "artifacts/00-gallery.html";
  const elapsedMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
  const priorRounds = new Map(bus.filter(event => event.type === "project_completed").map(event => [String(event.id), object(event.completion)]));
  const cumulativeElapsedMs = elapsedMs === null || [...priorRounds.values()].some(round => number(round.elapsedMs) === undefined) ? null : elapsedMs + [...priorRounds.values()].reduce((sum, round) => sum + (number(round.elapsedMs) ?? 0), 0);
  const imageCalls = bus.filter(event => event.type === "image_request_metrics" && inRound(event)).length;
  const zh = /[\u3400-\u9fff]/u.test(String(brief.originalRequest ?? brief.brief ?? brief.title));
  const title = clean(brief.title) || runId;
  const minutes = elapsedMs === null ? null : Math.ceil(elapsedMs / 60_000);
  const tokenText = usage.totalTokens === null ? (zh ? "未记录" : "not recorded") : usage.totalTokens.toLocaleString("en-US");
  const groups = new Map<string, number>();
  for (const item of delivered) { const kind = clean(item.kind) || (/\.html$/iu.test(String(item.file)) ? "html_page" : /\.(png|jpe?g|webp)$/iu.test(String(item.file)) ? "image" : "other"); groups.set(kind, (groups.get(kind) ?? 0) + 1); }
  const labels: Record<string, string> = zh ? { html_page: "网页", image: "设计图", other: "其他成果" } : { html_page: "HTML page(s)", image: "image(s)", other: "other output(s)" };
  const deliveryText = [...groups].map(([kind, count]) => `${count} ${labels[kind] ?? kind}`).join(zh ? "、" : ", ");
  const lines = zh ? [
    `项目已完成：${title}`,
    `完成情况：${Array.isArray(manifest.deliverables) ? `必需交付物 ${delivered.filter(item => item.required === true).length}/${required.length}，` : "交付数量未记录，"}交付校验通过，成果已导出。${missingOptional.length ? `另有 ${missingOptional.length} 项可选成果未生成。` : ""}`,
    `消耗：本轮总历时${minutes === null ? "未记录" : `约 ${minutes} 分钟`}（含等待、重试）；文本模型 ${tokenText} Token${usage.complete ? "" : "（统计不完整）"}。图片 Token 未计入；已记录图像接口调用 ${imageCalls} 次。`,
    ...(revision ? [`项目累计总历时约 ${cumulativeElapsedMs === null ? "未记录" : Math.ceil(cumulativeElapsedMs / 60_000)} 分钟；文本 Token：${cumulativeUsage.totalTokens?.toLocaleString("en-US") ?? "未记录"}${cumulativeUsage.complete ? "" : "（统计不完整）"}。`] : []),
    `成功交付：${deliveryText || "参见交付清单"}。`,
    `后续方向：${directions.length ? directions.join("；") : "暂无已记录的后续方向"}。`,
  ] : [
    `Project completed: ${title}`,
    `Completion: ${Array.isArray(manifest.deliverables) ? `${delivered.filter(item => item.required === true).length}/${required.length} required outputs delivered` : "delivery counts not recorded"}; delivery checks passed and package exported.${missingOptional.length ? ` ${missingOptional.length} optional outputs were not produced.` : ""}`,
    `Usage: ${minutes === null ? "unrecorded" : `about ${minutes} minutes`} elapsed this round (including waits/retries); ${tokenText} text-model tokens${usage.complete ? "" : " (incomplete statistics)"}. Image tokens excluded; ${imageCalls} image API calls recorded.`,
    ...(revision ? [`Project cumulative elapsed: ${cumulativeElapsedMs === null ? "unrecorded" : Math.ceil(cumulativeElapsedMs / 60_000)} minutes; text tokens: ${cumulativeUsage.totalTokens?.toLocaleString("en-US") ?? "not recorded"}${cumulativeUsage.complete ? "" : " (incomplete statistics)"}.`] : []),
    `Delivered: ${deliveryText || "see delivery manifest"}.`,
    `Next directions: ${directions.length ? directions.join("; ") : "none recorded"}.`,
  ];
  const summary = { schemaVersion: 1, id, runId, title, startedAt, completedAt, elapsedMs, cumulativeElapsedMs, usage, cumulativeUsage, imageCalls,
    imageTokenUsage: null, requiredCount: required.length, delivered: delivered.map(item => ({ id: item.id, kind: item.kind, purpose: item.purpose, file: item.file })),
    missingOptional: missingOptional.map(item => ({ id: item.id, purpose: item.purpose })), directions, entry, text: lines.join("\n") };
  const source = JSON.stringify(summary, null, 2);
  const temporary = join(runDir, `completion-summary.${randomUUID()}.tmp`);
  await writeFile(temporary, source); await rename(temporary, join(runDir, "completion-summary.json"));
  await writeFile(join(finalDir, "completion-summary.json"), source);
  const exported = await json(join(finalDir, "package-manifest.json"));
  await writeFile(join(finalDir, "package-manifest.json"), JSON.stringify({ ...exported, files: [...new Set([...Array.isArray(exported.files) ? exported.files : [], "completion-summary.json"]) ] }, null, 2));
  const event = { id, runId, type: "project_completed", at: completedAt, from_agent: "orchestrator", summary: zh ? "项目完成总结" : "Project completion summary", detail: summary.text,
    artifactRefs: [`runs/${runId}/${entry}`], completion: summary };
  return { summary, event, fresh: true };
}
