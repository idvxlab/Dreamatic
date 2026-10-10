import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { CONTEXT_FILES } from "./context-model.js";

export function roleContextPath(role: string): string | undefined {
  return ({ researcher: CONTEXT_FILES.research, designer: CONTEXT_FILES.design, reviewer: CONTEXT_FILES.review } as Record<string, string>)[role];
}

export { roleContextSchema } from "./context-schema.js";
import { roleContextSchema } from "./context-schema.js";

/** Bound retries to the offending field AND attempted payload, not changing prose. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function contextFailureIdentity(tool: string, issue: string, input: unknown) {
  // Structured input failures preserve code/field even if preparation ended before args capture.
  let structured: { code?: string; field?: string; message?: string } | undefined;
  try { structured = JSON.parse(issue); } catch { /* upstream diagnostics remain text */ }
  if (tool === "update_design_context" && !structured?.code) {
    const diagnostic = contextChangesArgumentIssue(input);
    if (diagnostic) {
      const field = ("target" in diagnostic ? diagnostic.target : undefined) ?? diagnostic.pointer;
      return { code: diagnostic.code, location: diagnostic.pointer, key: `${tool}:${diagnostic.code}:${field}:${stable(diagnostic.relevant)}` };
    }
  }
  // New input failures carry stable fields; regex remains only for upstream/legacy text.
  const location = structured?.field ? `update_design_context#${structured.field}` : issue.match(/(?:context\/(?:design|review|research)\.json|update_design_context)#\/[^\s:]+/)?.[0];
  const code = structured?.code ?? (/changed since|snapshot.*changed|draft changed|draft missing|hash/i.test(issue) ? "context_hash_conflict"
    : /runtime-owned|metadata.*protected/i.test(issue) ? "context_metadata_protected"
    : /schema|Validation failed|must be|unexpected|missing|required|path/i.test(issue) ? "invalid_context_input" : "context_operation_failed");
  let relevant = input;
  if (location && input && typeof input === "object" && (location.startsWith("update_design_context#") || "data" in input)) {
    const pointer = location.slice(location.indexOf("#") + 1);
    relevant = location.startsWith("update_design_context#") ? input : (input as { data: unknown }).data;
    for (const key of pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      if (!relevant || typeof relevant !== "object" || !Object.hasOwn(relevant, key)) { relevant = undefined; break; }
      relevant = Reflect.get(relevant, key);
    }
  }
  const required = issue.match(/must have required properties ([A-Za-z0-9_, ]+)/)?.[1];
  if (required) relevant = required.split(",").map(key => key.trim()).filter(Boolean).map(key => ({ key, present: !!relevant && typeof relevant === "object" && Object.hasOwn(relevant, key) }));
  return { code, location: location ?? "arguments", key: `${tool}:${code}:${location ?? issue.split("\n")[0]}:${stable(relevant)}` };
}

/** Author changes exclude runtime declarations and include explicit local retractions. */
export function roleContextChangesSchema(role: string, version = 1) {
  const schema = roleContextSchema(role, version);
  const properties: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (["tasks", "deliverables"].includes(key) && role === "designer") {
      const item = (value as ReturnType<typeof Type.Array>).items as ReturnType<typeof Type.Object>;
      const patchFields = { ...Type.Partial(item).properties };
      if (version === 2 && key === "deliverables") {
        for (const field of ["execution", "presentation"]) patchFields[field] = Type.Optional(Type.Partial((item.properties as Record<string, ReturnType<typeof Type.Object>>)[field]!));
      }
      properties[key] = Type.Optional(Type.Array(Type.Object({ ...patchFields, id: Type.String({ minLength: 1, description: "Stable id shared by task and deliverable. Preserve during upserts; a new id adds a row and never renames an old row." }), unsetFields: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }), { minItems: 1, uniqueItems: true, description: "Delete optional fields on this item. Omitted fields are preserved; [] clears an array. Never unset required fields or set and unset the same field." })) }, { additionalProperties: true })));
    } else if (key === "strategy" && role === "designer") {
      const authorFields = { ...Type.Partial(value as ReturnType<typeof Type.Object>).properties };
      for (const field of ["skill_selection", "runId", "schemaVersion", "revision", "design_system_ref", "execution_plan", "image_generation_plan", "deliverables", "presentation"]) {
        authorFields[field] = Type.Optional(Type.Never({ description: field === "skill_selection" ? "Runtime-owned; select Skills through use_skill with rationale." : "Not a strategy author field; use the named root fields and runtime-managed metadata." }));
      }
      properties[key] = Type.Optional(Type.Object(authorFields, { additionalProperties: true }));
    } else if (["system", "strategy", "presentation", "evidence", "assessment"].includes(key)) {
      properties[key] = Type.Optional(Type.Partial(value));
    } else properties[key] = Type.Optional(value);
  }
  if (role === "designer") { if (version === 1) properties.removeTasks = Type.Optional(Type.Array(Type.String())); properties.removeDeliverables = Type.Optional(Type.Array(Type.String()));
    for (const field of (version === 2 ? ["deliverables"] : ["tasks", "deliverables"]) as ("tasks" | "deliverables")[]) {
      const array = (schema.properties as Record<string, unknown>)[field] as ReturnType<typeof Type.Array>;
      properties[field === "tasks" ? "replaceTasks" : "replaceDeliverables"] = Type.Optional(Type.Array(array.items, { description: "Explicit atomic replacement of this complete collection. Supply full items; removes omitted ids. Cannot combine with upserts or removals for the same collection." }));
    }
  }
  const unsetFields = Type.Optional(Type.Array(Type.String({ pattern: "^[^/~]+$" }), { minItems: 1, uniqueItems: true, description: "Explicitly delete optional fields of this object; omitted fields are preserved. Never set and unset a field together." }));
  for (const property of Object.values(properties)) {
    const value = property as unknown as { type?: string; properties?: Record<string, unknown> };
    if (value.type === "object") {
      value.properties = { ...value.properties, unsetFields };
      // Named object dictionaries such as scores/palette also support explicit retraction.
      for (const child of Object.values(value.properties ?? {})) if (child && typeof child === "object" && (child as { type?: string }).type === "object") {
        const object = child as { properties?: Record<string, unknown> };
        object.properties = { ...object.properties, unsetFields };
      }
    }
  }
  return Type.Object({ ...properties, unsetFields }, { additionalProperties: false });
}
export function contextChangesArgumentIssue(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { code: "context_arguments_not_object", pointer: "/", message: "Pass {changes:{...named role fields}}", relevant: typeof input };
  const args = input as Record<string, unknown>;
  const extra = Object.keys(args).filter(key => !["changes", "reset"].includes(key)).sort();
  if (extra.length) return { code: "context_obsolete_arguments", pointer: "/", message: `Unexpected arguments: ${extra.join(", ")}. Use changes with named role fields, not updates/pointer/value or hashes. Runtime manages versions.`, relevant: extra };
  if (!args.changes || typeof args.changes !== "object" || Array.isArray(args.changes)) return { code: "context_changes_not_object", pointer: "/changes", message: "changes must be a named-field object, not serialized JSON or an array. Example: {changes:{assessment:{summary:\"Actual summary\"}}}", relevant: typeof args.changes };
  if (args.reset !== undefined && typeof args.reset !== "boolean") return { code: "invalid_reset", pointer: "/reset", message: "reset must be a boolean at the top level; reset:true discards the entire working draft", relevant: typeof args.reset };
  return undefined;
}
function inputError(pointer: string, code: string, message: string) {
  return new Error(JSON.stringify({ ok: false, saved: false, committed: false, code, field: pointer,
    message: `update_design_context#${pointer}: ${code}: ${message}`,
    instruction: "No fields were saved. Correct the named input and resubmit the original content; preserve all other design content." }));
}
/** Normalize only unambiguous envelope placement, before the same role validation.
 * Domain values are never synthesized; conflicts and unknown roots remain errors.
 */
export function prepareContextChanges(input: unknown, role?: string, version = 1): { changes: Record<string, unknown>; reset?: boolean } {
  let normalized = input;
  if (role && input && typeof input === "object" && !Array.isArray(input)) {
    const original = input as Record<string, unknown>;
    const roots = roleContextChangesSchema(role, version).properties;
    const misplaced = Object.keys(original).filter(key => key !== "changes" && key !== "reset");
    if (misplaced.length && misplaced.every(key => Object.hasOwn(roots, key)) &&
        (original.changes === undefined || (original.changes && typeof original.changes === "object" && !Array.isArray(original.changes)))) {
      const changes = structuredClone((original.changes ?? {}) as Record<string, unknown>);
      for (const key of misplaced) {
        if (Object.hasOwn(changes, key)) throw inputError(`/changes/${key}`, "conflicting_field_change", `Field ${key} appears both inside and outside changes; provide it once inside changes. No values were chosen or saved.`);
        changes[key] = structuredClone(original[key]);
      }
      normalized = { changes, ...(original.reset !== undefined ? { reset: original.reset } : {}) };
    }
  }
  if (role === "designer" && normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    const envelope = normalized as Record<string, unknown>;
    if (envelope.changes && typeof envelope.changes === "object" && !Array.isArray(envelope.changes)) {
      // These explicitly declared fields have exactly one owner in both versions.
      // Creative additions have no unique schema owner and are never guessed.
      const changes = structuredClone(envelope.changes as Record<string, unknown>);
      const schema = roleContextSchema("designer", version);
      const systemFields = "system" in schema.properties ? schema.properties.system.properties : {};
      const misplacedSystemFields = Object.keys(systemFields).filter(key => Object.hasOwn(changes, key));
      if (misplacedSystemFields.length) {
        if (changes.system !== undefined && (!changes.system || typeof changes.system !== "object" || Array.isArray(changes.system))) throw inputError("/changes/system", "invalid_named_fields", "system must be an object; preserve the misplaced system values when correcting this call.");
        const system = (changes.system ?? {}) as Record<string, unknown>;
        for (const key of misplacedSystemFields) {
          if (Object.hasOwn(system, key)) throw inputError(`/changes/system/${key}`, "conflicting_field_change", `${key} appears both inside and outside system; provide it once. No values were chosen or saved.`);
          system[key] = changes[key]; delete changes[key];
        }
        changes.system = system; normalized = { ...envelope, changes };
      }
    }
  }
  const issue = contextChangesArgumentIssue(normalized);
  if (issue) throw inputError(issue.pointer, issue.code, issue.message);
  const args = normalized as { changes: Record<string, unknown>; reset?: boolean };
  if (role) {
    const schema = roleContextChangesSchema(role, version);
    if (role === "designer" && args.changes.strategy && typeof args.changes.strategy === "object" && "skill_selection" in args.changes.strategy) throw inputError("/changes/strategy/skill_selection", "runtime_owned_field", "runtime-owned declaration. Select scoped Skills through use_skill with rationale; do not author skill_selection.");
    if (!Check(schema, args.changes)) {
      const errors = [...Errors(schema, args.changes)];
      const unknown = Object.keys(args.changes).filter(key => !Object.hasOwn(schema.properties, key));
      const hint = unknown.length ? ` Unknown role roots: ${unknown.join(", ")}. Allowed changes fields: ${Object.keys(schema.properties).join(", ")}.` + (role === "designer" ? " Put typography, palette and consistency/exclusion rules inside changes.system; creative decisions belong inside changes.strategy. Keep deliverables and presentation inside changes. Preserve their original values and split updates into small named-field calls." : "") : "";
      throw inputError(`/changes${errors[0]?.instancePath ?? ""}`, "invalid_named_fields", errors.map(error => `${error.instancePath}: ${error.message}`).join("; ") + hint);
    }
    const namedChanges = args.changes as Record<string, unknown>;
    if (role === "designer") for (const [field, replacement, removal] of [["tasks", "replaceTasks", "removeTasks"], ["deliverables", "replaceDeliverables", "removeDeliverables"]]) {
      if (namedChanges[replacement!] !== undefined && (namedChanges[field!] !== undefined || namedChanges[removal!] !== undefined)) throw inputError(`/changes/${replacement}`, "conflicting_collection_change", "Replacement cannot combine with upserts/removals for the same collection");
    }
    validateRetractions(args.changes, roleContextSchema(role, version), "/changes");
  }
  return args;
}

export function contextUpdateDescription(role: string, version = 1) {
  const fields = role === "designer" ? (version === 2 ? "system, strategy, deliverables, presentation, acceptanceNotes, executionNotes" : "system, strategy, tasks, deliverables, presentation, acceptanceNotes, executionNotes")
    : role === "researcher" ? "evidence, findings, usageConditions" : "assessment, intentCoverage";
  return `Update only your ${role} working Context. Arguments are {changes:{...}} and optional reset only; omit runId/path/schemaVersion/revision/hash arguments. Put ALL named fields (${fields}) inside changes. Example: ${JSON.stringify(contextChangesExample(role))}. Objects merge; ordinary arrays replace; omitted fields stay. changes:{} reads without saving. ` +
    (role === "designer" ? (version === 2 ? "Deliverables upsert by id and own execution/presentation; tasks are read-only derived views. Put typography/palette/consistency rules in system. " : "Tasks and deliverables upsert by matching id. ") + "removeDeliverables deletes ids; replaceDeliverables atomically replaces full items. Never combine replacement with upserts/removals. [] clears arrays. " : "") +
    "unsetFields deletes optional fields locally. Read design_context_read before resuming work; runtime owns versions and Skill receipts. reset:true discards work only after a complete canonical:true read. Commit separately with commit_design_context({}). Submit small updates (one section or a few deliverables) instead of repeatedly regenerating the entire design.";
}
/** Deletion is explicit and local, never a writable JSON path. */
function validateRetractions(patch: unknown, schema: unknown, pointer: string) {
  if (!patch || typeof patch !== "object") return;
  const shape = schema as { properties?: Record<string, unknown>; required?: string[]; items?: unknown } | undefined;
  if (Array.isArray(patch)) { for (const [index, item] of patch.entries()) validateRetractions(item, shape?.items, `${pointer}/${index}`); return; }
  const record = patch as Record<string, unknown>;
  if (record.unsetFields !== undefined) {
    const keys = record.unsetFields;
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== "string" || !key || /[/~]/u.test(key)) || new Set(keys).size !== keys.length) throw inputError(`${pointer}/unsetFields`, "invalid_unset_field", "unsetFields must be a nonempty array of unique literal field names");
    for (const key of keys) {
      if (["__proto__", "constructor", "prototype", "unsetFields", "skill_selection"].includes(key) || (pointer === "/changes" && ["runId", "schemaVersion", "revision", "path"].includes(key)) || shape?.required?.includes(key)) throw inputError(`${pointer}/unsetFields`, "invalid_unset_field", `Cannot unset protected or required field ${key}`);
      if (Object.hasOwn(record, key)) throw inputError(`${pointer}/unsetFields`, "conflicting_field_change", `Cannot set and unset ${key} in the same object`);
    }
  }
  for (const [key, value] of Object.entries(record)) if (key !== "unsetFields") validateRetractions(value, shape?.properties?.[key], `${pointer}/${key}`);
}
export function contextChangesExample(role: string) {
  return role === "reviewer" ? { changes: { assessment: { summary: "Actual assessment", verdict: "fail", round: 1 } } }
    : role === "researcher" ? { changes: { evidence: { target: "Actual subject", summary: "Evidence summary" }, findings: "Actual findings" } }
    : { changes: { system: { system_thesis: "Actual design thesis", consistency_rules: ["Actual shared rule"] }, strategy: { design_intent: "Actual intent" } } };
}

/** Only a content-free obsolete commit wrapper can be safely canonicalized. */
export function prepareContextCommit(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("commit_design_context takes exactly {}.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length === 1 && Object.hasOwn(record, "changes") && (record.changes === "{}" || (record.changes && typeof record.changes === "object" && !Array.isArray(record.changes) && !Object.keys(record.changes).length))) return {};
  if (Object.keys(record).length) throw new Error("commit_design_context takes exactly {}. Author content with update_design_context first; no content was committed.");
  return record;
}
