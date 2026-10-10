import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { roleContextSchema } from "./context-schema.js";

/** Transitional direct-call compatibility, excluded from every specialist active-tool list.
 * Existing regression and stored integrations share the current validated save path.
 * Remove when those callers are migrated; never advertise these to models.
 */
export function registerContextCompatibility(pi: ExtensionAPI, role: string, saveBound: (
  expectedSha256: string | null,
  buildData: (previous: Record<string, unknown> | undefined) => Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content: { type: "text"; text: string }[]; details: object }>) {
  pi.registerTool({ name: "save_design_context", label: "Save role Context", description: "Save your complete role-owned Context. Runtime binds project/path and increments revision. Pass domain data only, no runId/path/schemaVersion/revision. expectedSha256 is null for first creation or the exact hash from design_context_read for replacement. Never invent review approval or content.",
    parameters: Type.Object({ expectedSha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]), data: roleContextSchema(role) }, { additionalProperties: false }),
    async execute(_id, params, signal) { return saveBound(params.expectedSha256, () => structuredClone(params.data), signal); },
  });
  pi.registerTool({ name: "patch_design_context", label: "Patch role Context", description: "Patch domain fields in your bound Context. Runtime increments revision; never patch runId/schemaVersion/revision. expectedSha256 must be the exact current file hash. Review fields are /assessment/... . updates is an actual array, not a serialized JSON string.",
    parameters: Type.Object({ expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), updates: Type.Array(Type.Object({ pointer: Type.String(), value: Type.Unknown() }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    async execute(_id, params, signal) { return saveBound(params.expectedSha256, previous => {
      if (!previous) throw new Error("Create Context with save_design_context first.");
      const { schemaVersion: _schema, runId: _run, revision: _revision, ...data } = structuredClone(previous);
      for (const update of params.updates) {
        const keys = update.pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
        if (!update.pointer.startsWith("/") || /~(?![01])/u.test(update.pointer) || keys.some(key => ["__proto__", "constructor", "prototype"].includes(key)) || ["revision", "schemaVersion", "runId", "path"].includes(keys[0]!)) throw new Error("Patch only valid domain JSON pointers; runtime metadata is protected.");
        let target: Record<string, unknown> | unknown[] = data;
        for (const key of keys.slice(0, -1)) { const child: unknown = Reflect.get(target, key); if (!child || typeof child !== "object") throw new Error(`Missing JSON parent: ${update.pointer}`); target = child as Record<string, unknown>; }
        const key = keys.at(-1)!;
        if (Array.isArray(target) && key === "-") target.push(update.value);
        else { if (Array.isArray(target) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= target.length)) throw new Error("Array patch must address an existing item"); Reflect.set(target, key, update.value); }
      }
      return data;
    }, signal); },
  });
}
