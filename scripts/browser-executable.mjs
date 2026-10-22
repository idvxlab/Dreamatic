import { access } from "node:fs/promises";
export async function browserExecutable() {
  if (process.env.DREAMATIC_HTML_BROWSER === "off") return undefined;
  const { chromium } = await import("playwright-core");
  const candidates = [process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE, process.env.DREAMATIC_DESKTOP_BROWSER, chromium.executablePath(), ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : process.platform === "linux" ? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"] : [])];
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
  return undefined;
}

