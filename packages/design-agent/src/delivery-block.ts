import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export class DeliveryBlocked extends Error {
  constructor(readonly repairOwner: "designer" | "runtime", readonly issues: string[]) {
    super(`Build mechanical validation failed: ${issues.join("; ")}`);
  }
}

export class BuildIncomplete extends Error {
  constructor(readonly pendingOutputs: Array<{ id: string; method: string; files: string[] }>) {
    super(`Required build outputs are missing or empty: ${pendingOutputs.flatMap((item) => item.files).join(", ")}`);
  }
}

const loadedRuntimeAt = new Date().toISOString();
const loadedRuntimeHash = createHash("sha256");
/** Capture code identity during module initialization, not lazily after a later rebuild. */
for (const name of ["orchestrator-contract.js", "runtime.js", "design-categories.js", "design-context-v2.js", "presentation-validation.js", "context-schema.js", "context-draft.js", "context-authoring.js", "context-tools.js", "skill-activation.js", "design-scope-validation.js", "model-response-policy.js", "session-status.js", "provider.js", "workflow-contract.js", "retry.js", "context-model.js", "extension.js", "delivery-block.js", "html-delivery.js", "html-preflight.js", "finalize-delivery.js", "design-contract.js", "image-size.js", "image-output.js", "designer-recovery.js", "user-assets.js"]) loadedRuntimeHash.update(readFileSync(new URL(name, import.meta.url)));
const loadedCodeFingerprint = loadedRuntimeHash.digest("hex");
export const loadedRuntimeIdentity = { initializedAt: loadedRuntimeAt, codeFingerprint: loadedCodeFingerprint };
/** A runtime/configuration correction invalidates cached mechanical evidence. */
export async function deliveryRuntimeStamp(): Promise<string> {
  return createHash("sha256").update(loadedCodeFingerprint).update(JSON.stringify([process.env.DREAMATIC_HTML_BROWSER, process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE, process.env.DREAMATIC_HTML_REQUIRE_BROWSER])).digest("hex");
}
