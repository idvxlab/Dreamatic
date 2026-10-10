import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Acquisition observations, not a claim that fetched content is authoritative. */
export async function researchAcquisition(runDir: string) {
  const directory = join(runDir, "research/batches");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const successes = new Set<string>(), failures = new Map<string, string>();
  const observationErrors: { batch: string; reason: string }[] = [];
  for (const name of names.filter(name => name.endsWith(".json")).sort()) {
    let results: unknown;
    try { results = JSON.parse(await readFile(join(directory, name), "utf8")); }
    catch { observationErrors.push({ batch: `research/batches/${name}`, reason: "Fetch observations could not be read; acquisition completeness is unknown." }); continue; }
    if (!Array.isArray(results)) { observationErrors.push({ batch: `research/batches/${name}`, reason: "Unexpected batch format; acquisition completeness is unknown." }); continue; }
    for (const result of results) {
      if (!result || typeof result.url !== "string") continue;
      if (result.ok === true) successes.add(result.url);
      else if (result.ok === false) failures.set(result.url, String(result.error ?? "Fetch unavailable"));
    }
  }
  const unavailableSources = [...failures].filter(([url]) => !successes.has(url)).map(([url, error]) => ({ url, error, failureKind: /ENOTFOUND|EAI_AGAIN/i.test(error) ? "dns" : /timeout/i.test(error) ? "timeout" : /HTTP\s*\d{3}/i.test(error) ? "http" : /socket|other side closed/i.test(error) ? "connection" : "other" }));
  return { observationErrors, observationsComplete: observationErrors.length === 0, fetchedSourceCount: successes.size, unavailableSources, hasFetchGaps: unavailableSources.length > 0,
    instruction: "Fetch success is not factual verification. Distinguish inspected source text, search snippets, inference and concept assumptions. Preserve source-specific gaps through design, review and delivery. For consequential gaps use changed sources/refinementReason or qualify/omit claims; concept work still requires accurate attribution. No fetch attempts does not establish evidence completeness." };
}

/** Injected after a delegated task so its output protocol cannot drift with prose. */
export function specialistStageContract(role: string, version = 1) {
  const outputs: Record<string, string> = {
    researcher: "Author evidence, findings and usageConditions in context/research.json through update_design_context, then commit_design_context {} and design_bus_post {type:research_done,summary:...}. Do not create research-findings.md or evidence.json companion reports.",
    designer: "Author context/design.json. Each deliverable and its task share one stable id. category is the assigned scope category, never a content genre; omit it for runtime inference. Include kind,purpose,acceptance_test,required,file on new deliverables. Load every skill_ref in its own scope; bind additional disciplines via contributing_scopes. Updates upsert by id: rename with explicit removals or atomically replace complete collections with replaceTasks/replaceDeliverables. Commit with {}, then publish design_spec_ready/design_revision_ready.",
    reviewer: "Read research and design via design_context_read paths/select. Author assessment in context/review.json, commit {}, then publish design_review_pass/design_review_fail. Check evidence support and fact/inference boundaries even for concepts; no engineering certification is required. Event type and summary belong at the argument root, never inside payload.",
    builder: "Read approved context/design.json and execute its tasks. Author the declared Gallery when needed and call build_finalize. That tool commits build_done; do not call design_bus_post. After success stop immediately; Orchestrator calls export_package without further artifact inspection.",
  };
  if (role === "designer" && version === 2) outputs.designer = "Author context/design.json v2: one deliverable owns id/scope_id/category/skill_refs/file/kind/purpose/acceptance_test/required/user_requested, nested execution and presentation access requirements. Never author tasks or repeat identity/scope inside execution; tasks are derived read-only. execution.uses references deliverable ids. Bind Skills per scope, optionally using use_skill bindings for multiple scopes. Put system_thesis/palette/typography/consistency_rules/asset_rules/consistency_anchor/prohibited inside changes.system; strategy belongs inside changes.strategy. Commit ready content with {}, then publish; publication validates sources. design_context_validate is an optional targeted diagnostic. Declare executable interactions once in execution.interaction_checks; no duplicate outcome protocol is required. A minor review cannot waive required user access.";
  return `# Authoritative Stage Tool Protocol\nThis protocol governs storage, tool arguments and completion even if the delegated task names older files or tools. It does not override confirmed user intent. ${outputs[role] ?? ""}\nRole-bound update_design_context/commit_design_context omit runId/path. design_context_read accepts the assigned runId (a bound specialist may omit it for runtime injection). Other tools use their declared envelopes. commit_design_context takes exactly {}, not {changes:\"{}\"}. Do not serialize tool argument objects as strings.`;
}
