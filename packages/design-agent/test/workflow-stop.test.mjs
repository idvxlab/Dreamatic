import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stopAfterCommittedTurn } from "../dist/session-status.js";

const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const corePackage = sdkRequire.resolve("@earendil-works/pi-agent-core/package.json");
const coreMetadata = sdkRequire(corePackage);
const { Agent } = await import(new URL(coreMetadata.exports["."].import, pathToFileURL(corePackage)).href);

test("Pi ends a committed mixed tool batch without aborting or another provider call", async () => {
  let calls = 0;
  let committed = false;
  const message = {
    role: "assistant", api: "openai-completions", provider: "mock", model: "mock",
    content: [
      { type: "toolCall", id: "progress", name: "progress", arguments: {} },
      { type: "toolCall", id: "commit", name: "commit", arguments: {} },
    ],
    stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const tool = (name) => ({
    name, label: name, description: name, parameters: { type: "object", properties: {} },
    execute: async () => {
      if (name === "commit") committed = true;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  const agent = new Agent({
    initialState: { model: { id: "mock", provider: "mock", api: "openai-completions" }, tools: [tool("progress"), tool("commit")] },
    streamFn: () => {
      calls += 1;
      assert.equal(calls, 1);
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: "toolUse", message }; },
        result: async () => message,
      };
    },
  });
  const restore = stopAfterCommittedTurn(agent, () => committed);
  try {
    await agent.prompt("Complete the workflow");
    assert.equal(calls, 1);
    assert.equal(agent.state.messages.at(-1).toolName, "commit");
    assert.equal(agent.state.messages.some((entry) => ["error", "aborted"].includes(entry.stopReason)), false);
    assert.equal(agent.state.isStreaming, false);
  } finally {
    restore();
  }
  assert.equal(agent.shouldStopAfterTurn, undefined);
});

test("committed-turn stop preserves and restores existing SDK stop policy", async () => {
  let calls = 0;
  const previous = async () => { calls += 1; return true; };
  const agent = { shouldStopAfterTurn: previous };
  const restore = stopAfterCommittedTurn(agent, () => false);
  assert.equal(await agent.shouldStopAfterTurn({}), true);
  assert.equal(calls, 1);
  restore();
  assert.equal(agent.shouldStopAfterTurn, previous);
});
