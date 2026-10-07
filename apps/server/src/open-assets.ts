import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function openProjectAssets(workspace: string, runId: string, opener = execute, platform = process.platform): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId)) throw new Error("Invalid project id");
  const root = await realpath(workspace);
  const folder = await realpath(join(root, "runs", runId));
  if (!folder.startsWith(`${root}${sep}runs${sep}`) || !(await stat(folder)).isDirectory()) throw new Error("Invalid project folder");
  // Assets include generated files and research materials in different subfolders.
  const command = platform === "darwin" ? "/usr/bin/open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  await opener(command, [folder]);
}

export function localFolderRequest(peer: string | undefined, host: string | undefined, origin: string | undefined): boolean {
  const local = (name: string) => ["localhost", "127.0.0.1", "[::1]"].includes(name);
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "")) return false;
  try { return local(new URL(`http://${host}`).hostname) && (!origin || local(new URL(origin).hostname)); }
  catch { return false; }
}
