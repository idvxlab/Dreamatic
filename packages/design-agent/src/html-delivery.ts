import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { Browser } from "playwright-core";
import { assertSafeOutput, fileHash, htmlTask, physicalRunFile, type DeliveryContract, type HtmlTask } from "./design-contract.js";
import { resolveInside } from "./paths.js";

export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const HTML_CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2" };

export async function materializeHtml(runDir: string, task: HtmlTask, reuse = true, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const mappings = [...task.files, ...task.resources];
  const inputs = await Promise.all(mappings.map(async (mapping) => ({ ...mapping, hash: await fileHash(runDir, mapping.source) })));
  const fingerprint = createHash("sha256").update(JSON.stringify({ task, inputs })).digest("hex");
  const receiptPath = resolveInside(runDir, `.performance/html-${createHash("sha256").update(task.id).digest("hex")}.json`);
  const previous = reuse ? await readFile(receiptPath, "utf8").then((value) => JSON.parse(value) as { fingerprint?: string; outputs?: Record<string, string> }).catch(() => undefined) : undefined;
  if (previous?.fingerprint === fingerprint && previous.outputs) {
    const matches = await Promise.all(inputs.map(async (mapping) => (await fileHash(runDir, mapping.output).catch(() => undefined)) === previous.outputs?.[mapping.output]));
    if (matches.every(Boolean)) return { ok: true, id: task.id, method: task.method, reused: true, files: inputs.map((mapping) => mapping.output) };
  }
  const staging = resolveInside(runDir, `.performance/html-stage-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true });
    // Read every source before publishing; a failed source never overwrites successful outputs.
    for (const [index, mapping] of inputs.entries()) {
      signal?.throwIfAborted();
      await assertSafeOutput(runDir, mapping.output);
      const bytes = await readFile(await physicalRunFile(runDir, mapping.source));
      if (createHash("sha256").update(bytes).digest("hex") !== mapping.hash) throw new Error("HTML source changed during execution; obtain a new approval");
      await writeFile(join(staging, String(index)), bytes);
    }
    for (const [index, mapping] of inputs.entries()) {
      signal?.throwIfAborted();
      const output = await assertSafeOutput(runDir, mapping.output);
      await mkdir(dirname(output), { recursive: true });
      await rename(join(staging, String(index)), output);
    }
    const outputs = Object.fromEntries(inputs.map((mapping) => [mapping.output, mapping.hash]));
    await mkdir(dirname(receiptPath), { recursive: true });
    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ fingerprint, outputs }));
    await rename(temporary, receiptPath);
    return { ok: true, id: task.id, method: task.method, reused: false, files: inputs.map((mapping) => mapping.output) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Catch remote embedded resources in Designer sources before approval, without generating images. */
export async function lintHtmlSourceResources(runDir: string, task: Pick<HtmlTask, "id" | "files">): Promise<string[]> {
  const issues: string[] = [];
  for (const file of task.files.filter((file) => /\.(html|css)$/u.test(file.source))) {
    const source = await readFile(await physicalRunFile(runDir, file.source), "utf8");
    const check = (reference: string, navigation = false) => {
      if (navigation || /^data:image\//iu.test(reference)) return;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference)) issues.push(`${task.id}.files (${file.source}): remote embedded resource ${reference}. Use a declared local asset or system-font stack; navigation links are allowed.`);
    };
    if (file.source.endsWith(".html")) for (const tag of source.matchAll(/<([a-z][a-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu)) {
      for (const attr of tag[0].matchAll(/\b(src|href|poster|data)\s*=\s*["']([^"']+)["']/giu)) check(attr[2]!, tag[1]!.toLowerCase() === "a" && attr[1]!.toLowerCase() === "href");
      for (const attr of tag[0].matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/giu)) for (const candidate of attr[1]!.split(",")) check(candidate.trim().split(/\s/u)[0]!);
    }
    for (const reference of source.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)|@import\s*["']([^"']+)["']/giu)) check(reference[1] ?? reference[2]!);
  }
  return issues;
}

export async function lintHtmlDelivery(runDir: string, contract: DeliveryContract) {
  const issues: string[] = [];
  const tasks = contract.tasks.filter((task) => task.method === "html_generate").map(htmlTask);
  const files = new Set(tasks.flatMap((task) => [...task.files, ...task.resources].map((file) => file.output)));
  const checkReference = async (file: string, reference: string, navigation = false) => {
    if (!reference || reference.startsWith("#") || (navigation && (reference.startsWith("?") || /^(?:https?:\/\/|mailto:|tel:)/iu.test(reference))) || /^data:image\//iu.test(reference)) return;
    try {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(reference)) throw new Error("Resource must be relative and local");
      const absolute = resolveInside(resolveInside(runDir, "artifacts"), resolve(dirname(resolveInside(runDir, file)), decodeURIComponent(reference.split(/[?#]/u)[0]!)));
      const local = relative(runDir, absolute).replaceAll("\\", "/");
      if (!files.has(local)) throw new Error("Undeclared resource");
      await physicalRunFile(runDir, local);
    } catch { issues.push(`${file}: invalid, undeclared or missing reference ${reference}`); }
  };
  for (const file of files) {
    const path = await physicalRunFile(runDir, file).catch(() => undefined);
    if (!path || !(await stat(path)).size) { issues.push(`${file}: missing or empty file`); continue; }
    if (!/\.(html|css)$/u.test(file)) continue;
    const source = await readFile(path, "utf8");
    if (file.endsWith(".html")) {
      if (!/<html\b/iu.test(source) || !/<title\b/iu.test(source)) issues.push(`${file}: document needs html and title`);
      if (/<base\b/iu.test(source)) issues.push(`${file}: base elements are not supported in portable prototypes`);
      for (const tag of source.matchAll(/<([a-z][a-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu)) {
        for (const attribute of tag[0].matchAll(/\b(src|href|poster|data)\s*=\s*["']([^"']+)["']/giu)) await checkReference(file, attribute[2]!, tag[1]!.toLowerCase() === "a" && attribute[1]!.toLowerCase() === "href");
        for (const attribute of tag[0].matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/giu)) for (const candidate of attribute[1]!.split(",")) await checkReference(file, candidate.trim().split(/\s/u)[0]!);
      }
    }
    for (const reference of source.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)|@import\s*["']([^"']+)["']/giu)) await checkReference(file, reference[1] ?? reference[2]!);
  }
  for (const deliverable of contract.deliverables.filter((item) => item.required === true)) {
    if (!await physicalRunFile(runDir, String(deliverable.file)).then(async (path) => (await stat(path)).size > 0).catch(() => false)) issues.push(`Required output missing: ${String(deliverable.file)}`);
  }
  return { ok: issues.length === 0, issues, files: [...files], scope: "declared_html_files", checkedAt: new Date().toISOString() };
}

/** Mixed delivery keeps Gallery's static-resource rules without banning prototype scripts. */
export async function lintGalleryPresentation(runDir: string, entry: string): Promise<string[]> {
  const issues: string[] = [];
  const html = await readFile(await physicalRunFile(runDir, entry), "utf8");
  if (/<script\b/iu.test(html)) issues.push(`${entry}: script element found`);
  const reference = async (value: string, hyperlink = false) => {
    if (value.startsWith("#")) return;
    try {
      if (hyperlink && /^https?:\/\//iu.test(value)) {
        const url = new URL(value.replaceAll("&amp;", "&"));
        if (url.username || url.password) throw new Error("Unsafe link");
        return;
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(value)) throw new Error("Non-local resource");
      const path = resolveInside(runDir, resolve(dirname(resolveInside(runDir, entry)), decodeURIComponent(value.split(/[?#]/u)[0]!)));
      await physicalRunFile(runDir, relative(runDir, path));
    } catch { issues.push(`${entry}: invalid or missing local reference ${value}`); }
  };
  for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu)) {
    for (const attribute of tag[0].matchAll(/\b(src|href|poster|data)\s*=\s*["']([^"']+)["']/giu)) await reference(attribute[2]!, tag[1]!.toLowerCase() === "a" && attribute[1]!.toLowerCase() === "href");
    for (const attribute of tag[0].matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/giu)) for (const candidate of attribute[1]!.split(",")) await reference(candidate.trim().split(/\s/u)[0]!);
  }
  for (const match of html.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)|@import\s*["']([^"']+)["']/giu)) await reference(match[1] ?? match[2]!);
  return issues;
}

export async function browserExecutable(): Promise<string | undefined> {
  if (process.env.DREAMATIC_HTML_BROWSER === "off") return undefined;
  const { chromium } = await import("playwright-core");
  const candidates = [process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE, chromium.executablePath(), ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : process.platform === "linux" ? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"] : [])];
  for (const candidate of candidates) if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
  return undefined;
}

/** Browser checks use a disposable, API-free origin and declarative actions, never agent-authored test code. */
export async function checkHtmlBrowser(runDir: string, contract: DeliveryContract, signal?: AbortSignal, options: { interactionsOnly?: boolean } = {}) {
  const executablePath = await browserExecutable();
  if (!executablePath) return { status: "unavailable", passed: false, issues: [] as string[], reason: "Set DREAMATIC_HTML_BROWSER_EXECUTABLE to a Chromium browser. Static validation only; interactions remain unverified." };
  const tasks = contract.tasks.filter((task) => task.method === "html_generate").map(htmlTask);
  const allowed = new Set(tasks.flatMap((task) => [...task.files, ...task.resources].map((file) => file.output)));
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
      if (request.method !== "GET" || !allowed.has(path)) { response.writeHead(404); response.end(); return; }
      const bytes = await readFile(await physicalRunFile(runDir, path));
      response.writeHead(200, { "Content-Type": HTML_CONTENT_TYPES[extname(path)] ?? "application/octet-stream", "Content-Security-Policy": HTML_PREVIEW_CSP, "X-Content-Type-Options": "nosniff" });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser validation server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const issues: string[] = [];
  const checks: Array<{ taskId: string; name: string; width: number; status: "passed" | "failed" | "not_applicable"; issue?: string }> = [];
  let browser: Browser | undefined;
  try {
    signal?.throwIfAborted();
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath, headless: true });
    const abort = () => { void browser?.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (const task of tasks) {
        for (const viewport of task.viewports) {
          const context = await browser.newContext({ viewport, serviceWorkers: "block" });
          await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
          try {
            const page = await context.newPage();
            page.setDefaultTimeout(5000);
            page.on("pageerror", (error) => issues.push(`${task.id}: ${error.message}`));
            page.on("console", (message) => { if (message.type() === "error") issues.push(`${task.id}: ${message.text()}`); });
            page.on("response", (response) => { if (response.status() >= 400) issues.push(`${task.id}: resource ${response.status()} ${response.url()}`); });
            const htmlFiles = task.files.filter((file) => file.output.endsWith(".html"));
            for (const file of htmlFiles) {
              signal?.throwIfAborted();
              await page.goto(`${origin}/${file.output}`, { waitUntil: "load", timeout: 15000 });
              if (!options.interactionsOnly && await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) issues.push(`${file.output}: horizontal overflow at ${viewport.width}px`);
            }
            for (const check of task.interaction_checks) {
              if (viewport.width < (check.viewport?.min_width ?? 240) || viewport.width > (check.viewport?.max_width ?? 3840)) {
                checks.push({ taskId: task.id, name: check.name, width: viewport.width, status: "not_applicable" }); continue;
              }
              let activeStep = "";
              try {
              await page.goto(`${origin}/${check.page ?? htmlFiles[0]!.output}`, { waitUntil: "load", timeout: 15000 });
              for (const [index, step] of check.steps.entries()) {
                activeStep = `step ${index + 1} ${step.action} ${step.selector}`;
                signal?.throwIfAborted();
                const target = page.locator(step.selector);
                if (step.action === "click") await target.click();
                else if (step.action === "fill") await target.fill(step.value!);
                else if (step.action === "press") await target.press(step.value!);
                else if (step.action === "expect_visible" && (step.match ?? "any") === "any") await target.filter({ visible: true }).first().waitFor({ state: "visible" });
                else if (step.action === "expect_hidden" && (step.match ?? "all") === "all") await target.filter({ visible: true }).first().waitFor({ state: "hidden" });
                else if (["expect_visible", "expect_hidden"].includes(step.action) && step.match === "unique") await target.waitFor({ state: step.action === "expect_visible" ? "visible" : "hidden" });
                else {
                  const deadline = Date.now() + 5000;
                  while (true) {
                    const count = await target.count();
                    const match = step.match ?? "unique";
                    if (match === "unique" && count > 1) throw new Error(`Assertion selector ${step.selector} matches ${count} elements; specify match:any/all or select a unique element`);
                    const results = step.action === "expect_visible" || step.action === "expect_hidden"
                      ? await Promise.all((await target.all()).map((item) => item.isVisible().then((visible) => step.action === "expect_visible" ? visible : !visible)))
                      : await target.evaluateAll((elements, { action, value }) => elements.map((element) => action === "expect_text" ? Boolean(element.textContent?.includes(value!)) : (element as HTMLInputElement).value === value), { action: step.action, value: step.value });
                    if (count > 0 && (match === "any" ? results.some(Boolean) : results.every(Boolean))) break;
                    if (Date.now() >= deadline) throw new Error(`${step.action} did not pass for ${step.selector} (${match})`);
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    signal?.throwIfAborted();
                  }
                }
              }
              checks.push({ taskId: task.id, name: check.name, width: viewport.width, status: "passed" });
              } catch (error) {
                signal?.throwIfAborted();
                const issue = `${task.id} / ${check.name} at ${viewport.width}px${activeStep ? ` (${activeStep})` : ""}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
                checks.push({ taskId: task.id, name: check.name, width: viewport.width, status: "failed", issue }); issues.push(issue);
              }
            }
          } catch (error) { issues.push(`${task.id} at ${viewport.width}px: ${error instanceof Error ? error.message : String(error)}`); }
          finally { await context.close(); }
        }
      }
    } finally { signal?.removeEventListener("abort", abort); }
    signal?.throwIfAborted();
    return { status: "completed", passed: issues.length === 0, issues: [...new Set(issues)], checks };
  } finally { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
