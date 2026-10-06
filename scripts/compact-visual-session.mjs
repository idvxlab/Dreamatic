import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { compactVisualSession } from "../packages/design-agent/dist/index.js";

const workspaceRoot = resolve(process.cwd(), "workspace");
const requested = process.argv.slice(2).map((value) => resolve(process.cwd(), value));

if (!requested.length) {
  throw new Error("Pass one or more DreamaticArt workspace session .jsonl files.");
}

for (const sessionFile of requested) {
  if (!sessionFile.startsWith(`${workspaceRoot}${sep}`) || !sessionFile.endsWith(".jsonl")) {
    throw new Error(`Refusing to compact a file outside DreamaticArt workspace sessions: ${sessionFile}`);
  }
  if (!(await stat(sessionFile)).isFile()) throw new Error(`Session is not a file: ${sessionFile}`);
  const result = await compactVisualSession(sessionFile);
  console.log(JSON.stringify({ sessionFile, ...result }));
}
