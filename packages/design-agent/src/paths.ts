import { resolve, sep } from "node:path";

export function resolveInside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(absoluteRoot, candidate);
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes the Dreamatic workspace: ${candidate}`);
  }
  return absoluteCandidate;
}

export function safeRunId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!normalized) throw new Error("runId must contain a letter or number");
  return normalized;
}

