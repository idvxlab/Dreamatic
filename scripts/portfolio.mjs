import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { generatePortfolio } from '../apps/server/dist/portfolio-pdf.js';
try { loadEnvFile('.env'); } catch { /* Optional local settings. */ }
const runId = process.argv[2];
if (!runId || process.argv.length !== 3) {
  console.error('Usage: npm run portfolio -- <completed-run-id>'); process.exitCode = 1;
} else {
  try {
    const workspace = resolve(process.env.DREAMATIC_WORKSPACE || 'workspace');
    const result = await generatePortfolio(workspace, runId);
    console.log(JSON.stringify({ ...result, absolutePath: resolve(workspace, result.path) }, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
