import { contextUpdateDescription } from "./context-tools.js";
import { registerContextCompatibility } from "./context-compatibility.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { resolveInside, safeRunId } from "./paths.js";
import { serializeJsonWrite } from "./performance.js";
import { contextSkeleton, draftHash, assembleContextDraft, mergePreparedContextChanges, contextReadiness, selectContextSection } from "./context-draft.js";
import { roleContextPath, roleContextSchema, prepareContextCommit, prepareContextChanges, roleContextChangesSchema, contextFailureIdentity } from "./context-tools.js";
import { canonicalContextError, CONTEXT_FILES, hasUnifiedContext, prepareContextDocument, unifiedContextInstruction } from "./context-model.js";
import { validateDesignScopes } from "./design-scope-validation.js";
import type { SkillActivation } from "./skill-activation.js";
import { ContextFailureTracker } from "./context-failures.js";

function textResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} }; }
function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
export type ContextReadSelection = { section?: string; ids?: string[]; canonical?: boolean };
export type BoundContextRead = (selection?: ContextReadSelection) => Promise<Record<string, unknown>>;

/** Dreamatic-owned authoring state; Pi tool execution stays upstream. */
export function registerContextAuthoring(pi: ExtensionAPI, dependencies: {
  contractVersion?: number; workspaceDir: string; role: string; boundRunId: string; skillActivation: SkillActivation;
  classifiedScopes: () => Promise<{ id: string; category: string }[]>;
  availableProfessionals: Record<string, string[]>;
  persistSkillReceipt: () => Promise<void>;
  assertRoleWrite: (workspace: string, runId: string, role: string, path: string) => Promise<void>;
  finishWorkflow: (value: unknown) => ReturnType<typeof textResult> & { terminate?: boolean };
}): BoundContextRead {
  const { workspaceDir, role, boundRunId, skillActivation, classifiedScopes, availableProfessionals, persistSkillReceipt, assertRoleWrite, finishWorkflow } = dependencies;
  const version = role === "designer" ? dependencies.contractVersion ?? 1 : 1;
  const contextPath = roleContextPath(role);
  if (!contextPath) throw new Error(`No Context authoring role: ${role}`);
  let readBoundContextDraft: BoundContextRead;

  const saveBound = async (expectedSha256: string | null, buildData: (previous: Record<string, unknown> | undefined) => Record<string, unknown>, signal?: AbortSignal, canonicalLocked = false) => {
    const runDir = resolveInside(workspaceDir, join("runs", safeRunId(boundRunId)));
    if (!(await hasUnifiedContext(runDir))) throw new Error("Legacy projects use write_json/patch_json with their original storage contract.");
    const path = resolveInside(runDir, contextPath);
    const write = async () => {
      const source = await readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      const hash = source === undefined ? null : createHash("sha256").update(source).digest("hex");
      if (expectedSha256 !== hash) throw new Error(`${contextPath}#: Context changed since it was read. Reload design_context_read with this path and full:true; runtime will reconcile the canonical base; do not submit version hashes.`);
      const previous = source === undefined ? undefined : requiredRecord(JSON.parse(source), contextPath);
      const data = buildData(previous);
      for (const key of ["runId", "path", "schemaVersion", "revision"]) if (key in data) throw new Error(`${contextPath}#/${key}: runtime-owned metadata; omit it from domain data.`);
      await assertRoleWrite(workspaceDir, boundRunId, role, path);
      signal?.throwIfAborted();
      const document = { ...data, schemaVersion: version, runId: boundRunId, revision: Number(previous?.revision ?? 0) + 1 };
      const prepared = prepareContextDocument(runDir, contextPath, document, boundRunId);
      const views = prepared.projections;
      if (contextPath === CONTEXT_FILES.design) {
        if ((await classifiedScopes()).length) await persistSkillReceipt();
        try { await validateDesignScopes(runDir, JSON.parse(views["plan/design_plan.json"]!), JSON.parse(views["plan/deliverable_manifest.json"]!)); }
        catch (error) { throw new Error(`context/design.json#/deliverables: ${canonicalContextError(error instanceof Error ? error.message : String(error))}. Use assigned scope_id/category and Skills loaded in this invocation.`); }
      }
      signal?.throwIfAborted();
      await prepared.persist();
      const saved = await readFile(path, "utf8");
      return textResult({ ok: true, path: relative(workspaceDir, path), bytes: Buffer.byteLength(saved), sha256: createHash("sha256").update(saved).digest("hex"), instruction: unifiedContextInstruction(role, version) });
    };
    return canonicalLocked ? write() : serializeJsonWrite(path, write);
  };
  const draftPath = resolveInside(workspaceDir, join("runs", boundRunId, ".performance", `context-draft-${role}.json`));
  const draftCommitFailures = new ContextFailureTracker();
  const rejectDraftCommit = ( issues: { code: string; pointer: string; message: string }[], data: Record<string, unknown>) => {
    const attempts = Math.max(...issues.map(issue => {
      const key = contextFailureIdentity("save_design_context", `context/${role === "designer" ? "design" : role === "researcher" ? "research" : "review"}.json#${issue.pointer}: ${issue.code}: ${issue.message}`, { data }).key;
      return draftCommitFailures.record(key);
    }));
    const recovery = { ok: false, saved: false, committed: false, readiness: contextReadiness(issues), blocked: attempts >= 3, attempts, issues,
      instruction: "Commit saved no canonical content; editable work is retained. Use issues[].repairRead for complete affected objects and repair named fields. [] clears contributing_scopes; unsetFields on an object or item deletes optional fields. reset:true discards all working changes and requires design_context_read canonical:true before an intentional restart." };
    return recovery.blocked ? { ...finishWorkflow(recovery), details: recovery } : { ...textResult(recovery), details: recovery };
  };
  const readDraft = async () => {
    const physicalRoot = await realpath(resolveInside(workspaceDir, join("runs", boundRunId)));
    const physicalParent = await realpath(dirname(draftPath)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (physicalParent && physicalParent !== join(physicalRoot, ".performance")) throw new Error("Context draft directory must not redirect through a symlink");
    const physicalFile = await realpath(draftPath).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (physicalFile && physicalFile !== join(physicalParent ?? join(physicalRoot, ".performance"), basename(draftPath))) throw new Error("Context draft file must not redirect through a symlink");
    const source = await readFile(draftPath, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    return { source, draft: source ? requiredRecord(JSON.parse(source), "Context draft") : undefined };
  };
  const writeDraft = async (data: Record<string, unknown>, baseSha256: string | null) => {
    await mkdir(dirname(draftPath), { recursive: true });
    await readDraft(); // Recheck physical storage before writing.
    const source = JSON.stringify({ data, baseSha256 });
    const temporary = `${draftPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, source); await rename(temporary, draftPath); } finally { await unlink(temporary).catch(() => {}); }
    return draftHash(source);
  };
  // Snapshot versions belong to the invocation, never model-authored arguments.
  let observedDraftHash: string | null | undefined;
  let observedBaseHash: string | null | undefined;
  let observedCanonicalHash: string | null | undefined;
  const canonicalPath = resolveInside(workspaceDir, join("runs", boundRunId, contextPath));
  const workingContext = async () => {
    const { source, draft } = await readDraft();
    const canonical = await readFile(resolveInside(workspaceDir, join("runs", boundRunId, contextPath)), "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    let domain = contextSkeleton(role, version);
    if (canonical) { const { schemaVersion: _s, runId: _r, revision: _v, ...fields } = requiredRecord(JSON.parse(canonical), contextPath); domain = fields; }
    return { data: draft ? requiredRecord(draft.data, "draft data") : domain, source, hash: source ? draftHash(source) : null,
      baseHash: draft ? draft.baseSha256 as string | null : canonical ? draftHash(canonical) : null, canonical, domain };
  };
  const assemble = async (data: Record<string, unknown>) => {
    const diagnosis = assembleContextDraft(role, data, skillActivation.all(), await classifiedScopes(), skillActivation.deactivated(), availableProfessionals, version);
    const issues = diagnosis.issues.map(issue => {
      const section = issue.pointer.split("/")[1];
      const repairRead = section && Object.hasOwn(roleContextSchema(role, version).properties, section)
        ? { runId: boundRunId, audience: role, section, ...(issue.deliverableId && section === "deliverables" ? { ids: [issue.deliverableId] } : {}), full: true } : undefined;
      return { ...issue, ...(repairRead ? { repairRead } : {}) };
    });
    return { ...diagnosis, issues };
  };
  readBoundContextDraft = async selection => serializeJsonWrite(draftPath, () => serializeJsonWrite(canonicalPath, async () => {
    const current = await workingContext();
    const selectedData = selection?.canonical ? current.domain : current.data;
    const data = selection?.section ? selectContextSection(role, selectedData, selection.section, selection.ids, version) : selectedData;
    observedDraftHash = current.hash;
    observedBaseHash = current.baseHash;
    if (selection?.canonical || !current.source) observedCanonicalHash = current.canonical ? draftHash(current.canonical) : null;
    const diagnosis = await assemble(selectedData);
    // Return persisted declarations, not the derived diagnosis's proposed changes.
    return { data, ...(selection?.canonical && current.source ? { retainedWorkingData: current.data } : {}), source: selection?.canonical ? "canonical" : current.source ? "working_draft" : current.canonical ? "canonical" : "skeleton", hasWorkingDraft: !!current.source, readiness: contextReadiness(diagnosis.issues), issues: diagnosis.issues, versionManagedByRuntime: true };
  }));
  pi.registerTool({ name: "update_design_context", label: "Update role Context", description: contextUpdateDescription(role, version),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: Type.Object({ changes: roleContextChangesSchema(role, version), reset: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    prepareArguments: args => prepareContextChanges(args, role, version),
    async execute(_id, params, signal) {
      if (!params.reset && !Object.keys(params.changes).length) return textResult({ ok: true, saved: false, committed: false, ...(await readBoundContextDraft!()) });
      return serializeJsonWrite(draftPath, () => serializeJsonWrite(canonicalPath, async () => {
        const runDir = resolveInside(workspaceDir, join("runs", boundRunId));
        if (!(await hasUnifiedContext(runDir))) throw new Error("Named Context authoring requires unified Context.");
        await assertRoleWrite(workspaceDir, boundRunId, role, resolveInside(runDir, contextPath));
        const current = await workingContext();
        if (observedDraftHash === undefined) {
          if (current.source || current.canonical) throw new Error("Read design_context_read before updating existing Context; runtime needs its observed version.");
          observedDraftHash = null; observedBaseHash = null; observedCanonicalHash = null;
        }
        if (current.hash !== observedDraftHash || (!current.source && current.baseHash !== observedBaseHash)) throw new Error("Context snapshot changed in another invocation. Read design_context_read and reconcile current content before updating; no fields were saved.");
        if (params.reset && (observedCanonicalHash === undefined || observedCanonicalHash !== (current.canonical ? draftHash(current.canonical) : null))) throw new Error("Canonical Context was not observed or changed. Read design_context_read with canonical:true before reset; no fields were saved.");
        const data = mergePreparedContextChanges(role, params.reset ? current.domain : current.data, params.changes, version);
        const assembled = await assemble(data);
        const base = params.reset ? current.canonical ? draftHash(current.canonical) : null : current.baseHash;
        signal?.throwIfAborted();
        const hash = await writeDraft(assembled.data, base);
        observedDraftHash = hash; observedBaseHash = base;
        return textResult({ ok: true, saved: true, committed: false, readiness: contextReadiness(assembled.issues), issues: assembled.issues, versionManagedByRuntime: true,
          instruction: "Working Context saved; readiness describes known commit blockers, not stage approval. Repair issues with named changes before commit_design_context {}. Omitted fields are retained; [] clears arrays; unsetFields deletes optional object/item fields. No hash arguments are needed." });
      }));
    },
  });
  pi.registerTool({ name: "commit_design_context", label: "Commit role Context", description: "Call with {}. Runtime assembles observed working Context, validates structure, scoped Skills and semantics, and atomically submits with version checks. Retains editable work for subsequent repairs. Read design_context_read before committing retained work in a fresh invocation. This does not publish completion or approve design.",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: Type.Object({}, { additionalProperties: false }),
    prepareArguments: prepareContextCommit,
    async execute(_id, params, signal) { return serializeJsonWrite(draftPath, () => serializeJsonWrite(canonicalPath, async () => {
      if (Object.keys(params).length) throw new Error("commit_design_context takes {}; runtime manages all version hashes.");
      const current = await workingContext();
      if (observedDraftHash === undefined) throw new Error("Read design_context_read before committing retained work.");
      if (!current.source || current.hash !== observedDraftHash) throw new Error("Context snapshot missing or changed in another invocation; read design_context_read before committing.");
      const assembled = await assemble(current.data);
      const issues = assembled.issues;
      if (issues.length) return rejectDraftCommit( issues, assembled.data);
      try {
        if (current.canonical && current.baseHash === draftHash(current.canonical) && JSON.stringify(assembled.data) === JSON.stringify(current.domain)) return textResult({ ok: true, saved: false, committed: true, readiness: "ready", unchanged: true, instruction: "Context already committed; no revision changed. Publish only after stage checks succeed." });
        const result = await saveBound(current.baseHash, () => assembled.data, signal, true);
        const saved = requiredRecord(JSON.parse(result.content[0]!.text), "Context commit result");
        draftCommitFailures.clear();
        try {
          observedDraftHash = await writeDraft(assembled.data, saved.sha256 as string);
          observedBaseHash = saved.sha256 as string;
          observedCanonicalHash = saved.sha256 as string;
          return textResult({ ok: true, saved: true, committed: true, readiness: "ready", path: saved.path, bytes: saved.bytes,
            instruction: "Canonical Context saved. Editable work retained; continue with named changes if publication checks find issues. Runtime manages versions. Publish completion only after stage checks succeed." });
        } catch (error) {
          observedDraftHash = undefined; observedBaseHash = undefined;
          return textResult({ ok: true, saved: true, committed: true, readiness: "ready", path: saved.path, warning: error instanceof Error ? error.message : String(error),
            instruction: "Canonical Context saved, draft refresh failed. Read design_context_read, then explicitly reset:true before further edits. Do not repeat the previous commit." });
        }
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const pointer = message.match(/context\/(?:design|review|research)\.json#(\/[^\s:]*)/)?.[1] ?? contextPath;
        return rejectDraftCommit([{ code: /changed since/.test(message) ? "context_hash_conflict" : "context_commit_rejected", pointer, message }], assembled.data);
      }
    })); },
  });
  registerContextCompatibility(pi, role, saveBound);
  return readBoundContextDraft!;
}
