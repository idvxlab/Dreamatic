import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
try { loadEnvFile(join(repoRoot, ".env")); } catch { /* Report missing values below. */ }

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const positionalImage = args.find((value, index) => !value.startsWith("--") && (index === 0 || !args[index - 1]?.startsWith("--")));
const imageInput = option("--image") ?? positionalImage;
const apiKey = process.env.DREAMATIC_IMAGE_API_KEY?.trim() || process.env.DREAMATIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
const baseUrl = (process.env.DREAMATIC_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/u, "");
const endpoint = process.env.DREAMATIC_IMAGE_EDIT_ENDPOINT?.trim() || `${baseUrl}/images/edits`;
const model = process.env.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1";
const size = option("--size") ?? process.env.DREAMATIC_IMAGE_DEFAULT_SIZE ?? "1536x1024";
const timeoutMs = Math.max(10_000, Number(option("--timeout-ms") ?? process.env.DREAMATIC_IMAGE_TIMEOUT_MS ?? 300_000));
const responseFormat = process.env.DREAMATIC_IMAGE_RESPONSE_FORMAT ?? "b64_json";
const endpointUrl = new URL(endpoint);

function print(label, value) {
  console.log(`${label}: ${value}`);
}

function safeError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}${error.cause ? `; cause=${String(error.cause)}` : ""}` : String(error);
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}

console.log("DreamaticArt image-edit diagnostics");
print("endpoint", endpoint);
print("model", model);
print("size", size);
print("response format", responseFormat);
print("timeout", `${timeoutMs} ms`);
print("API key", apiKey ? "configured (value hidden)" : "MISSING");
print("HTTPS_PROXY", process.env.HTTPS_PROXY || process.env.https_proxy ? "configured" : "not configured");
print("NODE_USE_ENV_PROXY", process.env.NODE_USE_ENV_PROXY ?? "not configured");

if (!apiKey) {
  console.error("No image API key is available. Configure DREAMATIC_IMAGE_API_KEY or DREAMATIC_API_KEY in .env.");
  process.exit(1);
}

try {
  const address = await lookup(endpointUrl.hostname);
  print("DNS", `${endpointUrl.hostname} -> ${address.address}`);
} catch (error) {
  console.error(`DNS failed: ${safeError(error)}`);
}

const connectivityStarted = performance.now();
try {
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
  });
  print("endpoint reachability", `HTTP ${response.status} in ${Math.round(performance.now() - connectivityStarted)} ms (any HTTP response confirms the host is reachable)`);
  await response.body?.cancel();
} catch (error) {
  console.error(`Endpoint connection failed after ${Math.round(performance.now() - connectivityStarted)} ms: ${safeError(error)}`);
  process.exit(1);
}

if (!imageInput) {
  console.log("Connectivity check complete. To make one real, billable edit request, run:");
  console.log('  npm run diagnose:image-edit -- --image "/absolute/path/to/reference.png"');
  process.exit(0);
}

const imagePath = isAbsolute(imageInput) ? imageInput : resolve(repoRoot, imageInput);
const mimeTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);
const mimeType = mimeTypes.get(extname(imagePath).toLowerCase());
if (!mimeType) {
  console.error(`Unsupported diagnostic image type: ${extname(imagePath) || "none"}`);
  process.exit(1);
}

let bytes;
try {
  const info = await stat(imagePath);
  bytes = await readFile(imagePath);
  print("input image", `${imagePath} (${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
} catch (error) {
  console.error(`Cannot read input image: ${safeError(error)}`);
  process.exit(1);
}

const form = new FormData();
form.set("model", model);
form.set("prompt", "Diagnostic edit: add one small neutral gray circle in the top-left corner and preserve everything else.");
form.set("size", size);
form.set("n", "1");
form.set("response_format", responseFormat);
form.append("image", new Blob([Uint8Array.from(bytes)], { type: mimeType }), basename(imagePath));

console.log("Sending one real image-edit request (this may be billable)…");
const editStarted = performance.now();
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const elapsedMs = Math.round(performance.now() - editStarted);
  print("edit response", `HTTP ${response.status} in ${elapsedMs} ms`);
  print("request id", response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? "not returned");
  print("retry-after", response.headers.get("retry-after") ?? "not returned");
  const body = await response.text();
  if (!response.ok) {
    console.error(`API error body: ${body.slice(0, 1_200).replaceAll(apiKey, "[redacted]")}`);
    process.exit(1);
  }
  const payload = JSON.parse(body);
  const first = payload?.data?.[0];
  print("result", first?.b64_json ? `base64 image returned (${first.b64_json.length} characters)` : first?.url ? "image URL returned" : "success response received, but no image field was recognized");
} catch (error) {
  console.error(`Edit request failed after ${Math.round(performance.now() - editStarted)} ms: ${safeError(error)}`);
  process.exit(1);
}
