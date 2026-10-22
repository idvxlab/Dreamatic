#!/usr/bin/env node
const message = "Dreamatic design execution is unavailable while the system is being redesigned.";
if (process.argv.includes("--help") || process.argv.includes("-h")) console.log(message);
else { console.error(message); process.exitCode = 1; }
export {};
