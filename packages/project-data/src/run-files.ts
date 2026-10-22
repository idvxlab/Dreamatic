import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInside } from "./paths.js";

export const RUN_FILES = {
  researchFindings: "research/research-findings.md",
  reviewReport: "review/design-review.md",
  reviewData: "review/design-review.json",
} as const;

export const RUN_DOCUMENT_ALIASES: Record<string, readonly string[]> = {
  [RUN_FILES.researchFindings]: ["research/research.md"],
  [RUN_FILES.reviewReport]: ["review/review.md"],
  [RUN_FILES.reviewData]: ["review/review.json"],
};

export const RUN_CONTEXT_SECTIONS = {
  requirements: "brief.json",
  research: ["research/evidence.json", RUN_FILES.researchFindings, "research/brand_lock.md", "research/assets/manifest.json", "research/assets/validation.json"],
  designSpec: ["plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md"],
  tokens: "plan/design_system.json",
  components: "plan/design_plan.json",
  decisions: "plan/design_plan.json",
  reviewIssues: [RUN_FILES.reviewData, RUN_FILES.reviewReport],
  implementation: "artifacts/artifact-manifest.json",
};

export function canonicalRunDocument(path: string): string {
  return Object.entries(RUN_DOCUMENT_ALIASES).find(([canonical, aliases]) => canonical === path || aliases.includes(path))?.[0] ?? path;
}

export function runDocumentCandidates(path: string): string[] {
  const canonical = canonicalRunDocument(path);
  return [canonical, ...(RUN_DOCUMENT_ALIASES[canonical] ?? [])];
}

export async function findRunDocument(runDir: string, path: string): Promise<{ path: string; absolutePath: string } | undefined> {
  for (const candidate of runDocumentCandidates(path)) {
    const absolutePath = resolveInside(runDir, candidate);
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) throw new Error(`Run document is not a file: ${candidate}`);
      resolveInside(await realpath(runDir), await realpath(absolutePath));
      return { path: candidate, absolutePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}
