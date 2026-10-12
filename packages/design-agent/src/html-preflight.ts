import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSafeOutput, htmlTask, physicalRunFile, validateDeliveryContract, type DeliveryContract } from "./design-contract.js";
import { encodeImageOutput } from "./image-output.js";
import { browserExecutable, checkHtmlBrowser, lintHtmlSourceDependencies } from "./html-delivery.js";
import { DeliveryBlocked, deliveryRuntimeStamp } from "./delivery-block.js";

// Only for disposable interaction previews. Never write placeholders into a Run's artifacts.
const IMAGE_PLACEHOLDER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
type BrowserReport = Awaited<ReturnType<typeof checkHtmlBrowser>>;
function failure(issues: string[], contract: DeliveryContract) {
  const tasks = contract.tasks.filter((task) => task.method === "html_generate").map(htmlTask);
  const groups = new Map<string, { issue: string; widths: string[] }>();
  for (const issue of issues) {
    const width = issue.match(/\bat (\d+)px\b/);
    const key = width ? issue.replace(width[0], "at <viewport>px") : issue;
    const group = groups.get(key);
    if (group && width) { if (!group.widths.includes(width[1]!)) group.widths.push(width[1]!); }
    else groups.set(key, { issue, widths: width ? [width[1]!] : [] });
  }
  return new DeliveryBlocked("designer", [...groups.values()].map(({ issue, widths }) => {
    const message = widths.length > 1 ? issue.replace(/\bat \d+px\b/, `at ${widths.map(width => `${width}px`).join(", ")}`) : issue;
    for (const task of tasks) {
      const index = task.interaction_checks.findIndex(check => issue.startsWith(`${task.id} / ${check.name} at `));
      if (index >= 0) {
        const check = task.interaction_checks[index]!;
        const output = check.page ?? task.files.find(file => file.output.endsWith(".html"))?.output;
        const source = task.files.find(file => file.output === output)?.source;
        const hint = /\(step \d+ click /.test(issue) && /Timeout/.test(issue)
          ? " Each check starts on a freshly loaded page: reveal scroll/menu-dependent controls before clicking. Viewport bounds are inclusive; CSS max-width:768px hiding a control requires min_width:769 for its desktop check. Verify required mobile navigation separately; skipped checks do not prove mobile coverage."
          : /\(step \d+ expect_in_viewport /.test(issue) && /outside the viewport/.test(issue)
            ? " expect_in_viewport only asserts arrival; it never scrolls. Each check starts on a freshly loaded page. Put the actual navigation click or keyboard scroll before this assertion, not after it. Use expect_visible only when rendered visibility, rather than viewport arrival, is the requirement."
            : "";
        return `HTML source preflight: ${message}; location: deliverable ${task.id}.execution.interaction_checks[${index}]${source ? `; page source: ${source}` : ""}. Verify selector/viewport against existing behavior before changing sources.${hint}`;
      }
    }
    const id = issue.match(/^Presentation ([^:]+):/)?.[1];
    const deliverable = contract.deliverables.find(item => item.id === id);
    const owners = deliverable ? tasks.filter(task => task.resources.some(resource => resource.source === deliverable.file)) : [];
    const sources = [...new Set(owners.flatMap(task => task.files.filter(file => file.output.endsWith(".html")).map(file => file.source)))];
    return `HTML source preflight: ${message}${sources.length ? `; location: deliverable ${id}.presentation; page sources: ${sources.join(", ")}` : ""}`;
  }));
}

/** Exercise exact Designer sources before image generation; final delivery still checks real assets/layout. */
export async function assertHtmlSourcePreflight(runDir: string, contract: DeliveryContract, signal?: AbortSignal) {
  const tasks = contract.tasks.filter((task) => task.method === "html_generate").map(htmlTask);
  if (!tasks.length) return { status: "not_applicable", reused: false };
  signal?.throwIfAborted();
  await validateDeliveryContract(runDir, contract);
  const sourceIssues = await lintHtmlSourceDependencies(runDir, contract);
  if (sourceIssues.length) throw failure(sourceIssues, contract);
  const executable = await browserExecutable();
  if (!executable) {
    if (process.env.DREAMATIC_HTML_REQUIRE_BROWSER === "true" || contract.deliverables.some(item => (item.presentation as { required?: boolean } | undefined)?.required)) throw new DeliveryBlocked("runtime", ["Required HTML source preflight browser is unavailable; configure DREAMATIC_HTML_BROWSER_EXECUTABLE"]);
    return { status: "unavailable", reused: false, reason: "HTML source interactions remain unverified; browser validation is unavailable" };
  }
  const bytesByOutput = new Map<string, Buffer>();
  for (const task of tasks) for (const file of task.files) bytesByOutput.set(file.output, await readFile(await physicalRunFile(runDir, file.source)));
  for (const task of tasks) for (const resource of task.resources) {
    const bytes = resource.source.startsWith("artifacts/")
      ? bytesByOutput.get(resource.source) ?? encodeImageOutput(IMAGE_PLACEHOLDER, resource.source).bytes
      : await readFile(await physicalRunFile(runDir, resource.source));
    bytesByOutput.set(resource.output, bytes);
  }
  // Contract validation guarantees artifact resources have a declared image/HTML producer.
  const hash = createHash("sha256").update(await deliveryRuntimeStamp()).update(executable).update(JSON.stringify(contract));
  for (const [path, bytes] of [...bytesByOutput].sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update(bytes);
  const fingerprint = hash.digest("hex");
  const cachePath = join(runDir, ".performance/html-preflight.json");
  const cached = await readFile(cachePath, "utf8").then(JSON.parse).catch(() => undefined) as { fingerprint?: string; report?: BrowserReport } | undefined;
  signal?.throwIfAborted();
  if (cached?.fingerprint === fingerprint && cached.report?.status === "completed") {
    if (!cached.report.passed) throw failure(cached.report.issues, contract);
    return { ...cached.report, fingerprint, reused: true };
  }
  const previewDir = await mkdtemp(join(tmpdir(), "dreamatic-html-preflight-"));
  try {
    for (const [path, bytes] of bytesByOutput) {
      signal?.throwIfAborted();
      const output = await assertSafeOutput(previewDir, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    let report: BrowserReport;
    try { report = await checkHtmlBrowser(previewDir, contract, signal, { interactionsOnly: true, sourcePreview: true }); }
    catch (error) {
      signal?.throwIfAborted();
      throw new DeliveryBlocked("runtime", [`HTML source preflight browser failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
    signal?.throwIfAborted();
    if (report.status === "completed") {
      await mkdir(dirname(cachePath), { recursive: true });
      const temporaryCache = `${cachePath}.${fingerprint}.tmp`;
      await writeFile(temporaryCache, JSON.stringify({ fingerprint, report, checkedAt: new Date().toISOString(), evidence: "Source interaction preview only; generated images use private placeholders. Final delivery validation remains required." }, null, 2));
      await rename(temporaryCache, cachePath);
      if (!report.passed) throw failure(report.issues, contract);
    } else if (process.env.DREAMATIC_HTML_REQUIRE_BROWSER === "true") throw new DeliveryBlocked("runtime", [report.reason ?? "Required HTML source preflight browser is unavailable"]);
    return { ...report, fingerprint, reused: false };
  } finally { await rm(previewDir, { recursive: true, force: true }); }
}
