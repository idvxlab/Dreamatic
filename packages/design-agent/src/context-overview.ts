import { projectContext } from "./performance.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pick = (value: unknown, fields: string[]) => Object.fromEntries(Object.entries(record(value)).filter(([key]) => fields.includes(key)));

/** Navigation, not a replacement specification. Full section reads remain lossless. */
export function contextOverview(value: unknown, audience: string, budget: number) {
  const source = record(value);
  const lightweight = audience === "builder" || audience === "orchestrator";
  const omittedPointers: string[] = [];
  const content: Record<string, unknown> = {};
  const fields = Object.entries(source);
  for (const [key, original] of fields) {
    let entry = original;
    if (lightweight && ["system", "evidence", "findings", "knowledge", "assets"].includes(key)) {
      content[key] = { detailOmitted: true };
      omittedPointers.push(`/${key}`);
      continue;
    }
    if (lightweight && key === "strategy") {
      entry = pick(original, ["design_intent", "skill_gaps"]);
    }
    if (lightweight && ["deliverables", "tasks"].includes(key) && Array.isArray(original)) {
      entry = original.map(item => ({ ...pick(item, ["id", "scope_id", "kind", "file", "required", "method", "dependencies", "user_requested", "presentation"]),
        ...(record(item).execution ? { execution: pick(record(item).execution, ["method", "uses"]) } : {}) }));
    }
    const projected = projectContext(entry, Math.max(256, Math.floor(budget / Math.max(1, fields.length))), 260);
    content[key] = projected.content;
    if (JSON.stringify(projected.content) !== JSON.stringify(original)) omittedPointers.push(`/${key}`);
    omittedPointers.push(...projected.omittedPointers.map(pointer => `/${key}${pointer}`));
  }
  return { content, omittedPointers: [...new Set(omittedPointers)] };
}
