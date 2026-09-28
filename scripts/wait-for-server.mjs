const url = process.argv[2] ?? "http://localhost:4310/api/health";
const timeoutMs = Number.parseInt(process.env.DREAMATIC_STARTUP_TIMEOUT_MS ?? "30000", 10);
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      console.log(`Dreamatic server is ready: ${url}`);
      process.exit(0);
    }
  } catch {
    // The server is still starting. Retry without surfacing a transient error.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.error(`Dreamatic server did not become ready within ${timeoutMs}ms: ${url}`);
process.exit(1);
