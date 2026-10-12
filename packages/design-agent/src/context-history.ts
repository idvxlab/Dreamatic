import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const text = (message: Record<string, any>) => (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
const parse = (source: string) => { try { return record(JSON.parse(source)); } catch { return {}; } };

/** Projects only the provider's copy. Tool-call arguments remain intact:
 * models may copy historical arguments into a new write. */
export async function compactPersistedHistory(messages: unknown[], options: { cwd: string; runDir?: string; role?: string }) {
  const calls = new Map<string, Record<string, any>>();
  const results = new Map<string, Record<string, any>>();
  for (const raw of messages) {
    const message = record(raw);
    if (message.role === "assistant") for (const block of message.content ?? []) if (block.type === "toolCall") calls.set(block.id, block);
    if (message.role === "toolResult" && !message.isError && parse(text(message)).ok !== false) results.set(message.toolCallId, message);
  }
  const root = options.runDir ? await realpath(options.runDir).catch(() => undefined) : undefined;
  const files = new Map<string, Promise<{ path: string; content: string } | undefined>>();
  const savedFile = (path: unknown) => {
    if (typeof path !== "string" || !root) return Promise.resolve(undefined);
    const absolute = isAbsolute(path) ? path : resolve(options.cwd, path);
    if (!files.has(absolute)) files.set(absolute, (async () => {
      const physical = await realpath(absolute).catch(() => undefined);
      if (!physical) return;
      const local = relative(root, physical);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) return;
      return readFile(physical, "utf8").then(content => ({ path: physical, content })).catch(() => undefined);
    })());
    return files.get(absolute)!;
  };

  // A read and use_skill may both contain the same body. Keep one complete version,
  // with every activation receipt; different versions are never conflated.
  const skillBodies = new Map<string, string>();
  for (const message of results.values()) {
    if (message.toolName !== "use_skill") continue;
    const source = text(message), start = source.search(/^---\s*$/m);
    if (start < 0) continue;
    const body = source.slice(start), key = hash(body);
    if (skillBodies.has(key)) {
      message.content = [{ type: "text", text: `${source.slice(0, start)}[Identical Skill body ${key} retained in its earlier load; activation above still applies.]` }];
    } else skillBodies.set(key, body);
  }
  for (const message of results.values()) {
    if (message.toolName !== "read") continue;
    const source = text(message);
    for (const [sha256, body] of skillBodies) if (source.includes(body)) {
      message.content = message.content.map((block: any) => block.type === "text"
        ? { ...block, text: block.text.replace(body, `[Identical Skill body ${sha256} retained in use_skill. This native read did not activate a scope.]`) } : block);
      break;
    }
  }

  const latestReads = new Map<string, Record<string, any>>();
  const findingsSaved = options.role === "researcher" && [...results.entries()].some(([id, result]) =>
    result.toolName === "update_design_context" && parse(text(result)).saved === true && typeof record(calls.get(id)?.arguments).changes?.findings === "string");
  const researchDraft = findingsSaved && options.runDir ? await savedFile(join(options.runDir, ".performance/context-draft-researcher.json")) : undefined;
  const researchData = record(parse(researchDraft?.content ?? "").data);
  const sources = record(researchData.evidence).official_sources;
  const retainedSourceUrls = typeof researchData.findings === "string" && researchData.findings.trim() && Array.isArray(sources)
    ? sources.map(source => record(source).url).filter((url: unknown) => typeof url === "string" && /^https?:\/\//.test(url)) : [];
  let assistantsAfter = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = record(messages[index]);
    if (message.role === "assistant") { assistantsAfter++; continue; }
    if (message.role !== "toolResult" || message.isError || parse(text(message)).ok === false) continue;
    const call = calls.get(message.toolCallId), args = record(call?.arguments);
    if (message.toolName === "design_context_read" || message.toolName === "list_skills") {
      // Identical selectors only: a draft, overview and complete section remain distinct.
      const key = `${message.toolName}:${JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))}`;
      if (latestReads.has(key) && assistantsAfter >= 2 && text(message).length > 2000) {
        message.content = [{ type: "text", text: `[Earlier ${message.toolName} result superseded by the later successful read with the same arguments ${JSON.stringify(args)}. Use that result; reread before editing current content.]` }];
      } else latestReads.set(key, message);
    }
    if (message.toolName === "read" && assistantsAfter >= 2 && text(message).length > 2000 && retainedSourceUrls.length) {
      const saved = await savedFile(args.path);
      if (saved && relative(root!, saved.path).startsWith("research/sources/") && saved.path.endsWith(".txt") &&
        text(message).includes(saved.content) &&
        retainedSourceUrls.some((url: string) => saved.content.split("\n").slice(0, 3).includes(url))) {
        message.content = [{ type: "text", text: `[Earlier research source retained on disk; findings and source provenance are saved in working Research Context. path=${saved.path}; sha256=${hash(saved.content)}. Read the source again before making a new claim or checking exact evidence.]` }];
      }
    }
    if (message.toolName === "research_fetch_batch" && assistantsAfter >= 2) {
      const payload = parse(text(message));
      if (!Array.isArray(payload.results)) continue;
      let changed = false;
      for (const item of payload.results) {
        if (item.ok !== true || typeof item.text !== "string") continue;
        const path = typeof item.cachedPath === "string" && options.runDir ? join(options.runDir, "../..", item.cachedPath) : undefined;
        const saved = await savedFile(path);
        // Remove a preview only when a later successful read already supplied
        // this exact cached source. Initial research evidence stays available.
        const laterRead = messages.slice(index + 1).some(raw => {
          const candidate = record(raw), laterArgs = record(calls.get(candidate.toolCallId)?.arguments);
          return candidate.role === "toolResult" && candidate.toolName === "read" && !candidate.isError && saved &&
            resolve(options.cwd, String(laterArgs.path ?? "")) === saved.path;
        });
        if (saved && laterRead && saved.content.includes(item.text)) { item.text = `[Preview omitted; complete cached source was read later. path=${saved.path}; sha256=${hash(saved.content)}. Reload with read for exact evidence.]`; changed = true; }
      }
      if (changed) message.content = [{ type: "text", text: JSON.stringify(payload) }];
    }
  }
}
