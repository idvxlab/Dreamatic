import { spawn } from "node:child_process";

export function createIdleSleepGuard(options: { platform?: string; enabled?: boolean; launch?: () => () => void } = {}) {
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled ?? process.env.DREAMATIC_PREVENT_IDLE_SLEEP !== "false";
  const launch = options.launch ?? (() => {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return () => { child.kill(); };
  });
  let release: (() => void) | undefined;
  return {
    start() {
      if (enabled && platform === "darwin" && !release) release = launch();
    },
    stop() {
      release?.();
      release = undefined;
    },
  };
}
