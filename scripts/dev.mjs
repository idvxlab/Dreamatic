import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let stopping = false;

function prefix(stream, label, destination) {
  stream.on("data", (chunk) => {
    const value = String(chunk).replace(/\r?\n$/u, "").replaceAll("\n", `\n[${label}] `);
    if (value) destination.write(`[${label}] ${value}\n`);
  });
}

function start(label, entry, cwd) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  prefix(child.stdout, label, process.stdout);
  prefix(child.stderr, label, process.stderr);
  return child;
}

async function waitForServer(server) {
  const url = "http://localhost:4310/api/health";
  const deadline = Date.now() + Number.parseInt(process.env.DREAMATIC_STARTUP_TIMEOUT_MS ?? "30000", 10);
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited before becoming ready (code ${server.exitCode}).`);
    try {
      const response = await fetch(url);
      const health = response.ok ? await response.json() : undefined;
      if (health?.processId === server.pid) {
        console.log(`[dev] Dreamatic server is ready: ${url}`);
        return;
      }
    } catch {
      // The server is still loading its persisted sessions.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    Promise.all([...children].map((child) => child.exitCode === null ? once(child, "exit") : undefined)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exitCode = code;
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

const server = start("server", join(repoRoot, "apps", "server", "dist", "index.js"), repoRoot);
try {
  await waitForServer(server);
  const web = start("web", join(repoRoot, "node_modules", "vite", "bin", "vite.js"), join(repoRoot, "apps", "web"));
  const [label, code] = await Promise.race([
    once(server, "exit").then(([exitCode]) => ["server", exitCode]),
    once(web, "exit").then(([exitCode]) => ["web", exitCode]),
  ]);
  if (!stopping) {
    console.error(`[dev] ${label} exited unexpectedly (code ${code ?? 1}).`);
    await stop(typeof code === "number" ? code : 1);
  }
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  await stop(1);
}
