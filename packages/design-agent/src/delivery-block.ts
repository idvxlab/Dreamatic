import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

let runtimeHash: Promise<string> | undefined;
/** A runtime correction invalidates an old deterministic block without changing approval. */
export async function deliveryRuntimeStamp(): Promise<string> {
  runtimeHash ??= Promise.all(["extension.js", "delivery-block.js", "html-delivery.js", "html-preflight.js", "finalize-delivery.js", "design-contract.js", "image-size.js", "image-output.js", "designer-recovery.js", "user-assets.js"].map((name) => readFile(new URL(name, import.meta.url))))
    .then((files) => { const hash = createHash("sha256"); for (const bytes of files) hash.update(bytes); return hash.digest("hex"); });
  return createHash("sha256").update(await runtimeHash).update(JSON.stringify([process.env.DREAMATIC_HTML_BROWSER, process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE, process.env.DREAMATIC_HTML_REQUIRE_BROWSER])).digest("hex");
}
